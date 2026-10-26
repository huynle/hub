// The hub CLI against an in-process fake hub (Bun.serve): requests, text and --json output, exit codes,
// credential precedence.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
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

const SESSION = {
  id: "ses_abc",
  name: "@api",
  roles: ["reviewer.hub"],
  title: "Refactor the API",
  state: "blocked",
  harness: "opencode",
  now: "bash: bun test",
  blockers: [{ kind: "permission", id: "per_1", summary: "bash: git push origin main" }],
  children: 0,
  labels: {},
}
const IDLE = { id: "ses_def", roles: [], title: "Docs", state: "idle", harness: "opencode", blockers: [], children: 0, labels: {} }
const STATUS = {
  at: 1,
  you: { kind: "session", sessionID: "ses_abc", name: "@api" },
  machines: [
    { id: "m1", name: "mbp", online: true, harnesses: ["opencode"], projects: [{ root: "/p/hub", name: "hub", sessions: [SESSION, IDLE] }] },
    { id: "m2", name: "box", online: false, harnesses: [], projects: [] },
  ],
  attention: [{ kind: "permission", sessionID: "ses_abc", name: "@api", id: "per_1", summary: "bash: git push origin main" }],
}

describe("status", () => {
  test("GET /api/agent/status; text groups machines, projects and one line per session", async () => {
    hub.routes["GET /api/agent/status"] = () => Response.json(STATUS)
    const r = await cli(["status"], { env: { HUB_URL: hub.url, HUB_SESSION_TOKEN: "t", OPENCODE_SESSION_ID: "ses_abc" } })
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.path).toBe("/api/agent/status")
    const lines = r.stdout.split("\n")
    expect(lines.some((l) => l.includes("mbp") && l.includes("online"))).toBe(true)
    expect(lines.some((l) => l.includes("box") && l.includes("offline"))).toBe(true)
    expect(lines.some((l) => l.trim() === "hub")).toBe(true)
    const line = lines.find((l) => l.includes("ses_abc") && l.includes("blocked"))!
    expect(line).toContain("@api")
    expect(line).toContain("opencode")
    expect(line).toContain("bash: bun test")
    expect(line).toContain("permission: bash: git push origin main")
    expect(lines.some((l) => l.includes("ses_def") && l.includes("idle"))).toBe(true)
    expect(r.stdout).toContain("attention")
    // The attention line names the request ID that hub approve/deny/answer take.
    expect(lines.some((l) => l.includes("permission per_1:"))).toBe(true)
    expect(r.stderr).toBe("")
  })

  test("--json is the raw snapshot", async () => {
    hub.routes["GET /api/agent/status"] = () => Response.json(STATUS)
    const r = await cli(["status", "--json"])
    expect(JSON.parse(r.stdout)).toEqual(STATUS)
  })

  test("warns when OPENCODE_SESSION_ID is not the snapshot's session", async () => {
    hub.routes["GET /api/agent/status"] = () => Response.json(STATUS)
    const r = await cli(["status"], { env: { HUB_URL: hub.url, HUB_SESSION_TOKEN: "t", OPENCODE_SESSION_ID: "ses_zzz" } })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("ses_zzz")
  })
})

describe("sessions", () => {
  test("filters become query parameters; one line per session", async () => {
    hub.routes["GET /api/agent/sessions"] = () => Response.json({ sessions: [{ ...SESSION, machineID: "m1", project: "hub" }, { ...IDLE, machineID: "m1", project: "hub" }] })
    const r = await cli(["sessions", "--project", "hub", "--state=idle,blocked", "--machine", "mbp", "--label", "a=1", "--label", "b=2"])
    expect(r.code).toBe(0)
    const url = new URL(hub.seen[0]!.path, "http://x")
    expect(url.pathname).toBe("/api/agent/sessions")
    expect(url.searchParams.get("project")).toBe("hub")
    expect(url.searchParams.get("state")).toBe("idle,blocked")
    expect(url.searchParams.get("machine")).toBe("mbp")
    expect(url.searchParams.getAll("label")).toEqual(["a=1", "b=2"])
    const lines = r.stdout.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("@api")
    expect(lines[0]).toContain("blocked")
    expect(lines[1]).toContain("ses_def")
  })

  test("no filters: no query string; none found says so", async () => {
    hub.routes["GET /api/agent/sessions"] = () => Response.json({ sessions: [] })
    const r = await cli(["sessions"])
    expect(hub.seen[0]!.path).toBe("/api/agent/sessions")
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("no sessions")
  })

  test("--json is the raw list", async () => {
    hub.routes["GET /api/agent/sessions"] = () => Response.json({ sessions: [IDLE] })
    const r = await cli(["sessions", "--json"])
    expect(JSON.parse(r.stdout)).toEqual({ sessions: [IDLE] })
  })
})

describe("show", () => {
  const SHOW = {
    ...SESSION,
    online: true,
    machineID: "m1",
    project: "hub",
    directory: "/p/hub",
    blockers: [{ kind: "permission", id: "per_1", summary: "bash: git push origin main", sessionID: "ses_abc" }],
    summary: { directory: "/p/hub", branch: "main" },
  }

  test("GET /api/agent/sessions/:addr; text shows state, blockers and summary", async () => {
    hub.routes["GET /api/agent/sessions/@api"] = () => Response.json(SHOW)
    const r = await cli(["show", "@api"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("ses_abc")
    expect(r.stdout).toContain("Refactor the API")
    expect(r.stdout).toContain("blocked")
    expect(r.stdout).toContain("bash: git push origin main")
    expect(r.stdout).toContain("main")
    expect(r.stdout).not.toContain("{")
  })

  test("addresses are path-encoded", async () => {
    hub.routes["GET /api/agent/sessions/a%2Fb"] = () => Response.json(SHOW)
    const r = await cli(["show", "a/b"])
    expect(r.code).toBe(0)
  })

  test("--json is the raw view", async () => {
    hub.routes["GET /api/agent/sessions/ses_abc"] = () => Response.json(SHOW)
    const r = await cli(["show", "ses_abc", "--json"])
    expect(JSON.parse(r.stdout)).toEqual(SHOW)
  })

  test("needs an address", async () => {
    const r = await cli(["show"])
    expect(r.code).toBe(2)
  })

  test("unsupported features are mentioned", async () => {
    hub.routes["GET /api/agent/sessions/ses_abc"] = () => Response.json({ ...SHOW, summary: undefined, unsupported: [{ feature: "summary", harness: "claude-code" }] })
    const r = await cli(["show", "ses_abc"])
    expect(r.stdout).toContain("summary")
    expect(r.stdout).toContain("claude-code")
  })
})

describe("log", () => {
  const LOG = {
    sessionID: "ses_abc",
    rows: [
      { key: "k2", messageID: "m2", sessionID: "ses_abc", kind: "tool", name: "bash", state: "done", text: "bun test", at: 2 },
      { key: "k1", messageID: "m1", sessionID: "ses_abc", kind: "user", text: "please fix\nthe tests", at: 1 },
    ],
  }

  test("GET .../log?n=; rows printed oldest first, one per line", async () => {
    hub.routes["GET /api/agent/sessions/@api/log"] = () => Response.json(LOG)
    const r = await cli(["log", "@api", "-n", "5"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.path).toBe("/api/agent/sessions/@api/log?n=5")
    const lines = r.stdout.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("user")
    expect(lines[0]).toContain("please fix the tests")
    expect(lines[1]).toContain("bash")
    expect(lines[1]).toContain("bun test")
  })

  test("without -n the hub's default applies", async () => {
    hub.routes["GET /api/agent/sessions/@api/log"] = () => Response.json(LOG)
    await cli(["log", "@api"])
    expect(hub.seen[0]!.path).toBe("/api/agent/sessions/@api/log")
  })

  test("-n must be a number", async () => {
    const r = await cli(["log", "@api", "-n", "lots"])
    expect(r.code).toBe(2)
    expect(hub.seen).toEqual([])
  })

  test("--json is the raw page", async () => {
    hub.routes["GET /api/agent/sessions/@api/log"] = () => Response.json(LOG)
    const r = await cli(["log", "@api", "--json"])
    expect(JSON.parse(r.stdout)).toEqual(LOG)
  })
})

describe("who", () => {
  const WHO = {
    sessions: [
      { sessionID: "ses_abc", name: "api", project: "hub", title: "Refactor", state: "working", online: true, roles: [{ role: "reviewer", project: "hub", generation: 1 }] },
      { sessionID: "ses_def", online: false, roles: [] },
    ],
  }

  test("GET /api/agent/who with project and role; one line per session", async () => {
    hub.routes["GET /api/agent/who"] = () => Response.json(WHO)
    const r = await cli(["who", "--project", "hub", "--role", "reviewer"])
    expect(r.code).toBe(0)
    const url = new URL(hub.seen[0]!.path, "http://x")
    expect(url.searchParams.get("project")).toBe("hub")
    expect(url.searchParams.get("role")).toBe("reviewer")
    const lines = r.stdout.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("@api")
    expect(lines[0]).toContain("@@reviewer.hub")
    expect(lines[0]).toContain("working")
    expect(lines[1]).toContain("ses_def")
    expect(lines[1]).toContain("offline")
  })

  test("a @@role argument is the role filter", async () => {
    hub.routes["GET /api/agent/who"] = () => Response.json({ sessions: [] })
    await cli(["who", "@@reviewer"])
    expect(new URL(hub.seen[0]!.path, "http://x").searchParams.get("role")).toBe("reviewer")
  })

  test("--json is the raw list", async () => {
    hub.routes["GET /api/agent/who"] = () => Response.json(WHO)
    const r = await cli(["who", "--json"])
    expect(JSON.parse(r.stdout)).toEqual(WHO)
  })
})

describe("name and roles", () => {
  test("name POSTs {name} (own session) and prints the name", async () => {
    hub.routes["POST /api/agent/name"] = () => Response.json({ sessionID: "ses_abc", name: "api" })
    const r = await cli(["name", "@api"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]).toMatchObject({ method: "POST", path: "/api/agent/name", body: { name: "@api" } })
    expect(r.stdout).toContain("@api")
    expect(r.stdout).toContain("ses_abc")
  })

  test("name --session targets another session; a previous name is shown as an alias", async () => {
    hub.routes["POST /api/agent/name"] = () => Response.json({ sessionID: "ses_def", name: "docs", alias: "old" })
    const r = await cli(["name", "docs", "--session", "ses_def"])
    expect(hub.seen[0]!.body).toEqual({ name: "docs", session: "ses_def" })
    expect(r.stdout).toContain("@old")
  })

  test("name_taken exits 3", async () => {
    hub.routes["POST /api/agent/name"] = fail(409, "name_taken", "@api is taken")
    const r = await cli(["name", "@api"])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain("@api is taken")
  })

  test("role claim POSTs {role, exclusive, session}", async () => {
    hub.routes["POST /api/agent/roles/claim"] = () => Response.json({ sessionID: "ses_abc", role: "reviewer", project: "hub", generation: 3, exclusive: true })
    const r = await cli(["role", "claim", "reviewer.hub", "--exclusive", "--session", "@api"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]).toMatchObject({ method: "POST", path: "/api/agent/roles/claim", body: { role: "reviewer.hub", exclusive: true, session: "@api" } })
    expect(r.stdout).toContain("@@reviewer.hub")
    expect(r.stdout).toContain("ses_abc")
  })

  test("role claim without flags sends only the role", async () => {
    hub.routes["POST /api/agent/roles/claim"] = () => Response.json({ sessionID: "ses_abc", role: "reviewer", generation: 1 })
    await cli(["role", "claim", "@@reviewer"])
    expect(hub.seen[0]!.body).toEqual({ role: "reviewer" })
  })

  test("role release POSTs {role}", async () => {
    hub.routes["POST /api/agent/roles/release"] = () => Response.json({ sessionID: "ses_abc", role: "reviewer", released: true })
    const r = await cli(["role", "release", "reviewer"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]).toMatchObject({ method: "POST", path: "/api/agent/roles/release", body: { role: "reviewer" } })
    expect(r.stdout).toContain("released")
  })

  test("role needs claim or release", async () => {
    expect((await cli(["role"])).code).toBe(2)
    expect((await cli(["role", "grab", "x"])).code).toBe(2)
    expect((await cli(["role", "release", "x", "--exclusive"])).code).toBe(2)
    expect(hub.seen).toEqual([])
  })

  test("--json prints the raw answer", async () => {
    const body = { sessionID: "ses_abc", role: "reviewer", generation: 1 }
    hub.routes["POST /api/agent/roles/claim"] = () => Response.json(body)
    const r = await cli(["role", "claim", "reviewer", "--json"])
    expect(JSON.parse(r.stdout)).toEqual(body)
  })
})

/** An SSE response: each chunk written with a small delay; closes after the last unless `hold`. */
function sse(chunks: string[], options: { hold?: boolean } = {}) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
          await Bun.sleep(5)
        }
        if (!options.hold) controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const READY = `data: ${JSON.stringify({ type: "ready", at: 1 })}\n\n`
const BLOCKED = `data: ${JSON.stringify({ type: "blocker.opened", sessionID: "ses_abc", rootID: "ses_abc", blocker: { kind: "permission", id: "per_1", summary: "bash: x" }, at: 2 })}\n\n`
const PING = "event: ping\ndata: 0\n\n"

describe("watch", () => {
  test("prints each event as one JSON line and skips pings; filters become query parameters", async () => {
    hub.routes["GET /api/agent/watch"] = () => sse([READY, PING, BLOCKED.slice(0, 20), BLOCKED.slice(20)], { hold: true })
    const controller = new AbortController()
    const running = cli(["watch", "--blocked", "--session", "@api"], { signal: controller.signal })
    for (let i = 0; i < 100 && hub.seen.length === 0; i++) await Bun.sleep(5)
    await Bun.sleep(80)
    controller.abort()
    const r = await running
    expect(r.code).toBe(0)
    const url = new URL(hub.seen[0]!.path, "http://x")
    expect(url.pathname).toBe("/api/agent/watch")
    expect(url.searchParams.get("blocked")).toBe("1")
    expect(url.searchParams.get("session")).toBe("@api")
    const lines = r.stdout.trim().split("\n")
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["ready", "blocker.opened"])
    expect(JSON.parse(lines[1]!).blocker.id).toBe("per_1")
    expect(r.stderr).toBe("")
  })

  test("no filters: no query string", async () => {
    hub.routes["GET /api/agent/watch"] = () => sse([READY])
    await cli(["watch"])
    expect(hub.seen[0]!.path).toBe("/api/agent/watch")
  })

  test("the hub ending the stream exits 1 after printing what came", async () => {
    hub.routes["GET /api/agent/watch"] = () => sse([READY, BLOCKED])
    const r = await cli(["watch"])
    expect(r.code).toBe(1)
    expect(r.stdout.trim().split("\n")).toHaveLength(2)
    expect(r.stderr).toContain("ended")
  })

  test("an error before the stream uses the error's exit code", async () => {
    hub.routes["GET /api/agent/watch"] = fail(401, "token_expired", "Token expired")
    const r = await cli(["watch"])
    expect(r.code).toBe(9)
  })
})

describe("login and logout", () => {
  const file = (home: string) => path.join(home, ".config", "hub", "cli.json")
  const APP_WHOAMI = { actor: { kind: "app", userID: "u1", tokenID: "abcd", label: "cli", scopes: ["sessions:read"] }, user: SESSION_WHOAMI.user }

  test("checks the token with whoami, then stores {url, token} owner-only", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(APP_WHOAMI)
    const home = mkdtempSync(path.join(tmpdir(), "hub-cli-home-"))
    const r = await cli(["login", "--url", hub.url, "--token", "hat_secret"], { env: {}, home })
    expect(r.code).toBe(0)
    expect(hub.seen[0]).toMatchObject({ path: "/api/agent/whoami", auth: "Bearer hat_secret" })
    expect(JSON.parse(readFileSync(file(home), "utf8"))).toEqual({ url: hub.url, token: "hat_secret" })
    expect(statSync(file(home)).mode & 0o777).toBe(0o600)
    expect(r.stdout).toContain(hub.url)
    expect(r.stdout + r.stderr).not.toContain("hat_secret")
  })

  test("then commands use it", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(APP_WHOAMI)
    const home = mkdtempSync(path.join(tmpdir(), "hub-cli-home-"))
    await cli(["login", "--url", hub.url, "--token", "hat_secret"], { env: {}, home })
    const r = await cli(["whoami"], { env: {}, home })
    expect(r.code).toBe(0)
    expect(hub.seen[1]!.auth).toBe("Bearer hat_secret")
  })

  test("reads the token from stdin when --token is not given; HUB_URL is the default URL", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(APP_WHOAMI)
    const home = mkdtempSync(path.join(tmpdir(), "hub-cli-home-"))
    const r = await cli(["login"], { env: { HUB_URL: hub.url }, home, stdin: "hat_piped\n" })
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.auth).toBe("Bearer hat_piped")
    expect(JSON.parse(readFileSync(file(home), "utf8"))).toEqual({ url: hub.url, token: "hat_piped" })
  })

  test("uses the given token, not the session's HUB_SESSION_TOKEN", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json(APP_WHOAMI)
    await cli(["login", "--url", hub.url, "--token", "hat_given"])
    expect(hub.seen[0]!.auth).toBe("Bearer hat_given")
  })

  test("a rejected token is not stored", async () => {
    hub.routes["GET /api/agent/whoami"] = fail(401, "unauthorized", "Invalid or revoked token")
    const home = mkdtempSync(path.join(tmpdir(), "hub-cli-home-"))
    const r = await cli(["login", "--url", hub.url, "--token", "hat_bad"], { env: {}, home })
    expect(r.code).toBe(9)
    expect(existsSync(file(home))).toBe(false)
  })

  test("without a URL or a token it is a usage error", async () => {
    expect((await cli(["login", "--token", "hat_x"], { env: {} })).code).toBe(2)
    expect((await cli(["login", "--url", hub.url], { env: {}, stdin: "  \n" })).code).toBe(2)
    expect(hub.seen).toEqual([])
  })

  test("logout deletes the login file", async () => {
    const home = loggedIn(hub.url, "hat_file")
    const r = await cli(["logout"], { env: {}, home })
    expect(r.code).toBe(0)
    expect(existsSync(file(home))).toBe(false)
    const again = await cli(["logout"], { env: {}, home })
    expect(again.code).toBe(0)
    expect(again.stdout).toContain("not logged in")
  })
})
