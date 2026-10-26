// The create-hub-extension scaffold (packages/spoke-sdk/scaffold.ts): it writes a minimal HarnessSpoke spoke and its
// conformance driver for a new harness, and what it writes passes the spoke conformance suite as it is.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CHECK_IDS, runConformance } from "../../conformance/src/index.ts"
import { FAKE_TIMING } from "../../conformance/test/helpers.ts"
import { scaffoldMain, scaffoldSpoke, SCAFFOLD_FILES, sessionNamespace } from "../scaffold.ts"

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-scaffold-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) } }
}

describe("scaffoldSpoke", () => {
  test("writes the spoke, its conformance driver and a README for the harness", () => {
    const dir = path.join(tempDir(), "my-agent-spoke")
    const result = scaffoldSpoke({ name: "my-agent", dir })
    expect(result).toEqual({ dir, harness: "my-agent", namespace: "my", files: [...SCAFFOLD_FILES] })
    for (const file of SCAFFOLD_FILES) expect(existsSync(path.join(dir, file))).toBe(true)
    const spoke = readFileSync(path.join(dir, "spoke.ts"), "utf8")
    expect(spoke).toContain('export const HARNESS = "my-agent"')
    expect(spoke).toContain('export const SESSION_NAMESPACE = "my"')
    expect(spoke).toContain("class MyAgentSpoke")
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toContain("hub-conformance spoke --driver")
  })

  test("imports the hub's packages by a path that resolves from the files' real location (tmp dirs are symlinked on macOS)", () => {
    const dir = path.join(tempDir(), "deep", "er")
    scaffoldSpoke({ name: "demo", dir })
    for (const file of ["spoke.ts", "driver.ts"]) {
      const source = readFileSync(path.join(dir, file), "utf8")
      const specs = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!).filter((s) => !s.startsWith("node:") && !s.startsWith("./"))
      expect(specs.length).toBeGreaterThan(0)
      for (const spec of specs) expect({ spec, exists: existsSync(path.resolve(realpathSync(dir), spec)) }).toEqual({ spec, exists: true })
    }
  })

  test("refuses names a hello would refuse, and the built-in harness names", () => {
    const dir = tempDir()
    for (const name of ["", "My-Agent", "-x", "has space", "a/b", "x".repeat(65)]) {
      expect(() => scaffoldSpoke({ name, dir: path.join(dir, "n") })).toThrow(/harness id/)
    }
    for (const name of ["opencode", "claude-code", "codex"]) expect(() => scaffoldSpoke({ name, dir: path.join(dir, "n") })).toThrow(/built-in harness/)
    expect(existsSync(path.join(dir, "n"))).toBe(false)
  })

  test("never writes into a directory that has files, and leaves it as it was", () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "keep.txt"), "mine")
    expect(() => scaffoldSpoke({ name: "demo", dir })).toThrow(/not empty/)
    expect(readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("mine")
    expect(existsSync(path.join(dir, "spoke.ts"))).toBe(false)
    const empty = path.join(dir, "empty")
    mkdirSync(empty)
    expect(scaffoldSpoke({ name: "demo", dir: empty }).files).toEqual([...SCAFFOLD_FILES])
  })

  test("session namespace: two letters from the name, padded; a taken or invalid one is refused", () => {
    expect(sessionNamespace("my-agent")).toBe("my")
    expect(sessionNamespace("x1")).toBe("xx")
    expect(sessionNamespace("42")).toBe("xx")
    expect(sessionNamespace("a.b.c")).toBe("ab")
    const dir = tempDir()
    // ses_cc… is Claude Code's, ses_cx… Codex's, ses_pr… the preset spoke's, ses_cf… the conformance reference.
    for (const name of ["ccbot", "cxtool", "prompter", "cfg"]) expect(() => scaffoldSpoke({ name, dir: path.join(dir, name) })).toThrow(/--namespace/)
    expect(scaffoldSpoke({ name: "ccbot", dir: path.join(dir, "ok"), namespace: "cb" }).namespace).toBe("cb")
    expect(() => scaffoldSpoke({ name: "demo", dir: path.join(dir, "bad"), namespace: "C1" })).toThrow(/two lowercase letters/)
  })
})

describe("scaffoldMain (bun packages/spoke-sdk/scaffold.ts <name> <dir>)", () => {
  test("writes the files and prints the next steps", () => {
    const dir = path.join(tempDir(), "out")
    const { out, err, io: streams } = io()
    expect(scaffoldMain(["demo", dir], streams)).toBe(0)
    expect(err).toEqual([])
    expect(out.join("")).toContain(path.join(dir, "driver.ts"))
    expect(out.join("")).toContain("hub-conformance spoke --driver")
  })

  test("--namespace picks the session namespace", () => {
    const dir = path.join(tempDir(), "out")
    const { io: streams } = io()
    expect(scaffoldMain(["ccbot", dir, "--namespace", "cb"], streams)).toBe(0)
    expect(readFileSync(path.join(dir, "spoke.ts"), "utf8")).toContain('SESSION_NAMESPACE = "cb"')
  })

  test("usage errors exit 2, refusals exit 1, each with the reason", () => {
    const dir = tempDir()
    const usage = io()
    expect(scaffoldMain([], usage.io)).toBe(2)
    expect(usage.err.join("")).toContain("Usage:")
    const extra = io()
    expect(scaffoldMain(["demo", dir, "--bogus"], extra.io)).toBe(2)
    const refused = io()
    expect(scaffoldMain(["codex", path.join(dir, "x")], refused.io)).toBe(1)
    expect(refused.err.join("")).toMatch(/built-in harness/)
  })
})

describe("the scaffolded spoke", () => {
  test(
    "passes the spoke conformance suite as written (permission skipped: not announced)",
    async () => {
      const dir = path.join(tempDir(), "demo-spoke")
      scaffoldSpoke({ name: "demo", dir })
      const report = await runConformance({ driver: [process.execPath, path.join(dir, "driver.ts")], ...FAKE_TIMING })
      const statuses = Object.fromEntries(report.checks.map((c) => [c.id, c.status === "fail" ? `fail: ${c.problems.join("; ")}` : c.status]))
      expect(statuses).toEqual(Object.fromEntries(CHECK_IDS.map((id) => [id, id === "permission" ? "skip" : "pass"])))
      expect(report.ok).toBe(true)
      expect(report).toMatchObject({ harness: "demo", evidence: "hooks" })
      expect(report.features).toEqual(expect.arrayContaining(["interrupt", "stop", "deliver", "sessionTokens", "actTokens"]))
    },
    60_000,
  )
})
