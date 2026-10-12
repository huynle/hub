// Hub command line: --version and --help answer without starting anything; unknown flags are refused.
import { describe, expect, test } from "bun:test"
import { centralConfig } from "../src/central/config"
import { authStartupLines, hubHelp, parseHubArgs } from "../src/central/main"

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

describe("multi-user (oidc) startup", () => {
  test("help lists the sign-in settings", () => {
    const help = hubHelp("1.2.3")
    for (const word of ["VOICE_AUTH", "VOICE_OIDC_CLIENT_ID", "VOICE_OIDC_CLIENT_SECRET", "VOICE_OIDC_ALLOWED", "VOICE_ADMIN_EMAILS", "/auth/callback"]) {
      expect(help).toContain(word)
    }
  })

  test("authStartupLines: pairing says nothing; oidc names issuer, redirect URI and counts, never the secret", () => {
    const base = { VOICE_PORT: "4097", VOICE_PUBLIC_URL: "https://voice.example.com" }
    expect(authStartupLines(centralConfig(base, "/home/user"))).toEqual({ info: [], warnings: [] })
    const oidc = centralConfig(
      {
        ...base,
        VOICE_AUTH: "oidc",
        VOICE_OIDC_CLIENT_ID: "client-123",
        VOICE_OIDC_CLIENT_SECRET: "s3cret-value",
        VOICE_OIDC_ALLOWED: "alice@example.com,@example.org",
        VOICE_ADMIN_EMAILS: "admin@example.com",
      },
      "/home/user",
    )
    const lines = authStartupLines(oidc)
    const text = [...lines.info, ...lines.warnings].join("\n")
    expect(text).toContain("https://accounts.google.com")
    expect(text).toContain("https://voice.example.com/auth/callback")
    expect(text).toMatch(/2 allow-list entries, 1 admin/)
    expect(text).not.toContain("s3cret-value")
    expect(lines.warnings).toEqual([])
  })

  test("authStartupLines warns about a plain-http public URL and the dev-only insecure issuer", () => {
    const config = centralConfig(
      {
        VOICE_PUBLIC_URL: "http://voice.example.com",
        VOICE_AUTH: "oidc",
        VOICE_OIDC_ISSUER: "http://127.0.0.1:5555",
        VOICE_OIDC_INSECURE_ISSUER: "1",
        VOICE_OIDC_CLIENT_ID: "c",
        VOICE_OIDC_CLIENT_SECRET: "s",
        VOICE_OIDC_ALLOWED: "a@example.com",
        VOICE_ADMIN_EMAILS: "a@example.com",
      },
      "/home/user",
    )
    const { warnings } = authStartupLines(config)
    expect(warnings.join("\n")).toMatch(/https/)
    expect(warnings.join("\n")).toMatch(/VOICE_OIDC_INSECURE_ISSUER/)
  })
})
