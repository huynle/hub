// Phase 4 (launches) end to end: one in-process hub (hub.json agents.launches.maxActive 1 and
// agents.webhooks.allowPrivate), a fake OpenCode service spoke and a REAL `hub node` daemon (packages/node, host
// runtime) on one machine, the `hub` CLI in-process (as the user's device token, as app tokens with scope
// sessions:launch, as a launched session's shell token) and a local webhook receiver (Bun.serve) that checks every
// delivery with the SDK's verifyWebhook.
//
// - The node reads its settings the way `hub node run` does: config.json (machine token, hub URL) and node.json
//   (workspaceRoots: a temp root; labels) in the directory of HUB_SPOKE_CONFIG. Its host runtime makes real git
//   worktrees in temp repositories under that root.
// - The fake service spoke (kind service; features launch, deliver, hubPrompt, sessionTokens) answers a launch
//   create by reporting a new session in the requested directory, records primers (deliver) and prompts (turn),
//   and plays a turn as OpenCode reports it: session.status busy, then idle, then the turn's result.
// - The end watcher's 30 s settle is crossed by moving the hub's clock (CentralOptions.now) forward, not by
//   waiting.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../packages/cli/src/cli"
import { NodeDaemon, nodeConfigPath, readNodeConfig, readSpokeCredentials } from "../packages/node/src/index.ts"
import { verifyWebhook } from "../packages/sdk/src/index.ts"
import { END_SETTLE_MS } from "../src/central/agent/launch-engine"
import { centralConfig } from "../src/central/config"
import { defaults, writeConfig } from "../src/config"
import { connect, harness, hello, PUBLIC, waitFor, type FakeSpoke, type Harness } from "./central-harness"

const USER = "local"

interface Result {
  code: number
  stdout: string
  stderr: string
}
type Who = { env: Record<string, string>; home: string }
interface Hook {
  type: string
  subject: string
  verified: boolean
  data: any
}

let h: Harness
let tmp: string
/** The node's workspace root, and two repositories under it. */
let root: string
let repo: string
let slowRepo: string
let machineID: string
let nodeEnv: Record<string, string>
let daemon: NodeDaemon
let service: FakeSpoke
let receiver: ReturnType<typeof Bun.serve>
let user: Who
let webhookSecret = ""
/** The hub's clock runs this far ahead of the real one (the end watcher's settle). */
let skew = 0

/** What the fake service spoke was asked, and the sessions it reports. */
const spokeOps: any[] = []
const reported: Array<{ id: string; title: string; directory: string; updated: number; owned: boolean }> = []
/** Shell tokens the hub pushed for launched sessions (sessionTokens). */
const shellTokens = new Map<string, { token: string; hubURL?: string }>()
const hooks: Hook[] = []

const json = (r: Result) => JSON.parse(r.stdout)
const body = async (r: Response) => (await r.json()) as any
const dir = (name: string) => mkdtempSync(path.join(tmp, `${name}-`))

async function cli(argv: string[], who: Who): Promise<Result> {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, { env: who.env, home: who.home, cwd: repo, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}

async function login(token: string, name: string): Promise<Who> {
  const home = dir(name)
  const who = { env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, home }
  expect((await cli(["login", "--url", h.url, "--token", token], who)).code).toBe(0)
  return who
}

const GIT_ENV = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" }
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function makeRepo(at: string): void {
  mkdirSync(at, { recursive: true })
  git(at, "init", "-q", "-b", "main")
  writeFileSync(path.join(at, "README.md"), "# e2e\n")
  git(at, "add", "README.md")
  git(at, "commit", "-q", "-m", "init")
}

/** The launch as the hub has it. */
const launch = async (id: string) => (await h.launches.view(USER, id))!

async function untilState(id: string, states: string[], timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const l = await launch(id)
    if (states.includes(l.state)) return l
    if (Date.now() > deadline) throw new Error(`launch ${id} is ${l.state} (${l.reason}), not ${states.join("/")}`)
    await Bun.sleep(10)
  }
}

const opsFor = (sessionID: string, op: string) => spokeOps.filter((r) => r.op === op && r.sessionID === sessionID)

/** The fake service spoke reports the session's status (OpenCode's session.status event). */
const status = (sessionID: string, type: "busy" | "idle") => service.send({ t: "event", event: { type: "session.status", data: { sessionID, status: { type } } } })

function serveSpoke(client: FakeSpoke): void {
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    const req = frame.req
    spokeOps.push(req)
    const reply = (result: unknown) => client.send({ t: "res", id: frame.id, ok: true, result })
    switch (req.op) {
      case "create": {
        const id = `ses_l${reported.length + 1}`
        reported.push({ id, title: req.title ?? "", directory: req.directory, updated: Date.now(), owned: true })
        client.send({ t: "sessions", sessions: reported })
        return reply({ sessionID: id })
      }
      case "deliver":
        return reply({ delivered: "steer" })
      case "turn":
        // As OpenCode: the session works on the prompt, goes idle, and the turn's result follows.
        status(req.sessionID, "busy")
        setTimeout(() => {
          status(req.sessionID, "idle")
          setTimeout(() => reply({ outcome: "succeeded", reply: "done" }), 30)
        }, 60)
        return
      case "stop":
        status(req.sessionID, "idle")
        return reply({ stopped: [req.sessionID] })
      case "sessionTokens":
        for (const t of req.tokens) shellTokens.set(t.sessionID, { token: t.token, ...(req.hubURL ? { hubURL: req.hubURL } : {}) })
        return reply({ applied: req.tokens.map((t: any) => t.sessionID), skipped: [] })
      default:
        return reply({})
    }
  })
}

/** A NodeDaemon set up as `hub node run` sets it up: config.json and node.json next to HUB_SPOKE_CONFIG. */
function startNode(): NodeDaemon {
  const { config, problems } = readNodeConfig(nodeConfigPath(nodeEnv, tmp))
  expect(problems).toEqual([])
  const node = new NodeDaemon({ config, credentials: readSpokeCredentials(nodeEnv, tmp)! })
  node.start()
  return node
}

const bearer = (token: string, init: { method?: string; json?: unknown } = {}) =>
  fetch(`${h.url}${"/api/agent/launches"}`, {
    method: init.method ?? "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  })

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-e2e-p4-")))
  root = path.join(tmp, "work")
  repo = path.join(root, "app")
  slowRepo = path.join(root, "slow")
  makeRepo(repo)
  makeRepo(slowRepo)
  // Every checkout in the slow repository takes a while (git runs the hook after `worktree add` checks out).
  const hook = path.join(slowRepo, ".git", "hooks", "post-checkout")
  writeFileSync(hook, "#!/bin/sh\nsleep 3\n")
  chmodSync(hook, 0o755)

  const config = centralConfig({ HUB_PORT: "0", HUB_PUBLIC_URL: PUBLIC, HUB_STATE_DIR: dir("state") }, "/home/none", {
    agents: { launches: { maxActive: 1 }, webhooks: { allowPrivate: true } },
  })
  h = await harness({ config, now: () => Date.now() + skew })
  const machine = await h.store.addMachine("mbp")
  machineID = machine.machine.id

  // The machine as `hub node` finds it: config.json (the spoke's: hub URL, machine token) and node.json beside it.
  const configDir = dir("spoke-config")
  const spokeConfig = path.join(configDir, "config.json")
  writeConfig(spokeConfig, { ...defaults("mbp"), server: h.url, mode: "always", token: machine.token, autoStartLocalHub: false, herdr: false })
  writeFileSync(path.join(configDir, "node.json"), JSON.stringify({ workspaceRoots: [root], labels: { pool: "e2e" }, slots: 2 }))
  nodeEnv = { HUB_SPOKE_CONFIG: spokeConfig }
  daemon = startNode()

  service = await connect(h, machine.token)
  serveSpoke(service)
  service.send(hello("svc_p4", { kind: "service", directory: root, features: ["launch", "deliver", "hubPrompt", "sessionTokens"] }))
  await service.next((f) => f.t === "welcome")
  service.send({ t: "sessions", sessions: [] })
  await waitFor(() => h.nodes.forMachine(machineID) !== undefined && h.registry.serviceFor(machineID) !== undefined, 5000)

  // The user's device token for the CLI (a device link, redeemed).
  const { code } = await body(await h.api("/api/devices/link", { method: "POST", json: {} }))
  const { token } = await body(await h.api("/api/devices/redeem", { method: "POST", json: { code }, cookie: null, origin: null }))
  user = await login(token, "user-home")

  // The user's webhook for every launch event; the receiver checks each delivery's signature with the SDK.
  receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const raw = await request.text()
      const check = verifyWebhook({ body: raw, headers: request.headers, secret: webhookSecret, now: Date.now() + skew })
      const evt = JSON.parse(raw)
      hooks.push({ type: evt.type, subject: evt.subject, verified: check.ok && check.event === evt.type, data: evt.data })
      return new Response("ok")
    },
  })
  const created = await h.api("/api/agent/webhooks", { method: "POST", json: { url: `http://127.0.0.1:${receiver.port}/hook`, events: ["launch.*"], label: "e2e" } })
  expect(created.status).toBe(201)
  webhookSecret = (await body(created)).secret
})

afterAll(async () => {
  daemon?.stop()
  service?.close()
  receiver?.stop(true)
  await h?.stop()
  rmSync(tmp, { recursive: true, force: true })
})

describe("setup", () => {
  test("the node connects with the machine's token and node.json; the service spoke announces launch", () => {
    const node = h.nodes.forMachine(machineID)!
    expect(node.workspaceRoots).toEqual([root])
    expect(node.labels).toMatchObject({ pool: "e2e" })
    expect(node.runtimes).toEqual([{ kind: "host", harnesses: ["opencode"] }])
    expect(node.capacity.slots).toBe(2)
    expect(h.registry.supports(h.registry.serviceFor(machineID)!, "launch")).toBe(true)
  })
})

describe("a launch's life", () => {
  let id = ""
  let sessionID = ""
  const worktree = () => path.join(repo, ".worktrees", "feat", "e2e")

  test("`hub launch`: queued → placing → provisioning → running in a real worktree, name, roles and labels set", async () => {
    const r = await cli(
      ["launch", "--repo", repo, "--branch", "feat/e2e", "--name", "api", "--role", "builder", "--label", "app=brain", "--node-label", "pool=e2e", "--prompt", "Build the API", "--cleanup", "remove", "--json"],
      user,
    )
    expect(r.code).toBe(0)
    id = json(r).launch.id
    expect(json(r).launch).toMatchObject({ state: "queued", by: "user", spec: { name: "api", labels: { app: "brain" } } })

    const running = await untilState(id, ["running", "ended"])
    expect(running).toMatchObject({ state: "running", machineID, name: "api", directory: worktree() })
    expect(running.history.map((s) => s.state)).toEqual(["queued", "placing", "provisioning", "running"])
    sessionID = running.sessionID!

    // A real worktree on the branch, with the launch's marker in its git directory.
    expect(existsSync(path.join(worktree(), "README.md"))).toBe(true)
    expect(git(worktree(), "symbolic-ref", "--short", "HEAD")).toBe("feat/e2e")
    expect(git(repo, "worktree", "list")).toContain(worktree())

    // The spoke was asked to create the session there, for this launch.
    expect(spokeOps.find((q) => q.op === "create")).toMatchObject({ op: "create", directory: worktree(), launchID: id, title: "api" })
    // The name and the role resolve to the session; the labels are on the launch list's filter.
    for (const address of ["@api", "@@builder"]) {
      const resolved = await cli(["show", address, "--json"], user)
      expect({ address, code: resolved.code }).toEqual({ address, code: 0 })
      expect(resolved.stdout).toContain(sessionID)
    }
    expect(await h.launches.labelsFor(USER, sessionID)).toEqual({ app: "brain" })
    const filtered = json(await cli(["launches", "list", "--label", "app=brain", "--json"], user)).launches
    expect(filtered.map((l: any) => l.id)).toEqual([id])
  })

  test("the primer (with the name and role) and then the prompt reach the spoke", async () => {
    await waitFor(() => opsFor(sessionID, "turn").length === 1, 5000)
    const primer = opsFor(sessionID, "deliver").find((q) => q.meta?.kind === "primer")
    expect(primer).toBeDefined()
    expect(primer.text).toContain("@api")
    expect(primer.text).toContain("builder")
    const turn = opsFor(sessionID, "turn")[0]
    expect(turn).toMatchObject({ sessionID, text: "Build the API" })
    expect(spokeOps.indexOf(primer)).toBeLessThan(spokeOps.indexOf(turn))
  })

  test("idle after the prompt was seen working (and settled): ended idle; artifacts collected; the worktree removed", async () => {
    // The turn ran (busy → idle) and finished; the session stays idle. Past the settle, the next registry change
    // makes the watcher look again.
    await waitFor(() => h.registry.idle(sessionID), 5000)
    await Bun.sleep(50)
    expect((await launch(id)).state).toBe("running")
    skew += END_SETTLE_MS + 1000
    service.send({ t: "sessions", sessions: reported.map((s) => (s.id === sessionID ? { ...s, updated: s.updated + 1 } : s)) })
    status(sessionID, "idle")
    const ended = await untilState(id, ["ended"])
    expect(ended).toMatchObject({ state: "ended", outcome: "idle", artifacts: { branch: "feat/e2e", dirty: false } })
    expect(ended.reason).toContain("workspace removed")
    expect(existsSync(worktree())).toBe(false)
    expect(git(repo, "worktree", "list")).not.toContain(worktree())
    // The branch (the work) stays.
    expect(git(repo, "branch", "--list", "feat/e2e")).toContain("feat/e2e")
  })

  test("the user's webhook got each change, signed (verifyWebhook); the launch's history orders them", async () => {
    await waitFor(() => hooks.filter((e) => e.subject === id).length >= 4, 8000)
    await h.webhooks.drain()
    // Deliveries run concurrently, so they may arrive out of order: a receiver orders them by the launch.
    const mine = hooks.filter((e) => e.subject === id).sort((x, y) => x.data.launch.history.length - y.data.launch.history.length)
    expect(mine.map((e) => e.type)).toEqual(["launch.queued", "launch.provisioning", "launch.running", "launch.ended"])
    expect(mine.every((e) => e.verified)).toBe(true)
    expect(mine.at(-1)!.data.launch).toMatchObject({ id, state: "ended", outcome: "idle" })
  })

  test("the launched session's shell token cannot launch (403, exit 5)", async () => {
    await waitFor(() => shellTokens.has(sessionID), 5000)
    // (Its shells would reach the hub at the public URL; the test reaches the same hub at its local one.)
    const shell = shellTokens.get(sessionID)!
    expect(shell.hubURL).toBe(PUBLIC)
    const r = await cli(["launch", "--repo", repo, "--branch", "feat/nope", "--json"], { env: { HUB_URL: h.url, HUB_SESSION_TOKEN: shell.token }, home: dir("shell") })
    expect(r.code).toBe(5)
    expect(json(r).error.code).toBe("forbidden")
    expect((await bearer(shell.token, { json: { workspace: { repo, branch: "feat/nope" } } })).status).toBe(403)
  })
})

describe("idempotency and caps", () => {
  test("the same key and body answer the same launch; the same key with another body is refused (exit 2)", async () => {
    const args = ["launch", "--key", "k-e2e", "--branch", "feat/key", "--prompt", "Same", "--end", "never"]
    const first = await cli([...args, "--json"], user)
    expect(first.code).toBe(0)
    const id = json(first).launch.id
    const again = await cli(args, user)
    expect(again.code).toBe(0)
    expect(again.stdout).toContain(`${id} was already launched with key k-e2e`)
    const other = await cli(["launch", "--key", "k-e2e", "--branch", "feat/key", "--prompt", "Different", "--json"], user)
    expect(other.code).toBe(2)
    expect(json(other).error.code).toBe("invalid")
    expect((await h.launches.list(USER)).filter((l) => l.spec.key === "k-e2e")).toHaveLength(1)
    await untilState(id, ["running"])
    const stopped = await cli(["launches", "stop", id, "--json"], user)
    expect(stopped.code).toBe(0)
    expect(json(stopped).launch).toMatchObject({ state: "ended", outcome: "stopped" })
  })

  test("maxActive 1: a second launch waits queued until the first ends; `hub launches stop` stops each", async () => {
    const a = json(await cli(["launch", "--branch", "feat/cap-a", "--prompt", "A", "--end", "never", "--json"], user)).launch.id
    await untilState(a, ["running"])
    const b = json(await cli(["launch", "--branch", "feat/cap-b", "--prompt", "B", "--end", "never", "--json"], user)).launch.id
    await Bun.sleep(300)
    expect((await launch(b)).state).toBe("queued")
    expect(json(await cli(["launches", "list", "--state", "queued", "--json"], user)).launches.map((l: any) => l.id)).toEqual([b])

    const stopA = await cli(["launches", "stop", a], user)
    expect(stopA.code).toBe(0)
    expect(stopA.stdout).toContain(`stopped ${a}: ended stopped`)
    expect(opsFor((await launch(a)).sessionID!, "stop")).toHaveLength(1)
    // cleanup keep (the default): the worktree stays.
    expect(existsSync(path.join(repo, ".worktrees", "feat", "cap-a", "README.md"))).toBe(true)

    await untilState(b, ["running"])
    expect((await cli(["launches", "stop", b], user)).code).toBe(0)
    // Stopping again: it already ended (gone, exit 8).
    expect((await cli(["launches", "stop", b, "--json"], user)).code).toBe(8)
  })
})

describe("app tokens", () => {
  let app: Who & { id: string; token: string }

  test("sessions:launch without a launch grant: 403 (exit 5)", async () => {
    const created = await h.api("/api/agent/app-tokens", { method: "POST", json: { label: "launcher", scopes: ["sessions:launch"] } })
    expect(created.status).toBe(201)
    const { id, token } = await body(created)
    app = { id, token, ...(await login(token, "app-home")) }
    const r = await cli(["launch", "--branch", "feat/app", "--json"], app)
    expect(r.code).toBe(5)
    expect(json(r).error.code).toBe("forbidden")
    expect((await bearer(token, { json: { workspace: { repo, branch: "feat/app" } } })).status).toBe(403)
  })

  test("with a launch grant on the repo it launches; the kill switch pauses it (423); its webhook gets only its launch", async () => {
    expect((await cli(["grant", "create", "--holder", `app:${app.id}`, "--project", repo, "--allow", "launch"], user)).code).toBe(0)

    // The app's own webhook (its own secret).
    const appHooks: Array<{ subject: string; verified: boolean }> = []
    let appSecret = ""
    const appReceiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const raw = await request.text()
        appHooks.push({ subject: JSON.parse(raw).subject, verified: verifyWebhook({ body: raw, headers: request.headers, secret: appSecret, now: Date.now() + skew }).ok })
        return new Response("ok")
      },
    })
    try {
      const hook = await fetch(`${h.url}/api/agent/webhooks`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${appReceiver.port}/app` }),
      })
      expect(hook.status).toBe(201)
      appSecret = (await body(hook)).secret

      // The kill switch: paused (exit 5; HTTP 423), nothing is queued.
      const before = (await h.launches.list(USER)).length
      expect((await h.api("/api/agent/acting", { method: "PUT", json: { enabled: false } })).status).toBe(200)
      const paused = await cli(["launch", "--branch", "feat/app", "--json"], app)
      expect(paused.code).toBe(5)
      expect(json(paused).error.code).toBe("paused")
      expect((await bearer(app.token, { json: { workspace: { repo, branch: "feat/app" } } })).status).toBe(423)
      expect((await h.launches.list(USER)).length).toBe(before)
      expect((await h.api("/api/agent/acting", { method: "PUT", json: { enabled: true } })).status).toBe(200)

      const r = await cli(["launch", "--branch", "feat/app", "--prompt", "App work", "--end", "never", "--json"], app)
      expect(r.code).toBe(0)
      const id = json(r).launch.id
      expect(json(r).launch.by).toBe(`app:${app.id}`)
      await untilState(id, ["running"])
      // The app sees only the launches it started.
      expect(json(await cli(["launches", "list", "--json"], app)).launches.map((l: any) => l.id)).toEqual([id])
      expect((await cli(["launches", "stop", id], app)).code).toBe(0)
      await waitFor(() => appHooks.some((e) => e.subject === id) && hooks.some((e) => e.subject === id && e.type === "launch.ended"), 8000)
      await h.webhooks.drain()
      expect(new Set(appHooks.map((e) => e.subject))).toEqual(new Set([id]))
      expect(appHooks.every((e) => e.verified)).toBe(true)
    } finally {
      appReceiver.stop(true)
    }
  })
})

describe("tenancy", () => {
  test("another user sees none of these launches or webhooks; GET and DELETE of a launch are 404", async () => {
    const bob = await h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const cookie = `voice_device=${(await h.store.addDevice("bob phone", bob.id)).token}`
    const mine = await h.launches.list(USER)
    expect(mine.length).toBeGreaterThan(0)
    expect((await body(await h.api("/api/agent/launches", { cookie }))).launches).toEqual([])
    for (const method of ["GET", "DELETE"]) expect({ method, status: (await h.api(`/api/agent/launches/${mine[0]!.id}`, { method, cookie })).status }).toEqual({ method, status: 404 })
    expect((await body(await h.api("/api/agent/webhooks", { cookie }))).webhooks).toEqual([])
  })
})

describe("node loss", () => {
  test("the node going away while it prepares: the launch ends lost, before any session", async () => {
    const r = await cli(["launch", "--repo", slowRepo, "--branch", "feat/slow", "--prompt", "Never", "--json"], user)
    expect(r.code).toBe(0)
    const id = json(r).launch.id
    await waitFor(() => h.nodes.forMachine(machineID)?.launches.some((l) => l.launchID === id && l.phase === "preparing") === true, 8000)
    expect((await launch(id)).state).toBe("provisioning")
    daemon.stop()
    const ended = await untilState(id, ["ended"])
    expect(ended.outcome).toBe("lost")
    expect(spokeOps.some((q) => q.op === "create" && q.launchID === id)).toBe(false)
    // The node comes back and serves again.
    daemon = startNode()
    await waitFor(() => h.nodes.forMachine(machineID) !== undefined, 5000)
  })
})
