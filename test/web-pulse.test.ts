// What the session is doing right now: streamed reasoning and text in the activity feed, and the "now" header
// summary (pulse) with elapsed time since the run started.
import { describe, expect, test } from "bun:test"
import * as core from "../web/feedback-core.js"

const { ActivityFeed } = core
const tailText = (...args: Parameters<typeof core.tailText>) => core.tailText(...args)
const formatElapsed = (ms: number) => core.formatElapsed(ms)

const ROOT = "ses_root"
const tree = (root: string, children: Array<{ id: string; title?: string; state: string; since?: number }> = [], since?: number) => [
  { id: ROOT, title: "Root", state: root, blockers: [], ...(since !== undefined ? { since } : {}) },
  ...children.map((c) => ({ blockers: [], ...c })),
]
const tool = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, kind: "tool", tool: "shell", summary: "bun test", state: "running", at, ...extra })

describe("streamed reasoning", () => {
  test("reasoning deltas fill a running Thinking row with its text; the row stays as Thought when done", () => {
    const feed = new ActivityFeed(ROOT)
    feed.reasoning(ROOT, "msg_1", "Let me look ", 10)
    feed.reasoning(ROOT, "msg_1", "at the tests.", 11)
    expect(feed.rows()).toEqual([
      { key: "thinking:msg_1", depth: 0, kind: "thinking", label: "Thinking…", state: "running", sessionID: ROOT, text: "Let me look at the tests." },
    ])
    // the hub's activity item for the same stretch merges into it (same id)
    feed.activity(ROOT, { id: "thinking:msg_1", kind: "thinking", state: "done", at: 12 })
    expect(feed.rows()[0]).toMatchObject({ kind: "thinking", label: "Thought", state: "done", text: "Let me look at the tests." })
  })

  test("reasoning text is capped, keeping the newest part", () => {
    const feed = new ActivityFeed(ROOT, { maxText: 100 })
    feed.reasoning(ROOT, "msg_1", "a".repeat(80), 1)
    feed.reasoning(ROOT, "msg_1", "b".repeat(80), 2)
    const text = feed.rows()[0]!.text!
    expect(text.length).toBe(100)
    expect(text.endsWith("b".repeat(80))).toBe(true)
  })

  test("a subagent's reasoning nests under it", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(tree("working", [{ id: "kid", title: "Explore", state: "working" }]), 1)
    feed.reasoning("kid", "msg_k", "hmm", 2)
    expect(feed.rows().map((r) => [r.depth, r.kind, r.text ?? null])).toEqual([
      [0, "subagent", null],
      [1, "thinking", "hmm"],
    ])
  })
})

describe("streamed text", () => {
  test("a subagent row shows its latest non-empty output line", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(tree("working", [{ id: "kid", title: "Fix tests", state: "working" }]), 1)
    feed.text("kid", "msg_k", "Looking at the failures.\nFound ", 2)
    expect(feed.rows()[0]).toMatchObject({ kind: "subagent", line: "Found" })
    feed.text("kid", "msg_k", "3 failing tests.\n\n", 3)
    expect(feed.rows()[0]!.line).toBe("Found 3 failing tests.")
    feed.text("kid", "msg_k", `${"x".repeat(300)}`, 4)
    expect(feed.rows()[0]!.line!.length).toBeLessThanOrEqual(160)
  })

  test("text from an unknown child creates a working placeholder subagent", () => {
    const feed = new ActivityFeed(ROOT)
    feed.text("kid", "msg_k", "hello", 1)
    expect(feed.rows()).toEqual([{ key: "sub:kid", depth: 0, kind: "subagent", label: "kid", state: "working", sessionID: "kid", line: "hello" }])
  })

  test("text in a session ends its running thinking", () => {
    const feed = new ActivityFeed(ROOT)
    feed.reasoning(ROOT, "msg_1", "plan", 1)
    feed.text(ROOT, "msg_1", "Sure", 2)
    expect(feed.rows()[0]).toMatchObject({ kind: "thinking", state: "done" })
  })
})

describe("pulse", () => {
  test("idle with no activity: not busy, Idle, no lastAt", () => {
    expect(new ActivityFeed(ROOT).pulse()).toEqual({ busy: false, blocked: false, label: "Idle", since: undefined, lastAt: undefined })
  })

  test("working root without details is Working, timed from the status tree's since", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(tree("working", [], 1000), 1000)
    expect(feed.pulse()).toMatchObject({ busy: true, label: "Working", since: 1000 })
  })

  test("without since, the time the feed first saw the tree busy is used", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(tree("working"), 5000)
    feed.status(tree("working"), 6000)
    expect(feed.pulse().since).toBe(5000)
    feed.status(tree("idle"), 7000)
    feed.status(tree("working"), 8000)
    expect(feed.pulse().since).toBe(8000)
  })

  test("the newest root step wins: Thinking, Writing reply, Running <tool>", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(tree("working", [], 1), 1)
    feed.reasoning(ROOT, "msg_1", "hmm", 2)
    expect(feed.pulse().label).toBe("Thinking")
    feed.text(ROOT, "msg_1", "I'll run the tests.", 3)
    expect(feed.pulse().label).toBe("Writing reply")
    feed.activity(ROOT, tool("t1", 4))
    expect(feed.pulse().label).toBe("Running shell · bun test")
    // finished tool, nothing newer: just Working (the earlier text is stale)
    feed.activity(ROOT, tool("t1", 5, { state: "done" }))
    expect(feed.pulse().label).toBe("Working")
    feed.text(ROOT, "msg_2", "All green.", 6)
    expect(feed.pulse().label).toBe("Writing reply")
  })

  test("working subagents are counted, and alone they make the session busy", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(tree("idle", [{ id: "a", title: "Fix tests", state: "working", since: 50 }]), 100)
    expect(feed.pulse()).toMatchObject({ busy: true, label: "Subagent “Fix tests” working", since: 50 })
    feed.status(tree("working", [
      { id: "a", title: "Fix tests", state: "working", since: 50 },
      { id: "b", title: "Docs", state: "working", since: 70 },
    ], 40), 110)
    expect(feed.pulse()).toMatchObject({ label: "2 subagents working", since: 40 })
    feed.reasoning(ROOT, "msg_1", "waiting", 120)
    expect(feed.pulse().label).toBe("Thinking · 2 subagents working")
  })

  test("blocked trees are not busy but blocked; idle reports the last activity time", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(tree("blocked"), 10)
    expect(feed.pulse()).toMatchObject({ busy: false, blocked: true, label: "Needs you" })
    feed.activity(ROOT, tool("t1", 20, { state: "done" }))
    feed.text(ROOT, "msg_1", "done", 30)
    feed.status(tree("idle"), 40)
    expect(feed.pulse()).toMatchObject({ busy: false, blocked: false, label: "Idle", lastAt: 40 })
  })
})

describe("helpers", () => {
  test("tailText keeps the last lines (and characters) for the collapsed Thinking block", () => {
    expect(tailText("a\nb\n\nc\nd\ne\n", 4)).toBe("b\nc\nd\ne")
    expect(tailText("  only  ", 4)).toBe("only")
    expect(tailText("x".repeat(1000), 4, 100)).toBe(`…${"x".repeat(99)}`)
    expect(tailText(undefined, 4)).toBe("")
  })

  test("formatElapsed: 0s, 12s, 3m 05s, 1h 02m", () => {
    expect(formatElapsed(-5)).toBe("0s")
    expect(formatElapsed(12_400)).toBe("12s")
    expect(formatElapsed(185_000)).toBe("3m 05s")
    expect(formatElapsed(3_720_000)).toBe("1h 02m")
  })
})
