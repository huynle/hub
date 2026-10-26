// Phase 7 (agent control plane across harnesses, P7-T11) end to end: one in-process hub (multi-user) and ONE machine
// of the user's running every kind of spoke this repository ships, each the real one:
// - OpenCode: the plugin's Spoke over a fake OpenCode host (test/fixtures/fake-opencode.ts; evidence native);
// - Claude Code: the per-user daemon (packages/claude-code) with its hook bridge over a real Unix socket, driven by
//   the spike's fixture hook inputs (a terminal session, evidence hooks), and starting the fake claude for launches;
// - Codex: the app-server spoke attached to a fake shared daemon (fake-app-server.ts over a Unix-socket WebSocket)
//   where a "TUI" client starts the thread and answers nothing (evidence rpc), plus its own app-server for launches;
// - a preset: the preset spoke running a fake terminal harness in a private tmux server (-L hub-e2e7-…; evidence
//   screen);
// - a `hub node` daemon whose host runtime offers opencode, claude-code (the fake claude on PATH) and codex.
//
// Checks: who/status/sessions list every session with its harness and the catalog its evidence; a message reaches
// each with an honest delivery mode; acting: a permission approved through the hub runs the Claude Code and Codex
// tools, and ops a spoke did not announce answer unsupported (agent 422, console 409) naming feature and harness;
// launches for claude-code and codex run in node worktrees; tenancy: another user reaches none of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runHook } from "../packages/claude-code/src/bridge.ts"
import { startDaemon, type ClaudeDaemon } from "../packages/claude-code/src/daemon.ts"
import { claudeSessionID } from "../packages/claude-code/src/ids.ts"
import { daemonLaunchOptions } from "../packages/claude-code/src/main.ts"
import { fakeClaude } from "../packages/claude-code/test/fake-claude.ts"
import { codexSessionID } from "../packages/codex/src/ids.ts"
import { JsonRpcPeer } from "../packages/codex/src/jsonrpc.ts"
import { startCodexSpoke, type CodexSpoke } from "../packages/codex/src/spoke.ts"
import { connectUnixWebSocket } from "../packages/codex/src/websocket.ts"
import { detectHarnesses, HostRuntime, NodeDaemon, nodeConfigPath, readNodeConfig, readSpokeCredentials } from "../packages/node/src/index.ts"
import { PresetSpoke } from "../packages/preset/src/spoke.ts"
import { tmuxBackend, tmuxRunner, type TerminalBackend } from "../packages/preset/src/tmux.ts"
import type { HarnessPreset } from "../packages/protocol/src/index.ts"
import { stubModel, type StubModel } from "../packages/testkit/src/index.ts"
import { run as cli } from "../packages/cli/src/cli"
import { defaults, writeConfig } from "../src/config"
import { Spoke } from "../src/spoke/spoke"
import { harness, sse, waitFor, type Harness } from "./central-harness"
import { FakeOpenCode } from "./fixtures/fake-opencode"

const SLOW = 30_000
const GIT_ENV = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" }
const OIDC_ENV = { HUB_AUTH: "oidc", HUB_OIDC_CLIENT_ID: "cid", HUB_OIDC_CLIENT_SECRET: "csecret", HUB_OIDC_ALLOWED: "@example.com", HUB_ADMIN_EMAILS: "alice@example.com" }
const FAKE_APP_SERVER = path.join(import.meta.dir, "..", "packages", "codex", "test", "fixtures", "fake-app-server.ts")
const CC_FIXTURES = path.join(import.meta.dir, "..", "packages", "claude-code", "test", "fixtures")
const hasTmux = spawnSync("tmux", ["-V"]).status === 0

const PRESET: HarnessPreset = {
  name: "preset-fake-tui",
  description: "A fake terminal harness",
  command: [process.execPath, path.join(import.meta.dir, "..", "packages", "preset", "fixtures", "fake-tui.ts")],
  nativeID: { source: "screen", pattern: "fake-tui session ([0-9a-f]+)" },
  delivery: "paste",
  evidence: "screen",
}

let h: Harness
let tmp: string
let root: string
let repo: string
let aliceID: string
let aliceCookie: string
let aliceDeviceToken: string
let eveCookie: string
let machineID: string
let stub: StubModel

let host: FakeOpenCode
let oc: Spoke
let OC = ""

let claude: ClaudeDaemon
let ccSocket: string
let fake: ReturnType<typeof fakeClaude>
const CC_NATIVE = randomUUID()
const CC = claudeSessionID(CC_NATIVE)
let ccEnvFile: string

let codexDaemon: ChildProcess | undefined
let codex: CodexSpoke
let tui: { peer: JsonRpcPeer; approvals: Array<{ id: number | string; params: any }>; notes: Array<{ method: string; params: any }>; close(): void }
let CX = ""
let cxThread = ""

const tmuxSocket = `hub-e2e7-${randomBytes(4).toString("hex")}`
let preset: PresetSpoke | undefined
let presetBackend: TerminalBackend | undefined
let PR = ""

let node: NodeDaemon

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

/** The hub as alice (her device cookie) unless another cookie is given. */
const api = (pathname: string, init: RequestInit & { json?: unknown; cookie?: string } = {}) => h.api(pathname, { ...init, cookie: init.cookie ?? aliceCookie })
const body = async (r: Response) => (await r.json()) as any

/** A Claude Code hook as Claude Code would run it (the spike's fixture input, this session, the repo as cwd). */
async function hook(name: string, extra: Record<string, unknown> = {}, more: { argv?: string[]; env?: Record<string, string> } = {}) {
  const input = { ...JSON.parse(readFileSync(path.join(CC_FIXTURES, `${name}.json`), "utf8")), session_id: CC_NATIVE, cwd: repo, ...extra }
  const out = { stdout: "", stderr: "" }
  const code = await runHook({ argv: more.argv ?? [], stdin: JSON.stringify(input), env: more.env ?? {}, socketPath: ccSocket, stdout: (s) => (out.stdout += s), stderr: (s) => (out.stderr += s) })
  return { code, ...out, json: out.stdout ? JSON.parse(out.stdout) : undefined }
}

/** Events the hub got from spokes about a session (the console's live state). */
const state = (sessionID: string) => h.registry.status(sessionID)?.find((s) => s.id === sessionID)

/** Kills a child we started (never a pid ≤ 1: quirk wqnafwvz). */
async function killChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (!Number.isInteger(child.pid) || (child.pid as number) <= 1) return
  const gone = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGTERM")
  await Promise.race([gone, Bun.sleep(3000)])
}

function killTmux(): void {
  if (!hasTmux) return
  const where = spawnSync("tmux", ["-L", tmuxSocket, "display-message", "-p", "#{socket_path}"], { encoding: "utf8" }).stdout?.trim()
  spawnSync("tmux", ["-L", tmuxSocket, "kill-server"], { stdio: "ignore" })
  rmSync(where || `${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid?.() ?? 0}/${tmuxSocket}`, { force: true })
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-e2e-p7-")))
  root = path.join(tmp, "work")
  repo = path.join(root, "app")
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(path.join(repo, "README.md"), "# e2e\n")
  git(repo, "add", "README.md")
  git(repo, "commit", "-q", "-m", "init")
  stub = stubModel()

  h = await harness({ env: OIDC_ENV, noDevice: true })
  const alice = await h.store.upsertUser({ email: "alice@example.com", role: "admin" })
  aliceID = alice.id
  aliceDeviceToken = (await h.store.addDevice("alice phone", alice.id)).token
  aliceCookie = `voice_device=${aliceDeviceToken}`
  const eve = await h.store.upsertUser({ email: "eve@example.com", role: "user" })
  eveCookie = `voice_device=${(await h.store.addDevice("eve phone", eve.id)).token}`
  const machine = await h.store.addMachine("mbp", aliceID)
  machineID = machine.machine.id

  // The machine as its spokes find it: config.json (hub URL, machine token), node.json beside it, the fake claude on PATH.
  fake = fakeClaude()
  const configDir = path.join(tmp, "config")
  mkdirSync(configDir)
  const spokeConfig = path.join(configDir, "config.json")
  writeConfig(spokeConfig, { ...defaults("mbp"), server: h.url, mode: "always", token: machine.token, autoStartLocalHub: false, herdr: false })
  writeFileSync(path.join(configDir, "node.json"), JSON.stringify({ workspaceRoots: [root], slots: 4, harnesses: { codex: true } }))
  const env = { HUB_SPOKE_CONFIG: spokeConfig, HUB_STATE_DIR: path.join(tmp, "state"), PATH: `${path.dirname(fake.bin)}${path.delimiter}${process.env.PATH ?? ""}` }

  // OpenCode: the plugin's spoke over the fake host, a session the user opened in the repo.
  host = new FakeOpenCode({ directory: repo })
  const ocConfig = path.join(configDir, "opencode-spoke.json")
  writeConfig(ocConfig, { ...defaults("mbp"), server: h.url, mode: "always", token: machine.token, autoStartLocalHub: false, herdr: false })
  oc = new Spoke(host.host, { configFile: ocConfig, machineName: "mbp", kind: "standalone", processID: "proc_oc7", pid: process.pid, pluginVersion: "0.6.1", snapshotDebounceMs: 10, seedDebounceMs: 10, pollMs: 20, backoff: { minMs: 10, maxMs: 50 } })
  oc.start()
  OC = host.createSession({ title: "OpenCode work" })

  // Claude Code: the per-user daemon (as `hub claude-code daemon` sets it up), a terminal session through its hooks.
  ccSocket = path.join(tmp, "cc", "d.sock")
  claude = await startDaemon({
    socketPath: ccSocket,
    server: h.url,
    token: machine.token,
    harnessVersion: "2.1.296",
    pluginVersion: "0.6.1",
    directory: tmp,
    tokenWaitMs: 3000,
    launch: daemonLaunchOptions({ env, home: tmp, program: { execPath: process.execPath, entry: path.join(tmp, "hub-cli.js") } })!,
  })
  await until(() => claude.state === "connected", 5000, "the claude-code daemon")
  ccEnvFile = path.join(tmp, "cc-env", "sessionstart-hook-1.sh")
  mkdirSync(path.dirname(ccEnvFile))
  expect((await hook("session-start", {}, { env: { CLAUDE_ENV_FILE: ccEnvFile } })).code).toBe(0)

  // Codex: a fake shared daemon with a TUI client that starts a thread in the repo; the spoke attaches to it.
  const cxSocket = path.join(tmp, "cx", "d.sock")
  mkdirSync(path.dirname(cxSocket))
  codexDaemon = spawn(process.execPath, [FAKE_APP_SERVER, "app-server", "--listen", `unix://${cxSocket}`], { env: { ...process.env, FAKE_CODEX_MODEL_URL: stub.openaiBaseURL }, stdio: ["ignore", "pipe", "inherit"] })
  await new Promise<void>((resolve) => codexDaemon!.stdout!.once("data", () => resolve()))
  {
    const channel = await connectUnixWebSocket(cxSocket)
    const approvals: Array<{ id: number | string; params: any }> = []
    const notes: Array<{ method: string; params: any }> = []
    // The TUI never answers approvals here: the hub does.
    const peer = new JsonRpcPeer(channel, { onRequest: (id, _m, params) => void approvals.push({ id, params }), onNotification: (method, params) => void notes.push({ method, params }) })
    await peer.request("initialize", { clientInfo: { name: "tui", version: "0" }, capabilities: { experimentalApi: true } })
    peer.notify("initialized")
    tui = { peer, approvals, notes, close: () => peer.close() }
    const started = await peer.request("thread/start", { cwd: repo, approvalPolicy: "untrusted" })
    cxThread = started.thread.id
    CX = codexSessionID(cxThread)
  }
  codex = startCodexSpoke({
    server: h.url,
    token: machine.token,
    harnessVersion: "0.160.0",
    pluginVersion: "0.6.1",
    directory: tmp,
    codexBin: process.execPath,
    codexBinArgs: [FAKE_APP_SERVER],
    env: { PATH: process.env.PATH ?? "" },
    daemonSocket: cxSocket,
    pollMs: 50,
    threadDefaults: { approvalPolicy: "never" },
    backoff: { minMs: 20, maxMs: 50 },
  })

  // A preset: the fake terminal harness in a private tmux server.
  if (hasTmux) {
    presetBackend = tmuxBackend({ socket: tmuxSocket, config: "/dev/null", run: tmuxRunner("tmux", process.env) })
    preset = new PresetSpoke({ preset: PRESET, backend: presetBackend, server: h.url, token: machine.token, pluginVersion: "0.6.1", directory: repo, sampleMs: 200, backoff: { minMs: 20, maxMs: 50 } })
    preset.start()
    PR = (await preset.launch({ cwd: repo })).sessionID
  }

  // The node: its host runtime offers what node.json and PATH allow (opencode, claude-code via the fake, codex).
  const { config } = readNodeConfig(nodeConfigPath(env, tmp))
  node = new NodeDaemon({ config, credentials: readSpokeCredentials(env, tmp)!, runtimes: [new HostRuntime({ roots: config.workspaceRoots, harnesses: detectHarnesses({ env, ...(config.harnesses ? { overrides: config.harnesses } : {}) }) })] })
  node.start()

  await until(() => [OC, CC, CX, ...(PR ? [PR] : [])].every((id) => h.registry.hasSession(id)), 8000, "every harness's session")
  await until(() => h.nodes.forMachine(machineID) !== undefined && h.registry.serviceFor(machineID, "claude-code") !== undefined && h.registry.serviceFor(machineID, "codex") !== undefined, 5000, "node and service spokes")
}, 60_000)

afterAll(async () => {
  node?.stop()
  preset?.stop()
  killTmux()
  await codex?.stop()
  tui?.close()
  await killChild(codexDaemon)
  await claude?.stop()
  oc?.stop()
  await h?.stop()
  await stub?.stop()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})


/** Hub session IDs of the four harnesses' sessions, with what each must look like. */
const expected = () => [
  { id: OC, harness: "opencode", evidence: "native" },
  { id: CC, harness: "claude-code", evidence: "hooks" },
  { id: CX, harness: "codex", evidence: "rpc" },
  ...(PR ? [{ id: PR, harness: "preset-fake-tui", evidence: "screen" }] : []),
]

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
const launch = async (id: string) => (await h.launches.view(aliceID, id))!
async function untilState(id: string, states: string[], timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const l = await launch(id)
    if (states.includes(l.state)) return l
    if (Date.now() > deadline) throw new Error(`launch ${id} is ${l.state} (${l.reason}), not ${states.join("/")}`)
    await Bun.sleep(10)
  }
}

describe("who, status and sessions across harnesses", () => {
  test(
    "every session is listed with its harness; the catalog carries each process's evidence and features",
    async () => {
      const sessions = (await body(await api("/api/agent/sessions"))).sessions as any[]
      for (const e of expected()) expect(sessions).toContainEqual(expect.objectContaining({ id: e.id, harness: e.harness, machineID, project: "app" }))
      const status = await body(await api("/api/agent/status"))
      const machine = status.machines.find((m: any) => m.id === machineID)
      expect(machine).toMatchObject({ online: true })
      expect([...machine.harnesses].sort()).toEqual(expected().map((e) => e.harness).sort())
      const listed = machine.projects.flatMap((p: any) => p.sessions.map((s: any) => [s.id, s.harness]))
      for (const e of expected()) expect(listed).toContainEqual([e.id, e.harness])
      const who = (await body(await api("/api/agent/who"))).sessions as any[]
      for (const e of expected()) expect(who).toContainEqual(expect.objectContaining({ sessionID: e.id, online: true, machineID }))

      // The console's catalog: evidence per process, and only what each announced (the controls are gated on it).
      const events = sse(await api("/api/events"))
      const catalog = await events.next((m) => m.type === "catalog")
      await events.cancel()
      const processes = catalog.machines.find((m: any) => m.id === machineID).processes as any[]
      for (const e of expected()) {
        const p = processes.find((p) => p.sessions.some((s: any) => s.id === e.id))
        expect({ harness: p.harness, evidence: p.evidence }).toEqual({ harness: e.harness, evidence: e.evidence })
      }
      const features = (harness: string) => processes.find((p) => p.harness === harness).features as string[]
      expect(features("opencode")).toEqual(expect.arrayContaining(["turn", "steer", "permission", "form", "timeline", "deliver"]))
      expect(features("claude-code")).not.toContain("steer")
      expect(features("claude-code")).not.toContain("timeline")
      expect(features("codex")).toEqual(expect.arrayContaining(["turn", "steer", "interrupt", "permission", "turnEvents"]))
      if (PR) expect(features("preset-fake-tui")).not.toEqual(expect.arrayContaining(["permission"]))
      if (PR) expect(features("preset-fake-tui")).not.toContain("steer")

      // The `hub` CLI as the user (her device token): the same sessions.
      const home = mkdtempSync(path.join(tmp, "cli-"))
      const who2 = { env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, home }
      const io = (out: { s: string }) => ({ env: who2.env, home, stdout: (t: string) => void (out.s += t), stderr: (t: string) => void (out.s += t) })
      const login = { s: "" }
      expect(await cli(["login", "--url", h.url, "--token", aliceDeviceToken], io(login))).toBe(0)
      const listedByCli = { s: "" }
      expect(await cli(["sessions", "--json"], io(listedByCli))).toBe(0)
      const fromCli = JSON.parse(listedByCli.s).sessions as any[]
      for (const e of expected()) expect(fromCli).toContainEqual(expect.objectContaining({ id: e.id, harness: e.harness }))
    },
    SLOW,
  )
})

describe("messaging each harness: honest delivery modes", () => {
  const send = async (to: string, text: string) => {
    const r = await api("/api/agent/msg", { method: "POST", json: { to, text } })
    expect(r.status).toBe(201)
    return body(r)
  }

  test(
    "OpenCode (native): woken as a turn, the message admitted once as a synthetic message",
    async () => {
      await until(() => h.registry.idle(OC), 5000, "OpenCode idle")
      const sent = await send(OC, "hello OpenCode")
      expect(sent.delivery).toBe("turn")
      await until(() => host.admitted.some((a) => a.text.includes("hello OpenCode")), 3000, "the synthetic message")
      expect(host.admitted.filter((a) => a.text.includes("hello OpenCode"))).toEqual([expect.objectContaining({ sessionID: OC, resume: true })])
      await until(() => h.registry.idle(OC), 5000, "its turn over")
    },
    SLOW,
  )

  test(
    "Claude Code (hooks): queued, and handed to the model at the session's next prompt hook",
    async () => {
      const sent = await send(CC, "hello Claude")
      expect(sent.delivery).toBe("queued")
      const prompt = await hook("user-prompt-submit")
      expect(prompt.json?.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining("hello Claude") })
      await hook("stop")
      await until(() => h.registry.idle(CC), 3000, "Claude Code idle")
    },
    SLOW,
  )

  test(
    "Codex (rpc): an idle thread takes it as a turn the daemon's clients see",
    async () => {
      await until(() => h.registry.idle(CX), 5000, "Codex idle")
      const before = tui.notes.filter((n) => n.method === "turn/completed").length
      const sent = await send(CX, "hello Codex")
      expect(sent.delivery).toBe("turn")
      await until(() => tui.notes.filter((n) => n.method === "turn/completed").length > before, 5000, "the turn in the TUI")
      await until(() => h.registry.idle(CX), 5000, "Codex idle again")
    },
    SLOW,
  )

  test.skipIf(!hasTmux)(
    "a preset (screen): queued (pasted, never confirmed), and the text is in the pane",
    async () => {
      const sent = await send(PR, "hello preset")
      expect(sent.delivery).toBe("queued")
      const pane = preset!.pane(PR)!
      await until(async () => (await presetBackend!.capture(pane, 200)).includes("fake-tui got:") && (await presetBackend!.capture(pane, 200)).includes("hello preset"), 5000, "the pasted message")
      // Screen evidence is never idle: the hub does not trust it to have finished anything.
      expect(h.registry.idle(PR)).toBe(false)
    },
    SLOW,
  )
})

describe("acting through the hub", () => {
  test(
    "Claude Code: the console approves a PermissionRequest the hook waits on; the tool runs",
    async () => {
      await hook("user-prompt-submit")
      await hook("pre-tool-use")
      const pending = hook("permission-request", {}, { argv: ["--wait", "10"] })
      await until(() => (state(CC)?.blockers.length ?? 0) > 0, 5000, "the permission blocker")
      const blocker = state(CC)!.blockers[0]!
      expect(blocker).toMatchObject({ kind: "permission", action: "shell" })
      const answer = await api(`/api/sessions/${CC}/permission`, { method: "POST", json: { requestID: blocker.id, decision: "once" } })
      expect(answer.status).toBe(204)
      expect((await pending).json).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })
      await hook("post-tool-use")
      await until(() => state(CC)?.blockers.length === 0, 3000, "the blocker gone")
      await hook("stop")
      await until(() => h.registry.idle(CC), 3000, "Claude Code idle")
    },
    SLOW,
  )

  test(
    "Codex: the agent approve verb (as the user) answers the daemon's approval request; the command completes",
    async () => {
      stub.queue({ toolCalls: [{ name: "exec_command", input: { cmd: "touch e2e" }, id: "call_e2e7" }] }, { text: "done" })
      await tui.peer.request("turn/start", { threadId: cxThread, input: [{ type: "text", text: "run it", text_elements: [] }] })
      await until(() => (state(CX)?.blockers.length ?? 0) > 0 && tui.approvals.length > 0, 5000, "the approval request")
      const blocker = state(CX)!.blockers[0]!
      expect(blocker).toMatchObject({ kind: "permission", action: "shell", resources: ["/bin/bash -lc 'touch e2e'"] })
      const approved = await api(`/api/agent/sessions/${CX}/approve`, { method: "POST", json: { requestID: blocker.id } })
      expect(approved.status).toBe(200)
      // Broadcast to every client of the thread; the hub answered first, the TUI hears it resolved.
      await until(() => tui.notes.some((n) => n.method === "serverRequest/resolved"), 5000, "resolved for the TUI")
      await until(
        () => tui.notes.some((n) => n.method === "item/completed" && n.params?.item?.type === "commandExecution" && n.params.item.status === "completed"),
        5000,
        "the command completed",
      )
      await until(() => h.registry.idle(CX) && state(CX)?.blockers.length === 0, 5000, "Codex idle")
    },
    SLOW,
  )

  test(
    "ops a spoke did not announce answer unsupported with feature and harness: agent 422, console 409",
    async () => {
      // A Claude Code turn running in a terminal: nothing can steer it (no steer feature).
      await hook("user-prompt-submit")
      await until(() => state(CC)?.state === "working", 3000, "Claude Code working")
      const agent = await api(`/api/agent/sessions/${CC}/prompt`, { method: "POST", json: { text: "and also this" } })
      expect(agent.status).toBe(422)
      expect((await body(agent)).error).toMatchObject({ code: "unsupported", feature: "steer", harness: "claude-code", message: "The claude-code spoke does not support steer" })
      const console_ = await api(`/api/sessions/${CC}/turn`, { method: "POST", json: { text: "and also this" } })
      expect(console_.status).toBe(409)
      expect(await body(console_)).toEqual({ code: "unsupported", error: "The claude-code spoke does not support steer" })
      await hook("stop")

      // Read routes: the timeline (log) and the summary (show) only where announced.
      for (const e of expected().filter((e) => e.harness !== "opencode")) {
        const log = await api(`/api/agent/sessions/${e.id}/log`)
        expect({ id: e.id, status: log.status, error: (await body(log)).error }).toEqual({
          id: e.id,
          status: 422,
          error: { code: "unsupported", feature: "timeline", harness: e.harness, message: `The ${e.harness} spoke does not support timeline` },
        })
        const show = await body(await api(`/api/agent/sessions/${e.id}`))
        expect(show).toMatchObject({ id: e.id, harness: e.harness, unsupported: [{ feature: "summary", harness: e.harness }] })
      }
      expect((await api(`/api/agent/sessions/${OC}/log`)).status).toBe(200)
    },
    SLOW,
  )
})

describe("launches by harness", () => {
  test(
    "claude-code: placed on the node, a worktree, the daemon starts (fake) claude there with the launch's prompt",
    async () => {
      const created = await api("/api/agent/launches", { method: "POST", json: { harness: "claude-code", name: "cc", workspace: { repo, branch: "feat/cc" }, prompt: "Fix the tests" } })
      expect(created.status).toBe(201)
      const id = (await body(created)).launch.id
      const running = await untilState(id, ["running", "ended"])
      const worktree = path.join(repo, ".worktrees", "feat", "cc")
      expect(running).toMatchObject({ state: "running", machineID, directory: worktree })
      expect(running.sessionID).toMatch(/^ses_cc/)
      await until(() => lines(fake.prompts).some((p) => p.text === "Fix the tests"), 5000, "the prompt")
      expect(lines(fake.log).at(-1).cwd).toBe(worktree)
      await until(() => h.registry.idle(running.sessionID!), 5000, "the launched session idle")
      expect((await api(`/api/agent/launches/${id}`, { method: "DELETE" })).status).toBe(200)
      expect((await untilState(id, ["ended"])).outcome).toBe("stopped")
    },
    SLOW,
  )

  test(
    "codex: placed on the node, a worktree, a thread on the spoke's own app-server running the launch's prompt",
    async () => {
      const created = await api("/api/agent/launches", { method: "POST", json: { harness: "codex", name: "cx", workspace: { repo, branch: "feat/cx" }, prompt: "Build it" } })
      expect(created.status).toBe(201)
      const id = (await body(created)).launch.id
      const running = await untilState(id, ["running", "ended"])
      const worktree = path.join(repo, ".worktrees", "feat", "cx")
      expect(running).toMatchObject({ state: "running", machineID, directory: worktree })
      expect(running.sessionID).toMatch(/^ses_cx/)
      expect(git(worktree, "symbolic-ref", "--short", "HEAD")).toBe("feat/cx")
      await until(() => h.registry.idle(running.sessionID!), 8000, "the launched thread idle after its prompt")
      expect(h.registry.session(running.sessionID!)).toMatchObject({ directory: worktree })
      expect((await api(`/api/agent/launches/${id}`, { method: "DELETE" })).status).toBe(200)
      expect((await untilState(id, ["ended"])).outcome).toBe("stopped")
    },
    SLOW,
  )
})

describe("tenancy", () => {
  test(
    "another user sees none of the harnesses' sessions and reaches none of them",
    async () => {
      const secrets = expected().map((e) => e.id)
      const reads = ["/api/agent/sessions", "/api/agent/status", "/api/agent/who", "/api/agent/launches", "/api/decisions"]
      for (const p of reads) {
        const r = await api(p, { cookie: eveCookie })
        const text = await r.text()
        expect({ p, status: r.status, leaks: secrets.filter((s) => text.includes(s)) }).toEqual({ p, status: 200, leaks: [] })
      }
      const events = sse(await api("/api/events", { cookie: eveCookie }))
      const catalog = await events.next((m) => m.type === "catalog")
      await events.cancel()
      expect(secrets.filter((s) => JSON.stringify(catalog).includes(s))).toEqual([])
      const admittedBefore = host.admitted.length
      for (const id of secrets) {
        const rows = [
          { what: "msg", status: (await api("/api/agent/msg", { method: "POST", json: { to: id, text: "hi from eve" }, cookie: eveCookie })).status },
          { what: "prompt", status: (await api(`/api/agent/sessions/${id}/prompt`, { method: "POST", json: { text: "x" }, cookie: eveCookie })).status },
          { what: "approve", status: (await api(`/api/agent/sessions/${id}/approve`, { method: "POST", json: { requestID: "per_x" }, cookie: eveCookie })).status },
          { what: "permission", status: (await api(`/api/sessions/${id}/permission`, { method: "POST", json: { requestID: "per_x", decision: "once" }, cookie: eveCookie })).status },
          { what: "stop", status: (await api(`/api/sessions/${id}/stop`, { method: "POST", cookie: eveCookie })).status },
        ]
        expect({ id, rows }).toEqual({ id, rows: rows.map((r) => ({ what: r.what, status: 404 })) })
      }
      await Bun.sleep(200)
      expect(host.admitted.length).toBe(admittedBefore)
    },
    SLOW,
  )
})
