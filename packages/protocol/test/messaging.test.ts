import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"
import { encode, featureForOp, HUB_FEATURES, IMPLIED_OPENCODE_FEATURES, KNOWN_SPOKE_FEATURES, MAX_FRAME, parseServerMessage, PROTOCOL_VERSION, SPOKE_FEATURES, spokeFeatures } from "../src/index.ts"

const j = (v: unknown) => JSON.stringify(v)
const P = protocol as any

const meta = { kind: "msg", from: "@api-refactor", to: "@@reviewer" }
const deliver = (extra: Record<string, unknown> = {}) => ({ op: "deliver", sessionID: "ses_1", messageID: "msg_7f", text: "[hub] from @api-refactor\n---\nhi\n---", wake: true, meta, ...extra })
const frame = (req: unknown) => j({ t: "req", id: "d1", req })
const parses = (req: unknown) => parseServerMessage(frame(req)) !== undefined

describe("deliver op", () => {
  test("a valid deliver request round-trips", () => {
    const req = deliver({ meta: { ...meta, replyTo: "msg_1", delivery: "queue" } })
    expect(parseServerMessage(frame(req))).toEqual({ t: "req", id: "d1", req } as any)
    expect(parses(deliver({ wake: false }))).toBe(true)
  })

  test("every message kind is accepted; reply and decline name the message they answer", () => {
    expect(P.MESSAGE_KINDS).toEqual(["msg", "ask", "reply", "decline", "primer", "decision"])
    for (const kind of ["msg", "ask", "primer", "decision"]) expect(parses(deliver({ meta: { ...meta, kind } }))).toBe(true)
    for (const kind of ["reply", "decline"]) {
      expect(parses(deliver({ meta: { ...meta, kind, replyTo: "msg_1" } }))).toBe(true)
      expect(parses(deliver({ meta: { ...meta, kind } }))).toBe(false)
    }
    expect(parses(deliver({ meta: { ...meta, kind: "shout" } }))).toBe(false)
  })

  test("requires session, message id, text, wake and meta", () => {
    for (const key of ["sessionID", "messageID", "text", "wake", "meta"]) expect(parses(deliver({ [key]: undefined }))).toBe(false)
    expect(parses(deliver({ sessionID: "" }))).toBe(false)
    expect(parses(deliver({ messageID: "" }))).toBe(false)
    expect(parses(deliver({ text: "" }))).toBe(false)
    expect(parses(deliver({ text: 5 }))).toBe(false)
    expect(parses(deliver({ wake: "yes" }))).toBe(false)
    expect(parses(deliver({ meta: "msg" }))).toBe(false)
    expect(parses(deliver({ meta: null }))).toBe(false)
  })

  test("text is at most DELIVER_TEXT_MAX (16000) characters", () => {
    expect(P.DELIVER_TEXT_MAX).toBe(16_000)
    expect(parses(deliver({ text: "x".repeat(16_000) }))).toBe(true)
    expect(parses(deliver({ text: "x".repeat(16_001) }))).toBe(false)
  })

  test("ids are at most 300 characters; the message id is a plain token", () => {
    expect(P.DELIVER_ID_MAX).toBe(300)
    expect(parses(deliver({ sessionID: "s".repeat(300) }))).toBe(true)
    expect(parses(deliver({ sessionID: "s".repeat(301) }))).toBe(false)
    expect(parses(deliver({ messageID: "m".repeat(300) }))).toBe(true)
    expect(parses(deliver({ messageID: "m".repeat(301) }))).toBe(false)
    expect(parses(deliver({ messageID: "msg 1" }))).toBe(false)
    expect(parses(deliver({ messageID: "msg\n1" }))).toBe(false)
    expect(parses(deliver({ meta: { ...meta, kind: "reply", replyTo: "r".repeat(301) } }))).toBe(false)
    expect(parses(deliver({ meta: { ...meta, kind: "reply", replyTo: "" } }))).toBe(false)
  })

  test("from and to are short addresses without control, bidi or zero-width characters", () => {
    expect(parses(deliver({ meta: { ...meta, from: "a".repeat(300) } }))).toBe(true)
    expect(parses(deliver({ meta: { ...meta, from: "a".repeat(301) } }))).toBe(false)
    expect(parses(deliver({ meta: { ...meta, to: "" } }))).toBe(false)
    expect(parses(deliver({ meta: { ...meta, from: 5 } }))).toBe(false)
    for (const bad of ["@a\nb", "@a\u0007", "@a\u001b[31m", "@a\u0085", "@a\u202e", "@a\u2066", "@a\u200b", "@a\ufeff", "@a\u2028"]) {
      expect(parses(deliver({ meta: { ...meta, from: bad } }))).toBe(false)
      expect(parses(deliver({ meta: { ...meta, to: bad } }))).toBe(false)
    }
  })

  test("delivery, when given, is queue or steer", () => {
    expect(parses(deliver({ meta: { ...meta, delivery: "steer" } }))).toBe(true)
    expect(parses(deliver({ meta: { ...meta, delivery: "queue" } }))).toBe(true)
    expect(parses(deliver({ meta: { ...meta, delivery: "turn" } }))).toBe(false)
    expect(parses(deliver({ meta: { ...meta, delivery: true } }))).toBe(false)
  })

  test("deliverProblem explains why a request is refused", () => {
    expect(P.deliverProblem(deliver())).toBeUndefined()
    expect(P.deliverProblem(deliver({ text: "x".repeat(16_001) }))).toMatch(/text/)
    expect(P.deliverProblem(deliver({ meta: { ...meta, kind: "reply" } }))).toMatch(/replyTo/)
    expect(P.deliverProblem(deliver({ meta: { ...meta, to: "@a\u202e" } }))).toMatch(/to/)
    expect(P.deliverProblem("x")).toBeDefined()
  })

  test("the largest deliver request fits in one frame, even with every character escaped", () => {
    const worst = deliver({ sessionID: "s".repeat(300), messageID: "m".repeat(300), text: "\u0001".repeat(16_000), meta: { kind: "reply", from: "f".repeat(300), to: "t".repeat(300), replyTo: "r".repeat(300), delivery: "steer" } })
    const raw = encode({ t: "req", id: "x".repeat(64), req: worst } as any)
    expect(raw.length).toBeLessThanOrEqual(MAX_FRAME)
    expect(parseServerMessage(raw)).toBeDefined()
  })
})

describe("deliver result", () => {
  test("isDeliverResult accepts the four outcomes, with an optional inbox id", () => {
    expect(P.DELIVERED).toEqual(["steer", "turn", "queued", "retained"])
    for (const delivered of ["steer", "turn", "queued", "retained"]) expect(P.isDeliverResult({ delivered })).toBe(true)
    expect(P.isDeliverResult({ delivered: "steer", inboxID: "inb_1" })).toBe(true)
    expect(P.isDeliverResult({ delivered: "pending" })).toBe(false)
    expect(P.isDeliverResult({ delivered: "steer", inboxID: "" })).toBe(false)
    expect(P.isDeliverResult({ delivered: "steer", inboxID: "i".repeat(301) })).toBe(false)
    expect(P.isDeliverResult({})).toBe(false)
    expect(P.isDeliverResult(null)).toBe(false)
  })
})

describe("messaging features", () => {
  test("deliver is a spoke feature that must be announced: old OpenCode spokes do not imply it", () => {
    expect(KNOWN_SPOKE_FEATURES as readonly string[]).toContain("deliver")
    // The OpenCode spoke handles the op (P2-T3); older spokes never announced it, so the hub does not send it to them.
    expect(SPOKE_FEATURES as readonly string[]).toContain("deliver")
    expect(IMPLIED_OPENCODE_FEATURES as readonly string[]).not.toContain("deliver")
    expect(featureForOp("deliver" as any)).toBe("deliver" as any)
    const oldHello = { t: "hello", v: PROTOCOL_VERSION, processID: "p1", kind: "standalone", directory: "/tmp/x", pid: 1, mode: "always", opencodeVersion: "2.0.25", pluginVersion: "0.1.0" }
    expect(spokeFeatures(oldHello as any).has("deliver")).toBe(false)
    expect(spokeFeatures({ ...oldHello, features: ["autoName"] } as any).has("deliver")).toBe(false)
    expect(spokeFeatures({ ...oldHello, harness: "opencode", features: [...SPOKE_FEATURES, "deliver"] } as any).has("deliver")).toBe(true)
    expect(KNOWN_SPOKE_FEATURES.length).toBeLessThanOrEqual(64)
  })

  test("the hub announces messaging next to harness", () => {
    expect(HUB_FEATURES as readonly string[]).toEqual(expect.arrayContaining(["harness", "messaging"]))
    const welcome = { t: "welcome", v: PROTOCOL_VERSION, machineID: "m_1", publicURL: "https://hub.example", features: [...HUB_FEATURES] }
    expect(parseServerMessage(j(welcome))).toEqual(welcome as any)
  })
})

describe("message timeline rows", () => {
  test("timeline rows have a message kind next to the existing ones", () => {
    expect(P.TIMELINE_KINDS).toEqual(["user", "assistant", "reasoning", "tool", "message"])
  })

  test("a message row carries the message's kind, addresses and direction; it is a typed TimelinePage item", () => {
    const row: protocol.TimelineMessageItem = {
      key: "msg_7f:message",
      messageID: "msg_7f",
      sessionID: "ses_1",
      kind: "message",
      text: "hi",
      at: 1,
      pos: 1000,
      direction: "in",
      message: { kind: "reply", from: "@api-refactor", to: "@@reviewer", replyTo: "msg_1" },
    }
    const page: protocol.TimelinePage = { items: [row] }
    expect(page.items).toHaveLength(1)
    expect(P.MESSAGE_DIRECTIONS).toEqual(["in", "out"])
  })
})

describe("session.inbox.delivered origin", () => {
  test("the event keeps its type; origin is user or hub", () => {
    expect(P.INBOX_ORIGINS).toEqual(["user", "hub"])
    expect(protocol.FORWARDED_EVENTS.has("session.inbox.delivered")).toBe(true)
    const ev = (data: Record<string, unknown>) => protocol.parseSpokeMessage(j({ t: "event", event: { type: "session.inbox.delivered", data } }))
    expect(ev({ sessionID: "ses_1", inboxID: "inb_1", origin: "hub" })).toBeDefined()
    expect(ev({ sessionID: "ses_1", inboxID: "inb_1" })).toBeDefined()
    const data: protocol.InboxDeliveredData = { sessionID: "ses_1", inboxID: "inb_1", origin: "user" }
    expect(data.origin).toBe("user")
  })
})
