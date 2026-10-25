// The host runtime (design §6.4): the session runs in the machine's long-running harness service, which the hub
// asks to create it in the directory this runtime prepares. So the host runtime only makes, inspects and removes
// workspaces; it starts nothing.
//
// Workspaces: `worktree` (<repo>/.worktrees/<branch>, reused when the branch already has a worktree), `checkout`
// (the repository itself, switched to the branch) and `clone` (a fresh clone at `repo`). Every path is resolved
// (realpath, so through symlinks) and must stay under the node's workspace roots. Git runs through runGit only
// (no shell, `--` before paths, https/ssh only), and every name reaching it passed the protocol's ref and remote
// checks first, so none can read as an option.
//
// Cleanup never forces: uncommitted or unpushed work, a reused workspace, a checkout, or a workspace another launch
// made (each workspace this runtime makes carries a hub-launch marker in its git directory) keeps it, with a reason.
// Handles come from the hub, so collect and cleanup re-check everything.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  isAbsolutePath,
  isRefName,
  launchWorkspaceProblem,
  preparedWorkspaceProblem,
  type CleanupPolicy,
  type LaunchArtifacts,
  type NodeRuntimeInfo,
  type PreparedWorkspace,
} from "../../protocol/src/index.ts"
import { RuntimeError, type CleanupResult, type PrepareInput, type RunHandle, type Runtime, type RuntimeContext } from "../../runtime-sdk/src/index.ts"
import { GitError, runGit, type GitOptions } from "./git.ts"

/** The file in a workspace's git directory naming the launch that made it. */
export const LAUNCH_MARKER = "hub-launch"

export interface HostRuntimeOptions {
  /** node.json workspaceRoots. */
  readonly roots: readonly string[]
  /** Harnesses whose service runs on this machine (default opencode). */
  readonly harnesses?: readonly string[]
  /** Git settings (environment, binary, time limit); tests use them, the daemon passes none. */
  readonly git?: Omit<GitOptions, "cwd" | "signal">
}

/** `p` with every existing part resolved through symlinks; refuses a dangling symlink on the way. */
function resolvePath(p: string): string {
  const rest: string[] = []
  let current = p
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest.reverse())
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new RuntimeError(`cannot resolve ${p}: ${(cause as Error).message}`)
      let link = false
      try {
        link = lstatSync(current).isSymbolicLink()
      } catch {}
      if (link) throw new RuntimeError(`${p} goes through a dangling symlink`)
      const parent = path.dirname(current)
      if (parent === current) throw new RuntimeError(`cannot resolve ${p}`)
      rest.push(path.basename(current))
      current = parent
    }
  }
}

/** The real path of `p` when it is (or would be) under one of `roots`; throws a RuntimeError otherwise. */
export function resolveUnderRoots(p: string, roots: readonly string[]): string {
  if (roots.length === 0) throw new RuntimeError("this node has no workspaceRoots in node.json, so it prepares no workspaces")
  if (!isAbsolutePath(p)) throw new RuntimeError(`${p} is not an absolute path`)
  const real = resolvePath(p)
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      continue
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) return real
  }
  throw new RuntimeError(`${p} is not under this node's workspace roots`)
}

/** A branch name for a launch without one: launch/<launchID>, with characters a ref may not hold replaced. */
export function launchBranch(launchID: string): string {
  const name = launchID.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/\.{2,}/g, ".").slice(0, 100) || "launch"
  return `launch/${name.endsWith(".lock") ? `${name}-` : name}`
}

const isDirectory = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export class HostRuntime implements Runtime {
  readonly kind = "host"
  private readonly roots: readonly string[]
  private readonly harnesses: readonly string[]

  constructor(private readonly options: HostRuntimeOptions) {
    this.roots = options.roots
    this.harnesses = options.harnesses ?? ["opencode"]
  }

  info(): NodeRuntimeInfo {
    return { kind: this.kind, harnesses: [...this.harnesses] }
  }

  // ---------- prepare ----------

  async prepare(input: PrepareInput, ctx: RuntimeContext = {}): Promise<PreparedWorkspace> {
    if (ctx.signal?.aborted) throw new RuntimeError("prepare cancelled")
    if (input.runtime?.kind !== this.kind) throw new RuntimeError(`this runtime is host, not ${String(input.runtime?.kind)}`)
    if (!this.harnesses.includes(input.harness)) throw new RuntimeError(`harness ${input.harness} does not run on this node (it has ${this.harnesses.join(", ")})`)
    const problem = launchWorkspaceProblem(input.workspace)
    if (problem) throw new RuntimeError(problem)
    const ws = input.workspace
    if (ws.mode === "clone") return this.prepareClone(input, ctx)
    const repo = await this.repository(ws.repo, ctx)
    return ws.mode === "worktree" ? this.prepareWorktree(input, repo, ctx) : this.prepareCheckout(input, repo, ctx)
  }

  private async prepareWorktree(input: PrepareInput, repo: string, ctx: RuntimeContext): Promise<PreparedWorkspace> {
    const { base } = input.workspace
    const branch = input.workspace.branch ?? launchBranch(input.launchID)
    await this.git(repo, ["check-ref-format", "--branch", branch], ctx)
    const existing = (await this.worktrees(repo, ctx)).get(`refs/heads/${branch}`)
    if (existing) {
      const directory = resolveUnderRoots(existing, this.roots)
      return this.prepared(repo, directory, "worktree", branch, base, true, ctx)
    }
    const directory = resolveUnderRoots(path.join(repo, ".worktrees", ...branch.split("/")), this.roots)
    if (existsSync(directory)) throw new RuntimeError(`${directory} exists and is not the worktree of ${branch}`)
    if (base) await this.git(repo, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], ctx, `base ${base} is not a commit in ${repo}`)
    ctx.progress?.(`creating worktree ${branch}`)
    if (await this.hasBranch(repo, branch, ctx)) await this.git(repo, ["worktree", "add", "--", directory, branch], ctx)
    else await this.git(repo, ["worktree", "add", "-b", branch, "--", directory, base ?? "HEAD"], ctx)
    await this.mark(directory, input.launchID, ctx)
    return this.prepared(repo, directory, "worktree", branch, base, false, ctx)
  }

  private async prepareCheckout(input: PrepareInput, repo: string, ctx: RuntimeContext): Promise<PreparedWorkspace> {
    const { branch, base } = input.workspace
    if (branch) {
      await this.git(repo, ["check-ref-format", "--branch", branch], ctx)
      if (base) await this.git(repo, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], ctx, `base ${base} is not a commit in ${repo}`)
      ctx.progress?.(`switching to ${branch}`)
      if (await this.hasBranch(repo, branch, ctx)) await this.git(repo, ["switch", branch], ctx)
      else await this.git(repo, ["switch", "-c", branch, base ?? "HEAD"], ctx)
    }
    return this.prepared(repo, repo, "checkout", (await this.currentBranch(repo, ctx)) ?? branch, base, true, ctx)
  }

  private async prepareClone(input: PrepareInput, ctx: RuntimeContext): Promise<PreparedWorkspace> {
    const { branch, base, remote } = input.workspace
    const target = resolveUnderRoots(input.workspace.repo, this.roots)
    if (existsSync(target) || isLink(target)) throw new RuntimeError(`${target} exists; a clone needs a new directory`)
    const parent = path.dirname(target)
    mkdirSync(parent, { recursive: true })
    // The parent was created through resolved paths, but check again before git writes there.
    if (resolveUnderRoots(parent, this.roots) !== parent) throw new RuntimeError(`${parent} moved while preparing`)
    ctx.progress?.("cloning")
    await this.git(parent, ["clone", "--quiet", ...(base ? ["--branch", base] : []), "--", remote as string, target], ctx)
    if (branch) {
      await this.git(target, ["check-ref-format", "--branch", branch], ctx)
      const current = await this.currentBranch(target, ctx)
      if (current !== branch) {
        const remoteBranch = await this.succeeds(target, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], ctx)
        await this.git(target, remoteBranch ? ["switch", branch] : ["switch", "-c", branch], ctx)
      }
    }
    await this.mark(target, input.launchID, ctx)
    return this.prepared(target, target, "clone", (await this.currentBranch(target, ctx)) ?? branch, base, false, ctx)
  }

  /** The real path of a repository's top level under the roots. */
  private async repository(p: string, ctx: RuntimeContext): Promise<string> {
    const repo = resolveUnderRoots(p, this.roots)
    if (!isDirectory(repo)) throw new RuntimeError(`${repo} does not exist`)
    const top = (await this.git(repo, ["rev-parse", "--show-toplevel"], ctx, `${repo} is not a git repository`)).trim()
    if (resolvePath(top) !== repo) throw new RuntimeError(`${repo} must be the repository's top level (${top})`)
    return repo
  }

  private async prepared(repo: string, directory: string, mode: PreparedWorkspace["mode"], branch: string | undefined, base: string | undefined, reused: boolean, ctx: RuntimeContext): Promise<PreparedWorkspace> {
    const head = (await this.git(directory, ["rev-parse", "HEAD"], ctx)).trim()
    return { repo, directory, mode, ...(branch ? { branch } : {}), ...(base ? { base } : {}), head, reused }
  }

  // ---------- collect ----------

  async collect(handle: RunHandle, ctx: RuntimeContext = {}): Promise<LaunchArtifacts> {
    const ws = this.checkHandle(handle)
    const directory = resolveUnderRoots(ws.directory, this.roots)
    if (!isDirectory(directory)) throw new RuntimeError(`${directory} is gone`)
    const branch = await this.currentBranch(directory, ctx)
    const head = (await this.git(directory, ["rev-parse", "HEAD"], ctx)).trim()
    const dirty = await this.isDirty(directory, ctx)
    let commits: number | undefined
    if (ws.base) {
      for (const from of [ws.base, `origin/${ws.base}`]) {
        const out = await this.output(directory, ["rev-list", "--count", `${from}..HEAD`], ctx)
        if (out !== undefined && /^\d+$/.test(out.trim())) {
          commits = Number(out.trim())
          break
        }
      }
    }
    return { ...(branch ? { branch } : {}), ...(ws.base ? { base: ws.base } : {}), head, ...(commits !== undefined ? { commits } : {}), dirty }
  }

  // ---------- cleanup ----------

  async cleanup(handle: RunHandle, policy: CleanupPolicy, ctx: RuntimeContext = {}): Promise<CleanupResult> {
    const ws = this.checkHandle(handle)
    if (policy === "keep") return { removed: false, reason: "cleanup policy is keep" }
    if (ws.reused) return { removed: false, reason: "the workspace existed before this launch" }
    if (ws.mode === "checkout") return { removed: false, reason: "a checkout is the repository itself" }
    const directory = resolveUnderRoots(ws.directory, this.roots)
    if (!isDirectory(directory)) return { removed: false, reason: "the workspace is already gone" }
    if (this.roots.some((root) => resolvePath(root) === directory)) return { removed: false, reason: "the workspace is a workspace root" }
    if ((await this.marker(directory, ctx)) !== handle.launchID) return { removed: false, reason: "the workspace was not made by this launch" }
    if (await this.isDirty(directory, ctx)) return { removed: false, reason: "the workspace has uncommitted changes" }
    if (ws.mode === "worktree") {
      const repo = resolveUnderRoots(ws.repo, this.roots)
      if (directory === repo) return { removed: false, reason: "the workspace is the repository's main worktree" }
      ctx.progress?.("removing worktree")
      await this.git(repo, ["worktree", "remove", "--", directory], ctx)
      return { removed: true }
    }
    if (directory !== resolveUnderRoots(ws.repo, this.roots)) return { removed: false, reason: "a clone's directory must be its repo" }
    const unpushed = (await this.output(directory, ["rev-list", "--count", "--branches", "--not", "--remotes"], ctx))?.trim()
    if (unpushed !== "0") return { removed: false, reason: unpushed ? `the clone has ${unpushed} unpushed commits` : "the clone has unpushed commits" }
    ctx.progress?.("removing clone")
    rmSync(directory, { recursive: true })
    return { removed: true }
  }

  private checkHandle(handle: RunHandle): PreparedWorkspace {
    const problem = preparedWorkspaceProblem(handle?.workspace)
    if (problem) throw new RuntimeError(problem)
    return handle.workspace
  }

  // ---------- git helpers ----------

  /** Runs git; a failure becomes a RuntimeError (with `message` instead of git's, when given). */
  private async git(cwd: string, args: readonly string[], ctx: RuntimeContext, message?: string): Promise<string> {
    try {
      return await runGit(args, { ...this.options.git, cwd, ...(ctx.signal ? { signal: ctx.signal } : {}) })
    } catch (cause) {
      if (cause instanceof GitError) throw new RuntimeError(message && !/cancelled|timed out/.test(cause.message) ? message : cause.message)
      throw cause
    }
  }

  /** stdout, or undefined when git fails (cancellation still throws). */
  private async output(cwd: string, args: readonly string[], ctx: RuntimeContext): Promise<string | undefined> {
    try {
      return await this.git(cwd, args, ctx)
    } catch (cause) {
      if (ctx.signal?.aborted) throw cause
      return undefined
    }
  }

  private async succeeds(cwd: string, args: readonly string[], ctx: RuntimeContext): Promise<boolean> {
    return (await this.output(cwd, args, ctx)) !== undefined
  }

  private hasBranch(repo: string, branch: string, ctx: RuntimeContext): Promise<boolean> {
    return this.succeeds(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], ctx)
  }

  private async currentBranch(dir: string, ctx: RuntimeContext): Promise<string | undefined> {
    const out = (await this.output(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], ctx))?.trim()
    return out && isRefName(out) ? out : undefined
  }

  private async isDirty(dir: string, ctx: RuntimeContext): Promise<boolean> {
    return (await this.git(dir, ["status", "--porcelain", "--untracked-files=all"], ctx)).trim().length > 0
  }

  /** Worktree paths by checked-out ref (refs/heads/<branch>). */
  private async worktrees(repo: string, ctx: RuntimeContext): Promise<Map<string, string>> {
    const out = await this.git(repo, ["worktree", "list", "--porcelain"], ctx)
    const byRef = new Map<string, string>()
    for (const block of out.split(/\n\n+/)) {
      const lines = block.split("\n")
      const dir = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length)
      const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length)
      if (dir && ref && !lines.some((l) => l.startsWith("prunable"))) byRef.set(ref, dir)
    }
    return byRef
  }

  private async markerFile(dir: string, ctx: RuntimeContext): Promise<string> {
    return path.join((await this.git(dir, ["rev-parse", "--absolute-git-dir"], ctx)).trim(), LAUNCH_MARKER)
  }

  private async mark(dir: string, launchID: string, ctx: RuntimeContext): Promise<void> {
    writeFileSync(await this.markerFile(dir, ctx), `${launchID}\n`, { mode: 0o600 })
  }

  private async marker(dir: string, ctx: RuntimeContext): Promise<string | undefined> {
    try {
      return readFileSync(await this.markerFile(dir, ctx), "utf8").trim()
    } catch {
      return undefined
    }
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
