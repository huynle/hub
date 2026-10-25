import { describe, expect, test } from "bun:test"
import { confirmations, deliverModeProblems, idempotencyProblems } from "../src/deliver.ts"
import { permissionProblems } from "../src/permission.ts"
import { reconnectProblems } from "../src/reconnect.ts"

const S = "ses_cf1"

describe("deliver idempotency", () => {
  const queued = { ok: true, result: { delivered: "queued", inboxID: "inb_1" } }
  test("the same answer every time and at most one admission pass", () => {
    expect(idempotencyProblems({ answers: [queued, queued, queued], admissions: 1 })).toEqual([])
    expect(idempotencyProblems({ answers: [queued, queued], admissions: 0 })).toEqual([])
  })
  test("a different answer for a retry, a failure or a second admission fail", () => {
    expect(idempotencyProblems({ answers: [queued, { ok: true, result: { delivered: "queued", inboxID: "inb_2" } }], admissions: 1 }).join()).toMatch(/retry.*differs/)
    expect(idempotencyProblems({ answers: [queued, { ok: false, error: "x" }], admissions: 1 }).join()).toMatch(/failed/)
    expect(idempotencyProblems({ answers: [queued, queued], admissions: 2 }).join()).toMatch(/admitted 2 times/)
    expect(idempotencyProblems({ answers: [queued, undefined], admissions: 1 }).join()).toMatch(/no answer/)
  })
  test("admissions are counted from hub-origin inbox events of the session (matching the inboxID when known)", () => {
    const events = [
      { type: "session.inbox.delivered", data: { sessionID: S, inboxID: "inb_1", origin: "hub" } },
      { type: "session.inbox.delivered", data: { sessionID: S, inboxID: "inb_2", origin: "hub" } },
      { type: "session.inbox.delivered", data: { sessionID: S, inboxID: "inb_3", origin: "user" } },
      { type: "session.inbox.delivered", data: { sessionID: "ses_other", inboxID: "inb_1", origin: "hub" } },
    ]
    expect(confirmations(events, S, "inb_1")).toBe(1)
    expect(confirmations(events, S)).toBe(2)
  })
})

describe("deliver result modes", () => {
  const res = (delivered: string) => ({ ok: true, result: { delivered, inboxID: "inb_1" } })
  test("queued and retained are always allowed", () => {
    for (const evidence of ["native", "hooks", "rpc", "screen", "unknown"]) {
      expect(deliverModeProblems({ evidence, wake: true, answer: res("queued"), confirmed: false })).toEqual([])
      expect(deliverModeProblems({ evidence, wake: false, answer: res("retained"), confirmed: false })).toEqual([])
    }
  })
  test("hooks, screen (and unknown) evidence never claim steer or turn without confirmation", () => {
    for (const evidence of ["hooks", "screen", "unknown"]) {
      expect(deliverModeProblems({ evidence, wake: true, answer: res("steer"), confirmed: false }).join()).toMatch(/steer.*without.*confirm/)
      expect(deliverModeProblems({ evidence, wake: true, answer: res("turn"), confirmed: true })).toEqual([])
    }
    expect(deliverModeProblems({ evidence: "native", wake: true, answer: res("steer"), confirmed: false })).toEqual([])
  })
  test("wake:false never starts a turn; unknown modes fail", () => {
    expect(deliverModeProblems({ evidence: "native", wake: false, answer: res("turn"), confirmed: true }).join()).toMatch(/wake: false/)
    expect(deliverModeProblems({ evidence: "native", wake: true, answer: res("later"), confirmed: false }).join()).toMatch(/"later"/)
  })
  test("a refused deliver has no mode to judge", () => {
    expect(deliverModeProblems({ evidence: "hooks", wake: true, answer: { ok: false, error: "busy" }, confirmed: false })).toEqual([])
  })
})

describe("permission semantics", () => {
  test("an applied once (or reject) with a matching permission.replied passes", () => {
    expect(permissionProblems({ decision: "once", answer: { ok: true, result: {} }, replied: { reply: "once" }, tool: "success" })).toEqual([])
    expect(permissionProblems({ decision: "reject", answer: { ok: true, result: {} }, replied: {}, tool: "failed" })).toEqual([])
    expect(permissionProblems({ decision: "reject", answer: { ok: true, result: {} }, replied: { reply: "reject" }, tool: undefined })).toEqual([])
  })
  test("a refused or unanswered reply, a missing or wrong permission.replied, or a reply not applied fail", () => {
    expect(permissionProblems({ decision: "once", answer: { ok: false, error: "x" }, replied: { reply: "once" }, tool: "success" }).join()).toMatch(/refused/)
    expect(permissionProblems({ decision: "once", answer: undefined, replied: { reply: "once" }, tool: "success" }).join()).toMatch(/no answer/)
    expect(permissionProblems({ decision: "once", answer: { ok: true, result: {} }, replied: undefined, tool: "success" }).join()).toMatch(/permission\.replied/)
    expect(permissionProblems({ decision: "once", answer: { ok: true, result: {} }, replied: { reply: "reject" }, tool: "success" }).join()).toMatch(/"reject".*"once"/)
    expect(permissionProblems({ decision: "once", answer: { ok: true, result: {} }, replied: { reply: "once" }, tool: "failed" }).join()).toMatch(/not applied/)
    expect(permissionProblems({ decision: "reject", answer: { ok: true, result: {} }, replied: { reply: "reject" }, tool: "success" }).join()).toMatch(/ran anyway/)
    expect(permissionProblems({ decision: "once", answer: { ok: true, result: { gone: true } }, replied: { reply: "once" }, tool: "success" }).join()).toMatch(/gone/)
  })
})

describe("reconnect after bye", () => {
  test("a new hello within retryAfterMs plus the grace, re-reporting its sessions, passes", () => {
    expect(reconnectProblems({ retryAfterMs: 500, graceMs: 1000, helloAfterMs: 700, resentSessions: true })).toEqual([])
  })
  test("no reconnect, a late one, or one that forgets its sessions fails", () => {
    expect(reconnectProblems({ retryAfterMs: 500, graceMs: 1000, helloAfterMs: undefined, resentSessions: false }).join()).toMatch(/did not reconnect within 1500 ms/)
    expect(reconnectProblems({ retryAfterMs: 500, graceMs: 1000, helloAfterMs: 1600, resentSessions: true }).join()).toMatch(/1600 ms.*1500/)
    expect(reconnectProblems({ retryAfterMs: 500, graceMs: 1000, helloAfterMs: 400, resentSessions: false }).join()).toMatch(/sessions/)
  })
})
