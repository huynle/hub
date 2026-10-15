// Right-rail summary of a session: context usage, MCP servers, working-tree changes and per-file patches.
import { describe, expect, test } from "bun:test"
import { changeStats, contextUsage, filePatch, mcpServers, MAX_PATCH_CHARS } from "../src/spoke/summary"

/** Patches are capped by their JSON-encoded size so a reply always fits in one protocol frame. */
const ENCODED_LIMIT = 400 * 1024

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
    expect(big?.patch.length).toBe(MAX_PATCH_CHARS - 2)
    expect(MAX_PATCH_CHARS).toBe(ENCODED_LIMIT)
    expect(big?.truncated).toBe(true)
  })

  test("filePatch caps the JSON-encoded size, so quotes and backslashes cannot blow the frame limit", () => {
    const patch = '"\\'.repeat(300_000)
    const out = filePatch([{ file: "q", status: "modified", additions: 1, deletions: 0, patch }], "q")
    expect(out?.truncated).toBe(true)
    expect(JSON.stringify(out?.patch).length).toBeLessThanOrEqual(ENCODED_LIMIT)
    expect(patch.startsWith(out!.patch)).toBe(true)
    expect(out!.patch.length).toBeGreaterThan(ENCODED_LIMIT / 2 - 10)
    expect(JSON.stringify(out).length).toBeLessThan(1_000_000)
  })

  test("filePatch counts control characters at their escaped size", () => {
    const patch = "\u0001".repeat(200_000)
    const out = filePatch([{ file: "c", status: "modified", additions: 1, deletions: 0, patch }], "c")
    expect(out?.truncated).toBe(true)
    expect(JSON.stringify(out?.patch).length).toBeLessThanOrEqual(ENCODED_LIMIT)
  })

  test("filePatch never splits a surrogate pair when truncating", () => {
    const patch = "a" + "😀".repeat(MAX_PATCH_CHARS)
    const out = filePatch([{ file: "e", status: "modified", additions: 1, deletions: 0, patch }], "e")
    expect(out?.truncated).toBe(true)
    const last = out!.patch.charCodeAt(out!.patch.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    expect(out!.patch.length % 2).toBe(1)
  })
})
