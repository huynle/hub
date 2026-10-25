import { describe, expect, test } from "bun:test"
import { eventProblems } from "../src/events.ts"

const S = "ses_cf1"
const reported = new Set([S])
const ok = [
  { type: "session.created", data: { sessionID: S, title: "x" } },
  { type: "session.execution.started", data: { sessionID: S } },
  { type: "session.tool.called", data: { sessionID: S, id: "call_1", summary: "echo hi" } },
  { type: "session.tool.success", data: { sessionID: S, id: "call_1" } },
  { type: "permission.replied", data: { sessionID: S, requestID: "per_1", reply: "once" } },
  { type: "form.created", data: { form: { id: "frm_1", sessionID: S, fields: [] } } },
]

describe("events check", () => {
  test("events of the harness subset with valid data about reported sessions pass", () => {
    expect(eventProblems({ events: ok, sessions: reported })).toEqual([])
  })

  test("an event outside the harness subset fails", () => {
    expect(eventProblems({ events: [{ type: "message.part.updated", data: { sessionID: S } }], sessions: reported }).join()).toMatch(/message\.part\.updated.*type must be one of/)
  })

  test("an event without a hub sessionID fails", () => {
    expect(eventProblems({ events: [{ type: "session.status", data: { status: { type: "idle" } } }], sessions: reported }).join()).toMatch(/sessionID/)
    expect(eventProblems({ events: [{ type: "session.deleted", data: { sessionID: "0b5e…uuid" } }], sessions: reported }).join()).toMatch(/sessionID/)
  })

  test("an event about a session the spoke never reported fails", () => {
    expect(eventProblems({ events: [{ type: "session.deleted", data: { sessionID: "ses_cf2" } }], sessions: reported }).join()).toMatch(/ses_cf2.*not reported/)
    expect(eventProblems({ events: [{ type: "form.created", data: { form: { id: "f", sessionID: "ses_cf9", fields: [] } } }], sessions: reported }).join()).toMatch(/ses_cf9/)
  })

  test("unbounded data fails: over-long known fields and raw tool input or output", () => {
    expect(eventProblems({ events: [{ type: "session.tool.called", data: { sessionID: S, id: "c", summary: "x".repeat(161) } }], sessions: reported }).join()).toMatch(/summary/)
    expect(eventProblems({ events: [{ type: "session.tool.success", data: { sessionID: S, id: "c", output: "total 0\n" } }], sessions: reported }).join()).toMatch(/raw tool data.*output/)
    expect(eventProblems({ events: [{ type: "session.tool.called", data: { sessionID: S, id: "c", meta: { tool_input: { command: "ls" } } } }], sessions: reported }).join()).toMatch(/tool_input/)
    expect(eventProblems({ events: [{ type: "session.tool.called", data: { sessionID: S, id: "c", note: "y".repeat(1001) } }], sessions: reported }).join()).toMatch(/note.*1000/)
  })

  test("lists at most 20 problems", () => {
    const bad = Array.from({ length: 30 }, () => ({ type: "nope", data: {} }))
    expect(eventProblems({ events: bad, sessions: reported }).length).toBe(21)
  })
})
