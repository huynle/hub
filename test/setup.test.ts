// First-run setup for /voice: when to show it, which options in which order, server URL input, and the
// server reachability check. The TUI only renders what these decide.
import { describe, expect, test } from "bun:test"
import { checkServer, localServerFor, modeFor, needsSetup, parseServerInput, setupOptions, type SetupStatus } from "../src/setup"

const fresh: SetupStatus = { server: "http://127.0.0.1:4097", enrolled: false, connection: "off", mode: "off" }

describe("needsSetup", () => {
  test("not enrolled, or revoked by the server: set up", () => {
    expect(needsSetup(fresh)).toBe(true)
    expect(needsSetup({ ...fresh, enrolled: true, connection: "revoked", mode: "always" })).toBe(true)
  })

  test("enrolled: the regular menu, even while offline or with voice off", () => {
    for (const connection of ["connected", "connecting", "error", "off"] as const) {
      expect(needsSetup({ ...fresh, enrolled: true, connection, mode: "always" })).toBe(false)
    }
    expect(needsSetup({ ...fresh, enrolled: true, connection: "off", mode: "off" })).toBe(false)
  })
})

describe("setupOptions", () => {
  const values = (status: SetupStatus) => setupOptions(status).map((o) => o.value)

  test("a loopback (or default) server leads with this computer, then a voice server, then not now", () => {
    expect(values(fresh)).toEqual(["local", "local-session", "remote", "later"])
    const local = setupOptions(fresh)[0]!
    expect(local.title).toContain("On this computer")
    expect(local.description).toContain("nothing to install")
  })

  test("a configured remote server (e.g. preset by an admin) comes first as Connect to <host>", () => {
    const status = { ...fresh, server: "https://voice.example.com" }
    expect(values(status)).toEqual(["configured", "local", "local-session", "remote", "later"])
    expect(setupOptions(status)[0]!.title).toBe("Connect to voice.example.com")
    expect(setupOptions(status).find((o) => o.value === "remote")!.title).toBe("Connect to a different voice server…")
  })

  test("a revoked machine is told why", () => {
    const options = setupOptions({ ...fresh, server: "https://voice.example.com", enrolled: true, connection: "revoked" })
    expect(options[0]!.description).toContain("revoked")
  })
})

describe("localServerFor / modeFor", () => {
  test("keeps a configured loopback server (custom port), else the default local hub", () => {
    expect(localServerFor("http://127.0.0.1:4555")).toBe("http://127.0.0.1:4555")
    expect(localServerFor("http://localhost:4097")).toBe("http://localhost:4097")
    expect(localServerFor("https://voice.example.com")).toBe("http://127.0.0.1:4097")
    expect(localServerFor("https://localhost:4097")).toBe("http://127.0.0.1:4097") // a local hub serves http only
  })

  test("always by default; this session only for the secondary choice", () => {
    expect(modeFor("local")).toBe("always")
    expect(modeFor("local-session")).toBe("session")
    expect(modeFor("remote")).toBe("always")
    expect(modeFor("configured")).toBe("always")
  })
})

describe("parseServerInput", () => {
  test("accepts http(s) URLs and bare hosts (https), drops trailing slashes", () => {
    expect(parseServerInput(" https://voice.example.com/ ")).toEqual({ ok: true, url: "https://voice.example.com" })
    expect(parseServerInput("voice.example.com")).toEqual({ ok: true, url: "https://voice.example.com" })
    expect(parseServerInput("http://10.0.0.20:4097")).toEqual({ ok: true, url: "http://10.0.0.20:4097" })
    expect(parseServerInput("https://example.com/voice/")).toEqual({ ok: true, url: "https://example.com/voice" })
  })

  test("refuses empty input, other schemes, credentials, queries and spaces", () => {
    for (const raw of ["", "   ", "ftp://x.example", "https://user:pw@x.example", "https://x.example/?a=1", "https://x.example/#f", "https://x example.com", "javascript:alert(1)"]) {
      const result = parseServerInput(raw)
      expect(result.ok).toBe(false)
      expect((result as { error: string }).error.length).toBeGreaterThan(0)
    }
  })
})

describe("checkServer", () => {
  const fetchWith = (respond: (url: string) => Response | Promise<Response>) =>
    (async (url: string | URL | Request) => respond(String(url))) as unknown as typeof globalThis.fetch

  test("a voice hub answers /healthz with {ok: true}", async () => {
    const seen: string[] = []
    const fetch = fetchWith((url) => (seen.push(url), Response.json({ ok: true, version: "0.2.0", spokes: 1 })))
    expect(await checkServer("https://voice.example.com", { fetch })).toEqual({ ok: true, version: "0.2.0" })
    expect(seen).toEqual(["https://voice.example.com/healthz"])
  })

  test("unreachable, an HTTP error, or something that is not a voice hub: a clear reason", async () => {
    const down = await checkServer("https://voice.example.com", { fetch: fetchWith(() => Promise.reject(new Error("Unable to connect"))) })
    expect(down).toEqual({ ok: false, error: expect.stringMatching(/Could not reach https:\/\/voice\.example\.com.*Unable to connect/) })
    const auth = await checkServer("https://voice.example.com", { fetch: fetchWith(() => new Response("login", { status: 302 })) })
    expect(auth).toEqual({ ok: false, error: expect.stringContaining("HTTP 302") })
    const other = await checkServer("https://voice.example.com", { fetch: fetchWith(() => new Response("<html>")) })
    expect(other).toEqual({ ok: false, error: expect.stringContaining("not an opencode-voice hub") })
  })
})
