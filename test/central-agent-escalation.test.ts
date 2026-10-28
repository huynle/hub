// Escalations (design §5, §12.1; decision wvqeuis0 §7; P3-T8): an agent's approval outside its grant (needs_user)
// opens or updates ONE Decision per (holder, request) with approve/deny options, the agent's recommendation and the
// hub-set tier; the user's answer runs the permission reply as the user (no kill switch, no grant); the Decision
// closes when the request goes elsewhere; spam limits: per-holder hourly cap, open cap, coalesced pushes.
// A real Decisions + delivery engine over a fake registry, fake actions and a fake clock.
import { describe, expect, test } from "bun:test"
import type { Escalation } from "../src/central/agent/acting"
import type { AgentActor, UserActor } from "../src/central/agent/actor"
import type { AuditInput } from "../src/central/agent/audit"
import { Decisions } from "../src/central/agent/decisions"
import { Delivery, type DeliveryRegistry } from "../src/central/agent/delivery"
import type { DirectoryEntry, Resolved } from "../src/central/agent/directory"
import { partyFromActor } from "../src/central/agent/envelope"
import { AgentError } from "../src/central/agent/errors"
import {
  ESCALATION_PUSH_COALESCE_MS,
  ESCALATIONS_OPEN_MAX,
  ESCALATIONS_PER_HOLDER_HOUR,
  Escalations,
} from "../src/central/agent/escalation"
import { parseAddress } from "../src/central/agent/names"
import type { PermissionInput } from "../src/central/actions"
import { MemoryCounters } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import type { BlockerRecommendation } from "../src/status"

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
const U = "u1"

const orchestrator: AgentActor = { kind: "session", userID: U, machineID: "m1", sessionID: "ses_o", via: "act" } as AgentActor
const app: AgentActor = { kind: "app", userID: U, tokenID: "tok_1", scopes: ["sessions:act"], label: "assistant-app" }
const cookieUser: UserActor = { kind: "user", userID: U, deviceID: "d1", via: "cookie" }
const tokenUser: UserActor = { kind: "user", userID: U, deviceID: "d2", via: "device-token" }

function setup(options: { tenant?: (rootID: string) => string | undefined; outcome?: "done" | "gone" | "unsupported" } = {}) {
  let t = T0
  const now = () => t
  const state = new MemoryStateStore({ now })
  const counters = new MemoryCounters({ now })
  const entries = new Map<string, DirectoryEntry>([
    ["ses_o", { sessionID: "ses_o", name: "orchestrator", online: true, roles: [] }],
    ["ses_w", { sessionID: "ses_w", name: "worker", online: true, roles: [] }],
  ])
  const registry: DeliveryRegistry = { sessionTargets: (id) => (entries.has(id) ? ["c1"] : []), supports: () => true, connTenant: () => U, idle: () => false, recency: () => 0 }
  const directory = {
    resolve(userID: string, addr: string): Resolved {
      const address = parseAddress(addr)
      const found = [...entries.values()].filter((e) => address && userID === U && (address.kind === "id" ? e.sessionID === address.id : address.kind === "name" && e.name === address.name))
      if (!address || !found.length) throw new AgentError("not_found", `No session ${addr}`)
      return { address, sessions: found }
    },
  }
  const delivery = new Delivery({ state, counters, registry, directory, send: async () => ({ delivered: "steer" }), now })
  const notified: Array<{ id: string; reason: string }> = []
  const answered: PermissionInput[] = []
  const audits: AuditInput[] = []
  const recommended: Array<[string, BlockerRecommendation]> = []
  const published: string[] = []
  let escalations!: Escalations
  const decisions = new Decisions({
    state,
    delivery,
    now,
    notify: (_userID, decision, reason) => notified.push({ id: decision.id, reason }),
    act: (...args) => escalations.act(...args),
  })
  escalations = new Escalations({
    state,
    counters,
    decisions,
    now,
    registry: {
      recommend: (requestID, recommendation) => {
        recommended.push([requestID, recommendation])
        return true
      },
      sessionTenant: options.tenant ?? (() => U),
    },
    actions: {
      answerPermission: async (input) => {
        answered.push(input)
        if (options.outcome === "unsupported") return { outcome: "unsupported", feature: "permission", harness: "preset" }
        return { outcome: options.outcome ?? "done" }
      },
    },
    audit: { record: async (_userID, input) => void audits.push(input) as never },
    published: (_userID, message) => void published.push(message.id),
    describe: (_userID, actor) => partyFromActor(actor, actor.kind === "session" ? { name: entries.get(actor.sessionID)?.name } : {}),
  })
  return { decisions, escalations, delivery, notified, answered, audits, recommended, published, set: (at: number) => void (t = at) }
}

const escalation = (extra: Partial<Escalation> = {}): Escalation => ({
  userID: U,
  actor: orchestrator,
  verb: "approve",
  target: "ses_w",
  sessionID: "ses_w",
  rootID: "ses_w",
  requestID: "per_1",
  request: { action: "shell", resources: ["bun test", "bun run lint"] },
  always: false,
  evaluation: { verdict: "outside", reason: "shell bun run lint is outside the grant", tier: "tap", grants: ["g_1"] },
  why: "only runs tests in the worktree",
  ...extra,
})

describe("opening", () => {
  test("needs_user opens a Decision: approve/deny (deny safe), the agent's recommendation, the hub's tier, about the asking session", async () => {
    const s = setup()
    const { decisionID } = await s.escalations.escalate(escalation())
    const decision = (await s.decisions.get(U, decisionID!))!
    expect(decision).toMatchObject({
      from: { kind: "session", sessionID: "ses_o" },
      about: ["ses_w"],
      sessionID: "ses_w",
      options: [{ id: "approve", label: "Approve once" }, { id: "deny", label: "Deny", safe: true }],
      recommendation: { option: "approve", why: "only runs tests in the worktree" },
      tier: "tap",
      urgency: "high",
      state: "open",
      action: { kind: "permission", requestID: "per_1", rootID: "ses_w", sessionID: "ses_w", always: false },
    })
    expect(decision.question).toContain("@orchestrator")
    expect(decision.question).toContain("shell: bun test, bun run lint")
    expect(decision.question).toContain("shell bun run lint is outside the grant")
    expect(s.notified).toEqual([{ id: decisionID!, reason: "opened" }])
    expect(s.published).toEqual([decision.messageID])
  })

  test("the recommendation shows on the request's blocker, naming the agent and the Decision", async () => {
    const s = setup()
    const { decisionID } = await s.escalations.escalate(escalation())
    expect(s.recommended).toEqual([["per_1", { by: "@orchestrator", recommends: "approve", why: "only runs tests in the worktree", decisionID: decisionID! }]])
  })

  test("--always: the user may approve always or once (the agent recommends always), or deny", async () => {
    const s = setup()
    const { decisionID } = await s.escalations.escalate(escalation({ always: true, request: { action: "shell", resources: ["bun test"], save: ["bun test *"] } }))
    const decision = (await s.decisions.get(U, decisionID!))!
    expect(decision.options.map((o) => o.id)).toEqual(["always", "approve", "deny"])
    expect(decision.recommendation?.option).toBe("always")
    expect(decision.question).toContain("bun test *")
  })

  test("the tier comes from the evaluation (confirm stays confirm); without details the Decision says so", async () => {
    const s = setup()
    const { decisionID } = await s.escalations.escalate(escalation({ request: undefined, evaluation: { verdict: "outside", reason: "The request's details are unknown", tier: "confirm", grants: [] } }))
    const decision = (await s.decisions.get(U, decisionID!))!
    expect(decision.tier).toBe("confirm")
    expect(decision.question).toContain("details unknown")
  })

  test("an app holder is named as the app", async () => {
    const s = setup()
    const { decisionID } = await s.escalations.escalate(escalation({ actor: app }))
    expect((await s.decisions.get(U, decisionID!))!.from).toMatchObject({ kind: "app", tokenID: "tok_1" })
    expect(s.recommended[0]![1].by).toBe("app assistant-app")
  })
})

describe("one Decision per (holder, request)", () => {
  test("escalating the same request again updates the open Decision (new reason), no new push", async () => {
    const s = setup()
    const first = await s.escalations.escalate(escalation())
    const again = await s.escalations.escalate(escalation({ why: "lint is read-only" }))
    expect(again.decisionID).toBe(first.decisionID)
    expect((await s.decisions.list(U)).length).toBe(1)
    expect((await s.decisions.get(U, first.decisionID!))!.recommendation).toEqual({ option: "approve", why: "lint is read-only" })
    expect(s.notified).toHaveLength(1)
    expect(s.recommended.at(-1)![1].why).toBe("lint is read-only")
  })

  test("concurrent escalations of the same request open one Decision", async () => {
    const s = setup()
    const results = await Promise.allSettled([s.escalations.escalate(escalation()), s.escalations.escalate(escalation())])
    expect((await s.decisions.list(U)).length).toBe(1)
    const ids = results.flatMap((r) => (r.status === "fulfilled" && r.value.decisionID ? [r.value.decisionID] : []))
    expect(new Set(ids).size).toBe(1)
  })

  test("another holder, or another request, gets its own Decision; one no longer open is replaced", async () => {
    const s = setup()
    const a = await s.escalations.escalate(escalation())
    const b = await s.escalations.escalate(escalation({ actor: app }))
    s.set(T0 + ESCALATION_PUSH_COALESCE_MS)
    const c = await s.escalations.escalate(escalation({ requestID: "per_2" }))
    expect(new Set([a.decisionID, b.decisionID, c.decisionID]).size).toBe(3)
    await s.decisions.close(U, a.decisionID!, "gone")
    const d = await s.escalations.escalate(escalation())
    expect(d.decisionID).not.toBe(a.decisionID)
  })
})

describe("answering runs the reply as the user", () => {
  test("approve: the permission is answered once, as the user, audited as the user's; the agent hears the answer", async () => {
    const s = setup()
    const { decisionID } = await s.escalations.escalate(escalation())
    const { decision, reply } = await s.decisions.answer(U, decisionID!, { option: "approve" }, cookieUser)
    expect(decision.state).toBe("answered")
    expect(s.answered).toEqual([{ rootID: "ses_w", requestID: "per_1", decision: "once" }])
    expect(s.audits).toEqual([
      { actor: { kind: "user" }, verb: "approve", target: { sessionID: "ses_w", requestID: "per_1" }, decision: "allow", reason: `Decision ${decisionID}`, outcome: "ok" },
    ])
    expect(reply).toMatchObject({ recipient: { kind: "session", sessionID: "ses_o" } })
  })

  test("always and deny map to the permission decisions always and reject", async () => {
    const s = setup()
    const a = await s.escalations.escalate(escalation({ always: true }))
    await s.decisions.answer(U, a.decisionID!, { option: "always" }, cookieUser)
    const b = await s.escalations.escalate(escalation({ requestID: "per_2" }))
    await s.decisions.answer(U, b.decisionID!, { option: "deny" }, cookieUser)
    expect(s.answered.map((x) => x.decision)).toEqual(["always", "reject"])
    expect(s.audits.map((x) => x.verb)).toEqual(["approve", "deny"])
  })

  test("after answering, a new escalation of the same request opens a new Decision", async () => {
    const s = setup()
    const a = await s.escalations.escalate(escalation())
    await s.decisions.answer(U, a.decisionID!, { option: "deny" }, cookieUser)
    s.set(T0 + ESCALATION_PUSH_COALESCE_MS)
    const b = await s.escalations.escalate(escalation())
    expect(b.decisionID).not.toBe(a.decisionID)
  })

  test("tap: a device token cannot answer it; nothing runs", async () => {
    const s = setup()
    const { decisionID } = await s.escalations.escalate(escalation())
    await expect(s.decisions.answer(U, decisionID!, { option: "approve" }, tokenUser)).rejects.toMatchObject({ code: "forbidden" })
    expect(s.answered).toEqual([])
  })

  test("the request gone already (answered elsewhere): gone, the Decision closes, audited gone", async () => {
    const s = setup({ outcome: "gone" })
    const { decisionID } = await s.escalations.escalate(escalation())
    await expect(s.decisions.answer(U, decisionID!, { option: "approve" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    expect((await s.decisions.get(U, decisionID!))!.state).toBe("closed")
    expect(s.audits.at(-1)).toMatchObject({ verb: "approve", outcome: "gone" })
  })

  test("the request's spoke cannot answer permissions (unsupported): the Decision closes saying so, audited unsupported", async () => {
    const s = setup({ outcome: "unsupported" })
    const { decisionID } = await s.escalations.escalate(escalation())
    await expect(s.decisions.answer(U, decisionID!, { option: "approve" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    const closed = (await s.decisions.get(U, decisionID!))!
    expect(closed.state).toBe("closed")
    expect(closed.closed?.reason).toBe("The preset spoke does not support permission")
    expect(s.audits.at(-1)).toMatchObject({ verb: "approve", outcome: "unsupported" })
  })

  test("the request's tree belongs to another user now: gone, nothing runs", async () => {
    const s = setup({ tenant: () => "u2" })
    const { decisionID } = await s.escalations.escalate(escalation())
    await expect(s.decisions.answer(U, decisionID!, { option: "approve" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    expect(s.answered).toEqual([])
  })
})

describe("closing elsewhere", () => {
  test("the request answered elsewhere closes every Decision escalating it, and only those", async () => {
    const s = setup()
    const a = await s.escalations.escalate(escalation())
    const b = await s.escalations.escalate(escalation({ actor: app }))
    const c = await s.escalations.escalate(escalation({ requestID: "per_2" }))
    await s.escalations.closed(U, "per_1")
    expect((await s.decisions.get(U, a.decisionID!))!.state).toBe("closed")
    expect((await s.decisions.get(U, b.decisionID!))!.state).toBe("closed")
    expect((await s.decisions.get(U, c.decisionID!))!.state).toBe("open")
    await s.escalations.closed(undefined, "per_2")
    await s.escalations.closed("u2", "per_2")
    expect((await s.decisions.get(U, c.decisionID!))!.state).toBe("open")
  })
})

describe("spam limits", () => {
  test("a holder opens at most ESCALATIONS_PER_HOLDER_HOUR Decisions an hour (rate_limited); updates do not count", async () => {
    const s = setup()
    for (let i = 0; i < ESCALATIONS_PER_HOLDER_HOUR; i++) {
      const { decisionID } = await s.escalations.escalate(escalation({ requestID: `per_${i}` }))
      await s.decisions.answer(U, decisionID!, { option: "deny" }, cookieUser)
    }
    await expect(s.escalations.escalate(escalation({ requestID: "per_x" }))).rejects.toMatchObject({ code: "rate_limited" })
    expect((await s.escalations.escalate(escalation({ actor: app, requestID: "per_x" }))).decisionID).toBeDefined()
    s.set(T0 + HOUR)
    expect((await s.escalations.escalate(escalation({ requestID: "per_x" }))).decisionID).toBeDefined()
  })

  test("at most ESCALATIONS_OPEN_MAX open escalations per user (rate_limited); an update still works", async () => {
    const s = setup()
    const holders = Array.from({ length: ESCALATIONS_OPEN_MAX }, (_, i): AgentActor => ({ kind: "app", userID: U, tokenID: `tok_${i}`, scopes: ["sessions:act"], label: `a${i}` }))
    for (const [i, actor] of holders.entries()) await s.escalations.escalate(escalation({ actor, requestID: `per_${i}` }))
    await expect(s.escalations.escalate(escalation({ requestID: "per_more" }))).rejects.toMatchObject({ code: "rate_limited" })
    expect((await s.escalations.escalate(escalation({ actor: holders[0]!, requestID: "per_0", why: "again" }))).decisionID).toBeDefined()
  })

  test("pushes coalesce: Decisions opened within ESCALATION_PUSH_COALESCE_MS of the last push open quietly", async () => {
    const s = setup()
    await s.escalations.escalate(escalation({ requestID: "per_1" }))
    await s.escalations.escalate(escalation({ requestID: "per_2" }))
    s.set(T0 + ESCALATION_PUSH_COALESCE_MS)
    await s.escalations.escalate(escalation({ requestID: "per_3" }))
    expect(s.notified.map((n) => n.reason)).toEqual(["opened", "opened"])
    expect((await s.decisions.list(U, { state: "open" })).length).toBe(3)
  })
})
