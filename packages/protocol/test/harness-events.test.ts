// The harness event subset: the forwarded events a non-OpenCode spoke may send, with their shapes (P7-T1).
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"
import { encode, FORWARDED_EVENTS, INBOX_ORIGINS, parseSpokeMessage, type ForwardedEvent } from "../src/index.ts"

const P = protocol as any
const problem = (type: string, data: unknown): string | undefined => P.harnessEventProblem({ type, data })
const ok = (type: string, data: unknown) => expect(problem(type, data)).toBeUndefined()
const bad = (type: string, data: unknown) => expect(problem(type, data)).toBeString()

const S = "ses_cc0123456789abcdef0123456789abcdef"

/** One valid event of each type in the subset. */
const samples: Record<string, Record<string, unknown>> = {
  "session.created": { sessionID: S, title: "Fix the login redirect" },
  "session.renamed": { sessionID: S, title: "Login fix" },
  "session.deleted": { sessionID: S },
  "session.execution.started": { sessionID: S },
  "session.execution.succeeded": { sessionID: S },
  "session.execution.failed": { sessionID: S, error: { message: "model error" } },
  "session.execution.interrupted": { sessionID: S },
  "session.status": { sessionID: S, status: { type: "busy" } },
  "session.text.ended": { sessionID: S, assistantMessageID: "msg_1", ordinal: 0, text: "Done." },
  "session.inbox.delivered": { sessionID: S, inboxID: "inb_1", origin: "hub" },
  "session.tool.called": { sessionID: S, id: "toolu_1", summary: "npm test" },
  "session.tool.success": { sessionID: S, id: "toolu_1" },
  "session.tool.failed": { sessionID: S, id: "toolu_1", error: "exit 1" },
  "permission.asked": { sessionID: S, id: "per_1", action: "shell", resources: ["rm -rf build"] },
  "permission.replied": { sessionID: S, requestID: "per_1", reply: "once" },
  "form.created": { form: { id: "frm_1", sessionID: S, title: "Pick one", fields: [{ key: "a", type: "string" }] } },
  "form.replied": { sessionID: S, id: "frm_1" },
  "form.cancelled": { sessionID: S, id: "frm_1" },
}

describe("HARNESS_EVENTS", () => {
  test("is a subset of FORWARDED_EVENTS, so every hub (old ones too) accepts these frames", () => {
    expect(P.HARNESS_EVENTS.length).toBeGreaterThan(0)
    for (const type of P.HARNESS_EVENTS) expect(FORWARDED_EVENTS.has(type)).toBe(true)
    expect([...P.HARNESS_EVENTS].sort()).toEqual(Object.keys(samples).sort())
  })

  test("each sample is valid, and passes parseSpokeMessage as an event frame", () => {
    for (const [type, data] of Object.entries(samples)) {
      ok(type, data)
      expect(P.isHarnessEvent({ type, data })).toBe(true)
      expect(parseSpokeMessage(encode({ t: "event", event: { type, data } }))).toBeDefined()
    }
  })

  test("refuses event types outside the subset, OpenCode-only ones included", () => {
    for (const type of ["session.text.delta", "session.reasoning.delta", "session.seed", "pty.created", "session.viewed", "nope"]) bad(type, { sessionID: S })
    expect(P.harnessEventProblem("x")).toBeString()
    expect(P.harnessEventProblem({ type: "session.deleted" })).toBeString()
    expect(P.harnessEventProblem({ type: "session.deleted", data: [] })).toBeString()
  })

  test("session IDs follow the hub's rule (ses_ + letters and digits): a spoke maps native IDs first", () => {
    bad("session.deleted", { sessionID: "0b5a8e1c-0000-4000-8000-000000000000" })
    bad("session.deleted", { sessionID: "ses_" })
    bad("session.deleted", { sessionID: "ses_a-b" })
    bad("session.deleted", {})
    bad("session.created", { sessionID: S, parentID: "nope" })
    ok("session.created", { sessionID: S, parentID: "ses_cc1" })
  })

  test("a turn-interrupted event: Codex Interrupt, or one the spoke inferred (Claude Code fires no Stop on Esc)", () => {
    ok("session.execution.interrupted", { sessionID: S, turnID: "019a-turn" })
    ok("session.execution.interrupted", { sessionID: S, inferred: true })
    bad("session.execution.interrupted", { sessionID: S, inferred: false })
    bad("session.execution.interrupted", { sessionID: S, turnID: "" })
    // Interrupted and failed reuse types every hub knows, so an older hub ends the run too.
    expect(FORWARDED_EVENTS.has("session.execution.interrupted")).toBe(true)
  })

  test("validates the shape of each type", () => {
    bad("session.renamed", { sessionID: S })
    bad("session.renamed", { sessionID: S, title: "x".repeat(201) })
    bad("session.execution.failed", { sessionID: S, error: "boom" })
    bad("session.execution.failed", { sessionID: S, error: { message: "x".repeat(1001) } })
    bad("session.status", { sessionID: S, status: { type: "sleeping" } })
    ok("session.status", { sessionID: S, status: { type: "retry", attempt: 2, message: "rate limited" } })
    bad("session.text.ended", { sessionID: S, assistantMessageID: "msg_1", ordinal: -1, text: "x" })
    bad("session.text.ended", { sessionID: S, assistantMessageID: "msg_1", ordinal: 0, text: "x".repeat(16_001) })
    bad("session.inbox.delivered", { sessionID: S, inboxID: "inb_1", origin: "robot" })
    for (const origin of INBOX_ORIGINS) ok("session.inbox.delivered", { sessionID: S, inboxID: "inb_1", origin })
    bad("session.tool.called", { sessionID: S, id: "toolu_1", summary: "x".repeat(161) })
    bad("session.tool.failed", { sessionID: S, id: "toolu_1", error: 5 })
    bad("permission.asked", { sessionID: S, id: "per_1", resources: [] })
    bad("permission.asked", { sessionID: S, id: "per_1", action: "shell", resources: "rm" })
    bad("permission.asked", { sessionID: S, id: "per_1", action: "shell", resources: Array(101).fill("x") })
    ok("permission.asked", { sessionID: S, id: "per_1", action: "shell", resources: [], save: ["rm *"], source: { type: "tool", messageID: "msg_1", id: "toolu_1" } })
    bad("permission.asked", { sessionID: S, id: "per_1", action: "shell", resources: [], source: { type: "tool" } })
    bad("permission.replied", { sessionID: S, requestID: "per_1", reply: "maybe" })
    bad("form.created", { form: { id: "frm_1", sessionID: S, fields: "x" } })
    bad("form.created", { sessionID: S, id: "frm_1" })
    bad("form.replied", { sessionID: S })
  })

  test("extra data fields are allowed (newer spokes may add some), the known ones must still be valid", () => {
    ok("session.deleted", { sessionID: S, nativeID: "0b5a8e1c" })
  })

  test("the type narrows to ForwardedEvent", () => {
    const event: ForwardedEvent = { type: "session.deleted", data: { sessionID: S } }
    expect(P.isHarnessEvent(event)).toBe(true)
  })
})
