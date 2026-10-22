import { describe, expect, test } from "bun:test"
import { timelineItems } from "../src/spoke/timeline"
import session from "./fixtures/timeline-subagents-session.json"

// The fixture is a trimmed, anonymised copy of a real OpenCode v2 session (texts and commands replaced): one user
// turn spawning five background subagents, later turns spawning more, completion messages (synthetic) between
// them, messages with reasoning before text and text before tools.
const items = timelineItems("root", session as unknown[])

describe("timelineItems ordering position", () => {
  test("every row has a position that increases in the order of the session's messages and their parts", () => {
    expect(items.length).toBeGreaterThan(50)
    for (const item of items) expect(typeof item.pos).toBe("number")
    for (let i = 1; i < items.length; i++) expect(items[i]!.pos!).toBeGreaterThan(items[i - 1]!.pos!)
  })

  test("text that has no part time stays after the reasoning before it in the same message", () => {
    // msg_002: reasoning, text, shell. The text gets the message time (earlier than the reasoning's own time).
    const rows = items.filter((i) => i.messageID === "msg_002")
    expect(rows.map((r) => r.kind)).toEqual(["reasoning", "assistant", "tool"])
    expect(rows[1]!.at!).toBeLessThan(rows[0]!.at!)
    expect(rows[1]!.pos!).toBeGreaterThan(rows[0]!.pos!)
  })

  test("a later message with an earlier creation time (a queued prompt) keeps its place in the session", () => {
    const rows = timelineItems("s", [
      { id: "a1", type: "assistant", time: { created: 5000 }, content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
      { id: "u2", type: "user", time: { created: 4000 }, text: "steer" },
      { id: "a3", type: "assistant", time: { created: 5000 }, content: [{ type: "text", text: "three" }] },
    ])
    expect(rows.map((r) => r.text)).toEqual(["one", "two", "steer", "three"])
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.pos!).toBeGreaterThan(rows[i - 1]!.pos!)
  })

  test("positions do not depend on the messages before them (they stay valid when the history window moves)", () => {
    const tail = (session as unknown[]).slice(40)
    const shifted = timelineItems("root", tail)
    const full = new Map(items.map((i) => [i.key, i.pos]))
    for (const item of shifted) expect(item.pos).toBe(full.get(item.key)!)
  })
})

describe("timelineItems subagent spawns", () => {
  test("subagent tool rows carry the child session and its description", () => {
    const spawns = items.filter((i) => i.childSessionID)
    expect(spawns.map((s) => s.title)).toEqual([
      "C4 wait_for and events",
      "C2 wake from sleep",
      "C6 boot-time keys",
      "C7 OS playbooks",
      "S8 Mac helper bridge",
      "S1 screen settle",
      "S5 ask a human",
      "Fix flaky media lease test",
      "S3 macros",
      "S6 batching and caching",
      "Release 0.3.0 build+OTA+HIL",
      "EDID write retry fix",
    ])
    expect(spawns[0]).toMatchObject({ kind: "tool", name: "subagent", childSessionID: "ses_child01", callID: expect.stringMatching(/^toolu_/) })
  })

  test("the child session is read from the output when the metadata lacks it, for task tools too", () => {
    const rows = timelineItems("s", [
      {
        id: "a1",
        type: "assistant",
        time: { created: 1 },
        content: [
          { type: "tool", id: "c1", name: "task", state: { status: "completed", input: { description: "Explore" }, output: "task_id: x\nsessionID: ses_abc123 done" } },
          { type: "tool", id: "c2", name: "subagent", state: { status: "running", input: { description: "Build" }, content: [{ type: "text", text: "working (sessionID: ses_def456)." }] } },
          { type: "tool", id: "c3", name: "shell", state: { status: "completed", input: { command: "ls" }, metadata: { sessionID: "ses_nope" } } },
        ],
      },
    ])
    expect(rows.map((r) => [r.callID, r.childSessionID, r.title])).toEqual([
      ["c1", "ses_abc123", "Explore"],
      ["c2", "ses_def456", "Build"],
      ["c3", undefined, undefined],
    ])
  })

  test("text rows count their text parts (the ordinal of live text deltas)", () => {
    const rows = timelineItems("s", [{ id: "a1", type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "a" }, { type: "tool", id: "t", name: "read", state: { status: "completed" } }, { type: "text", text: "b" }] }])
    expect(rows.filter((r) => r.kind === "assistant").map((r) => r.ordinal)).toEqual([0, 1])
  })
})
