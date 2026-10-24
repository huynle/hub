// The hub CLI against an in-process fake hub (Bun.serve): requests, text and --json output, exit codes,
// credential precedence.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EXIT, run, type Io } from "../src/cli"

interface Seen {
  method: string
  path: string
  auth: string | null
  body?: unknown
}

type Handler = (request: Request, url: URL) => Response | Promise<Response>

/** A fake hub: `routes["GET /api/agent/whoami"] = () => Response.json(...)`; every request is recorded. */
function fakeHub() {
  const routes: Record<string, Handler> = {}
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" ? "" : await request.text()
      seen.push({ method: request.method, path: url.pathname + url.search, auth: request.headers.get("authorization"), ...(text ? { body: JSON.parse(text) } : {}) })
      const handler = routes[`${request.method} ${url.pathname}`]
      if (!handler) return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })
      return handler(request, url)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, routes, seen, stop: () => server.stop(true) }
}

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => () =>
  Response.json({ error: { code, message, ...extra } }, { status })

/** Runs the CLI with captured output; env defaults to a session identity at the fake hub. */
async function cli(argv: string[], options: { env?: Record<string, string | undefined>; home?: string; stdin?: string; signal?: AbortSignal } = {}) {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    env: options.env ?? { HUB_URL: hub.url, HUB_SESSION_TOKEN: "hst1.session" },
    home: options.home ?? mkdtempSync(path.join(tmpdir(), "hub-cli-home-")),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin! } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const code = await run(argv, io)
  return { code, stdout, stderr }
}

const SESSION_WHOAMI = {
  actor: { kind: "session", userID: "u1", machineID: "m1", sessionID: "ses_abc" },
  user: { id: "u1", name: "Huy", email: "huy@example.com", role: "admin" },
}

/** A home with a login file. */
function loggedIn(url: string, token: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "hub-cli-home-"))
  mkdirSync(path.join(home, ".config", "hub"), { recursive: true })
  writeFileSync(path.join(home, ".config", "hub", "cli.json"), JSON.stringify({ url, token }), { mode: 0o600 })
  return home
}

describe("credentials", () => {
  test("without HUB_URL/HUB_SESSION_TOKEN or a login: unauthorized exit, hint to log in", async () => {
    const r = await cli(["whoami"], { env: {} })
    expect(r.code).toBe(EXIT.unauthorized)
    expect(r.code).toBe(9)
    expect(r.stderr).toContain("hub login")
    expect(hub.seen).toEqual([])
  })

  test("HUB_URL + HUB_SESSION_TOKEN are sent as the bearer", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(SESSION_WHOAMI)
    const r = await cli(["whoami"])
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([{ method: "GET", path: "/api/agent/whoami", auth: "Bearer hst1.session" }])
  })

  test("the login file is used when the env has no session identity", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(SESSION_WHOAMI)
    const r = await cli(["whoami"], { env: {}, home: loggedIn(hub.url, "hat_file") })
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.auth).toBe("Bearer hat_file")
  })

  test("the env identity wins over the login file", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(SESSION_WHOAMI)
    const r = await cli(["whoami"], { home: loggedIn("http://127.0.0.1:1", "hat_file") })
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.auth).toBe("Bearer hst1.session")
  })

  test("a trailing slash on the URL is fine", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(SESSION_WHOAMI)
    const r = await cli(["whoami"], { env: { HUB_URL: `${hub.url}/`, HUB_SESSION_TOKEN: "t" } })
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.path).toBe("/api/agent/whoami")
  })
})

describe("whoami", () => {
  test("text: the session and the user", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(SESSION_WHOAMI)
    const r = await cli(["whoami"])
    expect(r.stdout).toContain("session ses_abc")
    expect(r.stdout).toContain("machine m1")
    expect(r.stdout).toContain("Huy")
    expect(r.stderr).toBe("")
  })

  test("text: an app token", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json({ actor: { kind: "app", userID: "u1", tokenID: "abcd", label: "laptop", scopes: ["sessions:read"] }, user: SESSION_WHOAMI.user })
    const r = await cli(["whoami"])
    expect(r.stdout).toContain("app token abcd (laptop)")
  })

  test("--json prints the raw response", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(SESSION_WHOAMI)
    const r = await cli(["whoami", "--json"])
    expect(JSON.parse(r.stdout)).toEqual(SESSION_WHOAMI)
  })

  test("warns when OPENCODE_SESSION_ID is another session", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(SESSION_WHOAMI)
    const r = await cli(["whoami"], { env: { HUB_URL: hub.url, HUB_SESSION_TOKEN: "t", OPENCODE_SESSION_ID: "ses_other" } })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("ses_other")
    expect(r.stderr).toContain("ses_abc")
  })

  test("no warning when OPENCODE_SESSION_ID is this session", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(SESSION_WHOAMI)
    const r = await cli(["whoami"], { env: { HUB_URL: hub.url, HUB_SESSION_TOKEN: "t", OPENCODE_SESSION_ID: "ses_abc" } })
    expect(r.stderr).toBe("")
  })

  test("warns when OPENCODE_SESSION_ID is set but the credential is not a session", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json({ actor: { kind: "app", userID: "u1", tokenID: "abcd", scopes: [] }, user: SESSION_WHOAMI.user })
    const r = await cli(["whoami"], { env: { OPENCODE_SESSION_ID: "ses_x" }, home: loggedIn(hub.url, "hat_file") })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("ses_x")
  })
})

describe("errors and exit codes", () => {
  const cases: [number, string, number][] = [
    [404, "not_found", 3],
    [409, "ambiguous", 3],
    [409, "name_taken", 3],
    [403, "needs_user", 4],
    [403, "forbidden", 5],
    [423, "paused", 5],
    [429, "rate_limited", 6],
    [422, "unsupported", 7],
    [503, "offline", 7],
    [410, "gone", 8],
    [401, "unauthorized", 9],
    [401, "token_expired", 9],
    [400, "invalid", 2],
    [500, "internal", 1],
  ]
  for (const [status, code, exit] of cases) {
    test(`${code} exits ${exit}`, async () => {
      hub.routes["GET /api/agent/whoami"] = fail(status, code, `the ${code} message`, { hint: `the ${code} hint` })
      const r = await cli(["whoami"])
      expect(r.code).toBe(exit)
      expect(r.stdout).toBe("")
      expect(r.stderr).toContain(`the ${code} message`)
      expect(r.stderr).toContain(`the ${code} hint`)
    })
  }

  test("ambiguous lists the candidates", async () => {
    hub.routes["GET /api/agent/sessions/@x"] = fail(409, "ambiguous", "@x matches 2 sessions", { candidates: [{ sessionID: "ses_1", name: "x" }, { sessionID: "ses_2" }] })
    const r = await cli(["show", "@x"])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain("ses_1")
    expect(r.stderr).toContain("ses_2")
  })

  test("rate_limited says when to retry", async () => {
    hub.routes["GET /api/agent/whoami"] = fail(429, "rate_limited", "slow down", { retryAfter: 12 })
    const r = await cli(["whoami"])
    expect(r.stderr).toContain("12")
  })

  test("--json errors also print the envelope on stdout", async () => {
    hub.routes["GET /api/agent/whoami"] = fail(404, "not_found", "nope")
    const r = await cli(["whoami", "--json"])
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stdout)).toEqual({ error: { code: "not_found", message: "nope" } })
  })

  test("a non-envelope HTTP error exits 1 with the status", async () => {
    hub.routes["GET /api/agent/whoami"] = () => new Response("<html>bad gateway</html>", { status: 502 })
    const r = await cli(["whoami"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("502")
  })

  test("an unreachable hub exits 1 and names the URL", async () => {
    const r = await cli(["whoami"], { env: { HUB_URL: "http://127.0.0.1:1", HUB_SESSION_TOKEN: "t" } })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("http://127.0.0.1:1")
  })

  test("token_expired on a session token says to start a new shell", async () => {
    hub.routes["GET /api/agent/whoami"] = fail(401, "token_expired", "Token expired")
    const r = await cli(["whoami"])
    expect(r.stderr).toContain("new shell")
  })

  test("the token is never printed", async () => {
    hub.routes["GET /api/agent/whoami"] = fail(401, "unauthorized", "Invalid or revoked token")
    const r = await cli(["whoami"], { env: { HUB_URL: hub.url, HUB_SESSION_TOKEN: "hst1.secret-token" } })
    expect(r.stderr + r.stdout).not.toContain("secret-token")
  })
})

describe("usage", () => {
  test("no command prints usage and exits 2", async () => {
    const r = await cli([])
    expect(r.code).toBe(EXIT.usage)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("Usage")
  })

  test("an unknown command exits 2", async () => {
    const r = await cli(["frobnicate"])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("frobnicate")
  })

  test("an unknown flag exits 2", async () => {
    const r = await cli(["whoami", "--nope"])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("--nope")
    expect(hub.seen).toEqual([])
  })

  test("help and --help print usage on stdout and exit 0", async () => {
    for (const argv of [["help"], ["--help"], ["-h"], ["whoami", "--help"]]) {
      const r = await cli(argv, { env: {} })
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("Usage")
      expect(r.stdout).toContain("hub watch")
    }
  })

  test("--version prints the package version", async () => {
    const r = await cli(["--version"], { env: {} })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
