import { describe, expect, test } from "bun:test"
import { newestPage, timelineItems } from "../src/spoke/timeline"

const quota = { type: "APIError", message: "  Quota exceeded for this account  ", status: 429, response: { body: "{}" }, retryAfterMs: 1000 }

describe("timelineItems failed turns", () => {
  test("an assistant message with an error and no content gets an error row", () => {
    const rows = timelineItems("s", [{ id: "a1", type: "assistant", time: { created: 10, completed: 20 }, content: [], error: quota }])
    expect(rows).toEqual([{ key: "a1:error", messageID: "a1", sessionID: "s", kind: "error", text: "Quota exceeded for this account", errorType: "APIError", errorStatus: 429, at: 10, pos: 10_000 }])
  })

  test("the error row works when content is missing", () => {
    const rows = timelineItems("s", [{ id: "a1", type: "assistant", time: { created: 10 }, error: { type: "X", message: "boom" } }])
    expect(rows.map((r) => [r.key, r.kind, r.text])).toEqual([["a1:error", "error", "boom"]])
  })

  test("the error row comes after the message's parts and before the next message", () => {
    const rows = timelineItems("s", [
      { id: "a1", type: "assistant", time: { created: 10 }, content: [{ type: "text", text: "partial" }, { type: "tool", name: "read", state: { status: "error" } }], error: { type: "X", message: "boom" } },
      { id: "u2", type: "user", time: { created: 11 }, text: "again" },
    ])
    expect(rows.map((r) => r.key)).toEqual(["a1:0", "a1:1", "a1:error", "u2:text"])
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.pos!).toBeGreaterThan(rows[i - 1]!.pos!)
    expect(rows[2]!.pos).toBe(rows[0]!.pos! + 2)
  })

  test("the error position is clamped to the message's last slot", () => {
    const content = Array.from({ length: 1200 }, () => ({ type: "text", text: "" }))
    const [row] = timelineItems("s", [{ id: "a1", type: "assistant", time: { created: 1 }, content, error: { message: "x" } }])
    expect(row!.pos).toBe(1000 + 999)
  })

  test("error text, type and status are bounded; a missing message falls back to 'failed'", () => {
    const [long] = timelineItems("s", [{ id: "a1", type: "assistant", content: [], error: { type: "T".repeat(100), message: "m".repeat(5000), status: 42 } }])
    expect(long!.text!.length).toBe(1000)
    expect(long!.errorType!.length).toBe(64)
    expect(long!.errorStatus).toBeUndefined()
    expect(long!.at).toBeUndefined()
    const [empty] = timelineItems("s", [{ id: "a2", type: "assistant", content: [], error: { message: "   " } }])
    expect(empty!.text).toBe("failed")
    expect(empty!.errorType).toBeUndefined()
    const [odd] = timelineItems("s", [{ id: "a3", type: "assistant", content: [], error: "not an object" }])
    expect(odd!.text).toBe("failed")
    const [high] = timelineItems("s", [{ id: "a4", type: "assistant", content: [], error: { message: "x", status: 600 } }])
    expect(high!.errorStatus).toBeUndefined()
    const [frac] = timelineItems("s", [{ id: "a5", type: "assistant", content: [], error: { message: "x", status: 500.5 } }])
    expect(frac!.errorStatus).toBeUndefined()
  })

  test("ISO string timestamps are accepted", () => {
    const iso = "2026-10-31T12:00:00.000Z"
    const [row] = timelineItems("s", [{ id: "a1", type: "assistant", time: { created: iso }, content: [], error: { message: "x" } }])
    expect(row!.at).toBe(Date.parse(iso))
  })
})

describe("timelineItems retrying turns", () => {
  const retry = { attempt: 2, at: 5000, error: { type: "APIError", message: "Rate limited", status: 429 } }

  test("a message retrying (no error, not completed) gets a retry row after its parts", () => {
    const rows = timelineItems("s", [{ id: "a1", type: "assistant", time: { created: 10 }, content: [{ type: "text", text: "hi" }], retry }])
    expect(rows.map((r) => r.key)).toEqual(["a1:0", "a1:retry"])
    expect(rows[1]).toEqual({ key: "a1:retry", messageID: "a1", sessionID: "s", kind: "retry", text: "Rate limited", errorType: "APIError", errorStatus: 429, attempt: 2, next: 5000, at: 10, pos: 10_001 })
  })

  test("retry works with missing content and an ISO retry time", () => {
    const iso = "2026-10-31T12:00:05.000Z"
    const [row] = timelineItems("s", [{ id: "a1", type: "assistant", time: { created: 10 }, retry: { ...retry, at: iso } }])
    expect(row!.kind).toBe("retry")
    expect(row!.next).toBe(Date.parse(iso))
  })

  test("no retry row once the message completed or failed", () => {
    expect(timelineItems("s", [{ id: "a1", type: "assistant", time: { created: 10, completed: 11 }, content: [], retry }])).toEqual([])
    const rows = timelineItems("s", [{ id: "a1", type: "assistant", time: { created: 10 }, content: [], retry, error: { type: "X", message: "gave up" } }])
    expect(rows.map((r) => r.kind)).toEqual(["error"])
  })

  test("retry text is bounded and falls back to 'retrying'", () => {
    const [long] = timelineItems("s", [{ id: "a1", type: "assistant", content: [], retry: { attempt: 1, at: 1, error: { message: "r".repeat(3000) } } }])
    expect(long!.text!.length).toBe(1000)
    const [bare] = timelineItems("s", [{ id: "a2", type: "assistant", content: [], retry: { attempt: 3 } }])
    expect(bare!.kind).toBe("retry")
    expect(bare!.text).toBe("retrying")
    expect(bare!.attempt).toBe(3)
    expect(bare!.next).toBeUndefined()
  })
})

describe("error rows and paging", () => {
  test("a page boundary keeps the error row with its message", () => {
    const items = timelineItems("s", [
      { id: "u1", type: "user", time: { created: 1 }, text: "q" },
      { id: "a1", type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "a" }], error: { message: "boom" } },
    ])
    const page = newestPage(items, 1)
    expect(page.items.map((r) => r.key)).toEqual(["a1:0", "a1:error"])
    expect(page.older).toBe("a1:0")
  })
})
