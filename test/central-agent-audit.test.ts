// The agent audit (design §5, §7, §11.4): every agent action {at, actor, verb, target, grant?, decision, reason?,
// outcome} in a per-user ring (2000) in the StateStore, newest first; each new entry goes to `recorded` (the
// owner's SSE 'agent' event); admins get only a hub-wide summary (who, kind, when) in Store.audit, never text.
import { describe, expect, test } from "bun:test"
import { agentAllows, type AgentActor } from "../src/central/agent/actor"
import { AGENT_AUDIT_LIMIT, AUDIT_REASON_MAX, AgentAudit, auditRoutes, type AgentAuditEntry, type AuditInput } from "../src/central/agent/audit"
import { agentFailure } from "../src/central/agent/errors"
import type { AgentContext } from "../src/central/agent/routes"
import { MemoryStateStore } from "../src/central/backend/memory-state"

const T0 = 1_700_000_000_000

const approve: AuditInput = {
  actor: { kind: "session", sessionID: "ses_orch", name: "orchestrator" },
  verb: "approve",
  target: { sessionID: "ses_worker", requestID: "per_1" },
  grant: "g_12",
  decision: "allow",
  reason: "only runs tests in the worktree",
  outcome: "ok",
}

function setup(options: { limit?: number } = {}) {
  let t = T0
  const state = new MemoryStateStore({ now: () => t })
  const recorded: { userID: string; entry: AgentAuditEntry }[] = []
  const summaries: { actor: string; action: string; target?: string; detail?: string }[] = []
  const audit = new AgentAudit({
    state,
    now: () => t,
    admin: { audit: (entry) => void summaries.push(entry) },
    recorded: (userID, entry) => void recorded.push({ userID, entry }),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  })
  return { audit, state, recorded, summaries, tick: (ms = 1) => void (t += ms) }
}

describe("AgentAudit.record", () => {
  test("stores the entry with time and sequence, and returns it", async () => {
    const { audit } = setup()
    const entry = await audit.record("u1", approve)
    expect(entry).toEqual({ seq: 1, at: T0, ...approve })
    expect((await audit.list("u1")).entries).toEqual([entry])
  })

  test("the default ring keeps 2000 entries", () => {
    expect(AGENT_AUDIT_LIMIT).toBe(2000)
  })

  test("drops the oldest entries past the limit", async () => {
    const { audit, state } = setup({ limit: 3 })
    for (let i = 0; i < 5; i++) await audit.record("u1", { ...approve, target: { requestID: `per_${i}` } })
    const { entries } = await audit.list("u1")
    expect(entries.map((e) => e.seq)).toEqual([5, 4, 3])
    expect((await state.list("u1", "agent-audit")).length).toBe(3)
  })

  test("each user has their own log", async () => {
    const { audit } = setup()
    await audit.record("u1", approve)
    await audit.record("u2", { ...approve, verb: "deny", decision: "needs_user", outcome: "escalated" })
    expect((await audit.list("u1")).entries.map((e) => e.verb)).toEqual(["approve"])
    expect((await audit.list("u2")).entries.map((e) => [e.seq, e.verb])).toEqual([[1, "deny"]])
  })

  test("sanitises and bounds the reason; an empty reason is dropped", async () => {
    const { audit } = setup()
    const long = await audit.record("u1", { ...approve, reason: `\u001b[31mred\u001b[0m\u0007 ${"x".repeat(AUDIT_REASON_MAX + 50)}` })
    expect(long.reason!.startsWith("red ")).toBe(true)
    expect(Array.from(long.reason!).length).toBe(AUDIT_REASON_MAX)
    const empty = await audit.record("u1", { ...approve, reason: " \u0007 " })
    expect("reason" in empty).toBe(false)
  })

  test("keeps only well-formed target ids and grant", async () => {
    const { audit } = setup()
    const entry = await audit.record("u1", { ...approve, target: { sessionID: "ses_ok", requestID: "bad id\n", formID: "x".repeat(300) }, grant: "" })
    expect(entry.target).toEqual({ sessionID: "ses_ok" })
    expect("grant" in entry).toBe(false)
  })

  test("refuses a malformed verb (a caller bug)", async () => {
    const { audit } = setup()
    await expect(audit.record("u1", { ...approve, verb: "Approve now" })).rejects.toThrow("verb")
  })

  test("sends each new entry to recorded, for its owner", async () => {
    const { audit, recorded } = setup()
    const entry = await audit.record("u1", approve)
    expect(recorded).toEqual([{ userID: "u1", entry }])
  })

  test("a throwing listener does not fail the record", async () => {
    const state = new MemoryStateStore()
    const audit = new AgentAudit({ state, recorded: () => { throw new Error("boom") } })
    const entry = await audit.record("u1", approve)
    expect((await audit.list("u1")).entries).toEqual([entry])
  })

  test("admins get a summary only: who (user), kind (agent.<verb>, actor kind), no target, reason or text", async () => {
    const { audit, summaries } = setup()
    await audit.record("u1", approve)
    expect(summaries).toEqual([{ actor: "u1", action: "agent.approve", detail: "session" }])
  })
})

describe("AgentAudit.list", () => {
  test("newest first, paged with limit and before", async () => {
    const { audit, tick } = setup()
    for (let i = 0; i < 5; i++) {
      await audit.record("u1", approve)
      tick()
    }
    const first = await audit.list("u1", { limit: 2 })
    expect(first.entries.map((e) => e.seq)).toEqual([5, 4])
    expect(first.next).toBe(4)
    const second = await audit.list("u1", { limit: 2, before: first.next! })
    expect(second.entries.map((e) => e.seq)).toEqual([3, 2])
    const last = await audit.list("u1", { limit: 2, before: second.next! })
    expect(last.entries.map((e) => e.seq)).toEqual([1])
    expect(last.next).toBeUndefined()
  })

  test("an unknown user has an empty log", async () => {
    const { audit } = setup()
    expect(await audit.list("nobody")).toEqual({ entries: [] })
  })
})

describe("GET /api/agent/audit (route)", () => {
  const user: AgentActor = { kind: "user", userID: "u1", deviceID: "d1", via: "cookie" }
  const call = async (audit: AgentAudit, query = "", userID = "u1") => {
    const [route] = auditRoutes(audit)
    const url = new URL(`http://hub.test/api/agent/audit${query}`)
    const context = { request: new Request(url), url, params: {}, actor: { ...user, userID }, credential: "cookie", user: { id: userID, role: "user", created: 0, lastSeen: 0 } } as AgentContext
    try {
      return await route!.handle(context)
    } catch (cause) {
      return agentFailure(cause)
    }
  }

  test("one GET route, users only (no session or app tokens)", () => {
    const routes = auditRoutes(setup().audit)
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/agent/audit"])
    const route = routes[0]!
    expect(agentAllows(route.allow, user)).toBe(true)
    expect(agentAllows(route.allow, { kind: "session", userID: "u1", machineID: "m1", sessionID: "s1" })).toBe(false)
    expect(agentAllows(route.allow, { kind: "app", userID: "u1", tokenID: "t1", scopes: ["sessions:read", "sessions:act"] })).toBe(false)
  })

  test("the caller's own entries, newest first, paged, never cached", async () => {
    const { audit } = setup()
    for (let i = 0; i < 3; i++) await audit.record("u1", approve)
    await audit.record("u2", approve)
    const res = await call(audit, "?limit=2")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = (await res.json()) as any
    expect(body.entries.map((e: AgentAuditEntry) => e.seq)).toEqual([3, 2])
    expect(body.next).toBe(2)
    const older = (await (await call(audit, "?limit=2&before=2")).json()) as any
    expect(older).toEqual({ entries: [expect.objectContaining({ seq: 1 })] })
    expect(((await (await call(audit, "", "u2")).json()) as any).entries.length).toBe(1)
  })

  test("a bad limit or before is invalid (400)", async () => {
    const { audit } = setup()
    for (const query of ["?limit=0", "?limit=abc", "?limit=501", "?before=-1", "?before=x"]) {
      const res = await call(audit, query)
      expect({ query, status: res.status }).toEqual({ query, status: 400 })
      expect(((await res.json()) as any).error.code).toBe("invalid")
    }
  })
})
