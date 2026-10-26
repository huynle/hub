// Which harnesses the host runtime offers (hello runtimes[host].harnesses): OpenCode always (its service spoke is
// the OpenCode plugin), Claude Code when its CLI is found (HUB_CLAUDE_BIN, else `claude` on PATH), and node.json
// `harnesses` overriding either way. Placement still needs each harness's connected service spoke with "launch".
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { detectHarnesses, findExecutable } from "../src/harnesses.ts"

function binDir(...names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-node-bin-"))
  for (const name of names) {
    writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n")
    chmodSync(path.join(dir, name), 0o755)
  }
  return dir
}

describe("findExecutable", () => {
  test("finds a name on PATH, skipping directories without it and files that are not executable", () => {
    const empty = binDir()
    const plain = binDir()
    writeFileSync(path.join(plain, "claude"), "not executable")
    const good = binDir("claude")
    expect(findExecutable("claude", { PATH: [empty, plain, good].join(path.delimiter) })).toBe(path.join(good, "claude"))
    expect(findExecutable("claude", { PATH: [empty, plain].join(path.delimiter) })).toBeUndefined()
    expect(findExecutable("claude", {})).toBeUndefined()
  })

  test("an absolute path is checked as it is; a directory is not an executable", () => {
    const good = binDir("claude")
    expect(findExecutable(path.join(good, "claude"), {})).toBe(path.join(good, "claude"))
    expect(findExecutable(path.join(good, "missing"), {})).toBeUndefined()
    mkdirSync(path.join(good, "dir"))
    expect(findExecutable(path.join(good, "dir"), { PATH: good })).toBeUndefined()
  })
})

describe("detectHarnesses", () => {
  test("opencode alone when no claude is found", () => {
    expect(detectHarnesses({ env: { PATH: binDir() } })).toEqual(["opencode"])
  })

  test("claude-code when `claude` is on PATH", () => {
    expect(detectHarnesses({ env: { PATH: binDir("claude") } })).toEqual(["opencode", "claude-code"])
  })

  test("HUB_CLAUDE_BIN names the CLI instead of PATH (absolute, or a name looked up on PATH)", () => {
    const dir = binDir("my-claude")
    expect(detectHarnesses({ env: { PATH: binDir("claude"), HUB_CLAUDE_BIN: path.join(dir, "gone") } })).toEqual(["opencode"])
    expect(detectHarnesses({ env: { PATH: binDir(), HUB_CLAUDE_BIN: path.join(dir, "my-claude") } })).toEqual(["opencode", "claude-code"])
    expect(detectHarnesses({ env: { PATH: dir, HUB_CLAUDE_BIN: "my-claude" } })).toEqual(["opencode", "claude-code"])
  })

  test("node.json overrides: false withholds a detected harness, true offers one detection missed", () => {
    const env = { PATH: binDir("claude") }
    expect(detectHarnesses({ env, overrides: { "claude-code": false } })).toEqual(["opencode"])
    expect(detectHarnesses({ env, overrides: { opencode: false } })).toEqual(["claude-code"])
    expect(detectHarnesses({ env: { PATH: binDir() }, overrides: { "claude-code": true, codex: true, aider: true } })).toEqual(["opencode", "claude-code", "codex", "aider"])
  })
})
