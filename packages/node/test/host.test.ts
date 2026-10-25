// The host runtime (design §6.4) on real temporary git repositories: worktree (created or reused), checkout and
// clone workspaces under the node's roots, collect (branch, head, commits, dirty) and cleanup (keep, or remove
// without force), plus the injection and escape cases the hardening exists for.
import { beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { LaunchWorkspace, PreparedWorkspace } from "../../protocol/src/index.ts"
import { RuntimeError } from "../../runtime-sdk/src/index.ts"
import { HostRuntime, resolveUnderRoots } from "../src/host.ts"

const base = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1" }
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env: base, encoding: "utf8" }).trim()

let root: string // as given in node.json (on macOS under /var, a symlink to /private/var)
let outside: string
let repo: string

function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  gitIn(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "a.txt"), "a\n")
  gitIn(dir, "add", "a.txt")
  gitIn(dir, "commit", "-q", "-m", "init")
  return dir
}

/** The file transport stands in for https in tests: https://example.invalid/<name> is rewritten to a local repo. */
function runtime(extra: { remoteDir?: string } = {}) {
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  if (extra.remoteDir) {
    Object.assign(env, {
      GIT_ALLOW_PROTOCOL: "https:ssh:file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${extra.remoteDir}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://example.invalid/",
    })
  }
  return new HostRuntime({ roots: [root], git: { baseEnv: base, env } })
}

const h = (workspace: PreparedWorkspace, launchID = "l1") => ({ launchID, workspace })
const prepare = (rt: HostRuntime, workspace: LaunchWorkspace, launchID = "l1") =>
  rt.prepare({ launchID, harness: "opencode", runtime: { kind: "host" }, workspace })

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hub-node-root-"))
  outside = mkdtempSync(path.join(tmpdir(), "hub-node-outside-"))
  repo = makeRepo(path.join(root, "proj"))
})

describe("resolveUnderRoots", () => {
  test("resolves existing and not-yet-existing paths through symlinks", () => {
    const real = realpathSync(root)
    expect(resolveUnderRoots(repo, [root])).toBe(path.join(real, "proj"))
    expect(resolveUnderRoots(path.join(repo, ".worktrees", "feat", "x"), [root])).toBe(path.join(real, "proj", ".worktrees", "feat", "x"))
    expect(resolveUnderRoots(root, [root])).toBe(real)
  })

  test("refuses paths outside every root, including through a symlink and a sibling prefix", () => {
    expect(() => resolveUnderRoots(outside, [root])).toThrow(RuntimeError)
    symlinkSync(outside, path.join(root, "escape"))
    expect(() => resolveUnderRoots(path.join(root, "escape"), [root])).toThrow(RuntimeError)
    expect(() => resolveUnderRoots(path.join(root, "escape", "new"), [root])).toThrow(RuntimeError)
    expect(() => resolveUnderRoots(`${root}-sibling/x`, [root])).toThrow(RuntimeError)
    expect(() => resolveUnderRoots(repo, [])).toThrow(/workspaceRoots/)
  })
})

describe("host runtime", () => {
  test("info: kind host with the opencode harness", () => {
    expect(runtime().info()).toEqual({ kind: "host", harnesses: ["opencode"] })
  })

  describe("prepare worktree", () => {
    test("creates <repo>/.worktrees/<branch> on a new branch from base", async () => {
      const ws = await prepare(runtime(), { repo, mode: "worktree", branch: "feat/x", base: "main" })
      const real = realpathSync(repo)
      expect(ws).toEqual({ repo: real, directory: path.join(real, ".worktrees", "feat", "x"), mode: "worktree", branch: "feat/x", base: "main", head: gitIn(repo, "rev-parse", "main"), reused: false })
      expect(gitIn(ws.directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/x")
    })

    test("checks out an existing branch", async () => {
      gitIn(repo, "branch", "existing")
      const ws = await prepare(runtime(), { repo, mode: "worktree", branch: "existing" })
      expect(ws.reused).toBe(false)
      expect(gitIn(ws.directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("existing")
    })

    test("reuses the branch's existing worktree", async () => {
      const first = await prepare(runtime(), { repo, mode: "worktree", branch: "feat/x" }, "l1")
      const again = await prepare(runtime(), { repo, mode: "worktree", branch: "feat/x" }, "l2")
      expect(again.directory).toBe(first.directory)
      expect(again.reused).toBe(true)
    })

    test("without a branch, uses launch/<launchID>", async () => {
      const ws = await prepare(runtime(), { repo, mode: "worktree" }, "lch:1@a")
      expect(ws.branch).toBe("launch/lch-1-a")
      expect(ws.directory.endsWith(path.join(".worktrees", "launch", "lch-1-a"))).toBe(true)
    })

    test("refuses a missing repo, a non-repo, a repo subdirectory and an unknown base", async () => {
      await expect(prepare(runtime(), { repo: path.join(root, "nope"), mode: "worktree", branch: "b" })).rejects.toThrow(RuntimeError)
      mkdirSync(path.join(root, "plain"))
      await expect(prepare(runtime(), { repo: path.join(root, "plain"), mode: "worktree", branch: "b" })).rejects.toThrow(RuntimeError)
      mkdirSync(path.join(repo, "sub"))
      await expect(prepare(runtime(), { repo: path.join(repo, "sub"), mode: "worktree", branch: "b" })).rejects.toThrow(/top level/)
      await expect(prepare(runtime(), { repo, mode: "worktree", branch: "b", base: "nosuch" })).rejects.toThrow(RuntimeError)
    })

    test("refuses a directory in the way that is not the branch's worktree", async () => {
      mkdirSync(path.join(repo, ".worktrees", "b"), { recursive: true })
      await expect(prepare(runtime(), { repo, mode: "worktree", branch: "b" })).rejects.toThrow(/exists/)
    })

    test("refuses a .worktrees symlink that leads out of the roots", async () => {
      symlinkSync(outside, path.join(repo, ".worktrees"))
      await expect(prepare(runtime(), { repo, mode: "worktree", branch: "b" })).rejects.toThrow(RuntimeError)
      expect(existsSync(path.join(outside, "b"))).toBe(false)
    })
  })

  describe("prepare checkout", () => {
    test("is the repo itself, switched to the branch (created from base when new)", async () => {
      const ws = await prepare(runtime(), { repo, mode: "checkout", branch: "work", base: "main" })
      expect(ws.directory).toBe(realpathSync(repo))
      expect(ws.reused).toBe(true)
      expect(gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work")
      gitIn(repo, "switch", "-q", "main")
      const again = await prepare(runtime(), { repo, mode: "checkout", branch: "work" })
      expect(again.branch).toBe("work")
      expect(gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work")
    })

    test("without a branch, leaves the repo as it is", async () => {
      const ws = await prepare(runtime(), { repo, mode: "checkout" })
      expect(ws.branch).toBe("main")
    })
  })

  describe("prepare clone", () => {
    test("clones the remote into repo and creates the branch", async () => {
      const remotes = mkdtempSync(path.join(tmpdir(), "hub-node-remotes-"))
      makeRepo(path.join(remotes, "src.git"))
      const target = path.join(root, "clones", "c1")
      const ws = await prepare(runtime({ remoteDir: remotes }), { repo: target, mode: "clone", remote: "https://example.invalid/src.git", branch: "feat/c", base: "main" })
      expect(ws.directory).toBe(path.join(realpathSync(root), "clones", "c1"))
      expect(ws.reused).toBe(false)
      expect(ws.mode).toBe("clone")
      expect(gitIn(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/c")
    })

    test("refuses an existing target and a clone outside the roots", async () => {
      const remotes = mkdtempSync(path.join(tmpdir(), "hub-node-remotes-"))
      makeRepo(path.join(remotes, "src.git"))
      await expect(prepare(runtime({ remoteDir: remotes }), { repo, mode: "clone", remote: "https://example.invalid/src.git" })).rejects.toThrow(/exists/)
      await expect(prepare(runtime({ remoteDir: remotes }), { repo: path.join(outside, "c"), mode: "clone", remote: "https://example.invalid/src.git" })).rejects.toThrow(RuntimeError)
      expect(existsSync(path.join(outside, "c"))).toBe(false)
    })

    test("the default transports refuse a file remote even if rewritten", async () => {
      const remotes = mkdtempSync(path.join(tmpdir(), "hub-node-remotes-"))
      makeRepo(path.join(remotes, "src.git"))
      const rt = new HostRuntime({
        roots: [root],
        git: { baseEnv: base, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://example.invalid/" } },
      })
      await expect(prepare(rt, { repo: path.join(root, "c2"), mode: "clone", remote: "https://example.invalid/src.git" })).rejects.toThrow(RuntimeError)
    })
  })

  describe("injection", () => {
    const cases: [string, LaunchWorkspace][] = [
      ["an option as branch", { repo: "/x", mode: "worktree", branch: "--upload-pack=touch /tmp/pwned" }],
      ["a dash branch", { repo: "/x", mode: "worktree", branch: "-b" }],
      ["a branch with ..", { repo: "/x", mode: "worktree", branch: "a/../../etc" }],
      ["a shell base", { repo: "/x", mode: "worktree", branch: "b", base: "main;touch /tmp/pwned" }],
      ["an ext remote", { repo: "/x", mode: "clone", remote: "ext::sh -c touch% /tmp/pwned" }],
      ["an option remote", { repo: "/x", mode: "clone", remote: "--upload-pack=touch /tmp/pwned" }],
      ["a file remote", { repo: "/x", mode: "clone", remote: "file:///etc" }],
      ["a relative repo", { repo: "proj", mode: "checkout" }],
      ["a .. repo", { repo: "/a/../etc", mode: "checkout" }],
    ]
    for (const [name, workspace] of cases) {
      test(`refuses ${name}`, async () => {
        const ws = workspace.repo === "/x" ? { ...workspace, repo } : workspace
        await expect(prepare(runtime(), ws)).rejects.toThrow(RuntimeError)
      })
    }

    test("refuses a runtime other than host and an unknown harness", async () => {
      const rt = runtime()
      await expect(rt.prepare({ launchID: "l1", harness: "opencode", runtime: { kind: "openshell" }, workspace: { repo, mode: "checkout" } })).rejects.toThrow(RuntimeError)
      await expect(rt.prepare({ launchID: "l1", harness: "aider", runtime: { kind: "host" }, workspace: { repo, mode: "checkout" } })).rejects.toThrow(RuntimeError)
    })

    test("collect and cleanup refuse a workspace outside the roots", async () => {
      makeRepo(path.join(outside, "r"))
      const ws: PreparedWorkspace = { repo: path.join(outside, "r"), directory: path.join(outside, "r"), mode: "clone", reused: false }
      await expect(runtime().collect(h(ws))).rejects.toThrow(RuntimeError)
      await expect(runtime().cleanup(h(ws), "remove")).rejects.toThrow(RuntimeError)
      expect(existsSync(path.join(outside, "r"))).toBe(true)
    })
  })

  describe("collect", () => {
    test("reports branch, base, head, commits since base and dirty", async () => {
      const rt = runtime()
      const ws = await prepare(rt, { repo, mode: "worktree", branch: "feat/x", base: "main" })
      writeFileSync(path.join(ws.directory, "b.txt"), "b\n")
      gitIn(ws.directory, "add", "b.txt")
      gitIn(ws.directory, "commit", "-q", "-m", "b")
      gitIn(ws.directory, "commit", "-q", "--allow-empty", "-m", "c")
      expect(await rt.collect(h(ws))).toEqual({ branch: "feat/x", base: "main", head: gitIn(ws.directory, "rev-parse", "HEAD"), commits: 2, dirty: false })
      writeFileSync(path.join(ws.directory, "untracked.txt"), "u\n")
      expect((await rt.collect(h(ws))).dirty).toBe(true)
    })

    test("a detached HEAD has no branch", async () => {
      const rt = runtime()
      const ws = await prepare(rt, { repo, mode: "worktree", branch: "d" })
      gitIn(ws.directory, "switch", "-q", "--detach")
      const artifacts = await rt.collect(h(ws))
      expect(artifacts.branch).toBeUndefined()
      expect(artifacts.head).toMatch(/^[0-9a-f]{40}$/)
    })
  })

  describe("cleanup", () => {
    test("keep keeps", async () => {
      const rt = runtime()
      const ws = await prepare(rt, { repo, mode: "worktree", branch: "k" })
      expect(await rt.cleanup(h(ws), "keep")).toEqual({ removed: false, reason: "cleanup policy is keep" })
      expect(existsSync(ws.directory)).toBe(true)
    })

    test("remove removes a clean worktree it made, keeping the branch", async () => {
      const rt = runtime()
      const ws = await prepare(rt, { repo, mode: "worktree", branch: "r" })
      expect(await rt.cleanup(h(ws), "remove")).toEqual({ removed: true })
      expect(existsSync(ws.directory)).toBe(false)
      expect(gitIn(repo, "branch", "--list", "r")).toContain("r")
    })

    test("remove keeps a worktree with uncommitted work (never forces)", async () => {
      const rt = runtime()
      const ws = await prepare(rt, { repo, mode: "worktree", branch: "dirty" })
      writeFileSync(path.join(ws.directory, "wip.txt"), "wip\n")
      const result = await rt.cleanup(h(ws), "remove")
      expect(result.removed).toBe(false)
      expect(result.reason).toContain("uncommitted")
      expect(existsSync(path.join(ws.directory, "wip.txt"))).toBe(true)
    })

    test("remove keeps a reused workspace and a checkout", async () => {
      const rt = runtime()
      await prepare(rt, { repo, mode: "worktree", branch: "u" }, "l1")
      const reused = await prepare(rt, { repo, mode: "worktree", branch: "u" }, "l2")
      expect((await rt.cleanup(h(reused, "l2"), "remove")).removed).toBe(false)
      expect(existsSync(reused.directory)).toBe(true)
      const checkout = await prepare(rt, { repo, mode: "checkout" })
      expect((await rt.cleanup(h(checkout), "remove")).removed).toBe(false)
      expect(existsSync(repo)).toBe(true)
    })

    test("remove only removes what this launch made (a hub cannot point it elsewhere)", async () => {
      const rt = runtime()
      const ws = await prepare(rt, { repo, mode: "worktree", branch: "mine" }, "l1")
      const other = await rt.cleanup({ launchID: "l2", workspace: ws }, "remove")
      expect(other.removed).toBe(false)
      expect(other.reason).toContain("not made by this launch")
      expect(existsSync(ws.directory)).toBe(true)
      // A forged cleanup naming the user's own repository as a fresh clone.
      const forged = await rt.cleanup({ launchID: "l1", workspace: { repo, directory: repo, mode: "clone", reused: false } }, "remove")
      expect(forged.removed).toBe(false)
      expect(existsSync(path.join(repo, "a.txt"))).toBe(true)
      // The repository's main worktree, forged as a worktree.
      const main = await rt.cleanup({ launchID: "l1", workspace: { repo, directory: repo, mode: "worktree", branch: "main", reused: false } }, "remove")
      expect(main.removed).toBe(false)
      expect(existsSync(path.join(repo, "a.txt"))).toBe(true)
    })

    test("remove removes a clean clone with nothing unpushed, and keeps one with unpushed commits", async () => {
      const remotes = mkdtempSync(path.join(tmpdir(), "hub-node-remotes-"))
      makeRepo(path.join(remotes, "src.git"))
      const rt = runtime({ remoteDir: remotes })
      const a = await prepare(rt, { repo: path.join(root, "ca"), mode: "clone", remote: "https://example.invalid/src.git" }, "la")
      expect(await rt.cleanup(h(a, "la"), "remove")).toEqual({ removed: true })
      expect(existsSync(a.directory)).toBe(false)
      const b = await prepare(rt, { repo: path.join(root, "cb"), mode: "clone", remote: "https://example.invalid/src.git", branch: "feat/b" }, "lb")
      gitIn(b.directory, "commit", "-q", "--allow-empty", "-m", "local")
      const kept = await rt.cleanup(h(b, "lb"), "remove")
      expect(kept.removed).toBe(false)
      expect(kept.reason).toContain("unpushed")
      expect(existsSync(b.directory)).toBe(true)
    })

    test("a workspace already gone is reported as not removed", async () => {
      const rt = runtime()
      const ws = await prepare(rt, { repo, mode: "worktree", branch: "gone" })
      gitIn(repo, "worktree", "remove", ws.directory)
      expect(await rt.cleanup(h(ws), "remove")).toEqual({ removed: false, reason: "the workspace is already gone" })
    })
  })

  test("a cancelled prepare stops", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runtime().prepare({ launchID: "l1", harness: "opencode", runtime: { kind: "host" }, workspace: { repo, mode: "worktree", branch: "c" } }, { signal: controller.signal })).rejects.toThrow(/cancelled/)
  })
})
