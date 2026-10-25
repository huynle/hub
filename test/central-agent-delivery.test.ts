// The delivery engine (design §3.3, §3.4; decisions jswt9p22, 52aqsopo): owner selection gated on the spoke's
// "deliver" feature, delivery modes, role holders and generations, the pending queue (offline recipients, 24 h,
// flushed in order on a sessions frame), hop cap and wake budget, human-turn resets, and the re-wake loop for
// open asks to idle recipients, with fake spokes, a fake directory, a fake clock and fake timers.
import { describe, expect, test } from "bun:test"
import type { AgentActor } from "../src/central/agent/actor"
import { Delivery, type DeliveryAlert, type DeliveryRegistry } from "../src/central/agent/delivery"
import type { DirectoryEntry, Resolved } from "../src/central/agent/directory"
import { AgentError } from "../src/central/agent/errors"
import { parseAddress } from "../src/central/agent/names"
import { MemoryCounters } from "../src/central/backend/memory-counters"
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

function setup(options: { state?: StateStore; clock?: ReturnType<typeof fakeClock> } = {}) {
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
