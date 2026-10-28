// Decisions and @me (design §12.1, §16 "Events and Decisions"): an ask to @me opens a Decision {question, options
// (safe), recommendation, urgency, tier, deadline, onTimeout}; only the user answers it, the first answer wins,
// later ones get gone; onTimeout picks only a safe option (answeredBy "timeout"), otherwise the Decision stays
// open and escalates once; tap Decisions only from a signed-in console (cookie); the answer goes back to the
// asker as a reply. A real delivery engine over fake spokes, a fake clock and fake timers.
import { describe, expect, test } from "bun:test"
import type { AgentActor, UserActor } from "../src/central/agent/actor"
import { type ActOutcome, DECISION_STATES, DECISION_TICK_MS, Decisions, type Decision } from "../src/central/agent/decisions"
import { Delivery, type DeliveryRegistry } from "../src/central/agent/delivery"
import type { DirectoryEntry, Resolved } from "../src/central/agent/directory"
import { AgentError } from "../src/central/agent/errors"
import { parseAddress } from "../src/central/agent/names"
import { MemoryCounters } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import type { StateStore, Timers } from "../src/central/backend/types"
import type { DeliverRequest } from "../src/protocol"

const T0 = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const U = "u1"

const asSession = (sessionID: string): AgentActor => ({ kind: "session", userID: U, machineID: "m1", sessionID })
const cookieUser: UserActor = { kind: "user", userID: U, deviceID: "d1", via: "cookie" }
const appUser: UserActor = { kind: "user", userID: U, deviceID: "d2", via: "device-token" }

function fakeClock() {
  let t = T0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++seq
      pending.set(id, { at: t + ms, fn })
      return id
    },
    clear: (handle) => void pending.delete(handle as number),
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await Bun.sleep(0)
  }
  return {
    now: () => t,
    timers,
    set: (at: number) => void (t = at),
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...pending].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        t = Math.max(t, due[1].at)
        due[1].fn()
        await settle()
      }
      t = end
      await settle()
    },
  }
}

function setup(options: { state?: StateStore; clock?: ReturnType<typeof fakeClock> } = {}) {
  const clock = options.clock ?? fakeClock()
  const state = options.state ?? new MemoryStateStore({ now: clock.now })
  const entries = new Map<string, DirectoryEntry>([
    ["ses_a", { sessionID: "ses_a", name: "alpha", online: true, roles: [] }],
    ["ses_b", { sessionID: "ses_b", name: "beta", online: true, roles: [] }],
  ])
  const sent: DeliverRequest[] = []
  const registry: DeliveryRegistry = {
    sessionTargets: (sessionID) => (entries.has(sessionID) ? ["c1"] : []),
    supports: () => true,
    connTenant: () => U,
    idle: () => false,
    recency: () => 0,
  }
  const directory = {
    resolve(userID: string, addr: string): Resolved {
      const address = parseAddress(addr)
      const found = [...entries.values()].filter((e) => address && userID === U && (address.kind === "id" ? e.sessionID === address.id : address.kind === "name" && e.name === address.name))
      if (!address || !found.length) throw new AgentError("not_found", `No session ${addr}`)
      return { address, sessions: found }
    },
  }
  let n = 0
  const delivery = new Delivery({
    state,
    counters: new MemoryCounters({ now: clock.now }),
    registry,
    directory,
    send: async (_connID, req) => {
      sent.push(req)
      return { delivered: "steer" }
    },
    now: clock.now,
    timers: clock.timers,
    newID: () => `msg_${String(++n).padStart(4, "0")}`,
  })
  const notified: Array<{ userID: string; id: string; reason: string; sessionID: string }> = []
  const changes: Array<{ userID: string; id: string; state: string; answeredBy?: string; escalated?: true }> = []
  let d = 0
  const make = () =>
    new Decisions({
      state,
      delivery,
      now: clock.now,
      timers: clock.timers,
      newID: () => `dec_${String(++d).padStart(4, "0")}`,
      users: () => [U],
      notify: (userID, decision, reason) => notified.push({ userID, id: decision.id, reason, sessionID: decision.sessionID ?? "" }),
      changed: (userID, decision) =>
        changes.push({
          userID,
          id: decision.id,
          state: decision.state,
          ...(decision.answer ? { answeredBy: decision.answer.answeredBy } : {}),
          ...(decision.escalatedAt !== undefined ? { escalated: true as const } : {}),
        }),
    })
  return { clock, state, delivery, sent, notified, changes, decisions: make(), make }
}

const OPTIONS = [
  { id: "go", label: "Proceed" },
  { id: "hold", label: "Hold", safe: true },
  { id: "rollback", label: "Roll back" },
]

describe("opening a Decision (ask @me)", () => {
  test("a session's ask to @me stores an open ask for the user and a Decision linked to it, and notifies once", async () => {
    const s = setup()
    const { message, decision } = await s.decisions.ask(U, asSession("ses_a"), {
      question: "Migration drops column `legacy_id`. Proceed?",
      options: OPTIONS,
      recommendation: { option: "hold", why: "3 services still read legacy_id" },
      urgency: "high",
      deadlineMs: 2 * HOUR,
      onTimeout: "hold",
    })
    expect(message).toMatchObject({ kind: "ask", to: "@me", recipient: { kind: "user" }, state: "open", text: "Migration drops column `legacy_id`. Proceed?" })
    expect(decision).toEqual({
      id: "dec_0001",
      messageID: message.id,
      from: { kind: "session", sessionID: "ses_a", name: "alpha" },
      about: ["ses_a"],
      sessionID: "ses_a",
      question: "Migration drops column `legacy_id`. Proceed?",
      options: [{ id: "go", label: "Proceed" }, { id: "hold", label: "Hold", safe: true }, { id: "rollback", label: "Roll back" }],
      recommendation: { option: "hold", why: "3 services still read legacy_id" },
      urgency: "high",
      tier: "confirm",
      deadline: T0 + 2 * HOUR,
      onTimeout: "hold",
      state: "open",
      at: T0,
      expiresAt: message.expiresAt!,
    })
    expect(s.sent).toEqual([])
    expect(s.notified).toEqual([{ userID: U, id: "dec_0001", reason: "opened", sessionID: "ses_a" }])
    expect(await s.decisions.get(U, "dec_0001")).toEqual(decision)
    expect((await s.decisions.byMessage(U, message.id))?.id).toBe("dec_0001")
  })

  test("defaults: normal urgency, confirm tier, no deadline, about the asker; a Decision may have no options (free text)", async () => {
    const s = setup()
    const { decision } = await s.decisions.ask(U, asSession("ses_a"), { question: "Which branch?" })
    expect(decision).toMatchObject({ options: [], urgency: "normal", tier: "confirm", about: ["ses_a"], sessionID: "ses_a" })
    expect(decision.deadline).toBeUndefined()
    expect(decision.onTimeout).toBeUndefined()
  })

  test("about: the sessions it concerns (the push opens the first); an app asking needs no session", async () => {
    const s = setup()
    const app: AgentActor = { kind: "app", userID: U, tokenID: "tok_1", scopes: ["messages:send"], label: "assistant-app" }
    const { decision } = await s.decisions.ask(U, app, { question: "Restart @beta?", about: ["ses_b"], tier: "tap" })
    expect(decision).toMatchObject({ from: { kind: "app", tokenID: "tok_1" }, about: ["ses_b"], sessionID: "ses_b", tier: "tap" })
    const none = await s.decisions.ask(U, app, { question: "Anything?" })
    expect(none.decision.about).toEqual([])
    expect(none.decision.sessionID).toBeUndefined()
  })

  test("question, labels and why are sanitised (control, bidi, zero-width characters go)", async () => {
    const s = setup()
    const { decision } = await s.decisions.ask(U, asSession("ses_a"), {
      question: "Ok\u202e?\u0007",
      options: [{ id: "y", label: "Ye\u200bs\u001b[31m" }, { id: "n", label: "No" }],
      recommendation: { option: "y", why: "fine\u2066" },
    })
    expect(decision.question).toBe("Ok?")
    expect(decision.options[0]!.label).toBe("Yes")
    expect(decision.recommendation).toEqual({ option: "y", why: "fine" })
  })

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["duplicate option ids", { options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }],
    ["a malformed option id", { options: [{ id: "A B", label: "A" }] }],
    ["an empty label", { options: [{ id: "a", label: " " }] }],
    ["too many options", { options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })) }],
    ["a recommendation of no option", { options: OPTIONS, recommendation: { option: "nope" } }],
    ["onTimeout to an option not marked safe", { options: OPTIONS, deadlineMs: HOUR, onTimeout: "go" }],
    ["onTimeout to no option", { options: OPTIONS, deadlineMs: HOUR, onTimeout: "nope" }],
    ["onTimeout without a deadline", { options: OPTIONS, onTimeout: "hold" }],
    ["a deadline after the ask expires", { options: OPTIONS, deadlineMs: 3 * HOUR, expiresInMs: 2 * HOUR }],
    ["a deadline in the past", { deadlineMs: 0 }],
    ["an unknown urgency", { urgency: "panic" }],
    ["an unknown tier", { tier: "auto" }],
  ]
  for (const [what, input] of invalid) {
    test(`invalid: ${what}`, async () => {
      const s = setup()
      await expect(s.decisions.ask(U, asSession("ses_a"), { question: "Q?", ...input } as any)).rejects.toMatchObject({ code: "invalid" })
      expect(await s.decisions.list(U)).toEqual([])
      expect((await s.delivery.messages.inbox(U, { kind: "user" })).asks).toEqual([])
    })
  }

  test("the user never opens a Decision for themselves", async () => {
    const s = setup()
    await expect(s.decisions.ask(U, cookieUser, { question: "Q?" })).rejects.toMatchObject({ code: "invalid" })
  })
})

describe("answering", () => {
  const open = async (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
    (await s.decisions.ask(U, asSession("ses_a"), { question: "Proceed?", options: OPTIONS, recommendation: { option: "hold" }, ...extra })).decision

  test("the user's answer closes the Decision and goes back to the asker as a reply to its ask", async () => {
    const s = setup()
    const decision = await open(s)
    s.clock.set(T0 + MIN)
    const { decision: answered, reply } = await s.decisions.answer(U, decision.id, { option: "go", text: "ship it" }, cookieUser)
    expect(answered).toMatchObject({ state: "answered", answer: { option: "go", text: "ship it", answeredBy: "user", deviceID: "d1", at: T0 + MIN } })
    expect(reply).toMatchObject({ kind: "reply", from: { kind: "user" }, recipient: { kind: "session", sessionID: "ses_a" }, replyTo: decision.messageID })
    expect(reply!.text).toBe(`Decision ${decision.id}: Proceed [go]\nship it`)
    expect((await s.delivery.messages.get(U, decision.messageID))?.state).toBe("answered")
    expect(s.sent.at(-1)).toMatchObject({ sessionID: "ses_a", meta: { kind: "reply", from: "@me", replyTo: decision.messageID } })
  })

  test("the first answer wins: a later one (or one racing it) is gone", async () => {
    const s = setup()
    const decision = await open(s)
    const results = await Promise.allSettled([
      s.decisions.answer(U, decision.id, { option: "go" }, cookieUser),
      s.decisions.answer(U, decision.id, { option: "rollback" }, appUser),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: "gone" })
    await expect(s.decisions.answer(U, decision.id, { option: "hold" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    const replies = (await s.delivery.messages.list(U, { kind: "user" })).filter((m) => m.kind === "reply")
    expect(replies).toHaveLength(1)
  })

  test("tap Decisions are answered only from a signed-in console (cookie), never with a device token", async () => {
    const s = setup()
    const decision = await open(s, { tier: "tap" })
    await expect(s.decisions.answer(U, decision.id, { option: "go" }, appUser)).rejects.toMatchObject({ code: "forbidden" })
    expect((await s.decisions.get(U, decision.id))?.state).toBe("open")
    expect((await s.decisions.answer(U, decision.id, { option: "go" }, cookieUser)).decision.state).toBe("answered")
  })

  test("an option the Decision does not offer is invalid; a free-text Decision needs text", async () => {
    const s = setup()
    const decision = await open(s)
    await expect(s.decisions.answer(U, decision.id, { option: "nope" }, cookieUser)).rejects.toMatchObject({ code: "invalid" })
    await expect(s.decisions.answer(U, decision.id, { text: "hmm" }, cookieUser)).rejects.toMatchObject({ code: "invalid" })
    const free = (await s.decisions.ask(U, asSession("ses_a"), { question: "Which branch?" })).decision
    await expect(s.decisions.answer(U, free.id, {}, cookieUser)).rejects.toMatchObject({ code: "invalid" })
    const { reply } = await s.decisions.answer(U, free.id, { text: "main" }, cookieUser)
    expect(reply!.text).toBe(`Decision ${free.id}: main`)
  })

  test("unknown and other users' Decisions are not_found", async () => {
    const s = setup()
    const decision = await open(s)
    await expect(s.decisions.answer(U, "dec_nope", { option: "go" }, cookieUser)).rejects.toMatchObject({ code: "not_found" })
    await expect(s.decisions.answer("u2", decision.id, { option: "go" }, { ...cookieUser, userID: "u2" })).rejects.toMatchObject({ code: "not_found" })
    expect(await s.decisions.get("u2", decision.id)).toBeUndefined()
  })

  test("a Decision whose ask expired reads expired and is gone", async () => {
    const s = setup()
    const decision = await open(s, { expiresInMs: HOUR })
    s.clock.set(T0 + HOUR)
    expect((await s.decisions.get(U, decision.id))?.state).toBe("expired")
    await expect(s.decisions.answer(U, decision.id, { option: "go" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
  })
})

describe("deadlines", () => {
  test("onTimeout picks the safe option at the deadline (answeredBy timeout) and tells the asker", async () => {
    const s = setup()
    const { decision } = await s.decisions.ask(U, asSession("ses_a"), { question: "Proceed?", options: OPTIONS, deadlineMs: 2 * HOUR, onTimeout: "hold" })
    s.decisions.start()
    await s.clock.advance(2 * HOUR - DECISION_TICK_MS)
    expect((await s.decisions.get(U, decision.id))?.state).toBe("open")
    await s.clock.advance(DECISION_TICK_MS)
    const after = (await s.decisions.get(U, decision.id))!
    expect(after).toMatchObject({ state: "answered", answer: { option: "hold", answeredBy: "timeout" } })
    const reply = (await s.delivery.messages.list(U, { kind: "user" })).find((m) => m.kind === "reply")!
    expect(reply.text).toBe(`Decision ${decision.id}: no answer by the deadline; took the safe option Hold [hold]`)
    await expect(s.decisions.answer(U, decision.id, { option: "go" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    s.decisions.stop()
  })

  test("without onTimeout the Decision stays open past its deadline and escalates once (notified again)", async () => {
    const s = setup()
    const { decision } = await s.decisions.ask(U, asSession("ses_a"), { question: "Proceed?", options: OPTIONS, deadlineMs: HOUR })
    await s.clock.advance(HOUR)
    await s.decisions.tick()
    await s.clock.advance(HOUR)
    await s.decisions.tick()
    const after = (await s.decisions.get(U, decision.id))!
    expect(after).toMatchObject({ state: "open", escalatedAt: T0 + HOUR })
    expect(s.notified.map((x) => x.reason)).toEqual(["opened", "escalated"])
    expect((await s.decisions.answer(U, decision.id, { option: "go" }, cookieUser)).decision.state).toBe("answered")
  })

  test("deadlines survive a restart: a new instance over the same state times out the Decision", async () => {
    const s = setup()
    const { decision } = await s.decisions.ask(U, asSession("ses_a"), { question: "Proceed?", options: OPTIONS, deadlineMs: HOUR, onTimeout: "hold" })
    const restarted = s.make()
    s.clock.set(T0 + HOUR)
    await restarted.tick()
    expect((await restarted.get(U, decision.id))?.answer?.answeredBy).toBe("timeout")
  })
})

describe("changes (the console's live 'decision' events)", () => {
  test("changed fires on open, on the user's answer, on a timeout answer, on escalation and on expiry", async () => {
    const s = setup()
    const a = (await s.decisions.ask(U, asSession("ses_a"), { question: "A?", options: OPTIONS })).decision
    const b = (await s.decisions.ask(U, asSession("ses_a"), { question: "B?", options: OPTIONS, deadlineMs: HOUR, onTimeout: "hold" })).decision
    const c = (await s.decisions.ask(U, asSession("ses_a"), { question: "C?", options: OPTIONS, deadlineMs: HOUR })).decision
    const e = (await s.decisions.ask(U, asSession("ses_a"), { question: "E?", expiresInMs: 2 * HOUR })).decision
    expect(s.changes).toEqual([a, b, c, e].map((x) => ({ userID: U, id: x.id, state: "open" })))
    s.changes.length = 0
    await s.decisions.answer(U, a.id, { option: "go" }, cookieUser)
    expect(s.changes).toEqual([{ userID: U, id: a.id, state: "answered", answeredBy: "user" }])
    s.changes.length = 0
    s.clock.set(T0 + HOUR)
    await s.decisions.tick()
    expect(s.changes).toEqual([
      { userID: U, id: b.id, state: "answered", answeredBy: "timeout" },
      { userID: U, id: c.id, state: "open", escalated: true },
    ])
    s.changes.length = 0
    s.clock.set(T0 + 2 * HOUR)
    await s.decisions.tick()
    expect(s.changes).toEqual([{ userID: U, id: e.id, state: "expired" }])
    s.changes.length = 0
    await s.decisions.tick()
    expect(s.changes).toEqual([])
  })

  test("a failing changed listener does not fail the ask or the answer", async () => {
    const s = setup()
    const decisions = new Decisions({
      state: s.state,
      delivery: s.delivery,
      now: s.clock.now,
      timers: s.clock.timers,
      changed: () => {
        throw new Error("listener broke")
      },
    })
    const { decision } = await decisions.ask(U, asSession("ses_a"), { question: "Ok?", options: OPTIONS })
    expect((await decisions.answer(U, decision.id, { option: "go" }, cookieUser)).decision.state).toBe("answered")
  })
})

describe("listing", () => {
  test("newest first, by state, and by asker", async () => {
    const s = setup()
    const a = (await s.decisions.ask(U, asSession("ses_a"), { question: "A?" })).decision
    s.clock.set(T0 + 1)
    const b = (await s.decisions.ask(U, asSession("ses_b"), { question: "B?" })).decision
    await s.decisions.answer(U, a.id, { text: "ok" }, cookieUser)
    const ids = (list: Decision[]) => list.map((x) => x.id)
    expect(ids(await s.decisions.list(U))).toEqual([b.id, a.id])
    expect(ids(await s.decisions.list(U, { state: "open" }))).toEqual([b.id])
    expect(ids(await s.decisions.list(U, { from: { kind: "session", sessionID: "ses_a" } }))).toEqual([a.id])
    expect(await s.decisions.list("u2")).toEqual([])
  })
})

describe("closed elsewhere (P3-T8)", () => {
  test("close: an open Decision becomes closed with a reason, the asker hears it, later answers are gone", async () => {
    const s = setup()
    const { decision } = await s.decisions.ask(U, asSession("ses_a"), { question: "Approve?", options: OPTIONS })
    s.changes.length = 0
    s.clock.set(T0 + MIN)
    const closed = await s.decisions.close(U, decision.id, "The request was answered elsewhere")
    expect(closed).toMatchObject({ state: "closed", closed: { at: T0 + MIN, reason: "The request was answered elsewhere" } })
    expect(closed!.answer).toBeUndefined()
    expect(s.changes).toEqual([{ userID: U, id: decision.id, state: "closed" }])
    const reply = (await s.delivery.messages.list(U, { kind: "user" })).find((m) => m.kind === "reply")!
    expect(reply).toMatchObject({ replyTo: decision.messageID, recipient: { kind: "session", sessionID: "ses_a" } })
    expect(reply.text).toBe(`Decision ${decision.id} closed: The request was answered elsewhere`)
    await expect(s.decisions.answer(U, decision.id, { option: "go" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    expect((await s.decisions.list(U, { state: "closed" })).map((d) => d.id)).toEqual([decision.id])
  })

  test("close leaves answered, expired and unknown Decisions alone (undefined, no change)", async () => {
    const s = setup()
    const a = (await s.decisions.ask(U, asSession("ses_a"), { question: "A?", options: OPTIONS })).decision
    await s.decisions.answer(U, a.id, { option: "go" }, cookieUser)
    const e = (await s.decisions.ask(U, asSession("ses_a"), { question: "E?", expiresInMs: HOUR })).decision
    s.clock.set(T0 + HOUR)
    s.changes.length = 0
    expect(await s.decisions.close(U, a.id, "x")).toBeUndefined()
    expect(await s.decisions.close(U, e.id, "x")).toBeUndefined()
    expect(await s.decisions.close(U, "dec_nope", "x")).toBeUndefined()
    expect(await s.decisions.close("u2", a.id, "x")).toBeUndefined()
    expect(s.changes).toEqual([])
    expect((await s.decisions.get(U, a.id))?.state).toBe("answered")
  })

  test("DECISION_STATES lists every state, closed included", () => {
    expect([...DECISION_STATES]).toEqual(["open", "answered", "expired", "closed"])
  })
})

describe("Decisions that act (escalations, P3-T8)", () => {
  const ACTION = { kind: "permission" as const, requestID: "per_1", rootID: "ses_b", sessionID: "ses_b", always: false }
  const APPROVE = [{ id: "approve", label: "Approve once" }, { id: "deny", label: "Deny", safe: true }]
  function acting(outcome: () => Promise<ActOutcome>) {
    const s = setup()
    const calls: Array<{ userID: string; id: string; option?: string; by: string }> = []
    const decisions = new Decisions({
      state: s.state,
      delivery: s.delivery,
      now: s.clock.now,
      timers: s.clock.timers,
      notify: (userID, decision, reason) => s.notified.push({ userID, id: decision.id, reason, sessionID: decision.sessionID ?? "" }),
      changed: (userID, decision) => s.changes.push({ userID, id: decision.id, state: decision.state }),
      act: async (userID, decision, choice, by) => {
        calls.push({ userID, id: decision.id, ...(choice.option ? { option: choice.option } : {}), by: by.deviceID })
        return outcome()
      },
    })
    return { ...s, decisions, calls }
  }
  const openActing = (s: ReturnType<typeof acting>, extra: Record<string, unknown> = {}) =>
    s.decisions.ask(U, asSession("ses_a"), { question: "@alpha asks to approve shell: bun test", options: APPROVE, recommendation: { option: "approve", why: "tests only" }, tier: "tap" }, { action: ACTION, ...extra })

  test("an action is stored on the Decision; the user's answer runs it (as that user), then the asker hears the answer", async () => {
    const s = acting(async () => "done")
    const { decision } = await openActing(s)
    expect(decision.action).toEqual(ACTION)
    const { decision: answered, reply } = await s.decisions.answer(U, decision.id, { option: "approve" }, cookieUser)
    expect(s.calls).toEqual([{ userID: U, id: decision.id, option: "approve", by: "d1" }])
    expect(answered).toMatchObject({ state: "answered", answer: { option: "approve", answeredBy: "user" } })
    expect(reply!.text).toBe(`Decision ${decision.id}: Approve once [approve]`)
  })

  test("the action finds the request gone: the Decision closes (not answered), the answer is gone", async () => {
    const s = acting(async () => "gone")
    const { decision } = await openActing(s)
    await expect(s.decisions.answer(U, decision.id, { option: "deny" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    const after = (await s.decisions.get(U, decision.id))!
    expect(after.state).toBe("closed")
    expect(after.answer).toBeUndefined()
    expect(s.changes.at(-1)).toEqual({ userID: U, id: decision.id, state: "closed" })
    const reply = (await s.delivery.messages.list(U, { kind: "user" })).find((m) => m.kind === "reply")!
    expect(reply.text).toBe(`Decision ${decision.id} closed: The request was answered elsewhere or ended`)
  })

  test("the action may add a note to the asker's reply (a grant request answers the grant id)", async () => {
    const s = acting(async () => ({ outcome: "done", note: "Grant g_0123456789abcdef created" }))
    const { decision } = await openActing(s)
    const { reply } = await s.decisions.answer(U, decision.id, { option: "approve" }, cookieUser)
    expect(reply!.text).toBe(`Decision ${decision.id}: Approve once [approve]\nGrant g_0123456789abcdef created`)
  })

  test("the action's subject gone with its own reason: the Decision closes with that reason", async () => {
    const s = acting(async () => ({ outcome: "gone", reason: "The requesting session is gone" }))
    const { decision } = await openActing(s)
    await expect(s.decisions.answer(U, decision.id, { option: "approve" }, cookieUser)).rejects.toMatchObject({ code: "gone" })
    const after = (await s.decisions.get(U, decision.id))!
    expect(after).toMatchObject({ state: "closed", closed: { reason: "The requesting session is gone" } })
  })

  test("a grant action is stored as given (the hub's, never an asker's)", async () => {
    const s = acting(async () => "done")
    const grant = { kind: "grant" as const, requester: "ses:ses_a", grant: { holder: "ses_a", scope: { projects: ["/p"] }, allow: ["approve"] } }
    const { decision } = await s.decisions.ask(U, asSession("ses_a"), { question: "@alpha requests a grant", options: APPROVE, tier: "tap" }, { action: grant })
    expect(decision.action).toEqual(grant)
  })

  test("the action fails: the Decision stays open (the user may try again) and the error goes through", async () => {
    let fail = true
    const s = acting(async () => {
      if (fail) throw new Error("spoke broke")
      return "done"
    })
    const { decision } = await openActing(s)
    await expect(s.decisions.answer(U, decision.id, { option: "approve" }, cookieUser)).rejects.toThrow("spoke broke")
    expect((await s.decisions.get(U, decision.id))?.state).toBe("open")
    fail = false
    expect((await s.decisions.answer(U, decision.id, { option: "approve" }, cookieUser)).decision.state).toBe("answered")
  })

  test("the action's tier still holds: tap needs the console cookie, and the action never runs without it", async () => {
    const s = acting(async () => "done")
    const { decision } = await openActing(s)
    await expect(s.decisions.answer(U, decision.id, { option: "approve" }, appUser)).rejects.toMatchObject({ code: "forbidden" })
    expect(s.calls).toEqual([])
  })

  test("quiet: opened without a notification (coalesced pushes); still a live change", async () => {
    const s = acting(async () => "done")
    const { decision } = await openActing(s, { quiet: true })
    expect(s.notified).toEqual([])
    expect(s.changes).toEqual([{ userID: U, id: decision.id, state: "open" }])
  })

  test("revise: an open Decision's recommendation is replaced (sanitised, must name an option); closed ones stay", async () => {
    const s = acting(async () => "done")
    const { decision } = await openActing(s)
    s.changes.length = 0
    const revised = await s.decisions.revise(U, decision.id, { recommendation: { option: "approve", why: "now\u202e with lint" } })
    expect(revised?.recommendation).toEqual({ option: "approve", why: "now with lint" })
    expect(s.changes).toEqual([{ userID: U, id: decision.id, state: "open" }])
    await expect(s.decisions.revise(U, decision.id, { recommendation: { option: "nope" } })).rejects.toMatchObject({ code: "invalid" })
    await s.decisions.answer(U, decision.id, { option: "deny" }, cookieUser)
    expect(await s.decisions.revise(U, decision.id, { recommendation: { option: "approve" } })).toBeUndefined()
  })
})
