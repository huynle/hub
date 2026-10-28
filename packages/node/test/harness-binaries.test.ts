// Which harness binary hub's spokes, wrappers and the node run (HBS-13 integration item 5):
//   Claude Code  HUB_CLAUDE_BIN > `binary` in hub's own claude-code.json (next to config.json, which follows
//                HUB_SPOKE_CONFIG; written by `hubctl setup` when it installed Claude Code) > `claude` on PATH
//   Codex        HUB_CODEX_BIN > the hub-installed data/hub/harnesses/codex/current/bin/codex (when it is there) >
//                `codex` on PATH
// and the node's host runtime offers codex when that binary is found, as it does claude-code.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { claudeBinary, codexBinary, detectHarnesses } from "../src/harnesses.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-node-bins-"))
  dirs.push(dir)
  return dir
}
function exe(file: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, "#!/bin/sh\nexit 0\n")
  chmodSync(file, 0o755)
  return file
}

describe("claudeBinary", () => {
  test("HUB_CLAUDE_BIN, then claude-code.json's binary, then claude", () => {
    const h = home()
    expect(claudeBinary({}, h)).toBe("claude")
    const hubInstalled = exe(path.join(h, ".local/share/hub/harnesses/claude-code/current/claude"))
    writeFileSync(path.join(mkdirp(path.join(h, ".config/hub")), "claude-code.json"), JSON.stringify({ binary: hubInstalled, other: 1 }))
    expect(claudeBinary({}, h)).toBe(hubInstalled)
    expect(claudeBinary({ HUB_CLAUDE_BIN: "/opt/claude" }, h)).toBe("/opt/claude")
  })

  test("claude-code.json follows HUB_SPOKE_CONFIG; a relative or missing binary is ignored", () => {
    const h = home()
    const elsewhere = mkdirp(path.join(h, "elsewhere"))
    const bin = exe(path.join(h, "bin/claude"))
    writeFileSync(path.join(elsewhere, "claude-code.json"), JSON.stringify({ binary: bin }))
    expect(claudeBinary({ HUB_SPOKE_CONFIG: path.join(elsewhere, "config.json") }, h)).toBe(bin)
    writeFileSync(path.join(elsewhere, "claude-code.json"), JSON.stringify({ binary: "claude-relative" }))
    expect(claudeBinary({ HUB_SPOKE_CONFIG: path.join(elsewhere, "config.json") }, h)).toBe("claude")
    writeFileSync(path.join(elsewhere, "claude-code.json"), "{not json")
    expect(claudeBinary({ HUB_SPOKE_CONFIG: path.join(elsewhere, "config.json") }, h)).toBe("claude")
  })
})

describe("codexBinary", () => {
  test("HUB_CODEX_BIN, then hub's current Codex (XDG_DATA_HOME honoured), then codex", () => {
    const h = home()
    expect(codexBinary({}, h)).toBe("codex")
    const current = exe(path.join(h, ".local/share/hub/harnesses/codex/current/bin/codex"))
    expect(codexBinary({}, h)).toBe(current)
    expect(codexBinary({ HUB_CODEX_BIN: "/opt/codex" }, h)).toBe("/opt/codex")
    const data = mkdirp(path.join(h, "data"))
    expect(codexBinary({ XDG_DATA_HOME: data }, h)).toBe("codex")
  })
})

describe("detectHarnesses offers codex when its binary is found", () => {
  test("codex on PATH or hub-installed", () => {
    const h = home()
    const bin = mkdirp(path.join(h, "bin"))
    expect(detectHarnesses({ env: { PATH: bin, HOME: h }, home: h })).toEqual(["opencode"])
    exe(path.join(h, ".local/share/hub/harnesses/codex/current/bin/codex"))
    expect(detectHarnesses({ env: { PATH: bin, HOME: h }, home: h })).toEqual(["opencode", "codex"])
    expect(detectHarnesses({ env: { PATH: bin, HOME: h }, home: h, overrides: { codex: false } })).toEqual(["opencode"])
  })
})

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}
