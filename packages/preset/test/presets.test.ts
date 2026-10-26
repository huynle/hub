import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { presetProblem, type HarnessPreset } from "../../protocol/src/index.ts"
import { findPreset, launchArgv, nativeIDFromScreen, OFFICIAL_PRESETS } from "../src/presets.ts"

const presetsDir = path.join(import.meta.dir, "..", "presets")
const tmp = () => mkdtempSync(path.join(tmpdir(), "hub-preset-test-"))
const CAT: HarnessPreset = { name: "cat", command: ["cat"], nativeID: { source: "none" }, delivery: "paste", evidence: "screen" }

describe("official presets", () => {
  test("every file in presets/ is a valid preset named after its file, and all of them are official", () => {
    const files = readdirSync(presetsDir).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const file of files) {
      const preset = JSON.parse(readFileSync(path.join(presetsDir, file), "utf8"))
      expect({ file, problem: presetProblem(preset) }).toEqual({ file, problem: undefined })
      expect(preset.name).toBe(file.replace(/\.json$/, ""))
    }
    expect(OFFICIAL_PRESETS.map((p) => p.name).sort()).toEqual(files.map((f) => f.replace(/\.json$/, "")).sort())
  })

  test("include aider and goose", () => {
    expect(OFFICIAL_PRESETS.map((p) => p.name)).toEqual(expect.arrayContaining(["aider", "goose"]))
  })
})

describe("findPreset", () => {
  test("a bare name is an official preset", () => {
    const found = findPreset("aider", { cwd: "/" })
    expect(found).toEqual({ preset: OFFICIAL_PRESETS.find((p) => p.name === "aider")!, source: "official" })
  })

  test("an unknown name is an error naming the official ones", () => {
    const found = findPreset("nope", { cwd: "/" })
    expect("error" in found && found.error).toContain("aider")
    expect("error" in found && found.error).toContain("nope")
  })

  test("a path (with a slash or .json) is read relative to cwd and validated", () => {
    const dir = tmp()
    writeFileSync(path.join(dir, "mine.json"), JSON.stringify(CAT))
    expect(findPreset("mine.json", { cwd: dir })).toEqual({ preset: CAT, source: path.join(dir, "mine.json") })
    expect(findPreset(`./mine.json`, { cwd: dir })).toEqual({ preset: CAT, source: path.join(dir, "mine.json") })
  })

  test("a file that is not JSON, missing or not a valid preset is an error saying why", () => {
    const dir = tmp()
    writeFileSync(path.join(dir, "bad.json"), "{nope")
    writeFileSync(path.join(dir, "shell.json"), JSON.stringify({ ...CAT, command: ["sh", "-c", "rm -rf ~; echo"] }))
    const bad = findPreset("bad.json", { cwd: dir })
    expect("error" in bad && bad.error).toMatch(/not JSON/)
    const missing = findPreset("missing.json", { cwd: dir })
    expect("error" in missing && missing.error).toMatch(/cannot read/)
    const shell = findPreset("shell.json", { cwd: dir })
    expect("error" in shell && shell.error).toMatch(/shell syntax/)
  })
})

describe("launchArgv", () => {
  const ids = () => "0b3a1c52-7f00-4d2e-9a43-111111111111"

  test("a preset without a native ID: its command, then the extra arguments", () => {
    expect(launchArgv(CAT, { args: ["-u", "a file"], newID: ids })).toEqual({ argv: ["cat", "-u", "a file"], nativeID: undefined })
  })

  test("an argv native ID: the hub passes a fresh ID with the flag, before the extra arguments", () => {
    const goose: HarnessPreset = { name: "goose", command: ["goose", "session"], nativeID: { source: "argv", flag: "--name" }, delivery: "paste", evidence: "screen" }
    expect(launchArgv(goose, { args: ["--debug"], newID: ids })).toEqual({ argv: ["goose", "session", "--name", ids(), "--debug"], nativeID: ids() })
  })

  test("a screen native ID is not known at launch", () => {
    const screen: HarnessPreset = { name: "s", command: ["s"], nativeID: { source: "screen", pattern: "session (\\w+)" }, delivery: "paste", evidence: "screen" }
    expect(launchArgv(screen, { newID: ids })).toEqual({ argv: ["s"], nativeID: undefined })
  })

  test("resume: command, resume flag and the ID; refused without a resume flag", () => {
    const resumable: HarnessPreset = { name: "r", command: ["r"], resumeFlag: "--resume", nativeID: { source: "screen", pattern: "id (\\w+)" }, delivery: "paste", evidence: "screen" }
    expect(launchArgv(resumable, { resume: "abc", args: ["-v"], newID: ids })).toEqual({ argv: ["r", "--resume", "abc", "-v"], nativeID: "abc" })
    expect(() => launchArgv(CAT, { resume: "abc", newID: ids })).toThrow(/cannot resume/)
  })

  test("refuses extra arguments with control characters (nothing is run through a shell, but a NUL would cut the argv)", () => {
    expect(() => launchArgv(CAT, { args: ["a\u0000b"], newID: ids })).toThrow(/control characters/)
  })
})

describe("nativeIDFromScreen", () => {
  const screen: HarnessPreset = { name: "s", command: ["s"], nativeID: { source: "screen", pattern: "session id: ([A-Za-z0-9_-]+)" }, delivery: "paste", evidence: "screen" }

  test("the first capture group of the first match", () => {
    expect(nativeIDFromScreen(screen, "hello\nsession id: 20251108_1\nsession id: other")).toBe("20251108_1")
  })

  test("undefined without a match, for other sources, and for an over-long ID", () => {
    expect(nativeIDFromScreen(screen, "nothing here")).toBeUndefined()
    expect(nativeIDFromScreen(CAT, "session id: x")).toBeUndefined()
    expect(nativeIDFromScreen(screen, `session id: ${"a".repeat(200)}`)).toBeUndefined()
  })
})
