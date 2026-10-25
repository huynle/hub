// Harness presets: data-only descriptions of a harness the hub drives through a terminal (P7-T1, design §1.2).
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"

const P = protocol as any
const aider = {
  name: "aider",
  description: "Aider in a terminal pane",
  command: ["aider", "--no-auto-commits"],
  resumeFlag: "--restore-chat-history",
  nativeID: { source: "screen", pattern: "Session: ([A-Za-z0-9-]+)" },
  delivery: "paste",
  evidence: "screen",
}
const problem = (v: unknown): string | undefined => P.presetProblem(v)
const refused = (extra: Record<string, unknown>) => expect(problem({ ...aider, ...extra })).toBeString()
const accepted = (extra: Record<string, unknown>) => expect(problem({ ...aider, ...extra })).toBeUndefined()

describe("presetProblem", () => {
  test("accepts a well-formed preset", () => {
    expect(problem(aider)).toBeUndefined()
    expect(P.isHarnessPreset(aider)).toBe(true)
    const { description: _d, resumeFlag: _r, ...minimal } = aider
    expect(problem({ ...minimal, nativeID: { source: "none" } })).toBeUndefined()
  })

  test("refuses non-objects and unknown fields", () => {
    for (const v of [null, "aider", [], 5]) expect(problem(v)).toBeString()
    expect(problem({ ...aider, env: { OPENAI_API_KEY: "x" } })).toContain("env")
    refused({ shell: true })
    refused({ nativeID: { source: "none", extra: 1 } })
  })

  test("the name is a harness token and not a built-in harness", () => {
    for (const name of ["opencode", "claude-code", "codex"]) {
      expect(P.RESERVED_HARNESS_NAMES).toContain(name)
      expect(problem({ ...aider, name })).toContain("reserved")
    }
    for (const name of ["", "Aider", "my aider", "-x", "x".repeat(65), 5]) refused({ name })
    accepted({ name: "gemini-cli" })
  })

  test("command is an argv list, never a shell string", () => {
    for (const command of [
      "aider --yes",
      [],
      [""],
      ["aider --yes"],
      ["-aider"],
      ["aider", "a;b"],
      ["aider", "$(whoami)"],
      ["aider", "`id`"],
      ["aider", "x|y"],
      ["aider", "x && y"],
      ["aider", "> out"],
      ["aider", "'quoted'"],
      ["aider", '"quoted"'],
      ["aider", "a\\b"],
      ["aider", "line\nbreak"],
      ["~/bin/aider"],
      ["aider", "x".repeat(1001)],
      Array(65).fill("x"),
      ["aider", 5],
    ]) refused({ command })
    accepted({ command: ["/usr/local/bin/aider", "--model", "gpt-4o", "--message-file=notes.md", "a prompt with spaces"] })
  })

  test("resumeFlag is one flag and needs a native ID to resume", () => {
    for (const resumeFlag of ["", "resume", "--resume x", "--a;b", 5]) refused({ resumeFlag })
    refused({ nativeID: { source: "none" } })
    accepted({ resumeFlag: "-r" })
  })

  test("nativeID: none, a flag the hub passes a fresh ID with, or a screen pattern with a capture group", () => {
    accepted({ nativeID: { source: "argv", flag: "--session-id" } })
    for (const nativeID of [
      undefined,
      "screen",
      { source: "file" },
      { source: "argv" },
      { source: "argv", flag: "session-id" },
      { source: "screen" },
      { source: "screen", pattern: "no group" },
      { source: "screen", pattern: "(unclosed" },
      { source: "screen", pattern: `(${"x".repeat(500)})` },
    ]) refused({ nativeID })
  })

  test("delivery is paste and evidence is screen (a preset is never trusted for idle)", () => {
    refused({ delivery: "steer" })
    refused({ delivery: undefined })
    refused({ evidence: "hooks" })
    refused({ evidence: "native" })
    refused({ evidence: undefined })
  })

  test("description is optional, short and printable", () => {
    refused({ description: "x".repeat(301) })
    refused({ description: "bad\u0007bell" })
    refused({ description: 5 })
  })

  test("PRESET_JSON_SCHEMA describes the same fields and refuses others", () => {
    const schema = P.PRESET_JSON_SCHEMA
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties).sort()).toEqual([...P.PRESET_FIELDS].sort())
    expect([...schema.required].sort()).toEqual(["command", "delivery", "evidence", "name", "nativeID"])
    expect(schema.properties.delivery.const).toBe("paste")
    expect(schema.properties.evidence.const).toBe("screen")
    expect(schema.properties.name.not.enum).toEqual([...P.RESERVED_HARNESS_NAMES])
  })

  test("PRESET_JSON_SCHEMA patterns agree with presetProblem on arguments and flags", () => {
    const arg = new RegExp(P.PRESET_JSON_SCHEMA.properties.command.items.pattern, "u")
    for (const a of ["aider", "/usr/bin/aider", "--model=x", "a prompt"]) expect(arg.test(a)).toBe(true)
    for (const a of ["a;b", "$(x)", "`x`", "x|y", "> o", "'q'", '"q"', "a\\b", "~/x"]) expect(arg.test(a)).toBe(false)
    const flag = new RegExp(P.PRESET_JSON_SCHEMA.properties.resumeFlag.pattern)
    for (const f of ["-r", "--resume", "--session-id"]) expect(flag.test(f)).toBe(true)
    for (const f of ["resume", "--a;b", "--resume x", ""]) expect(flag.test(f)).toBe(false)
  })
})
