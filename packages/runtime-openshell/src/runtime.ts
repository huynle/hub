// The `openshell` runtime of `hub node` (design §6.4, decision lk6gn3u7): a launch runs in an NVIDIA OpenShell
// sandbox the node creates through the openshell CLI (OpenShellClient).
//
// prepare  clones the workspace on the host under the node's roots (HostRuntime, with the node's git credentials),
//          creates the sandbox detached in the OpenShell workspace `hub` (compiled policy, the profile's providers,
//          labels hub.launch/hub.machine/hub.owner), waits for Ready, uploads a git bundle of the clone and clones it
//          inside at /sandbox/work. No git credentials ever enter the sandbox.
//
// start    writes the harness's hub config into the sandbox (.hub/config.json: the hub URL as the sandbox reaches it,
//          the launch-bound token and the launch ID; .hub/node.json: the workspace root; .hub/env.json: extra env),
//          uploaded as files so the token is never in an argv, then touches .hub/ready, which the image's entry
//          script waits for before it runs the harness.
// stop     writes .hub/stop holding the mode (graceful or kill) for the entry script; the sandbox keeps running,
//          so collect can still read it.
// collect  bundles the launch's branch inside (only the commits the host clone lacks), downloads and verifies the
//          bundle and fast-forwards the host clone (never forced: a diverged branch fails collect); dirty means
//          uncommitted work left in the sandbox. A gone sandbox leaves the host clone as the record.
// cleanup  deletes the sandbox only when nothing would be lost (policy remove, no uncommitted work, every commit
//          collected), else stops it and says why; the host clone goes through HostRuntime's rules.
//
// Names are deterministic (hub-<15 hex of sha256(launchID)>, OpenShell allows 19 characters) and every op checks the sandbox's hub.launch label,
// so a restarted node finds its own sandboxes again and never touches anyone else's.
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { launchWorkspaceProblem, preparedWorkspaceProblem, type CleanupPolicy, type LaunchArtifacts, type NodeRuntimeInfo, type PreparedWorkspace } from "../../protocol/src/index.ts"
import {
  RuntimeError,
  type CleanupResult,
  type PrepareInput,
  type RunHandle,
  type Runtime,
  type RuntimeContext,
  type StartInput,
  type StartResult,
  type StopMode,
  type StopResult,
} from "../../runtime-sdk/src/index.ts"
import { GitError, runGit, type GitOptions } from "../../node/src/git.ts"
import { HostRuntime, LAUNCH_MARKER, resolveUnderRoots } from "../../node/src/host.ts"
import pkg from "../package.json" with { type: "json" }
import { imageTag, startCommand } from "../image/image.ts"
import { OpenShellError, redact, type ExecResult, type OpenShellClient, type Sandbox } from "./cli.ts"
import { compilePolicy, sandboxHubEndpoint } from "./policy.ts"
import { normalizeOpenShellProfiles, profileNames, selectProfile, type OpenShellProfiles } from "./profiles.ts"

/** The sandbox's home: its working directory, where `.hub/` and the workspace live. */
export const SANDBOX_HOME = "/sandbox"
/** The session's directory inside the sandbox (the clone of the seed bundle). */
export const SANDBOX_WORKDIR = "/sandbox/work"
/** Hub files inside the sandbox, relative to SANDBOX_HOME. */
export const HUB_DIR = ".hub"
export const SEED_BUNDLE = `${HUB_DIR}/seed.bundle`
export const OUT_BUNDLE = `${HUB_DIR}/out.bundle`
/** Where collected branches land in the host clone before the fast-forward. */
const COLLECTED_REFS = "refs/hub/sandbox"
/** The spoke's launch config inside (src/config.ts parseLaunchConfig): { hubURL, token, launchID }. */
export const HUB_CONFIG_FILE = `${HUB_DIR}/config.json`
/** node.json next to it: { workspaceRoots: [SANDBOX_WORKDIR] }. */
export const HUB_NODE_FILE = `${HUB_DIR}/node.json`
/** The start op's extra environment for the harness, as a JSON object. */
export const HUB_ENV_FILE = `${HUB_DIR}/env.json`
/** Touched last by start: the entry script runs the harness once it exists. */
export const READY_FILE = `${HUB_DIR}/ready`
/** Written by stop with the mode ("graceful" or "kill"). */
export const STOP_FILE = `${HUB_DIR}/stop`
/** The image a profile without `image` gets (built by packages/runtime-openshell/image). */
/** The image build/image.ts tags for this package's version (it must be published to an HTTPS registry). */
export const DEFAULT_SANDBOX_IMAGE = imageTag(pkg.version)
/** The image's start script: starts the harness detached once .hub/config.json and .hub/ready exist. */
export const DEFAULT_START_COMMAND: readonly string[] = startCommand()
/** Non-secret environment every sandbox gets: the harness stays offline but for the hub and its providers. */
export const SANDBOX_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  HUB_LAUNCH_CONFIG: `${SANDBOX_HOME}/${HUB_DIR}/config.json`,
}
export const READY_TIMEOUT_MS = 300_000
const POLL_MS = 1_000
const LABEL_VALUE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/
const REASON_MAX = 300

export interface OpenShellRuntimeOptions {
  readonly client: OpenShellClient
  /** node.json workspaceRoots: the host clones live under them. */
  readonly roots: readonly string[]
  /** The hub URL as the node knows it (config.json `server`); the policy allows it. */
  readonly hubURL: string
  /** node.json `openshell.profiles`, normalized (default: the built-in default profile only). */
  readonly profiles?: OpenShellProfiles
  /** The image for profiles without one (default DEFAULT_SANDBOX_IMAGE). */
  readonly image?: string
  /** The argv that starts the harness after the ready file (default DEFAULT_START_COMMAND). */
  readonly startCommand?: readonly string[]
  /** Harnesses the image runs (default opencode). */
  readonly harnesses?: readonly string[]
  /** Label values: this machine and its owner (hub.machine, hub.owner). */
  readonly machineID?: string
  readonly owner?: string
  /** Host git settings (environment, binary, time limit); tests use them, the daemon passes none. */
  readonly git?: Omit<GitOptions, "cwd" | "signal">
  /** Sandbox phase polling interval and limit. */
  readonly pollMs?: number
  readonly readyTimeoutMs?: number
}

const sha = (s: string, hex = 20) => createHash("sha256").update(s).digest("hex").slice(0, hex)
/** OpenShell's limit for sandbox names (the gateway's MAX_ROUTABLE_NAME_LEN): "hub-" + 15 hex. */
export const SANDBOX_NAME_MAX = 19

/** The launch's sandbox: hub-<15 hex of sha256(launchID)>, a lowercase DNS label within SANDBOX_NAME_MAX. */
export function sandboxName(launchID: string): string {
  return `hub-${sha(launchID, SANDBOX_NAME_MAX - 4)}`
}

/** A label value for an ID: the ID itself when it is a valid label value, else 20 hex of its sha256. */
export function labelValue(id: string): string {
  return LABEL_VALUE.test(id) ? id : sha(id)
}

/** The host side of a sandboxed workspace: the clone at `repo`, as HostRuntime made it. */
function hostWorkspace(ws: PreparedWorkspace): PreparedWorkspace {
  const { runtime: _runtime, ...rest } = ws
  return { ...rest, directory: ws.repo }
}

const cut = (s: string) => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX)}…` : s)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class OpenShellRuntime implements Runtime {
  readonly kind = "openshell"
  private readonly client: OpenShellClient
  private readonly roots: readonly string[]
  private readonly profiles: OpenShellProfiles
  private readonly harnesses: readonly string[]
  private readonly host: HostRuntime
  private readonly pollMs: number
  private readonly readyTimeoutMs: number

  constructor(private readonly options: OpenShellRuntimeOptions) {
    this.client = options.client
    this.roots = options.roots
    this.profiles = options.profiles ?? normalizeOpenShellProfiles(undefined)
    this.harnesses = options.harnesses ?? ["opencode"]
    this.host = new HostRuntime({ roots: options.roots, harnesses: this.harnesses, ...(options.git ? { git: options.git } : {}) })
    this.pollMs = options.pollMs ?? POLL_MS
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  }

  info(): NodeRuntimeInfo {
    return { kind: this.kind, harnesses: [...this.harnesses], profiles: profileNames(this.profiles) }
  }

  // ---------- prepare ----------

  async prepare(input: PrepareInput, ctx: RuntimeContext = {}): Promise<PreparedWorkspace> {
    if (ctx.signal?.aborted) throw new RuntimeError("prepare cancelled")
    if (input.runtime?.kind !== this.kind) throw new RuntimeError(`this runtime is openshell, not ${String(input.runtime?.kind)}`)
    if (!this.harnesses.includes(input.harness)) throw new RuntimeError(`harness ${input.harness} does not run in this node's sandboxes (they have ${this.harnesses.join(", ")})`)
    const problem = launchWorkspaceProblem(input.workspace)
    if (problem) throw new RuntimeError(problem)
    if (input.workspace.mode !== "clone") throw new RuntimeError(`an openshell sandbox takes clone workspaces only, not ${input.workspace.mode}`)
    const profile = selectProfile(this.profiles, input.runtime.profile)
    const policy = compilePolicy({ hubURL: this.options.hubURL, profile, ...(input.workspace.remote ? { gitRemote: input.workspace.remote } : {}) })
    const name = sandboxName(input.launchID)

    const existing = await this.owned(name, input.launchID, ctx)
    const host = await this.hostClone(input, ctx)
    if (!existing) {
      ctx.progress?.(`creating sandbox ${name}`)
      await this.create(name, input.launchID, profile.image ?? this.options.image ?? DEFAULT_SANDBOX_IMAGE, policy.yaml, policy.providers, ctx)
    }
    await this.waitReady(name, ctx)
    await this.seed(name, host, ctx)
    return { ...host, directory: SANDBOX_WORKDIR, runtime: { kind: "openshell", sandbox: name, profile: profile.name } }
  }

  /** The launch's sandbox, or undefined when there is none; refuses one labelled for another launch. */
  private async owned(name: string, launchID: string, ctx: RuntimeContext): Promise<Sandbox | undefined> {
    const sandbox = await this.call(() => this.client.get(name, this.signal(ctx)))
    if (!sandbox) return undefined
    if (sandbox.labels["hub.launch"] !== labelValue(launchID)) throw new RuntimeError(`sandbox ${name} belongs to another launch`)
    return sandbox
  }

  /** The host clone: made by HostRuntime, or (a repeated prepare) the one this launch made before. */
  private async hostClone(input: PrepareInput, ctx: RuntimeContext): Promise<PreparedWorkspace> {
    const target = resolveUnderRoots(input.workspace.repo, this.roots)
    if (!existsSync(target)) return this.host.prepare({ ...input, runtime: { kind: "host" } }, ctx)
    if ((await this.marker(target, ctx)) !== input.launchID) throw new RuntimeError(`${target} exists and was not cloned by this launch`)
    const head = (await this.git(target, ["rev-parse", "HEAD"], ctx)).trim()
    const branch = (await this.gitOutput(target, ["symbolic-ref", "--quiet", "--short", "HEAD"], ctx))?.trim()
    const { base } = input.workspace
    return { repo: target, directory: target, mode: "clone", ...(branch ? { branch } : {}), ...(base ? { base } : {}), head, reused: false }
  }

  private async create(name: string, launchID: string, image: string, policyYAML: string, providers: readonly string[], ctx: RuntimeContext): Promise<Sandbox> {
    const labels: Record<string, string> = { "hub.launch": labelValue(launchID) }
    if (this.options.machineID) labels["hub.machine"] = labelValue(this.options.machineID)
    if (this.options.owner) labels["hub.owner"] = labelValue(this.options.owner)
    return this.withTemp(async (dir) => {
      const policyFile = path.join(dir, "policy.yaml")
      writeFileSync(policyFile, policyYAML, { mode: 0o600 })
      try {
        return await this.call(() => this.client.create({ name, from: image, policyFile, providers, labels, env: SANDBOX_ENV }, this.signal(ctx)))
      } catch (error) {
        // Another prepare of this launch created it meanwhile.
        const again = await this.owned(name, launchID, ctx)
        if (again) return again
        throw error
      }
    })
  }

  /** Polls until the sandbox is Ready; a RuntimeError when it fails, goes away or takes too long. */
  private async waitReady(name: string, ctx: RuntimeContext): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      if (ctx.signal?.aborted) throw new RuntimeError("prepare cancelled")
      const sandbox = await this.call(() => this.client.get(name, this.signal(ctx)))
      if (!sandbox) throw new RuntimeError(`sandbox ${name} is gone`)
      if (sandbox.phase === "Ready") return
      if (sandbox.phase !== "Provisioning" && sandbox.phase !== "Starting" && sandbox.phase !== "Unspecified") {
        const why = sandbox.conditions.find((c) => c.message)?.message
        throw new RuntimeError(cut(`sandbox ${name} is ${sandbox.phase}${why ? `: ${why}` : ""}`))
      }
      if (Date.now() > deadline) throw new RuntimeError(`sandbox ${name} was not ready after ${Math.round(this.readyTimeoutMs / 1000)} s`)
      await sleep(this.pollMs)
    }
  }

  /** Clones the host clone into /sandbox/work through a bundle, unless a clone is already there. */
  private async seed(name: string, host: PreparedWorkspace, ctx: RuntimeContext): Promise<void> {
    if ((await this.exec(name, ["git", "-C", "work", "rev-parse", "HEAD"], ctx)).exitCode === 0) return
    ctx.progress?.("seeding the sandbox")
    await this.withTemp(async (dir) => {
      const bundle = path.join(dir, "seed.bundle")
      await this.git(host.directory, ["bundle", "create", bundle, "HEAD", "--branches"], ctx)
      await this.mustExec(name, ["mkdir", "-p", HUB_DIR], ctx)
      await this.call(() => this.client.upload(name, bundle, `${SANDBOX_HOME}/${HUB_DIR}/`, this.signal(ctx)))
    })
    await this.mustExec(name, ["git", "clone", "--quiet", ...(host.branch ? ["--branch", host.branch] : []), "--", SEED_BUNDLE, "work"], ctx)
    const head = (await this.mustExec(name, ["git", "-C", "work", "rev-parse", "HEAD"], ctx)).stdout.trim()
    if (head !== host.head) throw new RuntimeError(`the sandbox clone is at ${head}, not ${host.head}`)
  }

  // ---------- start / stop ----------

  async start(workspace: PreparedWorkspace, input: StartInput, ctx: RuntimeContext = {}): Promise<StartResult> {
    if (ctx.signal?.aborted) throw new RuntimeError("start cancelled")
    if (!this.harnesses.includes(input.harness)) throw new RuntimeError(`harness ${input.harness} does not run in this node's sandboxes (they have ${this.harnesses.join(", ")})`)
    const handle = { launchID: input.launchID, workspace }
    const name = this.sandboxOf(handle)
    const sandbox = await this.owned(name, input.launchID, ctx)
    if (!sandbox) throw new RuntimeError(`sandbox ${name} is gone`)
    if (sandbox.phase !== "Ready") throw new RuntimeError(`sandbox ${name} is ${sandbox.phase}, not Ready`)
    if (await this.exists(name, READY_FILE, ctx)) return { ...handle, started: false, reason: "the harness is already started" }
    const hide = [input.hub.token]
    const config = { hubURL: sandboxHubEndpoint(input.hub.url).url, token: input.hub.token, launchID: input.launchID }
    ctx.progress?.("starting the harness")
    await this.upload(name, { [HUB_CONFIG_FILE]: config, [HUB_NODE_FILE]: { workspaceRoots: [SANDBOX_WORKDIR] }, [HUB_ENV_FILE]: input.env ?? {} }, ctx, hide)
    await this.mustExec(name, ["touch", READY_FILE], ctx, hide)
    await this.mustExec(name, [...(this.options.startCommand ?? DEFAULT_START_COMMAND)], ctx, hide)
    return { ...handle, started: true }
  }

  async stop(handle: RunHandle, mode: StopMode = "graceful"): Promise<StopResult> {
    const name = this.sandboxOf(handle)
    const sandbox = await this.owned(name, handle.launchID, {})
    if (!sandbox) return { stopped: false, reason: "the sandbox is gone" }
    if (sandbox.phase !== "Ready") return { stopped: false, reason: `the sandbox is ${sandbox.phase}` }
    if (!(await this.exists(name, READY_FILE, {}))) return { stopped: false, reason: "the harness was never started" }
    await this.upload(name, { [STOP_FILE]: `${mode}\n` }, {})
    return { stopped: true }
  }

  /** The handle's sandbox name, after checking the handle (it comes from the hub) names this launch's sandbox. */
  private sandboxOf(handle: RunHandle): string {
    const problem = preparedWorkspaceProblem(handle?.workspace)
    if (problem) throw new RuntimeError(problem)
    const runtime = handle.workspace.runtime
    if (runtime?.kind !== this.kind || !runtime.sandbox) throw new RuntimeError("the workspace is not in an openshell sandbox")
    const name = sandboxName(handle.launchID)
    if (runtime.sandbox !== name) throw new RuntimeError(`sandbox ${runtime.sandbox} is not this launch's`)
    return name
  }

  /** Whether a path (relative to the sandbox home) exists in the sandbox. */
  private async exists(name: string, rel: string, ctx: RuntimeContext): Promise<boolean> {
    return (await this.exec(name, ["test", "-e", rel], ctx)).exitCode === 0
  }

  /** Writes files (path under .hub → JSON value or text) into the sandbox's .hub directory. */
  private async upload(name: string, files: Readonly<Record<string, unknown>>, ctx: RuntimeContext, hide: readonly string[] = []): Promise<void> {
    await this.mustExec(name, ["mkdir", "-p", HUB_DIR], ctx, hide)
    await this.withTemp(async (dir) => {
      for (const [rel, value] of Object.entries(files)) {
        const local = path.join(dir, path.posix.basename(rel))
        writeFileSync(local, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
        await this.call(() => this.client.upload(name, local, `${SANDBOX_HOME}/${HUB_DIR}/`, this.signal(ctx)), hide)
      }
    })
  }

  // ---------- collect / cleanup ----------

  async collect(handle: RunHandle, ctx: RuntimeContext = {}): Promise<LaunchArtifacts> {
    const name = this.sandboxOf(handle)
    const host = hostWorkspace(handle.workspace)
    const sandbox = await this.owned(name, handle.launchID, ctx)
    let dirty = false
    if (sandbox?.phase === "Ready") {
      dirty = await this.isDirtyInside(name, ctx)
      await this.fetchBack(name, host, ctx)
    }
    const artifacts = await this.host.collect({ launchID: handle.launchID, workspace: host }, ctx)
    return { ...artifacts, dirty: dirty || artifacts.dirty === true }
  }

  /** Brings the sandbox's commits on the launch's branch into the host clone, fast-forward only. */
  private async fetchBack(name: string, host: PreparedWorkspace, ctx: RuntimeContext): Promise<void> {
    const ref = host.branch ? `refs/heads/${host.branch}` : "HEAD"
    const insideHead = (await this.exec(name, ["git", "-C", "work", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], ctx)).stdout.trim()
    if (!insideHead) throw new RuntimeError(`the sandbox has no ${host.branch ? `branch ${host.branch}` : "HEAD"}`)
    const hostHead = (await this.git(host.directory, ["rev-parse", "--verify", `${ref}^{commit}`], ctx)).trim()
    if (insideHead === hostHead) return
    ctx.progress?.("collecting the sandbox's commits")
    // Only what the host lacks: the host head is the bundle's prerequisite (when the sandbox has it).
    const known = (await this.exec(name, ["git", "-C", "work", "cat-file", "-e", `${hostHead}^{commit}`], ctx)).exitCode === 0
    await this.mustExec(name, ["git", "-C", "work", "bundle", "create", `../${OUT_BUNDLE}`, ref, ...(known ? [`^${hostHead}`] : [])], ctx)
    const target = `${COLLECTED_REFS}/${host.branch ?? "HEAD"}`
    await this.withTemp(async (dir) => {
      await this.call(() => this.client.download(name, `${SANDBOX_HOME}/${OUT_BUNDLE}`, dir, this.signal(ctx)))
      const bundle = path.join(dir, path.posix.basename(OUT_BUNDLE))
      if (!existsSync(bundle)) throw new RuntimeError("the sandbox's bundle did not arrive")
      await this.git(host.directory, ["bundle", "verify", "--quiet", bundle], ctx)
      // A bundle is read through the file transport; only for this fetch, from the node's own temporary file.
      await this.git(host.directory, ["fetch", "--quiet", "--no-tags", bundle, `+${ref}:${target}`], ctx, { GIT_ALLOW_PROTOCOL: "file" })
    })
    const fetched = (await this.git(host.directory, ["rev-parse", "--verify", `${target}^{commit}`], ctx)).trim()
    if (fetched !== insideHead) throw new RuntimeError(`the collected bundle holds ${fetched}, not ${insideHead}`)
    if ((await this.gitOutput(host.directory, ["merge-base", "--is-ancestor", hostHead, fetched], ctx)) === undefined)
      throw new RuntimeError(`the sandbox's ${host.branch ?? "HEAD"} does not fast-forward the host clone (it diverged)`)
    const current = (await this.gitOutput(host.directory, ["symbolic-ref", "--quiet", "HEAD"], ctx))?.trim()
    if (current === ref || ref === "HEAD") await this.git(host.directory, ["merge", "--ff-only", "--quiet", fetched], ctx)
    else await this.git(host.directory, ["update-ref", ref, fetched, hostHead], ctx)
  }

  async cleanup(handle: RunHandle, policy: CleanupPolicy, ctx: RuntimeContext = {}): Promise<CleanupResult> {
    const name = this.sandboxOf(handle)
    const host = hostWorkspace(handle.workspace)
    const sandbox = await this.cleanupSandbox(name, handle.launchID, host, policy, ctx)
    const clone = await this.host.cleanup({ launchID: handle.launchID, workspace: host }, policy, ctx)
    const reasons = [sandbox.reason && `sandbox: ${sandbox.reason}`, clone.reason && `host clone: ${clone.reason}`].filter(Boolean)
    return sandbox.removed && clone.removed ? { removed: true } : { removed: false, reason: cut(reasons.join("; ")) }
  }

  /** Deletes the sandbox when nothing would be lost; else stops it and says why. */
  private async cleanupSandbox(name: string, launchID: string, host: PreparedWorkspace, policy: CleanupPolicy, ctx: RuntimeContext): Promise<CleanupResult> {
    const sandbox = await this.owned(name, launchID, ctx)
    if (!sandbox) return { removed: true }
    let keep: string | undefined
    if (policy === "keep") keep = "cleanup policy is keep"
    else if (sandbox.phase === "Ready") keep = await this.unsaved(name, host, ctx)
    else if (sandbox.phase !== "Deleting") keep = `the sandbox is ${sandbox.phase}, so its work cannot be checked`
    if (keep) {
      if (sandbox.phase === "Ready" || sandbox.phase === "Starting" || sandbox.phase === "Provisioning") {
        ctx.progress?.(`stopping sandbox ${name}`)
        await this.call(() => this.client.stop(name, this.signal(ctx)))
      }
      return { removed: false, reason: keep }
    }
    ctx.progress?.(`deleting sandbox ${name}`)
    if (sandbox.phase !== "Deleting") await this.call(() => this.client.delete(name, this.signal(ctx)))
    await this.waitGone(name, ctx)
    return { removed: true }
  }

  /** Why deleting the sandbox would lose work (uncommitted changes, commits the host clone lacks), or undefined. */
  private async unsaved(name: string, host: PreparedWorkspace, ctx: RuntimeContext): Promise<string | undefined> {
    const work = await this.exec(name, ["git", "-C", "work", "rev-parse", "--verify", "--quiet", "HEAD"], ctx)
    if (work.exitCode !== 0) return undefined // never seeded: nothing of the launch's in it
    if (await this.isDirtyInside(name, ctx)) return "the sandbox has uncommitted changes"
    const heads = (await this.mustExec(name, ["git", "-C", "work", "for-each-ref", "--format=%(objectname)", "refs/heads"], ctx)).stdout.split("\n").map((l) => l.trim())
    for (const head of [work.stdout.trim(), ...heads].filter(Boolean)) {
      if ((await this.gitOutput(host.directory, ["cat-file", "-e", `${head}^{commit}`], ctx)) === undefined) return "the sandbox has commits that were not collected"
    }
    return undefined
  }

  private async isDirtyInside(name: string, ctx: RuntimeContext): Promise<boolean> {
    return (await this.mustExec(name, ["git", "-C", "work", "status", "--porcelain", "--untracked-files=all"], ctx)).stdout.trim().length > 0
  }

  /** Polls until the sandbox is gone (OpenShell deletes asynchronously). */
  private async waitGone(name: string, ctx: RuntimeContext): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    while (await this.call(() => this.client.get(name, this.signal(ctx)))) {
      if (ctx.signal?.aborted) throw new RuntimeError("cleanup cancelled")
      if (Date.now() > deadline) throw new RuntimeError(`sandbox ${name} was not deleted after ${Math.round(this.readyTimeoutMs / 1000)} s`)
      await sleep(this.pollMs)
    }
  }

  // ---------- helpers ----------

  private signal(ctx: RuntimeContext): { signal?: AbortSignal } {
    return ctx.signal ? { signal: ctx.signal } : {}
  }

  /** Runs an OpenShell call; its OpenShellError (already redacted, and without `hide`) becomes a RuntimeError. */
  private async call<T>(fn: () => Promise<T>, hide: readonly string[] = []): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof OpenShellError) throw new RuntimeError(redact(error.message, hide))
      throw error
    }
  }

  /** A command in the sandbox, in its home directory (no shell: argv as given). */
  private exec(name: string, command: readonly string[], ctx: RuntimeContext, hide: readonly string[] = []): Promise<ExecResult> {
    return this.call(() => this.client.exec(name, command, { workdir: SANDBOX_HOME, ...this.signal(ctx) }), hide)
  }

  private async mustExec(name: string, command: readonly string[], ctx: RuntimeContext, hide: readonly string[] = []): Promise<ExecResult> {
    const result = await this.exec(name, command, ctx, hide)
    if (result.exitCode !== 0) {
      const why = redact(result.stderr.trim(), hide) || "no error output"
      throw new RuntimeError(cut(`in sandbox ${name}: ${command.slice(0, 2).join(" ")} failed (exit ${result.exitCode}): ${why}`))
    }
    return result
  }

  private async withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-openshell-"))
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private async git(cwd: string, args: readonly string[], ctx: RuntimeContext, env?: Readonly<Record<string, string>>): Promise<string> {
    const options = this.options.git ?? {}
    try {
      return await runGit(args, { ...options, cwd, ...(env ? { env: { ...options.env, ...env } } : {}), ...this.signal(ctx) })
    } catch (cause) {
      if (cause instanceof GitError) throw new RuntimeError(cause.message)
      throw cause
    }
  }

  private async gitOutput(cwd: string, args: readonly string[], ctx: RuntimeContext): Promise<string | undefined> {
    try {
      return await this.git(cwd, args, ctx)
    } catch (cause) {
      if (ctx.signal?.aborted) throw cause
      return undefined
    }
  }

  /** The launch that made a host clone (HostRuntime's marker), or undefined. */
  private async marker(dir: string, ctx: RuntimeContext): Promise<string | undefined> {
    const gitDir = (await this.gitOutput(dir, ["rev-parse", "--absolute-git-dir"], ctx))?.trim()
    if (!gitDir) return undefined
    try {
      return readFileSync(path.join(gitDir, LAUNCH_MARKER), "utf8").trim()
    } catch {
      return undefined
    }
  }
}
