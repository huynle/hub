// Hub command line: --version and --help answer without starting anything; unknown flags are refused.
import { describe, expect, test } from "bun:test"
import { hubHelp, parseHubArgs } from "../src/central/main"

describe("parseHubArgs", () => {
  test("no arguments runs the hub", () => {
    expect(parseHubArgs([])).toEqual({ action: "run" })
  })

  test("--version / -v and --help / -h", () => {
    expect(parseHubArgs(["--version"])).toEqual({ action: "version" })
    expect(parseHubArgs(["-v"])).toEqual({ action: "version" })
    expect(parseHubArgs(["--help"])).toEqual({ action: "help" })
    expect(parseHubArgs(["-h"])).toEqual({ action: "help" })
  })

  test("anything else is an error that points at --help", () => {
    const result = parseHubArgs(["--port", "1"])
    expect(result.action).toBe("error")
    expect((result as { message: string }).message).toContain("--port")
    expect((result as { message: string }).message).toContain("--help")
  })
})

describe("hubHelp", () => {
  test("names the version, the config file and the main env vars", () => {
    const help = hubHelp("1.2.3")
    expect(help).toContain("opencode-voice hub 1.2.3")
    for (const word of ["VOICE_PORT", "VOICE_HOST", "VOICE_PUBLIC_URL", "VOICE_STATE_DIR", "OPENROUTER_API_KEY", "hub.json", "--version"]) {
      expect(help).toContain(word)
    }
  })
})
