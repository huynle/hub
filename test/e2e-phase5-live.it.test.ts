// OPT-IN live check of phase 5 (sandboxed launches, P5-T12) against a real local OpenShell gateway (0.1.x, vm
// driver). Runs only with HUB_IT_OPENSHELL=1 and `openshell` on PATH:
//
//   HUB_IT_OPENSHELL=1 bun test test/e2e-phase5-live.it.test.ts
//
// Ground rules (it shares the gateway with the user's own sandboxes):
// - Only the OpenShell workspace `hub` (OpenShellCli's default). Nothing else is listed, changed or deleted: no other
//   workspace, sandbox, profile, provider, global policy or setting.
// - Every sandbox this test creates carries the label hub.it=1 (the guarded client below adds it to every create and
//   refuses to stop or delete anything it did not create). Sandboxes it names itself start with `hub-it-`; the
//   runtime's own are `hub-<hash of the launch ID>` (launch IDs here start with `hub-it-`, so hub.launch says so).
// - Everything created is deleted in `finally`; a sweep at the start deletes only sandboxes labelled hub.it=1 that
//   are older than an hour (left by a crashed run).
//
// The hub's sandbox image (packages/runtime-openshell/image) must come from an HTTPS registry (the vm driver ignores
// local Docker images), and none is published, so the default checks use a public image with git and curl
// (docker.io/library/buildpack-deps:bookworm-scm) and cover what works without OpenCode inside:
// - OpenShellRuntime prepare: host clone, sandbox created in `hub` with the compiled policy and labels, Ready, the seed
//   bundle cloned inside at /sandbox/work; start's uploads (.hub/config.json with the sandbox's hub URL); a commit
//   made inside through exec; stop's .hub/stop; collect (bundle out, verified, fast-forwarded into the host clone,
//   reported); cleanup deletes the sandbox.
// - Network: a sandbox with the runtime's compiled policy (its hub rule given to curl instead of the absent
//   /usr/local/bin/opencode) reaches a 127.0.0.1-bound Bun.serve "hub" as host.openshell.internal, and egress to a
//   host the policy does not list fails.
//
// The full sandboxed launch (hub + node + engine + OpenCode inside, connected back with its launch token) also needs
//   HUB_IT_OPENSHELL_IMAGE=<registry>/hub-sandbox:<tag>   a published hub-sandbox image (HTTPS registry)
// and, for the agent to answer a prompt, a model provider created in the `hub` workspace by the operator:
//   HUB_IT_OPENSHELL_PROVIDER=<provider name>             (optional; without it the launch gets no prompt)
// Without HUB_IT_OPENSHELL_IMAGE that test is skipped with the reason.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeDaemon } from "../packages/node/src/index.ts"
import { HostRuntime } from "../packages/node/src/host.ts"
import { OpenShellCli, type CreateSandboxOptions, type OpenShellClient, type Sandbox } from "../packages/runtime-openshell/src/cli.ts"
import { compilePolicy, HARNESS_BINARY, SANDBOX_HOST_ALIAS } from "../packages/runtime-openshell/src/policy.ts"
import { normalizeOpenShellProfiles, selectProfile } from "../packages/runtime-openshell/src/profiles.ts"
import { labelValue, OpenShellRuntime, sandboxName, SANDBOX_WORKDIR } from "../packages/runtime-openshell/src/runtime.ts"
import type { Runtime } from "../packages/runtime-sdk/src/index.ts"
import type { PreparedWorkspace } from "../src/protocol"
import { centralConfig } from "../src/central/config"
import { harness, waitFor, type Harness } from "./central-harness"
import { freePort } from "./spoke-fake"

const enabled = process.env.HUB_IT_OPENSHELL === "1"
const openshell = enabled ? Bun.which("openshell") : null
if (enabled && !openshell) console.warn("[it] HUB_IT_OPENSHELL=1 but `openshell` is not on PATH; skipping")
const run = enabled && openshell !== null
const hubImage = process.env.HUB_IT_OPENSHELL_IMAGE
const provider = process.env.HUB_IT_OPENSHELL_PROVIDER
if (run && !hubImage) console.warn("[it] the full sandboxed launch is skipped: set HUB_IT_OPENSHELL_IMAGE to a published hub-sandbox image (HTTPS registry)")

/** A public HTTPS-registry image with git, curl and bash (the vm driver pulls it; local Docker images are not used). */
const IMAGE = "docker.io/library/buildpack-deps:bookworm-scm"
const IT_LABEL = { "hub.it": "1" }
const SWEEP_AGE_MS = 60 * 60_000
/** Sandbox create pulls the image the first time (~20 s, more on a slow link) and boots a microVM. */
const LIVE_MS = 600_000
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const BASE_ENV = { PATH: process.env.PATH ?? "", HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1" }
const IDENT = { GIT_AUTHOR_NAME: "it", GIT_AUTHOR_EMAIL: "it@example.com", GIT_COMMITTER_NAME: "it", GIT_COMMITTER_EMAIL: "it@example.com" }

let tmp = ""
let remotes = ""
let client: GuardedClient

/** Git in this test's temporary directory only. */
function git(cwd: string, ...args: string[]): string {
  if (!tmp || !cwd.startsWith(tmp + path.sep)) throw new Error(`refusing to run git outside the test's temporary directory (${cwd})`)
  return execFileSync("git", args, { cwd, env: { ...BASE_ENV, ...IDENT }, encoding: "utf8" }).trim()
}

/** The node's git settings: https://example.invalid/<name> is the local origin under `remotes` (host side only). */
const nodeGit = () => ({
  baseEnv: BASE_ENV,
  env: { ...IDENT, GIT_ALLOW_PROTOCOL: "https:ssh:file", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://example.invalid/" },
})

/**
 * The real CLI in the `hub` workspace, guarded: every create gets hub.it=1, and stop/delete only touch sandboxes
 * created through it (or, for the sweep, ones labelled hub.it=1).
 */
class GuardedClient implements OpenShellClient {
  readonly created = new Set<string>()
  private readonly cli = new OpenShellCli({ workspace: "hub", env: process.env })

  version = (o?: Parameters<OpenShellClient["version"]>[0]) => this.cli.version(o)
  status = (o?: Parameters<OpenShellClient["status"]>[0]) => this.cli.status(o)
  gatewayInfo = (o?: Parameters<OpenShellClient["status"]>[0]) => this.cli.gatewayInfo(o)
  get: OpenShellClient["get"] = (name, o) => this.cli.get(name, o)
  list: OpenShellClient["list"] = (selector, o) => this.cli.list(selector, o)
  exec: OpenShellClient["exec"] = (name, command, o) => this.cli.exec(name, command, o)
  upload: OpenShellClient["upload"] = (name, local, dest, o) => this.cli.upload(name, local, dest, o)
  download: OpenShellClient["download"] = (name, src, local, o) => this.cli.download(name, src, local, o)

  async create(sandbox: CreateSandboxOptions, o?: Parameters<OpenShellClient["create"]>[1]): Promise<Sandbox> {
    this.created.add(sandbox.name)
    return this.cli.create({ ...sandbox, labels: { ...sandbox.labels, ...IT_LABEL } }, o)
  }

  async stop(name: string, o?: Parameters<OpenShellClient["stop"]>[1]): Promise<void> {
    await this.mine(name)
    return this.cli.stop(name, o)
  }

  async delete(name: string, o?: Parameters<OpenShellClient["delete"]>[1]): Promise<void> {
    await this.mine(name)
    return this.cli.delete(name, o)
  }

  policySet(): Promise<void> {
    throw new Error("the live test never changes a policy after create")
  }

  /** Throws unless the sandbox was created here and (when it still exists) carries hub.it=1. */
  private async mine(name: string): Promise<void> {
    if (!this.created.has(name)) throw new Error(`refusing to touch ${name}: not created by this test`)
    const sandbox = await this.cli.get(name)
    if (sandbox && sandbox.labels["hub.it"] !== "1") throw new Error(`refusing to touch ${name}: no hub.it=1 label`)
  }

  /** Deletes a sandbox labelled hub.it=1 (the sweep and `finally`), and waits until it is gone. */
  async deleteLabelled(sandbox: Sandbox): Promise<void> {
    if (sandbox.labels["hub.it"] !== "1" || sandbox.workspace !== "hub") throw new Error(`refusing to delete ${sandbox.name}`)
    await this.cli.delete(sandbox.name)
    const deadline = Date.now() + 120_000
    while ((await this.cli.get(sandbox.name)) && Date.now() < deadline) await Bun.sleep(1000)
  }
}

/** When the gateway says the sandbox was created (ISO, or "YYYY-MM-DD HH:MM:SS" UTC); NaN when unreadable. */
function createdAt(sandbox: Sandbox): number {
  const t = Date.parse(sandbox.createdAt)
  return Number.isNaN(t) ? Date.parse(`${sandbox.createdAt.replace(" ", "T")}Z`) : t
}

/** Deletes hub.it=1 sandboxes: `all` (this run's, in finally) or only those older than an hour (the sweep). */
async function sweep(which: "stale" | "mine"): Promise<string[]> {
  const deleted: string[] = []
  for (const sandbox of await client.list(IT_LABEL)) {
    const stale = Date.now() - createdAt(sandbox) > SWEEP_AGE_MS
    if (which === "stale" ? !stale : !client.created.has(sandbox.name)) continue
    await client.deleteLabelled(sandbox)
    deleted.push(sandbox.name)
  }
  return deleted
}

beforeAll(async () => {
  if (!run) return
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-it-p5-")))
  remotes = path.join(tmp, "remotes")
  const origin = path.join(remotes, "proj")
  mkdirSync(origin, { recursive: true })
  git(origin, "init", "-q", "-b", "main")
  writeFileSync(path.join(origin, "README.md"), "# hub it\n")
  git(origin, "add", "README.md")
  git(origin, "commit", "-q", "-m", "init")
  client = new GuardedClient()
  await client.version()
  const swept = await sweep("stale")
  if (swept.length) console.warn(`[it] swept stale hub.it sandboxes: ${swept.join(", ")}`)
}, LIVE_MS)

afterAll(async () => {
  if (!run) return
  try {
    const left = await sweep("mine")
    if (left.length) console.warn(`[it] deleted in afterAll: ${left.join(", ")}`)
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}, LIVE_MS)

describe.skipIf(!run)("OpenShellRuntime on the real gateway (public image, no OpenCode inside)", () => {
  test(
    "prepare → start's uploads → a commit inside → stop → collect (ff into the host clone) → cleanup deletes the sandbox",
    async () => {
      const root = path.join(tmp, "work")
      mkdirSync(root, { recursive: true })
      const launchID = `hub-it-${stamp}-rt`
      const name = sandboxName(launchID)
      const hubPort = freePort()
      const runtime = new OpenShellRuntime({
        client,
        roots: [root],
        hubURL: `http://127.0.0.1:${hubPort}`,
        image: IMAGE,
        machineID: "hub-it",
        git: nodeGit(),
        pollMs: 1000,
        // The image has no hub-sandbox-start: a stand-in that checks start's files.
        startCommand: ["sh", "-c", "test -f .hub/config.json && test -f .hub/node.json && test -f .hub/ready && echo up > .hub/started"],
      })
      try {
        const ws: PreparedWorkspace = await runtime.prepare({
          launchID,
          harness: "opencode",
          runtime: { kind: "openshell" },
          workspace: { repo: path.join(root, "proj"), mode: "clone", remote: "https://example.invalid/proj", branch: "hub-it/live" },
        })
        expect(ws).toMatchObject({ directory: SANDBOX_WORKDIR, branch: "hub-it/live", runtime: { kind: "openshell", sandbox: name, profile: "default" } })
        const sandbox = (await client.get(name))!
        expect(sandbox.phase).toBe("Ready")
        expect(sandbox.labels).toMatchObject({ "hub.it": "1", "hub.launch": labelValue(launchID), "hub.machine": "hub-it" })
        const inside = async (...command: string[]) => {
          const r = await client.exec(name, command, { workdir: "/sandbox" })
          if (r.exitCode !== 0) throw new Error(`${command.join(" ")}: exit ${r.exitCode}: ${r.stderr}`)
          return r.stdout.trim()
        }
        // The seed bundle's clone inside, on the branch, at the host clone's head.
        expect(await inside("git", "-C", "work", "rev-parse", "HEAD")).toBe(ws.head!)
        expect(await inside("git", "-C", "work", "symbolic-ref", "--short", "HEAD")).toBe("hub-it/live")

        // start: the launch config with the sandbox's route to a loopback hub; the stand-in start command ran.
        const started = await runtime.start(ws, { launchID, harness: "opencode", hub: { url: `http://127.0.0.1:${hubPort}`, token: "hlt1.not-a-real-token" } })
        expect(started.started).toBe(true)
        expect(await inside("cat", ".hub/started")).toBe("up")
        const config = JSON.parse(await inside("cat", ".hub/config.json"))
        expect(config).toMatchObject({ hubURL: `http://${SANDBOX_HOST_ALIAS}:${hubPort}/`, launchID })
        expect(JSON.parse(await inside("cat", ".hub/node.json"))).toEqual({ workspaceRoots: [SANDBOX_WORKDIR] })

        // The agent commits inside (no credentials, no network: just git in the sandbox).
        await inside("bash", "-c", "echo 'made in the sandbox' > work/inside.txt && git -C work add inside.txt && git -C work -c user.name=it -c user.email=it@example.com commit -q -m inside")
        const insideHead = await inside("git", "-C", "work", "rev-parse", "HEAD")

        expect(await runtime.stop({ launchID, workspace: ws }, "graceful")).toEqual({ stopped: true })
        expect(await inside("cat", ".hub/stop")).toBe("graceful")

        const artifacts = await runtime.collect({ launchID, workspace: ws })
        expect(artifacts).toMatchObject({ branch: "hub-it/live", head: insideHead, dirty: false })
        expect(git(path.join(root, "proj"), "rev-parse", "hub-it/live")).toBe(insideHead)
        expect(readFileSync(path.join(root, "proj", "inside.txt"), "utf8")).toBe("made in the sandbox\n")

        // Nothing would be lost: the sandbox is deleted (the host clone keeps its unpushed commit).
        const cleaned = await runtime.cleanup({ launchID, workspace: ws }, "remove")
        expect(cleaned).toEqual({ removed: false, reason: "host clone: the clone has 1 unpushed commits" })
        expect(await client.get(name)).toBeUndefined()
      } finally {
        if (await client.get(name)) await client.deleteLabelled((await client.get(name))!)
      }
    },
    LIVE_MS,
  )
})

describe.skipIf(!run)("the compiled policy on the real gateway", () => {
  test(
    "the hub rule reaches a 127.0.0.1-bound hub as host.openshell.internal; an unlisted host is denied",
    async () => {
      const hits: string[] = []
      const hub = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          hits.push(`${new URL(req.url).pathname} host=${req.headers.get("host")}`)
          return new Response("hub-it-ok")
        },
      })
      // OpenShell sandbox names are at most 19 characters.
      const name = `hub-it-${stamp.slice(-8)}-net`
      const dir = mkdtempSync(path.join(tmp, "policy-"))
      try {
        const profile = selectProfile(normalizeOpenShellProfiles(undefined), undefined)
        const policy = compilePolicy({ hubURL: `http://127.0.0.1:${hub.port}`, profile })
        // The image has no OpenCode: the hub rule is given to curl instead (OpenShell matches the binary).
        expect(policy.yaml).toContain(`"${HARNESS_BINARY}"`)
        const file = path.join(dir, "policy.yaml")
        writeFileSync(file, policy.yaml.replaceAll(`"${HARNESS_BINARY}"`, `"/usr/bin/curl"`))
        await client.create({ name, from: IMAGE, policyFile: file, labels: { "hub.launch": name } })
        for (let i = 0; i < 120 && (await client.get(name))?.phase !== "Ready"; i++) await Bun.sleep(1000)
        expect((await client.get(name))?.phase).toBe("Ready")

        const toHub = await client.exec(name, ["curl", "-sS", "--max-time", "30", `http://${SANDBOX_HOST_ALIAS}:${hub.port}/it`])
        expect({ exit: toHub.exitCode, out: toHub.stdout, err: toHub.stderr }).toMatchObject({ exit: 0, out: "hub-it-ok" })
        expect(hits).toContain(`/it host=${SANDBOX_HOST_ALIAS}:${hub.port}`)

        const elsewhere = await client.exec(name, ["curl", "-sS", "-o", "/dev/null", "--max-time", "20", "https://example.com/"])
        expect(elsewhere.exitCode).not.toBe(0)
      } finally {
        hub.stop(true)
        const left = await client.get(name)
        if (left) await client.deleteLabelled(left)
      }
    },
    LIVE_MS,
  )
})

describe.skipIf(!run || !hubImage)("a full sandboxed launch (needs HUB_IT_OPENSHELL_IMAGE)", () => {
  let h: Harness | undefined
  let daemon: NodeDaemon | undefined

  afterAll(async () => {
    daemon?.stop()
    await h?.stop()
  })

  test(
    "launch → node prepares and starts → OpenCode's plugin connects back with its launch token → session created → stop → sandbox deleted",
    async () => {
      // The hub's public URL is its loopback URL, so the policy (from the node's server URL) and the launch config
      // (from the hub's public URL) name the same hub: host.openshell.internal:<port>.
      const port = freePort()
      const config = centralConfig({ HUB_PORT: String(port), HUB_PUBLIC_URL: `http://127.0.0.1:${port}`, HUB_STATE_DIR: mkdtempSync(path.join(tmp, "state-")) })
      h = harness({ config })
      const machine = h.store.addMachine("hub-it")
      const root = path.join(tmp, "full")
      mkdirSync(root, { recursive: true })
      const profiles = normalizeOpenShellProfiles(provider ? { default: { providers: [provider] } } : undefined)
      const runtimes: Runtime[] = [
        new HostRuntime({ roots: [root], git: nodeGit() }),
        new OpenShellRuntime({ client, roots: [root], hubURL: h.url, profiles, image: hubImage!, machineID: machine.machine.id, git: nodeGit(), pollMs: 1000 }),
      ]
      daemon = new NodeDaemon({ config: { workspaceRoots: [root], labels: {}, slots: 1 }, credentials: { server: h.url, token: machine.token, machineID: machine.machine.id }, runtimes })
      daemon.start()
      await waitFor(() => h!.nodes.forMachine(machine.machine.id)?.features?.includes("sandbox") === true, 30_000)

      const { launch } = await h.launches.accept("local", {
        workspace: { repo: path.join(root, "proj"), mode: "clone", remote: "https://example.invalid/proj", branch: "hub-it/full" },
        runtime: { kind: "openshell" },
        name: `it-${stamp}`.slice(0, 40),
        ...(provider ? { prompt: "Reply with the single word ok.", end: { when: "idle", cleanup: "remove" } } : { end: { cleanup: "remove" } }),
      })
      const deadline = Date.now() + LIVE_MS - 60_000
      let view = await h.launches.view("local", launch.id)
      while (view && view.state !== "running" && view.state !== "ended" && Date.now() < deadline) {
        await Bun.sleep(1000)
        view = await h.launches.view("local", launch.id)
      }
      expect({ state: view?.state, reason: view?.reason }).toMatchObject({ state: "running" })
      expect(view?.directory).toBe(SANDBOX_WORKDIR)
      expect(h.registry.launchConn(launch.id)).toBeDefined()
      expect(h.registry.hasSession(view!.sessionID!)).toBe(true)

      const ended = await h.launches.stop("local", launch.id)
      expect(ended).toMatchObject({ state: "ended", outcome: "stopped" })
      expect(await client.get(sandboxName(launch.id))).toBeUndefined()
    },
    LIVE_MS,
  )
})

test.skipIf(run)("live OpenShell checks are opt-in (HUB_IT_OPENSHELL=1)", () => {
  expect(run).toBe(false)
})
