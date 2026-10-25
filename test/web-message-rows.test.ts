// Hub messages in the console transcript (P2-T10a): inbound rows come from the spoke's timeline (kind "message",
// direction "in"); the session's sent messages come from the hub's store (GET /api/sessions/:session/messages and
// SSE 'message' events) and are merged by time. Rows render "from @y" / "to @@r (→ @x)", primers compactly, and a
// message never shows twice.
import { describe, expect, test } from "bun:test"
import { storedMessageRow, Timeline } from "../web/src/core/timeline-core"
import { transcriptBlocks } from "../web/src/lib/transcript"

const at = 1_792_000_000_000
const POS = 1000
/** A stored hub message (src/central/agent/messages.ts Message). */
const stored = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "msg",
  from: { kind: "session", sessionID: "ses_me", name: "api" },
  to: "@@reviewer",
  recipient: { kind: "session", sessionID: "ses_rev", name: "rev" },
  text: "please review",
  state: "sent",
  at,
  hop: 0,
  ...extra,
})
/** A spoke timeline row of a delivered message (src/spoke/timeline.ts). */
const inbound = (key: string, messageID: string, pos: number, extra: Record<string, unknown> = {}) => ({
  key,
  messageID,
  sessionID: "ses_me",
  kind: "message",
  text: "hello there",
  at: pos / POS,
  pos,
  direction: "in",
  message: { kind: "msg", from: "@web", to: "@api" },
  ...extra,
})

describe("storedMessageRow", () => {
  test("a message the session sent is an outbound row placed by its time", () => {
    expect(storedMessageRow("ses_me", stored("m1"))).toEqual({
      key: "hubmsg:m1",
      kind: "message",
      messageID: "m1",
      sessionID: "ses_me",
      text: "please review",
      at,
      direction: "out",
      message: { kind: "msg", from: "@api", to: "@@reviewer" },
      recipient: "@rev",
      state: "sent",
    })
  })

  test("a message to the session is inbound; one that is not the session's is nothing; malformed input is nothing", () => {
    expect(storedMessageRow("ses_rev", stored("m1"))).toMatchObject({ direction: "in", message: { from: "@api" } })
    expect(storedMessageRow("ses_other", stored("m1"))).toBeUndefined()
    expect(storedMessageRow("ses_me", { id: 3 })).toBeUndefined()
    expect(storedMessageRow("ses_me", null)).toBeUndefined()
  })

  test("the user, apps and unnamed sessions get readable addresses", () => {
    expect(storedMessageRow("ses_me", stored("m2", { from: { kind: "user" }, recipient: { kind: "session", sessionID: "ses_me" }, to: "ses_me" }))).toMatchObject({ message: { from: "@me" } })
    expect(storedMessageRow("ses_me", stored("m3", { from: { kind: "app", tokenID: "tok_1", label: "brain" }, recipient: { kind: "session", sessionID: "ses_me" } }))).toMatchObject({ message: { from: "app brain" } })
    expect(storedMessageRow("ses_me", stored("m4", { recipient: { kind: "session", sessionID: "ses_rev" } }))).toMatchObject({ recipient: "ses_rev" })
  })
})

describe("Timeline: hub message rows", () => {
  test("outbound store rows merge by time between history rows; the store and SSE copies are one row", () => {
    const t = new Timeline()
    t.load([
      { key: "u1:text", kind: "user", messageID: "u1", text: "go", pos: (at - 10) * POS },
      { key: "a1:0", kind: "assistant", messageID: "a1", text: "done", pos: (at + 10) * POS },
    ])
    t.hubMessage(storedMessageRow("ses_me", stored("m1"))!)
    t.hubMessage(storedMessageRow("ses_me", stored("m1", { text: "please review" }))!)
    expect(t.rows().map((r) => r.key)).toEqual(["u1:text", "hubmsg:m1", "a1:0"])
  })

  test("an inbound message seen live first is replaced by its spoke row; a spoke row already there is never duplicated", () => {
    const t = new Timeline()
    const live = storedMessageRow("ses_me", stored("m5", { from: { kind: "session", sessionID: "ses_web", name: "web" }, recipient: { kind: "session", sessionID: "ses_me", name: "api" }, to: "@api" }))!
    t.hubMessage(live)
    expect(t.rows().map((r) => r.key)).toEqual(["hubmsg:m5"])
    t.load([inbound("oc1:message", "m5", at * POS)])
    expect(t.rows().map((r) => r.key)).toEqual(["oc1:message"])
    t.hubMessage(live)
    expect(t.rows().map((r) => r.key)).toEqual(["oc1:message"])
  })

  test("live rows that arrive after a sent message go after it", () => {
    const t = new Timeline()
    t.load([{ key: "u1:text", kind: "user", messageID: "u1", text: "go", pos: (at - 10) * POS }])
    t.hubMessage(storedMessageRow("ses_me", stored("m1"))!)
    t.appendText({ messageID: "a2", delta: "after" })
    expect(t.rows().map((r) => r.key)).toEqual(["u1:text", "hubmsg:m1", "a2:text"])
  })
})

describe("transcriptBlocks: message rows", () => {
  test("inbound: 'from @y'; outbound: 'to @@r (→ @x)', or just 'to @x' when that is who got it", () => {
    const blocks = transcriptBlocks([
      inbound("oc1:message", "m5", 1, { message: { kind: "ask", from: "@web", to: "@api" } }) as any,
      storedMessageRow("ses_me", stored("m1"))!,
      storedMessageRow("ses_me", stored("m2", { to: "@rev" }))!,
    ])
    expect(blocks).toEqual([
      { type: "message", key: "oc1:message", direction: "in", kind: "ask", label: "from @web", text: "hello there", primer: false },
      { type: "message", key: "hubmsg:m1", direction: "out", kind: "msg", label: "to @@reviewer (→ @rev)", text: "please review", primer: false, state: "sent" },
      { type: "message", key: "hubmsg:m2", direction: "out", kind: "msg", label: "to @rev", text: "please review", primer: false, state: "sent" },
    ])
  })

  test("the identity primer is a compact hub note", () => {
    const [block] = transcriptBlocks([inbound("oc2:message", "p1", 1, { text: "[hub] You are @api. …", message: { kind: "primer", from: "hub", to: "@api" } }) as any])
    expect(block).toEqual({ type: "message", key: "oc2:message", direction: "in", kind: "primer", label: "Hub identity note", text: "[hub] You are @api. …", primer: true })
  })
})
