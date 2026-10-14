// Right-rail summary of a session: context usage, MCP servers, working-tree changes and per-file patches.
import { describe, expect, test } from "bun:test"
import { changeStats, contextUsage, filePatch, mcpServers, MAX_PATCH_CHARS } from "../src/spoke/summary"

const tokens = (input: number, output = 0, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } })
const assistant = (model: { providerID: string; id: string }, t?: unknown) => ({ type: "assistant", model, ...(t ? { tokens: t } : {}) })
const models = [
  { providerID: "anthropic", modelID: "claude-opus", name: "Opus", limit: { context: 200_000, output: 32_000 } },
  { providerID: "openai", modelID: "gpt", name: "GPT" },
]

describe("contextUsage", () => {
  test("uses the latest assistant message with tokens against the model's context limit", () => {
    const messages = [
      assistant({ providerID: "anthropic", id: "claude-opus" }, tokens(1000)),
      { type: "user", text: "hi" },
      assistant({ providerID: "anthropic", id: "claude-opus" }, tokens(30_000, 2_000, 1_000, 15_000, 2_000)),
      assistant({ providerID: "anthropic", id: "claude-opus" }),
    ]
    expect(contextUsage(messages, models)).toEqual({ used: 50_000, limit: 200_000, percent: 25, model: "Opus" })
  })

  test("without a known limit reports tokens only; without tokens reports nothing", () => {
    expect(contextUsage([assistant({ providerID: "openai", id: "gpt" }, tokens(10))], models)).toEqual({ used: 10, model: "GPT" })
    expect(contextUsage([assistant({ providerID: "x", id: "y" }, tokens(10))], models)).toEqual({ used: 10 })
    expect(contextUsage([{ type: "user" }, "junk", null], models)).toBeUndefined()
  })

  test("percent is clamped to 0–100 and rounded", () => {
    expect(contextUsage([assistant({ providerID: "anthropic", id: "claude-opus" }, tokens(250_000))], models)?.percent).toBe(100)
    expect(contextUsage([assistant({ providerID: "anthropic", id: "claude-opus" }, tokens(333))], models)?.percent).toBe(0)
  })
})

describe("mcpServers", () => {
  test("normalizes names and statuses, keeping short errors", () => {
    expect(
      mcpServers([
        { name: "github", status: { status: "connected" } },
        { name: "brain", status: { status: "failed", error: "x".repeat(500) } },
        { name: "slack", status: { status: "needs_auth", error: "login" } },
        { status: { status: "connected" } },
        { name: "weird", status: { status: "exploded" } },
      ]),
    ).toEqual([
      { name: "github", status: "connected" },
      { name: "brain", status: "failed", error: "x".repeat(200) },
      { name: "slack", status: "needs_auth", error: "login" },
      { name: "weird", status: "unknown" },
    ])
  })
})

describe("changes", () => {
  const diffs = [
    { file: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ a" },
    { file: "src/b.ts", status: "added", additions: 5, deletions: 0, patch: "@@ b" },
    { file: 7, status: "modified" },
  ]

  test("changeStats lists files without patches and totals the lines", () => {
    expect(changeStats(diffs)).toEqual({
      files: [
        { file: "src/a.ts", status: "modified", additions: 10, deletions: 2 },
        { file: "src/b.ts", status: "added", additions: 5, deletions: 0 },
      ],
      additions: 15,
      deletions: 2,
    })
  })

  test("filePatch returns one file's patch, truncated at the cap", () => {
    expect(filePatch(diffs, "src/b.ts")).toEqual({ file: "src/b.ts", status: "added", additions: 5, deletions: 0, patch: "@@ b", truncated: false })
    expect(filePatch(diffs, "nope.ts")).toBeUndefined()
    const big = filePatch([{ file: "big", status: "modified", additions: 1, deletions: 1, patch: "y".repeat(MAX_PATCH_CHARS + 10) }], "big")
    expect(big?.patch.length).toBe(MAX_PATCH_CHARS)
    expect(big?.truncated).toBe(true)
  })
})
