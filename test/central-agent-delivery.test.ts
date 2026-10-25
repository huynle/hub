// The delivery engine (design §3.3, §3.4; decisions jswt9p22, 52aqsopo): owner selection gated on the spoke's
// "deliver" feature, delivery modes, role holders and generations, the pending queue (offline recipients, 24 h,
// flushed in order on a sessions frame), hop cap and wake budget, human-turn resets, and the re-wake loop for
// open asks to idle recipients, with fake spokes, a fake directory, a fake clock and fake timers.
import { describe, expect, test } from "bun:test"
import type { AgentActor } from "../src/central/agent/actor"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Delivery, REWAKE_BACKOFF_MS, REWAKE_TICK_MS, type DeliveryAlert, type DeliveryRegistry } from "../src/central/agent/delivery"
import type { DirectoryEntry, Resolved } from "../src/central/agent/directory"
import { AgentError } from "../src/central/agent/errors"
import { HOP_CAP, type MessageLimits } from "../src/central/agent/message-limits"
import { parseAddress } from "../src/central/agent/names"
import { MemoryCounters } from "../src/central/backend/memory-counters"
import { FileStateStore } from "../src/central/backend/file-state"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import type { StateStore, Timers } from "../src/central/backend/types"
import type { DeliverRequest, DeliverResult } from "../src/protocol"

const T0 = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const U = "u1"

const asSession = (sessionID: string): AgentActor => ({ kind: "session", userID: U, machineID: "m1", sessionID })
const asUser: AgentActor = { kind: "user", userID: U, deviceID: "d1", via: "cookie" }

/** Timers that fire when the test advances the clock. */
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
  return {
    now: () => t,
    timers,
    pending: () => pending.size,
    /** Moves the clock; runs due timers (in order) and lets their async work settle. */
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

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await Bun.sleep(0)
}

interface FakeConn {
  deliver: boolean
  tenant: string
  sessions: Set<string>
  /** How this spoke answers a deliver request (default: steer when busy, turn when woken, else queued). */
  answer?: (req: DeliverRequest) => DeliverResult | Promise<DeliverResult>
}

/** A fake registry and directory: sessions, the spokes reporting them, roles and idle state. */
function world() {
  const conns = new Map<string, FakeConn>()
  const entries = new Map<string, DirectoryEntry>()
  const idle = new Set<string>()
  const recency = new Map<string, number>()
  const sent: Array<{ connID: string; req: DeliverRequest }> = []
  const registry: DeliveryRegistry = {
    sessionTargets: (sessionID) => [...conns].filter(([, c]) => c.sessions.has(sessionID)).map(([id]) => id),
    supports: (connID, feature) => feature === "deliver" && conns.get(connID)?.deliver === true,
    connTenant: (connID) => conns.get(connID)?.tenant,
    idle: (sessionID) => idle.has(sessionID),
    recency: (sessionID) => recency.get(sessionID) ?? 0,
  }
  const online = (sessionID: string) => [...conns.values()].some((c) => c.sessions.has(sessionID))
  const entry = (sessionID: string): DirectoryEntry => ({ ...entries.get(sessionID)!, online: online(sessionID) })
  const directory = {
    resolve(userID: string, addr: string): Resolved {
      const address = parseAddress(addr)
      if (!address || userID !== U) throw new AgentError("not_found", `No session ${addr}`)
      const all = [...entries.values()]
      const found =
        address.kind === "id"
          ? all.filter((e) => e.sessionID === address.id)
          : address.kind === "name"
            ? all.filter((e) => e.name === address.name)
            : all.filter((e) => e.roles.some((r) => r.role === address.role))
      if (!found.length) throw new AgentError("not_found", `No session ${addr}`)
      return { address, sessions: found.map((e) => entry(e.sessionID)) }
    },
  }
  const send = async (connID: string, req: DeliverRequest): Promise<DeliverResult> => {
    sent.push({ connID, req })
    const conn = conns.get(connID)
    if (!conn) throw new Error("gone")
    if (conn.answer) return conn.answer(req)
    return { delivered: req.wake ? "turn" : "queued" }
  }
  return {
    conns,
    entries,
    idle,
    recency,
    sent,
    registry,
    directory,
    send,
    addSession(sessionID: string, extra: Partial<DirectoryEntry> = {}) {
      entries.set(sessionID, { sessionID, online: false, roles: [], ...extra })
    },
    connect(connID: string, sessions: string[], options: Partial<FakeConn> = {}) {
      conns.set(connID, { deliver: true, tenant: U, sessions: new Set(sessions), ...options })
    },
  }
}

function setup(options: { state?: StateStore; clock?: ReturnType<typeof fakeClock>; limits?: Partial<MessageLimits> } = {}) {
  const clock = options.clock ?? fakeClock()
  const w = world()
  const state = options.state ?? new MemoryStateStore({ now: clock.now })
  const alerts: Array<{ userID: string; alert: DeliveryAlert }> = []
  let n = 0
  const make = (store: StateStore = state) =>
    new Delivery({
      state: store,
      counters: new MemoryCounters({ now: clock.now }),
      registry: w.registry,
      directory: w.directory,
      send: w.send,
      now: clock.now,
      timers: clock.timers,
      newID: () => `msg_${String(++n).padStart(4, "0")}`,
      alert: (userID, alert) => alerts.push({ userID, alert }),
      ...(options.limits ? { limits: options.limits } : {}),
    })
  w.addSession("ses_a", { name: "alpha" })
  w.addSession("ses_b", { name: "beta" })
  return { ...w, clock, state, alerts, delivery: make(), make }
}

describe("send to a session", () => {
  test("delivers through the owner with the hub-rendered envelope and records the result", async () => {
    const s = setup()
    s.connect("c1", ["ses_a", "ses_b"])
    const sent = await s.delivery.send(U, asSession("ses_a"), "@beta", "msg", "hello there")
    expect(sent.delivery).toBe("turn")
    expect(sent.message).toMatchObject({ kind: "msg", to: "@beta", recipient: { kind: "session", sessionID: "ses_b" }, delivery: "turn", deliveredAt: T0 })
    expect(s.sent).toHaveLength(1)
    const { connID, req } = s.sent[0]!
    expect(connID).toBe("c1")
    expect(req).toMatchObject({ op: "deliver", sessionID: "ses_b", messageID: sent.message.id, wake: true, meta: { kind: "msg", from: "@alpha", to: "@beta", delivery: "queue" } })
    expect(req.text).toContain(`[hub] msg from @alpha to you`)
    expect(req.text).toContain("hello there")
    expect((await s.delivery.messages.get(U, sent.message.id))?.delivery).toBe("turn")
  })
})

describe("delivery modes", () => {
  test("asks and urgent messages steer, plain messages queue behind a running turn", async () => {
    const s = setup()
    s.connect("c1", ["ses_a", "ses_b"])
    await s.delivery.send(U, asSession("ses_a"), "@beta", "ask", "question?")
    await s.delivery.send(U, asSession("ses_a"), "@beta", "msg", "now!", { urgent: true })
    await s.delivery.send(U, asSession("ses_a"), "@beta", "msg", "fyi")
    expect(s.sent.map((x) => x.req.meta.delivery)).toEqual(["steer", "steer", "queue"])
    expect(s.sent[0]!.req.meta.kind).toBe("ask")
  })

  test("wake:false admits without waking and reports queued", async () => {
    const s = setup()
    s.connect("c1", ["ses_b"])
    const sent = await s.delivery.send(U, asUser, "@beta", "msg", "later", { wake: false })
    expect(s.sent[0]!.req.wake).toBe(false)
    expect(s.sent[0]!.req.meta.from).toBe("@me")
    expect(sent.delivery).toBe("queued")
  })

  test("messages to a subagent session are admitted without waking", async () => {
    const s = setup()
    s.addSession("ses_child", { name: "child", parentID: "ses_b" })
    s.connect("c1", ["ses_child"])
    await s.delivery.send(U, asUser, "@child", "msg", "hi")
    expect(s.sent[0]!.req.wake).toBe(false)
  })
})

describe("owner selection", () => {
  test("skips connections without the deliver feature", async () => {
    const s = setup()
    s.connect("old", ["ses_b"], { deliver: false })
    s.connect("new", ["ses_b"])
    await s.delivery.send(U, asUser, "@beta", "msg", "hi")
    expect(s.sent.map((x) => x.connID)).toEqual(["new"])
  })

  test("only spokes without deliver report the session: unsupported {feature: deliver}, nothing stored", async () => {
    const s = setup()
    s.connect("old", ["ses_b"], { deliver: false })
    const error = await s.delivery.send(U, asUser, "@beta", "msg", "hi").catch((cause) => cause)
    expect(error).toBeInstanceOf(AgentError)
    expect(error.code).toBe("unsupported")
    expect(error.options.extra).toEqual({ feature: "deliver" })
    expect(s.sent).toHaveLength(0)
    expect(await s.delivery.messages.list(U, { kind: "user" })).toHaveLength(0)
  })

  test("a failing connection falls back to the next one with the same message id", async () => {
    const s = setup()
    s.connect("c1", ["ses_b"], { answer: () => Promise.reject(new Error("timeout")) })
    s.connect("c2", ["ses_b"])
    const sent = await s.delivery.send(U, asUser, "@beta", "msg", "hi")
    expect(s.sent.map((x) => x.connID)).toEqual(["c1", "c2"])
    expect(s.sent[0]!.req.messageID).toBe(s.sent[1]!.req.messageID)
    expect(sent.delivery).toBe("turn")
  })

  test("a malformed spoke answer counts as a failure", async () => {
    const s = setup()
    s.connect("c1", ["ses_b"], { answer: () => ({ delivered: "nope" }) as unknown as DeliverResult })
    const sent = await s.delivery.send(U, asUser, "@beta", "msg", "hi")
    expect(sent.delivery).toBe("pending")
  })
})

describe("pending queue", () => {
  test("an offline recipient gets the message on reconnect, in order", async () => {
    const s = setup()
    const first = await s.delivery.send(U, asUser, "@beta", "msg", "one")
    s.clock.advance(1000)
    const second = await s.delivery.send(U, asUser, "@beta", "ask", "two")
    expect(first.delivery).toBe("pending")
    expect(second.message.delivery).toBe("pending")
    expect(s.sent).toHaveLength(0)
    s.connect("c1", ["ses_b"])
    await s.delivery.onSessions("c1")
    expect(s.sent.map((x) => x.req.messageID)).toEqual([first.message.id, second.message.id])
    expect((await s.delivery.messages.get(U, first.message.id))?.delivery).toBe("turn")
    // Delivered once: another sessions frame sends nothing.
    await s.delivery.onSessions("c1")
    expect(s.sent).toHaveLength(2)
  })

  test("a spoke that fails during the flush keeps the message pending for the next frame", async () => {
    const s = setup()
    const sent = await s.delivery.send(U, asUser, "@beta", "msg", "one")
    let fail = true
    s.connect("c1", ["ses_b"], { answer: () => (fail ? Promise.reject(new Error("timeout")) : { delivered: "turn" }) })
    await s.delivery.onSessions("c1")
    expect((await s.delivery.messages.get(U, sent.message.id))?.delivery).toBe("pending")
    fail = false
    await s.delivery.onSessions("c1")
    expect((await s.delivery.messages.get(U, sent.message.id))?.delivery).toBe("turn")
    expect(s.sent).toHaveLength(2)
  })

  test("pending messages expire after 24 hours", async () => {
    const s = setup()
    await s.delivery.send(U, asUser, "@beta", "msg", "old")
    await s.clock.advance(24 * HOUR)
    s.connect("c1", ["ses_b"])
    await s.delivery.onSessions("c1")
    expect(s.sent).toHaveLength(0)
  })

  test("a pending ask that expired before its recipient came back is dropped", async () => {
    const s = setup()
    await s.delivery.send(U, asUser, "@beta", "ask", "quick?", { expiresInMs: 10 * MIN })
    await s.clock.advance(11 * MIN)
    s.connect("c1", ["ses_b"])
    await s.delivery.onSessions("c1")
    expect(s.sent).toHaveLength(0)
  })

  test("a flush delivers only the connection's tenant's messages, for sessions it reports", async () => {
    const s = setup()
    await s.delivery.send(U, asUser, "@beta", "msg", "for b")
    await s.delivery.send(U, asUser, "@alpha", "msg", "for a")
    s.connect("c1", ["ses_b"])
    s.connect("other", ["ses_a"], { tenant: "u2" })
    await s.delivery.onSessions("other")
    expect(s.sent).toHaveLength(0)
    await s.delivery.onSessions("c1")
    expect(s.sent.map((x) => x.req.sessionID)).toEqual(["ses_b"])
  })

  test("a reconnecting spoke without deliver leaves the message pending", async () => {
    const s = setup()
    const sent = await s.delivery.send(U, asUser, "@beta", "msg", "one")
    s.connect("old", ["ses_b"], { deliver: false })
    await s.delivery.onSessions("old")
    expect(s.sent).toHaveLength(0)
    s.connect("c1", ["ses_b"])
    await s.delivery.onSessions("c1")
    expect((await s.delivery.messages.get(U, sent.message.id))?.delivery).toBe("turn")
  })
})

describe("roles", () => {
  const role = (generation: number) => ({ roles: [{ role: "reviewer", generation }] })

  test("a role goes to an idle holder and records its generation", async () => {
    const s = setup()
    s.addSession("ses_c", role(1))
    s.addSession("ses_d", role(2))
    s.connect("c1", ["ses_c", "ses_d"])
    s.idle.add("ses_c")
    s.recency.set("ses_d", 9)
    const sent = await s.delivery.send(U, asUser, "@@reviewer", "ask", "review?")
    expect(s.sent[0]!.req.sessionID).toBe("ses_c")
    expect(sent.message).toMatchObject({ to: "@@reviewer", recipient: { sessionID: "ses_c" }, generation: 1 })
    expect(s.sent[0]!.req.text).toContain("to @@reviewer → you")
  })

  test("with no idle holder, the most recently active one", async () => {
    const s = setup()
    s.addSession("ses_c", role(1))
    s.addSession("ses_d", role(2))
    s.connect("c1", ["ses_c", "ses_d"])
    s.recency.set("ses_c", 3)
    s.recency.set("ses_d", 9)
    const sent = await s.delivery.send(U, asUser, "@@reviewer", "msg", "hi")
    expect(sent.message).toMatchObject({ recipient: { sessionID: "ses_d" }, generation: 2 })
  })

  test("with every holder offline, pending for the one seen last", async () => {
    const s = setup()
    s.addSession("ses_c", { ...role(1), lastSeen: T0 - 5 * MIN })
    s.addSession("ses_d", { ...role(2), lastSeen: T0 - MIN })
    const sent = await s.delivery.send(U, asUser, "@@reviewer", "msg", "hi")
    expect(sent).toMatchObject({ delivery: "pending", message: { recipient: { sessionID: "ses_d" }, generation: 2 } })
  })

  test("sendAll reaches every holder, each with its own message", async () => {
    const s = setup()
    s.addSession("ses_c", role(1))
    s.addSession("ses_d", role(2))
    s.connect("c1", ["ses_c", "ses_d"])
    const sent = await s.delivery.sendAll(U, asUser, "@@reviewer", "msg", "everyone")
    expect(sent.map((x) => [x.message.recipient.kind === "session" && x.message.recipient.sessionID, x.message.generation])).toEqual([
      ["ses_c", 1],
      ["ses_d", 2],
    ])
    expect(new Set(s.sent.map((x) => x.req.messageID)).size).toBe(2)
  })
})

describe("loop protection", () => {
  test("hops grow along a chain; over the cap the message is admitted without waking and the user is alerted", async () => {
    const s = setup()
    s.connect("c1", ["ses_a", "ses_b"])
    let hop = 0
    for (let i = 0; i < HOP_CAP; i++) {
      const sent = await s.delivery.send(U, asSession(i % 2 ? "ses_b" : "ses_a"), i % 2 ? "@alpha" : "@beta", "msg", `hop ${i}`)
      hop = sent.message.hop
      expect(s.sent.at(-1)!.req.wake).toBe(true)
    }
    expect(hop).toBe(HOP_CAP)
    const over = await s.delivery.send(U, asSession("ses_a"), "@beta", "msg", "one too many")
    expect(over.message.hop).toBe(HOP_CAP + 1)
    expect(s.sent.at(-1)!.req.wake).toBe(false)
    expect(s.alerts).toEqual([{ userID: U, alert: { kind: "hopCap", sessionID: "ses_b", messageID: over.message.id, text: expect.any(String) } }])
  })

  test("a human turn in the sender's session starts the chain over", async () => {
    const s = setup()
    s.connect("c1", ["ses_a", "ses_b"])
    await s.delivery.send(U, asSession("ses_a"), "@beta", "msg", "1")
    const second = await s.delivery.send(U, asSession("ses_b"), "@alpha", "msg", "2")
    expect(second.message.hop).toBe(2)
    await s.delivery.humanTurn(U, "ses_b")
    const third = await s.delivery.send(U, asSession("ses_b"), "@alpha", "msg", "3")
    expect(third.message.hop).toBe(1)
  })

  test("the user's messages are hop 0", async () => {
    const s = setup()
    s.connect("c1", ["ses_b"])
    expect((await s.delivery.send(U, asUser, "@beta", "msg", "hi")).message.hop).toBe(0)
  })

  test("the pair limit refuses with rate_limited before anything is stored or sent", async () => {
    const s = setup({ limits: { pair: 2 } })
    s.connect("c1", ["ses_b"])
    await s.delivery.send(U, asUser, "@beta", "msg", "1")
    await s.delivery.send(U, asUser, "@beta", "msg", "2")
    const error = await s.delivery.send(U, asUser, "@beta", "msg", "3").catch((cause) => cause)
    expect(error).toMatchObject({ code: "rate_limited" })
    expect(s.sent).toHaveLength(2)
    expect(await s.delivery.messages.list(U, { kind: "user" })).toHaveLength(2)
  })

  test("a spent wake budget delivers without waking", async () => {
    const s = setup({ limits: { wake: 1 } })
    s.connect("c1", ["ses_b"])
    await s.delivery.send(U, asUser, "@beta", "msg", "1")
    await s.delivery.send(U, asUser, "@beta", "msg", "2")
    expect(s.sent.map((x) => x.req.wake)).toEqual([true, false])
  })

  test("wake:false does not use the wake budget", async () => {
    const s = setup({ limits: { wake: 1 } })
    s.connect("c1", ["ses_b"])
    await s.delivery.send(U, asUser, "@beta", "msg", "1", { wake: false })
    await s.delivery.send(U, asUser, "@beta", "msg", "2")
    expect(s.sent.map((x) => x.req.wake)).toEqual([false, true])
  })

  test("a muted sender is refused (forbidden)", async () => {
    const s = setup()
    s.connect("c1", ["ses_b"])
    await s.delivery.messages.mute(U, { kind: "session", sessionID: "ses_b" }, "ses_a")
    expect(await s.delivery.send(U, asSession("ses_a"), "@beta", "msg", "hi").catch((cause) => cause)).toMatchObject({ code: "forbidden" })
    expect(s.sent).toHaveLength(0)
  })
})

describe("replies and declines", () => {
  test("a reply goes to the real sender session, steered, with replyTo", async () => {
    const s = setup()
    s.connect("c1", ["ses_a", "ses_b"])
    const ask = await s.delivery.send(U, asSession("ses_a"), "@beta", "ask", "q?")
    const reply = await s.delivery.reply(U, asSession("ses_b"), ask.message.id, "a!")
    expect(reply.original.state).toBe("answered")
    expect(reply.delivery).toBe("turn")
    expect(s.sent.at(-1)!.req).toMatchObject({ sessionID: "ses_a", meta: { kind: "reply", from: "@beta", to: "@alpha", replyTo: ask.message.id, delivery: "steer" } })
    expect(reply.message.hop).toBe(2)
  })

  test("a decline is delivered too", async () => {
    const s = setup()
    s.connect("c1", ["ses_a", "ses_b"])
    const ask = await s.delivery.send(U, asSession("ses_a"), "@beta", "ask", "q?")
    const declined = await s.delivery.decline(U, asSession("ses_b"), ask.message.id, "busy")
    expect(declined.original.state).toBe("declined")
    expect(s.sent.at(-1)!.req).toMatchObject({ sessionID: "ses_a", meta: { kind: "decline", replyTo: ask.message.id } })
  })

  test("a reply to the user or an app is stored only", async () => {
    const s = setup()
    s.connect("c1", ["ses_b"])
    const ask = await s.delivery.send(U, asUser, "@beta", "ask", "q?")
    const reply = await s.delivery.reply(U, asSession("ses_b"), ask.message.id, "a!")
    expect(reply.delivery).toBeUndefined()
    expect(s.sent).toHaveLength(1)
    expect((await s.delivery.messages.inbox(U, { kind: "user" })).messages.map((m) => m.id)).toEqual([reply.message.id])
  })

  test("a reply to an offline sender waits as pending", async () => {
    const s = setup()
    s.connect("c1", ["ses_a", "ses_b"])
    const ask = await s.delivery.send(U, asSession("ses_a"), "@beta", "ask", "q?")
    s.conns.get("c1")!.sessions.delete("ses_a")
    const reply = await s.delivery.reply(U, asSession("ses_b"), ask.message.id, "a!")
    expect(reply.delivery).toBe("pending")
  })
})

describe("re-wake of open asks", () => {
  const [first, second, third] = REWAKE_BACKOFF_MS as [number, number, number]

  /** An ask from @alpha to an idle @beta, delivered, with the loop running. */
  async function asked(options: Parameters<typeof setup>[0] = {}) {
    const s = setup(options)
    s.connect("c1", ["ses_a", "ses_b"])
    s.idle.add("ses_b")
    const ask = await s.delivery.send(U, asSession("ses_a"), "@beta", "ask", "q?")
    s.delivery.start()
    const reminders = () => s.sent.filter((x) => x.req.messageID !== ask.message.id)
    return { ...s, ask, reminders }
  }

  test("an idle recipient is woken again with backoff, then the user is told", async () => {
    const s = await asked()
    await s.clock.advance(first - REWAKE_TICK_MS)
    expect(s.reminders()).toHaveLength(0)
    await s.clock.advance(REWAKE_TICK_MS)
    expect(s.reminders()).toHaveLength(1)
    const { req } = s.reminders()[0]!
    expect(req).toMatchObject({ sessionID: "ses_b", wake: true, meta: { kind: "ask", from: "@alpha", to: "@beta", delivery: "steer" } })
    expect(req.messageID).not.toBe(s.ask.message.id)
    expect(req.text).toContain(s.ask.message.id)
    expect(req.text).toContain("still open")
    await s.clock.advance(second)
    expect(s.reminders()).toHaveLength(2)
    await s.clock.advance(third)
    expect(s.reminders()).toHaveLength(3)
    expect(s.alerts).toHaveLength(0)
    await s.clock.advance(third)
    expect(s.reminders()).toHaveLength(3)
    expect(s.alerts).toEqual([{ userID: U, alert: { kind: "unanswered", sessionID: "ses_b", messageID: s.ask.message.id, text: expect.stringContaining("@beta") } }])
    await s.clock.advance(10 * HOUR)
    expect(s.reminders()).toHaveLength(3)
    expect(s.alerts).toHaveLength(1)
  })

  test("an answered ask is not re-woken", async () => {
    const s = await asked()
    await s.delivery.reply(U, asSession("ses_b"), s.ask.message.id, "done")
    const before = s.sent.length
    await s.clock.advance(HOUR)
    expect(s.sent).toHaveLength(before)
  })

  test("a busy recipient is left alone; the backoff starts over once it is idle", async () => {
    const s = await asked()
    s.idle.delete("ses_b")
    await s.clock.advance(first + 5 * MIN)
    expect(s.reminders()).toHaveLength(0)
    s.idle.add("ses_b")
    // The last busy check was at first + 5 min: the wait runs from there.
    await s.clock.advance(first - REWAKE_TICK_MS)
    expect(s.reminders()).toHaveLength(0)
    await s.clock.advance(REWAKE_TICK_MS)
    expect(s.reminders()).toHaveLength(1)
  })

  test("only asks are re-woken, not plain messages", async () => {
    const s = setup()
    s.connect("c1", ["ses_b"])
    s.idle.add("ses_b")
    await s.delivery.send(U, asUser, "@beta", "msg", "fyi")
    s.delivery.start()
    await s.clock.advance(HOUR)
    expect(s.sent).toHaveLength(1)
  })

  test("asks sent with wake:false are not re-woken", async () => {
    const s = setup()
    s.connect("c1", ["ses_b"])
    s.idle.add("ses_b")
    await s.delivery.send(U, asUser, "@beta", "ask", "whenever", { wake: false })
    s.delivery.start()
    await s.clock.advance(HOUR)
    expect(s.sent).toHaveLength(1)
  })

  test("a pending ask is not re-woken while its recipient is offline", async () => {
    const s = setup()
    s.idle.add("ses_b")
    await s.delivery.send(U, asUser, "@beta", "ask", "q?")
    s.delivery.start()
    await s.clock.advance(HOUR)
    expect(s.sent).toHaveLength(0)
    expect(s.alerts).toHaveLength(0)
  })

  test("a spent wake budget postpones the reminder", async () => {
    const s = await asked({ limits: { wake: 1 } })
    await s.clock.advance(first)
    expect(s.reminders()).toHaveLength(0)
    // The window (10 min) rolls over: the budget is back.
    await s.clock.advance(10 * MIN)
    expect(s.reminders()).toHaveLength(1)
  })

  test("stop() ends the loop", async () => {
    const s = await asked()
    s.delivery.stop()
    expect(s.clock.pending()).toBe(0)
    await s.clock.advance(HOUR)
    expect(s.reminders()).toHaveLength(0)
  })
})

describe("restart", () => {
  test("pending messages and re-wakes survive a restart (FileStateStore)", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "hub-delivery-"))
    const clock = fakeClock()
    const firstStore = new FileStateStore({ stateDir, now: clock.now, timers: clock.timers })
    const s = setup({ state: firstStore, clock })
    s.connect("c1", ["ses_a", "ses_b"])
    const ask = await s.delivery.send(U, asSession("ses_b"), "@alpha", "ask", "q?")
    s.conns.delete("c1")
    const offline = await s.delivery.send(U, asUser, "@beta", "msg", "while you were away")
    expect(offline.delivery).toBe("pending")
    await firstStore.flush()
    s.delivery.stop()

    // A new hub process: new store over the same folder, new engine.
    const restarted = s.make(new FileStateStore({ stateDir, now: clock.now, timers: clock.timers }))
    restarted.start()
    s.idle.add("ses_a")
    s.connect("c2", ["ses_a", "ses_b"])
    await restarted.onSessions("c2")
    expect(s.sent.at(-1)!.req).toMatchObject({ messageID: offline.message.id, sessionID: "ses_b" })
    expect((await restarted.messages.get(U, offline.message.id))?.delivery).toBe("turn")
    const before = s.sent.length
    await clock.advance(REWAKE_BACKOFF_MS[0]!)
    expect(s.sent.slice(before).map((x) => x.req.sessionID)).toEqual(["ses_a"])
    expect(s.sent.at(-1)!.req.text).toContain(ask.message.id)
    restarted.stop()
  })
})
