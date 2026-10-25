// Pure grant policy (design §5, §7, §11.4; decision wvqeuis0): permission pattern grammar `action[:glob]`, OpenCode
// Wildcard semantics, bash→shell, every-resource matching, never beats allow (incl. save patterns), shell
// metacharacters, risk tiers, grant schema and duration validation, project path boundaries.
import { describe, expect, test } from "bun:test"
import { parsePattern, wildcard } from "../src/central/agent/policy"

describe("wildcard (OpenCode Wildcard.match)", () => {
  test.each([
    ["git status", "git status", true],
    ["git status --short", "git status*", true],
    ["git status", "git *", true],
    ["git", "git *", true], // a trailing " *" is optional
    ["gitk", "git *", false],
    ["src/a.ts", "src/*", true],
    ["src/deep/a.ts", "src/*", true], // * crosses slashes
    ["a.ts", "?.ts", true],
    ["ab.ts", "?.ts", false],
    ["axts", "a.ts", false], // . is literal
    ["a+b", "a+b", true],
    ["(x)", "(x)", true],
    ["src\\a.ts", "src/*", true], // backslashes normalise to /
    ["line1\nline2", "line1*", true], // * crosses newlines
    ["anything", "*", true],
    ["", "*", true],
    ["Git", "git", false], // case-sensitive
  ])("%j ~ %j → %p", (input, pattern, expected) => {
    expect(wildcard(input, pattern)).toBe(expected)
  })
})

describe("parsePattern", () => {
  test("action alone means every resource", () => {
    expect(parsePattern("external_directory")).toEqual({ action: "external_directory", resource: "*" })
    expect(parsePattern("read")).toEqual({ action: "read", resource: "*" })
  })

  test("action:glob splits at the first colon only", () => {
    expect(parsePattern("read:src/*")).toEqual({ action: "read", resource: "src/*" })
    expect(parsePattern("shell:echo a:b")).toEqual({ action: "shell", resource: "echo a:b" })
  })

  test("bash normalises to OpenCode's shell", () => {
    expect(parsePattern("bash:git status*")).toEqual({ action: "shell", resource: "git status*" })
    expect(parsePattern("bash")).toEqual({ action: "shell", resource: "*" })
  })

  test("MCP actions and action globs are kept", () => {
    expect(parsePattern("github_create_issue")).toEqual({ action: "github_create_issue", resource: "*" })
    expect(parsePattern("github_*")).toEqual({ action: "github_*", resource: "*" })
    expect(parsePattern("my-server.x_tool")).toEqual({ action: "my-server.x_tool", resource: "*" })
  })

  test.each(["", ":x", "read:", " read", "read ", "re ad", "read/x", "a".repeat(81), `read:${"x".repeat(1001)}`, 42, null])(
    "rejects %p",
    (bad) => {
      expect(parsePattern(bad as string)).toBeUndefined()
    },
  )
})
