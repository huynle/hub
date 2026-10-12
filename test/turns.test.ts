import { describe, expect, test } from "bun:test"
import { TurnTracker } from "../src/turns"

const delivered = (sessionID: string, inboxID: string) => ({
  type: "session.inbox.delivered",
  data: { sessionID, inboxID },
})
const ended = (sessionID: string, type = "session.execution.succeeded", data: Record<string, unknown> = {}) => ({
  type,
  data: { sessionID, ...data },
})

describe("TurnTracker", () => {
  test("resolves when the execution that received the prompt succeeds", async () => {
    const tracker = new TurnTracker()
    const done = tracker.wait("msg_1")
    tracker.observe(delivered("ses_a", "msg_1"))
    tracker.observe(ended("ses_a"))
    expect(await done).toEqual({ outcome: "succeeded" })
  })

  test("resolves a waiter registered after the turn already finished", async () => {
    const tracker = new TurnTracker()
    tracker.observe(delivered("ses_a", "msg_1"))
    tracker.observe(ended("ses_a"))
    expect(await tracker.wait("msg_1")).toEqual({ outcome: "succeeded" })
  })

  test("resolves a waiter registered after delivery but before completion", async () => {
    const tracker = new TurnTracker()
    tracker.observe(delivered("ses_a", "msg_1"))
    const done = tracker.wait("msg_1")
    tracker.observe(ended("ses_a"))
    expect(await done).toEqual({ outcome: "succeeded" })
  })

  test("ignores executions of other sessions", async () => {
    const tracker = new TurnTracker()
    const done = tracker.wait("msg_1")
    tracker.observe(delivered("ses_a", "msg_1"))
    tracker.observe(ended("ses_b"))
    let settled = false
    void done.then(() => (settled = true))
    await Bun.sleep(5)
    expect(settled).toBe(false)
    tracker.observe(ended("ses_a"))
    expect(await done).toEqual({ outcome: "succeeded" })
  })

  test("an execution ending before delivery does not complete the turn", async () => {
    const tracker = new TurnTracker()
    const done = tracker.wait("msg_2")
    tracker.observe(ended("ses_a"))
    tracker.observe(delivered("ses_a", "msg_2"))
    let settled = false
    void done.then(() => (settled = true))
    await Bun.sleep(5)
    expect(settled).toBe(false)
  })

  test("reports failure with the error message", async () => {
    const tracker = new TurnTracker()
    const done = tracker.wait("msg_1")
    tracker.observe(delivered("ses_a", "msg_1"))
    tracker.observe(ended("ses_a", "session.execution.failed", { error: { type: "x", message: "boom" } }))
    expect(await done).toEqual({ outcome: "failed", message: "boom" })
  })

  test("reports interruption with its reason", async () => {
    const tracker = new TurnTracker()
    const done = tracker.wait("msg_1")
    tracker.observe(delivered("ses_a", "msg_1"))
    tracker.observe(ended("ses_a", "session.execution.interrupted", { reason: "user" }))
    expect(await done).toEqual({ outcome: "interrupted", message: "user" })
  })

  test("times out", async () => {
    const tracker = new TurnTracker()
    expect(await tracker.wait("msg_1", { timeoutMs: 10 })).toEqual({ outcome: "timeout" })
  })

  test("keeps a bounded history of finished turns", () => {
    const tracker = new TurnTracker({ historyLimit: 2 })
    for (const id of ["m1", "m2", "m3"]) {
      tracker.observe(delivered("ses_a", id))
      tracker.observe(ended("ses_a"))
    }
    expect(tracker.finishedCount()).toBe(2)
  })
})
