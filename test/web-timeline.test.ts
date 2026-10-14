import { describe, expect, test } from "bun:test"
import { ModelCatalog, Timeline } from "../web/timeline-core.js"

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
