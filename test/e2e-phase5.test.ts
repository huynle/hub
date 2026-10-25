// Phase 5 (sandboxed launches) end to end, without a gateway: one in-process hub, a REAL `hub node` daemon
// (NodeDaemon) whose openshell runtime (OpenShellRuntime, built from node.json's `openshell` section the way
// `hub node run` builds it) drives the fake `openshell` CLI (packages/runtime-openshell/test/fake-openshell.ts), and
// the `hub` CLI in-process as the user.
//
// - The fake keeps each sandbox's filesystem in a directory and runs `sandbox exec` locally there, so the node's
//   prepare really clones the host clone into the sandbox's /sandbox/work through a git bundle, and collect really
//   bundles the sandbox's commits back out and fast-forwards the host clone.
// - The launch's git remote is https://example.invalid/proj, rewritten to a temp origin through the file transport
//   (as packages/runtime-openshell/test/runtime-helpers.ts does), so the host clone needs no network.
// - The runtime's start command is overridden (the image's hub-sandbox-start needs OpenCode): run by the fake's exec
//   in the sandbox, it checks the uploaded files and leaves a trace. The test then plays the harness inside: it
//   finds the launch config exactly as the plugin does (launchSource with HUB_LAUNCH_CONFIG, node.json beside it)
//   and opens a raw launch-bound protocol connection with the hlt1 token from that file. It reaches the hub at the
//   hub's local URL, standing in for the sandbox's route to the URL the config names.
// - The end watcher's 30 s settle is crossed by moving the hub's clock (CentralOptions.now) forward.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../packages/cli/src/cli"
import { NodeDaemon, nodeConfigPath, readNodeConfig, readSpokeCredentials } from "../packages/node/src/index.ts"
import { HostRuntime } from "../packages/node/src/host.ts"
import { openshellBackends, sweepSandboxes } from "../packages/node/src/openshell.ts"
import { OpenShellCli } from "../packages/runtime-openshell/src/cli.ts"
import { sandboxHubEndpoint } from "../packages/runtime-openshell/src/policy.ts"
import { labelValue, OpenShellRuntime, sandboxName, SANDBOX_WORKDIR } from "../packages/runtime-openshell/src/runtime.ts"
import { createFakeOpenShell, type FakeOpenShell } from "../packages/runtime-openshell/test/fake-openshell.ts"
import type { Runtime } from "../packages/runtime-sdk/src/index.ts"
import { END_SETTLE_MS } from "../src/central/agent/launch-engine"
import { centralConfig } from "../src/central/config"
import { defaults, writeConfig, type LaunchConfig } from "../src/config"
import { launchSource } from "../src/spoke/launch-source"
import { readWorkspaceRoots } from "../src/spoke/node-roots"
import { connect, harness, hello, PUBLIC, waitFor, type FakeSpoke, type Harness } from "./central-harness"

const USER = "local"
/** Per-test limit: every node op runs the fake CLI as a process, which is slow on a loaded machine. */
const SLOW = 60_000
/** The start command the fake runs in the sandbox (in /sandbox) instead of the image's hub-sandbox-start. */
const STARTED = ".hub/harness.started"
const START = ["sh", "-c", `test -f .hub/config.json && test -f .hub/node.json && test -f .hub/ready && echo up > ${STARTED}`]

interface Result {
  code: number
  stdout: string
  stderr: string
}
type Who = { env: Record<string, string>; home: string }

let h: Harness
let tmp: string
let root: string
let remotes: string
let machineID: string
let nodeEnv: Record<string, string>
let daemon: NodeDaemon
let fake: FakeOpenShell
let user: Who
let skew = 0

const json = (r: Result) => JSON.parse(r.stdout)
const body = async (r: Response) => (await r.json()) as any
const dir = (name: string) => mkdtempSync(path.join(tmp, `${name}-`))

async function cli(argv: string[], who: Who): Promise<Result> {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, { env: who.env, home: who.home, cwd: root, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}

// ---- git (temporary directories only) ----

const BASE_ENV = { PATH: process.env.PATH ?? "", HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1" }
const IDENT = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" }

function git(cwd: string, ...args: string[]): string {
  const temps = [tmpdir(), realpathSync(tmpdir())].map((t) => t + path.sep)
  if (!temps.some((t) => cwd.startsWith(t))) throw new Error(`refusing to run git outside the temporary directory (${cwd})`)
  return execFileSync("git", args, { cwd, env: { ...BASE_ENV, ...IDENT }, encoding: "utf8" }).trim()
}

function commit(at: string, file: string, text: string): string {
  writeFileSync(path.join(at, file), text)
  git(at, "add", file)
  git(at, "commit", "-q", "-m", `edit ${file}`)
  return git(at, "rev-parse", "HEAD")
}

/** The node's git settings: https://example.invalid/<name> is the local origin under `remotes`. */
const nodeGit = () => ({
  baseEnv: BASE_ENV,
  env: {
    ...IDENT,
    GIT_ALLOW_PROTOCOL: "https:ssh:file",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://example.invalid/",
  },
})

// ---- the node ----

/**
 * A NodeDaemon set up as `hub node run` sets it up (config.json and node.json next to HUB_SPOKE_CONFIG); with
 * `openshell`, also its openshell runtime over the fake CLI, the gateway's backends and the startup sweep.
 */
async function startNode(openshell: boolean): Promise<NodeDaemon> {
  const { config, problems } = readNodeConfig(nodeConfigPath(nodeEnv, tmp))
  // node.json's gpu profile asks for cpu: the node lists it as unsupported and never offers it.
  expect(problems).toEqual(["openshell.profiles.gpu: unsupported (profile gpu sets cpu, which the OpenShell vm backend does not support)"])
  const credentials = readSpokeCredentials(nodeEnv, tmp)!
  const runtimes: Runtime[] = [new HostRuntime({ roots: config.workspaceRoots, git: nodeGit() })]
  let extra = {}
  if (openshell) {
    expect(config.openshell?.enabled).toBe(true)
    const client = new OpenShellCli({ binary: fake.binary, env: { ...BASE_ENV, ...IDENT } })
    // createOpenShellRuntime's options, plus the test's git settings, fast polling and the start command.
    runtimes.push(
      new OpenShellRuntime({
        client,
        roots: config.workspaceRoots,
        hubURL: credentials.server,
        profiles: config.openshell!.profiles,
        harnesses: ["opencode"],
        machineID,
        git: nodeGit(),
        pollMs: 5,
        startCommand: START,
      }),
    )
    const sweep = await sweepSandboxes(client, machineID)
    expect(sweep.problems).toEqual([])
    extra = { backends: { openshell: await openshellBackends(client) }, recovered: sweep.launches }
  }
  const node = new NodeDaemon({ config, credentials, runtimes, ...extra })
  node.start()
  return node
}

async function restartNode(openshell: boolean): Promise<void> {
  daemon.stop()
  await waitFor(() => h.nodes.forMachine(machineID) === undefined, 5000)
  daemon = await startNode(openshell)
  await waitFor(() => h.nodes.forMachine(machineID) !== undefined, 5000)
}

// ---- launches ----

const launch = async (id: string) => (await h.launches.view(USER, id))!

async function untilState(id: string, states: string[], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const l = await launch(id)
    if (states.includes(l.state)) return l
    if (Date.now() > deadline) throw new Error(`launch ${id} is ${l.state} (${l.reason}), not ${states.join("/")}`)
    await Bun.sleep(10)
  }
}

/** `hub launch --runtime openshell` for a clone of https://example.invalid/proj at <root>/<dirName>. */
async function launchSandboxed(dirName: string, extra: string[]): Promise<string> {
  const r = await cli(["launch", "--runtime", "openshell", "--mode", "clone", "--repo", path.join(root, dirName), "--remote", "https://example.invalid/proj", ...extra, "--json"], user)
  expect(r.code).toBe(0)
  return json(r).launch.id
}

// ---- the harness inside the sandbox ----

interface Box {
  client: FakeSpoke
  config: LaunchConfig
  /** The sandbox's "/" in the fake. */
  root: string
  ops: any[]
  sessions: Array<{ id: string; title: string; directory: string; updated: number; owned: boolean }>
}

const sandboxRoot = (launchID: string) => fake.sandboxRoot(sandboxName(launchID))
/** What the plugin's service spoke announces (actTokens included: the hub must still never send them). */
const BOX_FEATURES = ["launch", "deliver", "hubPrompt", "sessionTokens", "actTokens"]

/** The launch config the node uploaded, found the way the plugin finds it (HUB_LAUNCH_CONFIG, node.json beside it). */
function uploadedConfig(launchID: string): { config: LaunchConfig; roots: string[] } {
  const source = launchSource({ HUB_LAUNCH_CONFIG: path.join(sandboxRoot(launchID), "sandbox", ".hub", "config.json") })
  if (source.kind !== "launch") throw new Error(`the sandbox's launch config is ${source.kind}`)
  return { config: source.launch, roots: readWorkspaceRoots(source.nodeConfig) }
}

/**
 * The status /spoke/ws answers a token with when it refuses it (a plain request, as test/central-spoke-launch.test.ts
 * does: Bun 1.3.5's WebSocket client can crash the process on a refused upgrade).
 */
async function upgradeStatus(token: string): Promise<number> {
  return (await fetch(`${h.url}/spoke/ws`, { headers: { authorization: `Bearer ${token}`, upgrade: "websocket" } })).status
}

/** Opens a launch-bound connection with a token and says hello for `launchID`. */
async function boxConnect(token: string, launchID: string, processID: string): Promise<FakeSpoke> {
  const client = await connect(h, token)
  client.send(hello(processID, { kind: "service", directory: SANDBOX_WORKDIR, features: BOX_FEATURES, launchID }))
  return client
}

/**
 * Plays the sandbox's harness once the node started it: reads .hub/config.json, connects with its token and serves
 * the hub's requests as the plugin would (create, deliver, turn, stop, sessionTokens).
 */
async function sandboxHarness(launchID: string): Promise<Box> {
  await waitFor(() => existsSync(path.join(sandboxRoot(launchID), "sandbox", STARTED)), 30_000)
  const { config } = uploadedConfig(launchID)
  const client = await boxConnect(config.token, launchID, `box_${launchID}`)
  const box: Box = { client, config, root: sandboxRoot(launchID), ops: [], sessions: [] }
  const status = (sessionID: string, type: "busy" | "idle") => box.client.send({ t: "event", event: { type: "session.status", data: { sessionID, status: { type } } } })
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    const req = frame.req
    box.ops.push(req)
    const reply = (result: unknown) => client.send({ t: "res", id: frame.id, ok: true, result })
    switch (req.op) {
      case "create": {
        const id = `ses_box${box.sessions.length + 1}${launchID.slice(-6)}`
        box.sessions.push({ id, title: req.title ?? "", directory: req.directory, updated: Date.now(), owned: true })
        client.send({ t: "sessions", sessions: box.sessions })
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
        return reply({ applied: req.tokens.map((t: any) => t.sessionID), skipped: [] })
      default:
        return reply({})
    }
  })
  await client.next((f) => f.t === "welcome", 5000)
  client.send({ t: "sessions", sessions: [] })
  return box
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-e2e-p5-")))
  root = path.join(tmp, "work")
  mkdirSync(root)
  remotes = path.join(tmp, "remotes")
  const origin = path.join(remotes, "proj")
  mkdirSync(origin, { recursive: true })
  git(origin, "init", "-q", "-b", "main")
  commit(origin, "README.md", "# e2e\n")
  fake = createFakeOpenShell()

  const config = centralConfig({ HUB_PORT: "0", HUB_PUBLIC_URL: PUBLIC, HUB_STATE_DIR: dir("state") }, "/home/none", { agents: { launches: { maxActive: 4 } } })
  h = await harness({ config, now: () => Date.now() + skew })
  const machine = await h.store.addMachine("mbp")
  machineID = machine.machine.id

  const configDir = dir("spoke-config")
  const spokeConfig = path.join(configDir, "config.json")
  writeConfig(spokeConfig, { ...defaults("mbp"), server: h.url, mode: "always", token: machine.token, autoStartLocalHub: false, herdr: false })
  writeFileSync(
    path.join(configDir, "node.json"),
    JSON.stringify({ workspaceRoots: [root], slots: 3, openshell: { enabled: true, profiles: { "net-off": { endpoints: [] }, gpu: { cpu: 4 } } } }),
  )
  nodeEnv = { HUB_SPOKE_CONFIG: spokeConfig }
  // First the node without its openshell runtime (as when the openshell CLI is unusable).
  daemon = await startNode(false)
  await waitFor(() => h.nodes.forMachine(machineID) !== undefined, 5000)

  const { code } = await body(await h.api("/api/devices/link", { method: "POST", json: {} }))
  const { token } = await body(await h.api("/api/devices/redeem", { method: "POST", json: { code }, cookie: null, origin: null }))
  const home = dir("user-home")
  user = { env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, home }
  expect((await cli(["login", "--url", h.url, "--token", token], user)).code).toBe(0)
}, SLOW)

afterAll(async () => {
  daemon?.stop()
  await h?.stop()
  fake?.cleanup()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe("no openshell node", () => {
  test("an openshell launch stays queued while no node offers sandboxes; nothing is prepared", async () => {
    expect(h.nodes.forMachine(machineID)!.runtimes.map((r) => r.kind)).toEqual(["host"])
    const id = await launchSandboxed("waits", ["--branch", "feat/waits", "--prompt", "Never"])
    await Bun.sleep(400)
    expect((await launch(id)).state).toBe("queued")
    expect(fake.calls()).toEqual([])
    expect(existsSync(path.join(root, "waits"))).toBe(false)
    const stopped = await cli(["launches", "stop", id, "--json"], user)
    expect(json(stopped).launch).toMatchObject({ state: "ended", outcome: "stopped" })
  }, SLOW)
})

describe("setup", () => {
  test("with openshell enabled the node offers sandboxes: feature sandbox, its usable profiles, the gateway's backends", async () => {
    await restartNode(true)
    const node = h.nodes.forMachine(machineID)!
    expect(node.features).toContain("sandbox")
    // gpu is unsupported (cpu): the node does not offer it at all.
    expect(node.runtimes).toEqual([
      { kind: "host", harnesses: ["opencode"] },
      { kind: "openshell", harnesses: ["opencode"], profiles: ["default", "net-off"], backends: ["vm"] },
    ])
    // No service spoke is connected: sandboxed launches need none.
    expect(h.registry.serviceFor(machineID)).toBeUndefined()
  }, SLOW)
})

describe("a sandboxed launch's life", () => {
  let id = ""
  let box: Box
  let sessionID = ""
  let insideHead = ""
  const hostClone = () => path.join(root, "proj")
  const inside = () => path.join(box.root, "sandbox", "work")

  test("`hub launch --runtime openshell`: placed on the node, prepared in a sandbox, started, connected back, running", async () => {
    id = await launchSandboxed("proj", ["--profile", "net-off", "--branch", "feat/sbx", "--name", "sbx", "--role", "builder", "--prompt", "Build it in the box", "--cleanup", "remove"])
    box = await sandboxHarness(id)
    const running = await untilState(id, ["running", "ended"])
    expect(running).toMatchObject({ state: "running", machineID, name: "sbx", directory: SANDBOX_WORKDIR })
    expect(running.history.map((s) => s.state)).toEqual(["queued", "placing", "provisioning", "running"])
    sessionID = running.sessionID!

    // The sandbox: deterministic name, labels, the profile's policy (the hub only), the offline env.
    const sandbox = fake.sandbox(sandboxName(id))!
    expect(sandbox.labels).toEqual({ "hub.launch": labelValue(id), "hub.machine": labelValue(machineID) })
    expect(sandbox.env).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: "1", HUB_LAUNCH_CONFIG: "/sandbox/.hub/config.json" })
    // The policy allows the hub as the node reaches it (loopback → host.openshell.internal) and no git remote.
    expect(sandbox.policy).toContain(`"host.openshell.internal"`)
    expect(sandbox.policy).toContain(`port: ${new URL(h.url).port}`)
    expect(sandbox.policy).not.toContain("example.invalid")

    // The host clone (on the branch) and its clone inside at /sandbox/work, through the seed bundle.
    expect(git(hostClone(), "symbolic-ref", "--short", "HEAD")).toBe("feat/sbx")
    expect(git(inside(), "rev-parse", "HEAD")).toBe(git(hostClone(), "rev-parse", "HEAD"))
    expect(git(inside(), "symbolic-ref", "--short", "HEAD")).toBe("feat/sbx")

    // What start uploaded: the launch config the plugin reads (its token in no argv), node.json, ready.
    const { config, roots } = uploadedConfig(id)
    expect(config.launchID).toBe(id)
    expect(config.token).toStartWith("hlt1.")
    expect(config.hubURL).toBe(sandboxHubEndpoint(PUBLIC).url.replace(/\/+$/, ""))
    expect(roots).toEqual([SANDBOX_WORKDIR])
    expect(fake.calls().some((c) => c.argv.some((a) => a.includes(config.token)))).toBe(false)

    // The session was created on the launch-bound connection, in the sandbox's workspace.
    expect(box.ops.find((q) => q.op === "create")).toMatchObject({ op: "create", directory: SANDBOX_WORKDIR, launchID: id, title: "sbx" })
    expect(h.registry.launchConn(id)).toBeDefined()
    for (const address of ["@sbx", "@@builder"]) {
      const resolved = await cli(["show", address, "--json"], user)
      expect({ address, code: resolved.code }).toEqual({ address, code: 0 })
      expect(resolved.stdout).toContain(sessionID)
    }
  }, SLOW)

  test("the primer (name and role) and then the prompt reach the sandbox's harness", async () => {
    await waitFor(() => box.ops.some((q) => q.op === "turn"), 5000)
    const primer = box.ops.find((q) => q.op === "deliver" && q.meta?.kind === "primer")
    expect(primer?.text).toContain("@sbx")
    expect(primer?.text).toContain("builder")
    const turn = box.ops.find((q) => q.op === "turn")
    expect(turn).toMatchObject({ sessionID, text: "Build it in the box" })
    expect(box.ops.indexOf(primer)).toBeLessThan(box.ops.indexOf(turn))
  }, SLOW)

  test("the launch-bound connection gets session tokens but no act tokens, and is never the machine's service", async () => {
    await waitFor(() => box.ops.some((q) => q.op === "sessionTokens"), 5000)
    await Bun.sleep(100)
    expect(box.ops.filter((q) => q.op === "actTokens")).toEqual([])
    expect(h.registry.serviceFor(machineID)).toBeUndefined()
  }, SLOW)

  test("idle end: harness stopped, the commit made inside fast-forwarded into the host clone and reported, sandbox deleted", async () => {
    // The agent commits inside the sandbox.
    insideHead = commit(inside(), "box.txt", "made in the sandbox\n")
    await waitFor(() => h.registry.idle(sessionID), 5000)
    expect((await launch(id)).state).toBe("running")
    skew += END_SETTLE_MS + 1000
    box.client.send({ t: "sessions", sessions: box.sessions.map((s) => ({ ...s, updated: s.updated + 1 })) })
    box.client.send({ t: "event", event: { type: "session.status", data: { sessionID, status: { type: "idle" } } } })
    const ended = await untilState(id, ["ended"])
    expect(ended).toMatchObject({ state: "ended", outcome: "idle", artifacts: { branch: "feat/sbx", head: insideHead, dirty: false } })

    // stop (graceful: .hub/stop) came before collect (the bundle out) and cleanup (delete).
    const name = sandboxName(id)
    const calls = fake.calls().filter((c) => c.argv.includes(name))
    const stopAt = calls.findIndex((c) => c.command === "sandbox upload" && c.argv.some((a) => a.endsWith("/stop")))
    const downloadAt = calls.findIndex((c) => c.command === "sandbox download")
    const deleteAt = calls.findIndex((c) => c.command === "sandbox delete")
    expect(stopAt).toBeGreaterThan(-1)
    expect(stopAt).toBeLessThan(downloadAt)
    expect(downloadAt).toBeLessThan(deleteAt)

    // The host clone has the sandbox's commit on its branch and keeps it (unpushed); the sandbox is gone.
    expect(git(hostClone(), "rev-parse", "feat/sbx")).toBe(insideHead)
    expect(readFileSync(path.join(hostClone(), "box.txt"), "utf8")).toBe("made in the sandbox\n")
    expect(fake.sandbox(name)).toBeUndefined()
    expect(ended.reason).toContain("workspace kept (host clone: the clone has 1 unpushed commits)")
    expect(ended.reason).not.toContain("sandbox:")
  }, SLOW)

  test("the end closes the launch-bound connection; its token connects no more", async () => {
    const closed = await box.client.closed
    expect(closed.code).toBe(4004)
    expect(h.registry.launchConn(id)).toBeUndefined()
    expect(await upgradeStatus(box.config.token)).toBe(401)
  }, SLOW)
})

describe("launch-bound connections", () => {
  let id = ""
  let box: Box

  test("a second connection with the launch's token replaces the first: never two at once", async () => {
    id = await launchSandboxed("proj2", ["--branch", "feat/two", "--prompt", "Two", "--end", "never"])
    box = await sandboxHarness(id)
    await untilState(id, ["running"])
    const first = h.registry.launchConn(id)!
    const second = await boxConnect(box.config.token, id, `box2_${id}`)
    await second.next((f) => f.t === "welcome", 5000)
    expect((await box.client.closed).code).toBe(4003)
    await waitFor(() => h.registry.launchConn(id) !== undefined && h.registry.launchConn(id) !== first, 5000)
    expect(second.ws.readyState).toBe(WebSocket.OPEN)
    box.client = second
  }, SLOW)

  test("a launch's token is refused for another launch, and a forged token is refused", async () => {
    // A token that does not verify is refused at the upgrade.
    expect(await upgradeStatus(`${box.config.token.slice(0, -4)}AAAA`)).toBe(401)
    // The hello must name the token's own launch.
    const other = await boxConnect(box.config.token, "lch_someone_else", "box_other")
    expect((await other.next((f) => f.t === "bye", 5000)).reason).toContain("does not name the launch")
    await other.closed
    // The launch's own connection is untouched, and still not the machine's service.
    expect(box.client.ws.readyState).toBe(WebSocket.OPEN)
    expect(h.registry.serviceFor(machineID)).toBeUndefined()
  }, SLOW)

  test("`hub launches stop`: the harness is killed and the sandbox kept (cleanup keep) and stopped", async () => {
    const stopped = await cli(["launches", "stop", id, "--json"], user)
    expect(stopped.code).toBe(0)
    expect(json(stopped).launch).toMatchObject({ state: "ended", outcome: "stopped" })
    const name = sandboxName(id)
    expect(fake.calls().some((c) => c.command === "sandbox upload" && c.argv.includes(name) && c.argv.some((a) => a.endsWith("/stop")))).toBe(true)
    expect(fake.sandbox(name)?.phase).toBe("Stopped")
    expect(json(stopped).launch.reason).toContain("cleanup policy is keep")
    expect((await box.client.closed).code).toBe(4004)
  }, SLOW)
})

describe("profiles and failures", () => {
  test("an unsupported profile is never offered: the launch waits queued and no sandbox is created", async () => {
    const before = fake.calls().length
    const id = await launchSandboxed("gpu", ["--profile", "gpu", "--branch", "feat/gpu", "--prompt", "Never"])
    await Bun.sleep(400)
    expect((await launch(id)).state).toBe("queued")
    expect(fake.calls().slice(before).filter((c) => c.command === "sandbox create")).toEqual([])
    expect((await cli(["launches", "stop", id], user)).code).toBe(0)
  }, SLOW)

  test("a sandbox the gateway cannot create: the launch ends failed with the reason, before any session", async () => {
    fake.fail({ command: "sandbox create", stderr: "Error:   × image pull failed: not authorized\n" })
    const id = await launchSandboxed("broken", ["--branch", "feat/broken", "--prompt", "Never"])
    const ended = await untilState(id, ["ended"])
    expect(ended.outcome).toBe("failed")
    expect(ended.reason).toContain("image pull failed")
    expect(ended.sessionID).toBeUndefined()
    expect(h.registry.launchConn(id)).toBeUndefined()
  }, SLOW)
})

describe("tenancy", () => {
  test("another user sees none of these launches (GET and DELETE 404), and the user's node never takes theirs", async () => {
    const bob = await h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const cookie = `voice_device=${(await h.store.addDevice("bob phone", bob.id)).token}`
    const mine = await h.launches.list(USER)
    expect(mine.filter((l) => l.spec.runtime.kind === "openshell").length).toBeGreaterThanOrEqual(5)
    expect((await body(await h.api("/api/agent/launches", { cookie }))).launches).toEqual([])
    for (const method of ["GET", "DELETE"]) expect({ method, status: (await h.api(`/api/agent/launches/${mine[0]!.id}`, { method, cookie })).status }).toEqual({ method, status: 404 })
    const before = fake.calls().length
    const bobs = await h.launches.accept(bob.id, { workspace: { repo: path.join(root, "bob"), mode: "clone", remote: "https://example.invalid/proj" }, runtime: { kind: "openshell" } })
    await Bun.sleep(300)
    expect((await h.launches.view(bob.id, bobs.launch.id))?.state).toBe("queued")
    expect(await h.launches.view(USER, bobs.launch.id)).toBeUndefined()
    expect(fake.calls().length).toBe(before)
    await h.launches.stop(bob.id, bobs.launch.id)
  }, SLOW)
})
