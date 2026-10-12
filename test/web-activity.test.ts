// Live activity feed: SSE activity items + status trees → compact rows (subagent tool calls nested under the subagent).
import { describe, expect, test } from "bun:test"
import { ActivityFeed } from "../web/feedback-core.js"

const ROOT = "ses_root"
const tool = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, kind: "tool", tool: "shell", summary: `cmd ${id}`, state: "running", at, ...extra })
const thinking = (id: string, at: number, state = "running") => ({ id, kind: "thinking", state, at })
const status = (children: Array<{ id: string; title?: string; state: string }>, root = "working") => [
  { id: ROOT, title: "Root", state: root, blockers: [] },
  ...children.map((c) => ({ blockers: [], ...c })),
]
const brief = (feed: ActivityFeed) => feed.rows().map((r) => `${"  ".repeat(r.depth)}${r.kind}:${r.label}:${r.state}${r.error ? `:${r.error}` : ""}`)

describe("ActivityFeed", () => {
  test("tool calls stream in order and update in place by id (dedupe)", () => {
    const feed = new ActivityFeed(ROOT)
    feed.activity(ROOT, tool("t1", 1))
    feed.activity(ROOT, tool("t2", 2, { tool: "read", summary: "src/a.ts" }))
    feed.activity(ROOT, tool("t1", 3, { state: "done" }))
    feed.activity(ROOT, tool("t2", 4, { tool: "read", summary: "src/a.ts", state: "failed", error: "ENOENT" }))
    expect(brief(feed)).toEqual(["tool:shell · cmd t1:done", "tool:read · src/a.ts:failed:ENOENT"])
  })

  test("a tool without a summary is labeled by its name", () => {
    const feed = new ActivityFeed(ROOT)
    feed.activity(ROOT, tool("t1", 1, { summary: undefined }))
    expect(feed.rows()[0]!.label).toBe("shell")
  })

  test("thinking shows while running and disappears when done or when the session moves on", () => {
    const feed = new ActivityFeed(ROOT)
    feed.activity(ROOT, thinking("r1", 1))
    expect(brief(feed)).toEqual(["thinking:Thinking…:running"])
    feed.activity(ROOT, tool("t1", 2))
    expect(brief(feed)).toEqual(["tool:shell · cmd t1:running"])
    feed.activity(ROOT, thinking("r2", 3))
    feed.activity(ROOT, thinking("r2", 4, "done"))
    expect(brief(feed)).toEqual(["tool:shell · cmd t1:running"])
  })

  test("subagents appear from status with their own activity nested under them", () => {
    const feed = new ActivityFeed(ROOT)
    feed.activity(ROOT, tool("task1", 1, { tool: "task", summary: "fix tests" }))
    feed.status(status([{ id: "ses_child", title: "Fix tests", state: "working" }]), 2)
    feed.activity("ses_child", tool("c1", 3, { summary: "bun test" }))
    feed.activity(ROOT, thinking("r1", 4))
    expect(brief(feed)).toEqual([
      "tool:task · fix tests:running",
      "subagent:Fix tests:working",
      "  tool:shell · bun test:running",
      "thinking:Thinking…:running",
    ])
    feed.status(status([{ id: "ses_child", title: "Fix tests", state: "idle" }]), 5)
    expect(brief(feed)[1]).toBe("subagent:Fix tests:done")
  })

  test("activity from an unknown child session creates a placeholder subagent that status names later", () => {
    const feed = new ActivityFeed(ROOT)
    feed.activity("ses_kid", tool("c1", 1))
    expect(brief(feed)).toEqual(["subagent:ses_kid:working", "  tool:shell · cmd c1:running"])
    feed.status(status([{ id: "ses_kid", title: "Explore", state: "working" }]), 2)
    expect(brief(feed)[0]).toBe("subagent:Explore:working")
  })

  test("a subagent that drops out of the status tree is done; errors are failed; blocked needs you", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(status([
      { id: "a", title: "A", state: "working" },
      { id: "b", title: "B", state: "working" },
      { id: "c", title: "C", state: "working" },
    ]), 1)
    feed.status(status([
      { id: "b", title: "B", state: "error" },
      { id: "c", title: "C", state: "blocked" },
    ]), 2)
    expect(brief(feed)).toEqual(["subagent:A:done", "subagent:B:failed", "subagent:C:blocked"])
  })

  test("idle children never seen working are not shown", () => {
    const feed = new ActivityFeed(ROOT)
    feed.status(status([{ id: "old", title: "Old", state: "idle" }], "idle"), 1)
    expect(feed.rows()).toEqual([])
  })

  test("caps items at max, evicting the oldest finished ones first", () => {
    const feed = new ActivityFeed(ROOT, { max: 30 })
    feed.activity(ROOT, tool("long", 0)) // still running: kept
    for (let i = 1; i <= 34; i++) feed.activity(ROOT, tool(`t${i}`, i, { state: "done" }))
    const labels = feed.rows().map((r) => r.label)
    expect(labels.length).toBe(30)
    expect(labels[0]).toBe("shell · cmd long")
    expect(labels[1]).toBe("shell · cmd t6")
    expect(labels[29]).toBe("shell · cmd t34")
  })

  test("initial load merges with live items by time and ignores duplicates", () => {
    const feed = new ActivityFeed(ROOT)
    feed.activity(ROOT, tool("t3", 30))
    feed.load([
      { ...tool("t1", 10, { state: "done" }), sessionID: ROOT },
      { ...tool("t3", 30), sessionID: ROOT },
      { ...tool("c1", 20, { state: "done" }), sessionID: "ses_child" },
    ])
    expect(brief(feed)).toEqual(["tool:shell · cmd t1:done", "subagent:ses_child:working", "  tool:shell · cmd c1:done", "tool:shell · cmd t3:running"])
  })

  test("when the root goes idle with no subagent working, leftover running items settle as done", () => {
    const feed = new ActivityFeed(ROOT)
    feed.activity(ROOT, tool("t1", 1))
    feed.activity(ROOT, thinking("r1", 2))
    feed.status(status([], "idle"), 3)
    expect(brief(feed)).toEqual(["tool:shell · cmd t1:done"])
  })

  test("now() is the newest running item, else a working subagent, else undefined", () => {
    const feed = new ActivityFeed(ROOT)
    expect(feed.now()).toBeUndefined()
    feed.activity(ROOT, tool("t1", 1))
    expect(feed.now()).toBe("shell · cmd t1")
    feed.status(status([{ id: "kid", title: "Kid", state: "working" }]), 2)
    feed.activity("kid", thinking("r1", 3))
    expect(feed.now()).toBe("Thinking…")
    feed.activity("kid", thinking("r1", 4, "done"))
    feed.activity(ROOT, tool("t1", 5, { state: "done" }))
    expect(feed.now()).toBe("Subagent: Kid")
    feed.status(status([{ id: "kid", title: "Kid", state: "idle" }], "idle"), 6)
    expect(feed.now()).toBeUndefined()
  })
})
