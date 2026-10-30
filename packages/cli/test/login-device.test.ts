// `hub login` without a token: the device-code flow (packages/cli/src/login.ts) against a fake hub. The terminal asks
// with its name and scopes, shows the approval link and code, polls until a user approves it in the console, checks
// the app token with whoami and stores it like `--token` (owner-only, atomically). Denied, expired, cancelled,
// redirected and plain-http hubs store nothing. And: a machine enrollment is not a user login (clear errors).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EXIT, run, type Io } from "../src/cli"
import { writeLogin } from "../src/credentials"

type Handler = (request: Request, body: any) => Response | Promise<Response>

function fakeHub() {
  const routes: Record<string, Handler> = {}
  const seen: { path: string; auth: string | null; body?: any }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" ? "" : await request.text()
      const body = text ? JSON.parse(text) : undefined
      seen.push({ path: url.pathname, auth: request.headers.get("authorization"), ...(body ? { body } : {}) })
      const handler = routes[`${request.method} ${url.pathname}`]
      return handler ? handler(request, body) : Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })
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

const TOKEN = "hat_0123456789abcdef_secretsecretsecretsecretsecretsecretsecret00"
const START = { userCode: "BCDF-GHJK", deviceCode: "dev-code", intervalMs: 2000, scopes: ["sessions:read", "messages:send", "messages:read"] }
const whoami = (scopes: string[]) => () => Response.json({ actor: { kind: "app", userID: "u1", tokenID: "0123456789abcdef", label: "CLI login: box", scopes }, user: { id: "u1", name: "Huy", role: "admin" } })

/** The hub's side: start, then `polls` (pending until the last), then whoami. */
function flow(polls: unknown[], options: { scopes?: string[]; approveURL?: string } = {}) {
  const scopes = options.scopes ?? START.scopes
  hub.routes["POST /cli/login"] = (_r, body) => Response.json({ ...START, scopes: [...new Set([...START.scopes, ...(body.scopes ?? [])])], approveURL: options.approveURL ?? `${hub.url}/approve?code=${START.userCode}`, expiresAt: Date.now() + 600_000 })
  let i = 0
  hub.routes["POST /cli/login/poll"] = () => Response.json(polls[Math.min(i++, polls.length - 1)])
  hub.routes["GET /api/agent/whoami"] = whoami(scopes)
}

const approved = (scopes = START.scopes) => ({ status: "approved", token: TOKEN, tokenID: "0123456789abcdef", scopes })

async function cli(argv: string[], options: { env?: Record<string, string | undefined>; home?: string; stdin?: string; signal?: AbortSignal; tty?: boolean } = {}) {
  let stdout = ""
  let stderr = ""
  const home = options.home ?? mkdtempSync(path.join(tmpdir(), "hub-login-home-"))
  const io: Io = {
    env: options.env ?? {},
    home,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin! } : {}),
    ...(options.tty !== undefined ? { stdinIsTerminal: options.tty } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    login: { intervalMs: 5, clientName: "box" },
  }
  const code = await run(argv, io)
  return { code, stdout, stderr, home }
}

const loginFile = (home: string) => path.join(home, ".config", "hub", "cli.json")

describe("hub login (device code)", () => {
  test("asks with the client name and default scopes, shows the link and code, stores the approved token", async () => {
    flow([{ status: "pending" }, { status: "pending" }, approved()])
    const r = await cli(["login", "--url", hub.url])
    expect(r.stderr).toContain(`${hub.url}/approve?code=BCDF-GHJK`)
    expect(r.stderr).toContain("BCDF-GHJK")
    expect(r.code).toBe(0)
    expect(hub.seen[0]).toEqual({ path: "/cli/login", auth: null, body: { clientName: "box" } })
    expect(hub.seen.filter((s) => s.path === "/cli/login/poll").every((s) => s.body.deviceCode === "dev-code" && s.auth === null)).toBe(true)
    expect(hub.seen.at(-1)).toMatchObject({ path: "/api/agent/whoami", auth: `Bearer ${TOKEN}` })
    expect(JSON.parse(readFileSync(loginFile(r.home), "utf8"))).toEqual({ url: hub.url, token: TOKEN })
    expect(statSync(loginFile(r.home)).mode & 0o777).toBe(0o600)
    expect(r.stdout).toContain(`logged in to ${hub.url}`)
    expect(r.stdout).toContain("scopes: sessions:read, messages:send, messages:read")
    // Without sessions:launch the output says how to get it.
    expect(r.stdout).toContain("--scope sessions:launch")
    expect(r.stdout + r.stderr).not.toContain(TOKEN)
  })

  test("--scope asks for more; with sessions:launch the output says launching also needs a grant", async () => {
    const scopes = [...START.scopes, "sessions:launch"]
    flow([approved(scopes)], { scopes })
    const r = await cli(["login", "--url", hub.url, "--scope", "sessions:launch"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.body).toEqual({ clientName: "box", scopes: ["sessions:launch"] })
    expect(r.stderr).toContain("sessions:launch")
    expect(r.stdout).toContain("grant")
    expect(r.stdout).toContain("--allow launch")
    expect(r.stdout).toContain("app:0123456789abcdef")
  })

  test("denied: exit 5, nothing stored", async () => {
    flow([{ status: "pending" }, { status: "denied" }])
    const r = await cli(["login", "--url", hub.url])
    expect(r.code).toBe(EXIT.forbidden)
    expect(r.stderr).toContain("denied")
    expect(existsSync(loginFile(r.home))).toBe(false)
  })

  test("expired: exit 4, nothing stored", async () => {
    flow([{ status: "expired" }])
    const r = await cli(["login", "--url", hub.url])
    expect(r.code).toBe(EXIT.needsUser)
    expect(r.stderr).toContain("expired")
    expect(existsSync(loginFile(r.home))).toBe(false)
  })

  test("cancelled (Ctrl-C): exit 4, nothing stored", async () => {
    flow([{ status: "pending" }])
    const controller = new AbortController()
    const pending = cli(["login", "--url", hub.url], { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    const r = await pending
    expect(r.code).toBe(EXIT.needsUser)
    expect(r.stderr).toContain("cancelled")
    expect(existsSync(loginFile(r.home))).toBe(false)
  })

  test("a plain-http hub that is not on loopback is refused before anything is sent", async () => {
    const r = await cli(["login", "--url", "http://hub.example.com"])
    expect(r.code).toBe(EXIT.usage)
    expect(r.stderr).toContain("https")
  })

  test("redirects are not followed", async () => {
    hub.routes["POST /cli/login"] = () => new Response(null, { status: 302, headers: { location: "https://evil.example/cli/login" } })
    const r = await cli(["login", "--url", hub.url])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("redirect")
  })

  test("an approval link on another origin is replaced by one on the hub URL, with a warning", async () => {
    flow([approved()], { approveURL: "https://evil.example/approve?code=BCDF-GHJK" })
    const r = await cli(["login", "--url", hub.url])
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain("evil.example/approve")
    expect(r.stderr).toContain(`${hub.url}/approve?code=BCDF-GHJK`)
  })

  test("a hub without the CLI login (older hub): says to use --token", async () => {
    const r = await cli(["login", "--url", hub.url])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("--token")
  })

  test("the URL defaults to this machine's enrollment", async () => {
    flow([approved()])
    const home = mkdtempSync(path.join(tmpdir(), "hub-login-home-"))
    mkdirSync(path.join(home, ".config", "hub"), { recursive: true })
    writeFileSync(path.join(home, ".config", "hub", "config.json"), JSON.stringify({ server: hub.url, token: "mt_machine", machineID: "mch_abc" }))
    const r = await cli(["login"], { home })
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(loginFile(home), "utf8")).url).toBe(hub.url)
  })

  test("--token keeps working, and so does a token piped on stdin", async () => {
    hub.routes["GET /api/agent/whoami"] = whoami(["sessions:read"])
    expect((await cli(["login", "--url", hub.url, "--token", "hat_given"])).code).toBe(0)
    const piped = await cli(["login", "--url", hub.url], { stdin: "hat_piped\n", tty: false })
    expect(piped.code).toBe(0)
    expect(JSON.parse(readFileSync(loginFile(piped.home), "utf8")).token).toBe("hat_piped")
    expect(hub.seen.some((s) => s.path === "/cli/login")).toBe(false)
  })

  test("on a terminal, no --token means the device code (not a prompt for a token)", async () => {
    flow([approved()])
    const r = await cli(["login", "--url", hub.url], { stdin: "never read", tty: true })
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(loginFile(r.home), "utf8")).token).toBe(TOKEN)
  })
})

describe("writeLogin", () => {
  test("replaces the file atomically, owner-only, leaving no temporary file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-login-write-"))
    const file = path.join(dir, "hub", "cli.json")
    writeLogin(file, { url: "https://a", token: "t1" })
    writeLogin(file, { url: "https://b", token: "t2" })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: "https://b", token: "t2" })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(readdirSync(path.dirname(file))).toEqual(["cli.json"])
  })
})

describe("a machine enrollment is not a user login", () => {
  const enrolled = () => {
    const home = mkdtempSync(path.join(tmpdir(), "hub-login-home-"))
    mkdirSync(path.join(home, ".config", "hub"), { recursive: true })
    writeFileSync(path.join(home, ".config", "hub", "config.json"), JSON.stringify({ server: "https://hub.example.com", token: "mt_machine_secret", machineID: "mch_abc123" }))
    return home
  }

  for (const argv of [["launch", "--repo", "/p", "--branch", "b"], ["whoami"], ["status"]]) {
    test(`hub ${argv[0]}: names the machine and says to run hub login`, async () => {
      const r = await cli(argv, { home: enrolled() })
      expect(r.code).toBe(EXIT.unauthorized)
      expect(r.stderr).toContain("this machine is enrolled (mch_abc123)")
      expect(r.stderr).toContain("needs a user login")
      expect(r.stderr).toContain("hub login")
      expect(r.stderr).not.toContain("mt_machine_secret")
    })
  }

  test("not enrolled either: the plain message", async () => {
    const r = await cli(["whoami"])
    expect(r.code).toBe(EXIT.unauthorized)
    expect(r.stderr).toContain("not logged in to a hub")
    expect(r.stderr).not.toContain("enrolled")
  })
})
