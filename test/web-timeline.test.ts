import { describe, expect, test } from "bun:test"
import { ModelCatalog, Timeline } from "../web/src/core/timeline-core"

describe("ModelCatalog", () => {
  const models = [
    { providerID: "openai", modelID: "gpt-5", name: "GPT 5", variants: ["fast", "thinking"], enabled: true },
    { providerID: "anthropic", modelID: "claude-opus", name: "Claude Opus", variants: ["default"], enabled: true },
    { providerID: "anthropic", modelID: "claude-old", name: "Claude Old", variants: [], enabled: false },
  ]
  test("groups enabled models by provider, searches names and ids, and retains a stale selection", () => {
    const catalog = new ModelCatalog(models)
    expect(catalog.groups("").map((g) => [g.providerID, g.items.map((x) => x.modelID)])).toEqual([
      ["anthropic", ["claude-opus"]],
      ["openai", ["gpt-5"]],
    ])
    expect(catalog.groups("gpt")[0]!.items[0]!.variants).toEqual(["fast", "thinking"])
    expect(catalog.selection({ providerID: "missing", modelID: "gone", variant: "x" })).toMatchObject({ stale: true, name: "missing/gone", variants: ["x"] })
  })
})

describe("Timeline", () => {
  test("merges history and live updates by stable key in chronological order", () => {
    const timeline = new Timeline()
    timeline.load([
      { key: "u1:text", kind: "user", text: "hello", at: 1 },
      { key: "a1:0", kind: "reasoning", text: "Thinking", state: "running", at: 2 },
      { key: "a1:1", kind: "tool", name: "read", state: "running", at: 3 },
    ])
    timeline.upsert({ key: "a1:1", kind: "tool", name: "read", state: "done", completed: 6, at: 3 })
    timeline.upsert({ key: "a1:2", kind: "assistant", text: "Done.", at: 7 })
    expect(timeline.rows().map((x) => [x.key, x.state])).toEqual([
      ["u1:text", undefined], ["a1:0", "running"], ["a1:1", "done"], ["a1:2", undefined],
    ])
    timeline.load([{ key: "a1:1", kind: "tool", name: "read", state: "done", at: 3 }])
    expect(timeline.rows()).toHaveLength(4)
  })

  test("nests child rows under a subagent and remembers lazily loaded detail", () => {
    const timeline = new Timeline()
    timeline.status([{ id: "root", state: "working" }, { id: "child", parentID: "root", title: "Research", state: "working", since: 2 }], "root")
    timeline.load([{ key: "c1:0", sessionID: "child", kind: "tool", name: "websearch", state: "running", at: 3 }])
    expect(timeline.rows()).toEqual([
      expect.objectContaining({ key: "sub:child", kind: "subagent", label: "Research", state: "working", depth: 0 }),
      expect.objectContaining({ key: "c1:0", kind: "tool", depth: 1 }),
    ])
    timeline.detail("c1:0", { input: { query: "x" }, output: "full" })
    expect(timeline.rows()[1]!.detail).toEqual({ input: { query: "x" }, output: "full" })
  })
})

describe("Timeline: live reasoning", () => {
  test("streamed reasoning deltas accumulate into one thought with text", () => {
    const timeline = new Timeline()
    timeline.appendReasoning({ sessionID: "s", messageID: "m1", delta: "Look at ", at: 10 })
    timeline.appendReasoning({ sessionID: "s", messageID: "m1", delta: "the tests.", at: 11 })
    expect(timeline.rows().filter((r) => r.kind === "reasoning").map((r) => [r.text, r.state, r.at])).toEqual([["Look at the tests.", "running", 10]])
  })

  test("deltas go into the running history row of the same message instead of a second thought", () => {
    const timeline = new Timeline()
    timeline.load([{ key: "m1:0", messageID: "m1", sessionID: "s", kind: "reasoning", text: "", state: "running", at: 5 }])
    timeline.appendReasoning({ sessionID: "s", messageID: "m1", delta: "Thinking hard", at: 10 })
    const thoughts = timeline.rows().filter((r) => r.kind === "reasoning")
    expect(thoughts.map((r) => [r.key, r.text, r.at])).toEqual([["m1:0", "Thinking hard", 5]])
  })

  test("history loaded after live deltas replaces the live row, keeping the streamed text when the stored text is empty", () => {
    const timeline = new Timeline()
    timeline.appendReasoning({ sessionID: "s", messageID: "m1", delta: "Streamed reasoning", at: 10 })
    timeline.load([{ key: "m1:0", messageID: "m1", sessionID: "s", kind: "reasoning", text: "", state: "done", at: 9, completed: 20 }])
    const thoughts = timeline.rows().filter((r) => r.kind === "reasoning")
    expect(thoughts.map((r) => [r.key, r.text, r.state])).toEqual([["m1:0", "Streamed reasoning", "done"]])
    // Stored text wins when the provider shared it.
    const other = new Timeline()
    other.appendReasoning({ sessionID: "s", messageID: "m2", delta: "partial", at: 10 })
    other.load([{ key: "m2:0", messageID: "m2", sessionID: "s", kind: "reasoning", text: "full stored text", state: "done", at: 9, completed: 20 }])
    expect(other.rows().filter((r) => r.kind === "reasoning").map((r) => r.text)).toEqual(["full stored text"])
  })

  test("ending reasoning marks running thoughts of that session done with a completion time", () => {
    const timeline = new Timeline()
    timeline.appendReasoning({ sessionID: "s", messageID: "m1", delta: "x", at: 10 })
    timeline.appendReasoning({ sessionID: "kid", messageID: "k1", delta: "y", at: 10 })
    timeline.endReasoning("s", 4010)
    expect(timeline.rows().map((r) => [r.sessionID, r.state, r.completed])).toEqual([["s", "done", 4010], ["kid", "running", undefined]])
    timeline.endReasoning(undefined, 5000)
    expect(timeline.rows().map((r) => r.state)).toEqual(["done", "done"])
  })
})
