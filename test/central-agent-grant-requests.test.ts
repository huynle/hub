// Grant requests (design §5, §7; P3-T9): an agent (a session, or an app token) asks the user for a grant. The hub
// validates it like a grant (the holder defaults to the requester and may only be the requester, or a reserved
// role the requesting session holds), opens a tap-tier, high-urgency Decision to @me (approve / deny, deny safe)
// whose question summarises the grant, and on approve creates the grant AS THE USER (owner the user, holder
// pinned); the requester hears the grant id, or the denial. One open request per requester, a few an hour.
// A real Decisions + delivery engine + Grants over a fake directory, store and clock.
import { describe, expect, test } from "bun:test"
import type { AgentActor, UserActor } from "../src/central/agent/actor"
import type { AuditInput } from "../src/central/agent/audit"
import { Decisions } from "../src/central/agent/decisions"
import { Delivery, type DeliveryRegistry } from "../src/central/agent/delivery"
import type { DirectoryEntry, Resolved } from "../src/central/agent/directory"
import { partyFromActor } from "../src/central/agent/envelope"
import { AgentError } from "../src/central/agent/errors"
import { GRANT_REQUESTS_PER_HOUR, GrantRequests } from "../src/central/agent/grant-requests"
import { Grants } from "../src/central/agent/grants"
import { parseAddress } from "../src/central/agent/names"
import { MemoryCounters } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
const U = "u1"
const TOKEN = "0123456789abcdef"

const orchestrator: AgentActor = { kind: "session", userID: U, machineID: "m1", sessionID: "ses_o", via: "shell" }
const app: AgentActor = { kind: "app", userID: U, tokenID: TOKEN, scopes: ["messages:send"], label: "concierge" }
const cookieUser: UserActor = { kind: "user", userID: U, deviceID: "d1", via: "cookie" }

const GRANT = { scope: { projects: ["/work/hub"] }, allow: ["approve", "deny"], permissions: { allow: ["read"], never: ["bash:git push*"] }, expires: "8h" }

function setup() {
  let t = T0
  const now = () => t
  const state = new MemoryStateStore({ now })
  const counters = new MemoryCounters({ now })
  const entries = new Map<string, DirectoryEntry>([
    ["ses_o", { sessionID: "ses_o", name: "orchestrator", online: true, roles: [{ role: "orchestrator" } as any] }],
    ["ses_w", { sessionID: "ses_w", name: "worker", online: true, roles: [] }],
  ])
  const registry: DeliveryRegistry = { sessionTargets: (id) => (entries.has(id) ? ["c1"] : []), supports: () => true, connTenant: () => U, idle: () => false, recency: () => 0 }
  const directory = {
    resolve(userID: string, addr: string): Resolved {
      const address = parseAddress(addr)
      const found = [...entries.values()].filter((e) => {
        if (!address || userID !== U) return false
        if (address.kind === "id") return e.sessionID === address.id
        if (address.kind === "name") return e.name === address.name
        return e.roles.some((r: any) => r.role === address.role)
      })
      if (!address || !found.length) throw new AgentError("not_found", `No session ${addr}`)
      return { address, sessions: found }
    },
  }
  const delivery = new Delivery({ state, counters, registry, directory, send: async () => ({ delivered: "steer" }), now })
  const store = {
    user: (id: string) => (id === U ? ({ id: U, role: "member" } as any) : undefined),
    agentData: (_id: string) => ({ appTokens: [{ id: TOKEN }] }) as any,
  }
  const grants = new Grants({ state, counters, directory, store, now })
  const audits: AuditInput[] = []
  const published: string[] = []
  let requests!: GrantRequests
  const decisions = new Decisions({ state, delivery, now, act: (...args) => requests.act(...args) })
  requests = new GrantRequests({
    state,
    counters,
    decisions,
    grants,
    directory,
    now,
    audit: { record: async (_userID, input) => void audits.push(input) as never },
    published: (_userID, message) => void published.push(message.id),
    describe: (_userID, actor) => partyFromActor(actor, actor.kind === "session" ? { name: entries.get(actor.sessionID)?.name } : {}),
  })
  return { requests, decisions, grants, delivery, audits, published, entries, set: (at: number) => void (t = at) }
}

const ask = (s: ReturnType<typeof setup>, actor: AgentActor = orchestrator, body: unknown = { grant: GRANT, why: "to unblock the workers' test runs" }) => s.requests.request(U, actor, body)

describe("requesting", () => {
  test("a session's request opens a tap-tier, high-urgency Decision to @me: approve / deny (safe), summarising the grant", async () => {
    const s = setup()
    const { decision, message } = await ask(s)
    expect(decision).toMatchObject({
      state: "open",
      tier: "tap",
      urgency: "high",
      from: { kind: "session", sessionID: "ses_o" },
      about: ["ses_o"],
      options: [{ id: "approve", label: "Approve grant" }, { id: "deny", label: "Deny", safe: true }],
    })
    expect(message.recipient).toEqual({ kind: "user" })
    expect(s.published).toEqual([message.id])
    for (const part of ["@orchestrator", "requests a grant", "holder ses_o", "/work/hub", "approve, deny", "allow read", "never shell:git push*", "8h", "to unblock the workers' test runs"]) {
      expect(decision.question).toContain(part)
    }
    expect(decision.action).toEqual({
      kind: "grant",
      requester: "ses:ses_o",
      grant: { holder: "ses_o", scope: { projects: ["/work/hub"] }, allow: ["approve", "deny"], permissions: { allow: ["read"], never: ["shell:git push*"] }, allowAlways: false, maxActionsPerHour: 60, expires: 8 * 3600 },
    })
    expect(s.audits).toEqual([{ actor: { kind: "session", sessionID: "ses_o", name: "orchestrator" }, verb: "grant.request", target: { sessionID: "ses_o" }, decision: "needs_user", reason: "to unblock the workers' test runs", outcome: "escalated" }])
  })

  test("an app token's request is held by the token (app:<id>)", async () => {
    const s = setup()
    const { decision } = await ask(s, app)
    expect(decision.from).toMatchObject({ kind: "app", tokenID: TOKEN })
    expect(decision.about).toEqual([])
    expect((decision.action as any).grant.holder).toBe(`app:${TOKEN}`)
    expect(decision.question).toContain(`holder app:${TOKEN}`)
  })

  test("the why is sanitised in the question", async () => {
    const s = setup()
    const { decision } = await ask(s, orchestrator, { grant: GRANT, why: "tests\u202e only\u0007" })
    expect(decision.question).toContain("tests only")
    expect(decision.question).not.toContain("\u202e")
  })

  test("the user does not request: they create grants directly (invalid)", async () => {
    const s = setup()
    await expect(ask(s, cookieUser as AgentActor)).rejects.toMatchObject({ code: "invalid" })
  })

  test("a malformed request or grant is invalid", async () => {
    const s = setup()
    for (const body of [
      null,
      "grant",
      { grant: GRANT },
      { grant: GRANT, why: "  " },
      { grant: GRANT, why: "x", extra: 1 },
      { why: "x" },
      { grant: { ...GRANT, allow: ["launch"] }, why: "x" },
      { grant: { ...GRANT, scope: { projects: ["relative"] } }, why: "x" },
    ]) {
      await expect(ask(s, orchestrator, body)).rejects.toMatchObject({ code: "invalid" })
    }
    expect(await s.decisions.list(U)).toEqual([])
  })
})

describe("the holder", () => {
  const holder = (h: string) => ({ grant: { ...GRANT, holder: h }, why: "x" })

  test("may name the requester itself (ses_… or its @name, pinned to the session id)", async () => {
    const s = setup()
    const byID = await ask(s, orchestrator, holder("ses_o"))
    expect((byID.decision.action as any).grant.holder).toBe("ses_o")
    await s.decisions.answer(U, byID.decision.id, { option: "deny" }, cookieUser)
    const byName = await ask(s, orchestrator, holder("@orchestrator"))
    expect((byName.decision.action as any).grant.holder).toBe("ses_o")
  })

  test("may be a reserved role the requesting session holds", async () => {
    const s = setup()
    const { decision } = await ask(s, orchestrator, holder("@@orchestrator"))
    expect((decision.action as any).grant.holder).toBe("@@orchestrator")
  })

  test("may not be another session, a role the requester does not hold, or another app (forbidden)", async () => {
    const s = setup()
    await expect(ask(s, orchestrator, holder("ses_w"))).rejects.toMatchObject({ code: "forbidden" })
    await expect(ask(s, orchestrator, holder("@worker"))).rejects.toMatchObject({ code: "forbidden" })
    await expect(ask(s, orchestrator, holder("@@concierge"))).rejects.toMatchObject({ code: "forbidden" })
    await expect(ask(s, orchestrator, holder(`app:${TOKEN}`))).rejects.toMatchObject({ code: "forbidden" })
    await expect(ask(s, app, holder("ses_o"))).rejects.toMatchObject({ code: "forbidden" })
    await expect(ask(s, app, holder("@@orchestrator"))).rejects.toMatchObject({ code: "forbidden" })
    await expect(ask(s, app, holder("app:fedcba9876543210"))).rejects.toMatchObject({ code: "forbidden" })
    expect(await s.decisions.list(U)).toEqual([])
  })

  test("a session that is not the user's is not_found (tenancy)", async () => {
    const s = setup()
    await expect(ask(s, orchestrator, holder("ses_elsewhere"))).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("limits", () => {
  test("one open request per requester: another waits (rate_limited, with the open Decision); answered, a new one opens", async () => {
    const s = setup()
    const first = await ask(s)
    const again = await ask(s).catch((e) => e)
    expect(again).toBeInstanceOf(AgentError)
    expect(again).toMatchObject({ code: "rate_limited" })
    expect(again.options.extra).toMatchObject({ decisionID: first.decision.id })
    expect((await ask(s, app)).decision.state).toBe("open")
    await s.decisions.answer(U, first.decision.id, { option: "deny" }, cookieUser)
    expect((await ask(s)).decision.id).not.toBe(first.decision.id)
  })

  test(`at most ${GRANT_REQUESTS_PER_HOUR} requests per requester an hour`, async () => {
    const s = setup()
    for (let i = 0; i < GRANT_REQUESTS_PER_HOUR; i++) {
      const { decision } = await ask(s)
      await s.decisions.answer(U, decision.id, { option: "deny" }, cookieUser)
    }
    const limited = await ask(s).catch((e) => e)
    expect(limited).toMatchObject({ code: "rate_limited" })
    expect(limited.options.extra.retryAfter).toBeGreaterThan(0)
    s.set(T0 + HOUR + 1)
    expect((await ask(s)).decision.state).toBe("open")
  })
})

describe("the user's answer", () => {
  test("approve creates the grant as the user (owner the user, holder pinned to the requester); the requester hears its id", async () => {
    const s = setup()
    const { decision } = await ask(s)
    const { reply } = await s.decisions.answer(U, decision.id, { option: "approve" }, cookieUser)
    const [grant] = await s.grants.list(U)
    expect(grant).toMatchObject({ owner: U, holder: "ses_o", holderSessionID: "ses_o", allow: ["approve", "deny"], permissions: { allow: ["read"], never: ["shell:git push*"] }, state: "active" })
    expect(grant!.expiresAt - grant!.created).toBe(8 * HOUR)
    expect(reply!.text).toContain(`Decision ${decision.id}: Approve grant [approve]`)
    expect(reply!.text).toContain(`Grant ${grant!.id} created`)
    expect(reply!.recipient).toMatchObject({ kind: "session", sessionID: "ses_o" })
    expect(s.audits.at(-1)).toEqual({ actor: { kind: "user" }, verb: "grant.approve", target: { sessionID: "ses_o" }, grant: grant!.id, decision: "allow", reason: `Decision ${decision.id}`, outcome: "ok" })
  })

  test("deny creates nothing; the requester hears the denial", async () => {
    const s = setup()
    const { decision } = await ask(s)
    const { reply } = await s.decisions.answer(U, decision.id, { option: "deny", text: "not today" }, cookieUser)
    expect(await s.grants.list(U)).toEqual([])
    expect(reply!.text).toBe(`Decision ${decision.id}: Deny [deny]\nnot today`)
    expect(s.audits.at(-1)).toEqual({ actor: { kind: "user" }, verb: "grant.deny", target: { sessionID: "ses_o" }, decision: "allow", reason: `Decision ${decision.id}`, outcome: "refused" })
  })

  test("the requesting session gone by then: no grant, the Decision closes", async () => {
    const s = setup()
    const { decision } = await ask(s)
    s.entries.delete("ses_o")
    await expect(s.decisions.answer(U, decision.id, { option: "approve" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    expect(await s.grants.list(U)).toEqual([])
    expect((await s.decisions.get(U, decision.id))!.state).toBe("closed")
  })

  test("an app requester's grant is held by the token", async () => {
    const s = setup()
    const { decision } = await ask(s, app)
    await s.decisions.answer(U, decision.id, { option: "approve" }, cookieUser)
    const [grant] = await s.grants.list(U)
    expect(grant).toMatchObject({ owner: U, holder: `app:${TOKEN}` })
  })
})
