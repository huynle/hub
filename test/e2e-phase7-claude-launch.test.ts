// Phase 7 (P7-T9): a launch with harness claude-code, end to end without the real Claude Code. One in-process hub,
// a REAL `hub node` daemon (packages/node, host runtime, real git worktrees under a temp root) whose host runtime
// offers the harnesses found on its PATH, and the REAL Claude Code spoke daemon (packages/claude-code) set up as
// `hub claude-code daemon` sets it up (daemonLaunchOptions: the CLI on PATH, node.json's roots). The `claude` on
// that PATH is the fake (packages/claude-code/test/fake-claude.ts): headless stream-json, hooks through the real
// bridge.
//
// Placement puts the launch on the node (its host runtime lists claude-code, and the machine's claude-code service
// spoke announces launch), the node prepares the worktree, the daemon creates the session by starting claude there
// and the launch's prompt arrives as the session's first user message; stopping the launch interrupts nothing that
// runs and ends it stopped.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { startDaemon, type ClaudeDaemon } from "../packages/claude-code/src/daemon.ts"
import { claudeSessionID } from "../packages/claude-code/src/ids.ts"
import { daemonLaunchOptions } from "../packages/claude-code/src/main.ts"
import { fakeClaude } from "../packages/claude-code/test/fake-claude.ts"
import { detectHarnesses, HostRuntime, NodeDaemon, nodeConfigPath, readNodeConfig, readSpokeCredentials } from "../packages/node/src/index.ts"
import { defaults, writeConfig } from "../src/config"
import { harness, waitFor, type Harness } from "./central-harness"

// End to end: real hubs, spokes, nodes and git; give each test room on a loaded machine.
setDefaultTimeout(30_000)

const USER = "local"
const GIT_ENV = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" }

let h: Harness
let tmp: string
let root: string
let repo: string
let machineID: string
let node: NodeDaemon
let claude: ClaudeDaemon
let fake: ReturnType<typeof fakeClaude>

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
const launch = async (id: string) => (await h.launches.view(USER, id))!

async function untilState(id: string, states: string[], timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const l = await launch(id)
    if (states.includes(l.state)) return l
    if (Date.now() > deadline) throw new Error(`launch ${id} is ${l.state} (${l.reason}), not ${states.join("/")}`)
    await Bun.sleep(10)
  }
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-e2e-p7cc-")))
  root = path.join(tmp, "work")
  repo = path.join(root, "app")
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(path.join(repo, "README.md"), "# e2e\n")
  git(repo, "add", "README.md")
  git(repo, "commit", "-q", "-m", "init")

  h = await harness()
  const machine = await h.store.addMachine("mbp")
  machineID = machine.machine.id

  // The machine as `hub node` and `hub claude-code daemon` find it: config.json (hub URL, machine token) and
  // node.json beside it, and the (fake) Claude Code CLI on PATH.
  fake = fakeClaude()
  const configDir = path.join(tmp, "config")
  mkdirSync(configDir)
  const spokeConfig = path.join(configDir, "config.json")
  writeConfig(spokeConfig, { ...defaults("mbp"), server: h.url, mode: "always", token: machine.token, autoStartLocalHub: false, herdr: false })
  writeFileSync(path.join(configDir, "node.json"), JSON.stringify({ workspaceRoots: [root], slots: 2 }))
  const env = { HUB_SPOKE_CONFIG: spokeConfig, HUB_STATE_DIR: path.join(tmp, "state"), PATH: `${path.dirname(fake.bin)}${path.delimiter}${process.env.PATH ?? ""}` }

  const { config } = readNodeConfig(nodeConfigPath(env, tmp))
  node = new NodeDaemon({ config, credentials: readSpokeCredentials(env, tmp)!, runtimes: [new HostRuntime({ roots: config.workspaceRoots, harnesses: detectHarnesses({ env }) })] })
  node.start()

  const launchOptions = daemonLaunchOptions({ env, home: tmp, program: { execPath: process.execPath, entry: path.join(tmp, "hub-cli.js") } })
  expect(launchOptions?.bin).toBe(fake.bin)
  claude = await startDaemon({
    socketPath: path.join(tmp, "cc", "d.sock"),
    server: h.url,
    token: machine.token,
    harnessVersion: "2.1.296",
    pluginVersion: "0.6.1",
    directory: tmp,
    tokenWaitMs: 500,
    launch: launchOptions!,
  })
  await waitFor(() => h.nodes.forMachine(machineID) !== undefined && h.registry.serviceFor(machineID, "claude-code") !== undefined, 5000)
})

afterAll(async () => {
  await claude?.stop()
  node?.stop()
  await h?.stop()
  rmSync(tmp, { recursive: true, force: true })
})

describe("setup", () => {
  test("the node's host runtime offers claude-code (its CLI is on PATH); the claude-code service spoke announces launch", () => {
    expect(h.nodes.forMachine(machineID)!.runtimes).toEqual([{ kind: "host", harnesses: ["opencode", "claude-code"] }])
    const connID = h.registry.serviceFor(machineID, "claude-code")!
    expect(h.registry.supports(connID, "launch")).toBe(true)
    // No OpenCode service spoke on this machine: a claude-code spoke never stands in for it.
    expect(h.registry.serviceFor(machineID)).toBeUndefined()
  })
})

describe("a claude-code launch", () => {
  let id = ""
  let sessionID = ""
  const worktree = () => path.join(repo, ".worktrees", "feat", "cc")

  test("is placed on the node, prepared as a worktree and created by the daemon starting claude there", async () => {
    const created = await h.api("/api/agent/launches", { method: "POST", json: { harness: "claude-code", name: "cc", workspace: { repo, branch: "feat/cc" }, prompt: "Fix the failing tests" } })
    expect(created.status).toBe(201)
    id = (await created.json()).launch.id
    const running = await untilState(id, ["running", "ended"])
    expect(running).toMatchObject({ state: "running", machineID, name: "cc", directory: worktree() })
    sessionID = running.sessionID!
    expect(sessionID).toMatch(/^ses_cc/)
    expect(git(worktree(), "symbolic-ref", "--short", "HEAD")).toBe("feat/cc")

    await waitFor(() => lines(fake.log).length > 0, 5000)
    const [start] = lines(fake.log)
    expect(start.cwd).toBe(worktree())
    expect(claudeSessionID(start.argv[start.argv.indexOf("--session-id") + 1])).toBe(sessionID)
    expect(start.argv).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json"]))
    // The hub plugin the daemon wrote for launches, with this machine's hub CLI in its hooks.
    const plugin = start.argv[start.argv.indexOf("--plugin-dir") + 1]
    expect(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")).toContain(path.join(tmp, "hub-cli.js"))
  })

  test("the launch's prompt is the session's first user message; the session works on it, then is idle", async () => {
    await waitFor(() => lines(fake.prompts).length > 0, 5000)
    expect(lines(fake.prompts)).toEqual([{ sessionID: expect.any(String), text: "Fix the failing tests", images: 0 }])
    await waitFor(() => h.registry.idle(sessionID), 5000)
    expect(h.registry.session(sessionID)).toMatchObject({ directory: worktree(), title: "cc" })
  })

  test("stopping the launch ends it stopped", async () => {
    const stopped = await h.api(`/api/agent/launches/${id}`, { method: "DELETE" })
    expect(stopped.status).toBe(200)
    const ended = await untilState(id, ["ended"])
    expect(ended.outcome).toBe("stopped")
  })
})
