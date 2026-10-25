// Phase 1 (agent identity) end to end: one in-process hub, two spokes with different harnesses, and the `hub` CLI
// acting as a session (a pushed session token), as an app token and as the user's device, plus a second user.
//
// - Spoke A: the real OpenCode spoke (Spoke class, fake host) on machine "laptop-a". It announces the
//   sessionTokens feature, so the hub mints and pushes a token for its session; the test takes it from the spoke
//   (shellIdentity: exactly what its shells get as HUB_SESSION_TOKEN / HUB_URL).
// - Spoke B: a raw protocol client on machine "laptop-b" with harness "fake", evidence "hooks" and no features:
//   no tokens for it, and `hub log` of its session is unsupported (exit 7).
// The CLI runs in process (packages/cli/src/cli.ts `run`, own env and HOME per credential), and once as a real
// process (packages/cli/src/main.ts) with HUB_URL + HUB_SESSION_TOKEN in its environment.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../packages/cli/src/cli"
import { defaults, writeConfig } from "../src/config"
import { Spoke, type SpokeHost } from "../src/spoke/spoke"
import { harness, session, spoke as rawSpoke, waitFor, type FakeSpoke, type Harness } from "./central-harness"
import { EventQueue } from "./spoke-fake"

const ROOT = path.resolve(import.meta.dir, "..")
const ALPHA = "ses_alpha01"
const BETA = "ses_beta01"

let h: Harness
let tmp: string
let spokeA: Spoke
let machineA: { id: string; token: string }
let machineB: { id: string; token: string }
let rawB: FakeSpoke & { token: string }
/** Requests the hub sent to spoke B (it answers each with an empty result). */
const requestsToB: Array<{ op: string }> = []
let sessionToken = ""
let sessionURL = ""

type Ev = { type: string; data: Record<string, unknown> }

/** The smallest OpenCode host the Spoke needs: an event stream and inert controls. */
function host(events: EventQueue<Ev>): SpokeHost {
  return {
    directory: "/work/alpha",
    opencodeVersion: "2.0.26",
    events: (signal) => events.iterate(signal),
    prompt: async () => ({ id: "msg_1" }),
    context: async () => [],
    getSession: async (id) => ({ id, title: "Alpha work", location: { directory: "/work/alpha" }, time: { updated: 1 } }),
    replyPermission: async () => "replied",
    interrupt: async () => undefined,
    switchAgent: async () => undefined,
    switchModel: async () => undefined,
    hasAgent: async () => true,
    defaultAgent: async () => "build",
  }
}

interface Result {
  code: number
  stdout: string
  stderr: string
}

/** Runs the CLI in process with its own environment and HOME. */
async function cli(argv: string[], env: Record<string, string>, home: string): Promise<Result> {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, { env, home, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}
const json = (r: Result) => JSON.parse(r.stdout)
const dir = (name: string) => mkdtempSync(path.join(tmp, `${name}-`))

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "hub-e2e-p1-"))
  h = await harness()
  const a = await h.store.addMachine("laptop-a")
  const b = await h.store.addMachine("laptop-b")
  machineA = { id: a.machine.id, token: a.token }
  machineB = { id: b.machine.id, token: b.token }

  // Spoke A: the real OpenCode spoke, connected through its config file like the plugin.
  const configFile = path.join(tmp, "spoke-a.json")
  writeConfig(configFile, { ...defaults("laptop-a"), server: h.url, mode: "always", token: machineA.token, autoStartLocalHub: false, herdr: false })
  const events = new EventQueue<Ev>()
  spokeA = new Spoke(host(events), {
    configFile,
    machineName: "laptop-a",
    kind: "standalone",
    processID: "proc_a",
    pid: 4001,
    pluginVersion: "9.9.9",
    snapshotDebounceMs: 10,
    snapshotIntervalMs: 60_000,
    seedDebounceMs: 10,
    pollMs: 20,
    backoff: { minMs: 10, maxMs: 50 },
  })
  spokeA.start()
  await waitFor(() => spokeA.status().connection === "connected", 5000)
  events.push({ type: "session.created", data: { sessionID: ALPHA, title: "Alpha work", location: { directory: "/work/alpha" }, slug: "alpha" } })

  // Spoke B: another harness speaking the protocol directly, without features.
  rawB = await rawSpoke(h, {
    machine: machineB,
    processID: "proc_b",
    hello: { harness: "fake", harnessVersion: "0.1.0", evidence: "hooks", features: [], directory: "/work/beta" },
  })
  rawB.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    requestsToB.push(frame.req)
    rawB.send({ t: "res", id: frame.id, ok: true, result: {} })
  })
  rawB.send({ t: "sessions", sessions: [session(BETA, { title: "Beta hooks", directory: "/work/beta" })] })
  await waitFor(() => h.registry.hasSession(ALPHA) && h.registry.hasSession(BETA), 5000)
})

afterAll(async () => {
  spokeA?.stop()
  rawB?.close()
  await h?.stop()
  rmSync(tmp, { recursive: true, force: true })
})

describe("session tokens reach only the spoke that supports them", () => {
  test("spoke A stores a pushed hst1 token for its session; its shells get it with the spoke's server as HUB_URL", async () => {
    await waitFor(() => spokeA.shellIdentity(ALPHA) !== undefined, 5000)
    const identity = spokeA.shellIdentity(ALPHA)!
    expect(identity.token).toMatch(/^hst1\./)
    expect(identity.url).toBe(h.url)
    sessionToken = identity.token
    sessionURL = identity.url!
    expect(spokeA.sessionToken(BETA)).toBeUndefined()
  })

  test("spoke B (harness fake, no sessionTokens feature) gets no tokens", async () => {
    // Spoke A got its token; give the hub a moment more for anything it would have sent B.
    await Bun.sleep(100)
    expect(requestsToB.filter((r) => r.op === "sessionTokens")).toEqual([])
    expect(rawB.frames.filter((f) => f.t === "req" && f.req?.op === "sessionTokens")).toEqual([])
  })
})

describe("the CLI as the session (HUB_URL + HUB_SESSION_TOKEN)", () => {
  let env: Record<string, string>
  let home: string
  beforeAll(() => {
    env = { HUB_URL: sessionURL, HUB_SESSION_TOKEN: sessionToken }
    home = dir("session-home")
  })

  test("whoami is the session actor", async () => {
    const r = await cli(["whoami", "--json"], env, home)
    expect(r.code).toBe(0)
    expect(json(r).actor).toEqual({ kind: "session", userID: "local", machineID: machineA.id, sessionID: ALPHA, via: "shell" })
    const text = await cli(["whoami"], env, home)
    expect(text.stdout).toContain(`session ${ALPHA} on machine ${machineA.id}`)
  })

  test("the real CLI process reads the session identity from its environment", async () => {
    const proc = Bun.spawn([process.execPath, path.join(ROOT, "packages/cli/src/main.ts"), "whoami", "--json"], {
      env: { PATH: process.env.PATH ?? "", HOME: home, HUB_URL: sessionURL, HUB_SESSION_TOKEN: sessionToken },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(stdout).actor).toMatchObject({ kind: "session", sessionID: ALPHA })
  })

  test("name @scout names its own session", async () => {
    const r = await cli(["name", "@scout"], env, home)
    expect(r.code).toBe(0)
    // Renamed from the name derived from its first title; the old one stays an alias.
    expect(r.stdout).toContain(`${ALPHA} is @scout`)
    expect(r.stdout).toContain("was @alpha-work")
  })

  test("role claim reviewer claims for its own session", async () => {
    const r = await cli(["role", "claim", "reviewer", "--json"], env, home)
    expect(r.code).toBe(0)
    expect(json(r)).toMatchObject({ sessionID: ALPHA, role: "reviewer" })
  })

  test("who lists @scout with @@reviewer", async () => {
    const r = await cli(["who"], env, home)
    expect(r.code).toBe(0)
    const line = r.stdout.split("\n").find((l) => l.includes(ALPHA))!
    expect(line).toContain(`@scout ${ALPHA}`)
    expect(line).toContain("@@reviewer")
    const role = await cli(["who", "@@reviewer", "--json"], env, home)
    expect(json(role).sessions.map((s: { sessionID: string }) => s.sessionID)).toEqual([ALPHA])
  })

  test("status shows both machines and harnesses, the name and the role", async () => {
    const r = await cli(["status", "--json"], env, home)
    expect(r.code).toBe(0)
    const body = json(r)
    expect(body.you).toMatchObject({ kind: "session", sessionID: ALPHA })
    const machines = Object.fromEntries(body.machines.map((m: { name: string; harnesses: string[] }) => [m.name, m.harnesses]))
    expect(machines).toEqual({ "laptop-a": ["opencode"], "laptop-b": ["fake"] })
    const sessions = body.machines.flatMap((m: any) => m.projects.flatMap((p: any) => p.sessions))
    expect(sessions.find((s: any) => s.id === ALPHA)).toMatchObject({ name: "@scout", harness: "opencode" })
    expect(sessions.find((s: any) => s.id === ALPHA).roles.join()).toContain("reviewer")
    expect(sessions.find((s: any) => s.id === BETA)).toMatchObject({ harness: "fake", title: "Beta hooks" })
    const text = await cli(["status"], env, home)
    expect(text.stdout).toContain("laptop-a  online  opencode")
    expect(text.stdout).toContain("laptop-b  online  fake")
    expect(text.stdout).toContain(`@scout ${ALPHA}`)
  })

  test("show @scout resolves the name to the session", async () => {
    const r = await cli(["show", "@scout"], env, home)
    expect(r.code).toBe(0)
    expect(r.stdout.split("\n")[0]).toBe(`@scout ${ALPHA}`)
    expect(r.stdout).toContain("title: Alpha work")
    expect(r.stdout).toContain("@@reviewer")
  })

  test("log of the OpenCode session works; log of the fake-harness session is unsupported (exit 7)", async () => {
    const own = await cli(["log", "@scout"], env, home)
    expect(own.code).toBe(0)
    const other = await cli(["log", BETA, "--json"], env, home)
    expect(other.code).toBe(7)
    expect(json(other).error).toMatchObject({ code: "unsupported", feature: "timeline", harness: "fake" })
    expect(other.stderr).toContain("does not support timeline")
  })

  test("a session token cannot name another session (forbidden, exit 5)", async () => {
    const r = await cli(["name", "@stolen", "--session", BETA], env, home)
    expect(r.code).toBe(5)
  })
})

describe("the CLI as an app token (hub login)", () => {
  let home: string
  let env: Record<string, string>
  beforeAll(() => {
    home = dir("app-home")
    env = { XDG_CONFIG_HOME: path.join(home, "xdg") }
  })

  test("a token from POST /api/agent/app-tokens logs in; cli.json lands in the temp config dir (0600)", async () => {
    const created = await h.api("/api/agent/app-tokens", { method: "POST", json: { label: "e2e app" } })
    expect(created.status).toBe(201)
    const { token } = (await created.json()) as { token: string }
    const r = await cli(["login", "--url", h.url, "--token", token], env, home)
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain(token)
    const file = path.join(home, "xdg", "hub", "cli.json")
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSync(path.join(home, ".config"))).toBe(false)
  })

  test("whoami, status and who work", async () => {
    expect(json(await cli(["whoami", "--json"], env, home)).actor).toMatchObject({ kind: "app", label: "e2e app", scopes: ["sessions:read"] })
    const status = await cli(["status", "--json"], env, home)
    expect(status.code).toBe(0)
    expect(json(status).machines.map((m: { name: string }) => m.name).sort()).toEqual(["laptop-a", "laptop-b"])
    const who = await cli(["who"], env, home)
    expect(who.code).toBe(0)
    expect(who.stdout).toContain(`@scout ${ALPHA}`)
  })

  test("name is forbidden for app tokens (exit 5)", async () => {
    const r = await cli(["name", "@y", "--session", BETA, "--json"], env, home)
    expect(r.code).toBe(5)
    expect(json(r).error.code).toBe("forbidden")
  })
})

describe("the CLI as the user's device (link code → device token)", () => {
  let home: string
  let env: Record<string, string>
  let deviceID = ""
  beforeAll(async () => {
    home = dir("device-home")
    env = { XDG_CONFIG_HOME: path.join(home, "xdg") }
    const { code } = (await (await h.api("/api/devices/link", { method: "POST", json: {} })).json()) as { code: string }
    const redeemed = await h.api("/api/devices/redeem", { method: "POST", json: { code, deviceName: "e2e cli" }, cookie: null, origin: null })
    expect(redeemed.status).toBe(200)
    const body = (await redeemed.json()) as { token: string; device: { id: string } }
    deviceID = body.device.id
    expect((await cli(["login", "--url", h.url, "--token", body.token], env, home)).code).toBe(0)
  })

  test("whoami is the user, through the device token", async () => {
    const r = await cli(["whoami", "--json"], env, home)
    expect(r.code).toBe(0)
    expect(json(r).actor).toEqual({ kind: "user", userID: "local", deviceID, via: "device-token" })
  })

  test("sessions filters: project, machine, state", async () => {
    const ids = async (...flags: string[]) => {
      const r = await cli(["sessions", "--json", ...flags], env, home)
      expect(r.code).toBe(0)
      return json(r).sessions.map((s: { id: string }) => s.id).sort()
    }
    expect(await ids()).toEqual([ALPHA, BETA])
    expect(await ids("--project", "alpha")).toEqual([ALPHA])
    expect(await ids("--machine", "laptop-b")).toEqual([BETA])
    expect(await ids("--machine", machineA.id)).toEqual([ALPHA])
    expect(await ids("--state", "blocked")).toEqual([])
    expect((await cli(["sessions", "--state", "nope"], env, home)).code).toBe(2)
  })

  test("the user may name any of their sessions, the fake-harness one too", async () => {
    const r = await cli(["name", "@beta", "--session", BETA], env, home)
    expect(r.code).toBe(0)
    expect((await cli(["show", "@beta"], env, home)).stdout.split("\n")[0]).toBe(`@beta ${BETA}`)
  })
})

describe("a second user sees none of it", () => {
  let home: string
  let env: Record<string, string>
  beforeAll(async () => {
    const bob = await h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const cookie = `voice_device=${(await h.store.addDevice("bob laptop", bob.id)).token}`
    const { code } = (await (await h.api("/api/devices/link", { method: "POST", json: {}, cookie })).json()) as { code: string }
    const { token } = (await (await h.api("/api/devices/redeem", { method: "POST", json: { code }, cookie: null, origin: null })).json()) as { token: string }
    home = dir("bob-home")
    env = { XDG_CONFIG_HOME: path.join(home, "xdg") }
    expect((await cli(["login", "--url", h.url, "--token", token], env, home)).code).toBe(0)
  })

  test("whoami is bob; status, sessions and who are empty", async () => {
    expect(json(await cli(["whoami", "--json"], env, home)).user).toMatchObject({ email: "bob@example.com" })
    expect(json(await cli(["status", "--json"], env, home))).toMatchObject({ machines: [], attention: [] })
    expect((await cli(["sessions"], env, home)).stdout.trim()).toBe("no sessions")
    expect((await cli(["who"], env, home)).stdout.trim()).toBe("no sessions")
    expect(json(await cli(["who", "--role", "reviewer", "--json"], env, home)).sessions).toEqual([])
  })

  test("the first user's sessions, names and roles are not found (exit 3)", async () => {
    for (const argv of [["show", "@scout"], ["show", ALPHA], ["show", "@@reviewer"], ["log", BETA], ["name", "@mine", "--session", ALPHA], ["role", "claim", "reviewer", "--session", "@beta"]]) {
      const r = await cli([...argv, "--json"], env, home)
      expect({ argv, code: r.code }).toEqual({ argv, code: 3 })
      expect(json(r).error.code).toBe("not_found")
    }
  })
})

describe("revoking the machine ends the session token", () => {
  test("after DELETE /api/machines/:id the session's CLI is unauthorized (exit 9); machine B is unaffected", async () => {
    const env = { HUB_URL: sessionURL, HUB_SESSION_TOKEN: sessionToken }
    const home = dir("revoked-home")
    expect((await cli(["whoami"], env, home)).code).toBe(0)
    expect((await h.api(`/api/machines/${machineA.id}`, { method: "DELETE" })).status).toBe(204)
    const r = await cli(["whoami"], env, home)
    expect(r.code).toBe(9)
    expect(r.stderr).toContain("HUB_SESSION_TOKEN")
    expect(r.stderr).not.toContain(sessionToken)
    expect(h.registry.hasSession(BETA)).toBe(true)
  })
})
