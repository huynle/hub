// The node's git runner: no shell (execFile argv), a fixed hardened environment (no prompts, https/ssh transports
// only, never ext::), inherited GIT_* repository overrides dropped, time limits and cancellation.
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { GitError, gitEnv, redact, runGit } from "../src/git.ts"

const tmp = () => mkdtempSync(path.join(tmpdir(), "hub-node-git-"))
const base = { PATH: process.env.PATH, HOME: tmpdir() }

function repo(): string {
  const dir = tmp()
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...base, GIT_CONFIG_NOSYSTEM: "1" } })
  g("init", "-q", "-b", "main")
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
  return dir
}

describe("gitEnv", () => {
  test("disables prompts, allows only https and ssh, and drops repository overrides", () => {
    const env = gitEnv({ ...base, GIT_DIR: "/evil", GIT_WORK_TREE: "/evil", GIT_INDEX_FILE: "/evil", GIT_CONFIG_PARAMETERS: "'core.pager=evil'", GIT_EXEC_PATH: "/evil", GIT_ALLOW_PROTOCOL: "ext", SSH_AUTH_SOCK: "/sock" })
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
    expect(env.GIT_ALLOW_PROTOCOL).toBe("https:ssh")
    expect(env.GCM_INTERACTIVE).toBe("never")
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS", "GIT_EXEC_PATH"]) expect(env[name]).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBe("/sock")
    expect(env.PATH).toBe(process.env.PATH)
  })

  test("an overlay (tests, config) applies last", () => {
    expect(gitEnv(base, { GIT_ALLOW_PROTOCOL: "https:ssh:file" }).GIT_ALLOW_PROTOCOL).toBe("https:ssh:file")
  })
})

describe("runGit", () => {
  test("runs git with argv in cwd and returns stdout", async () => {
    const dir = repo()
    const out = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, baseEnv: base })
    expect(out.trim()).toBe("main")
  })

  test("an inherited GIT_DIR does not redirect git", async () => {
    const dir = repo()
    const out = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir, baseEnv: { ...base, GIT_DIR: "/nonexistent" } })
    expect(out.trim()).toContain(path.basename(dir))
  })

  test("argv is never a shell: metacharacters stay literal", async () => {
    const dir = repo()
    const marker = path.join(dir, "pwned")
    await expect(runGit(["rev-parse", `--verify`, `main;touch ${marker}`], { cwd: dir, baseEnv: base })).rejects.toBeInstanceOf(GitError)
    await expect(runGit(["rev-parse", "--verify", `$(touch ${marker})`], { cwd: dir, baseEnv: base })).rejects.toBeInstanceOf(GitError)
    expect(existsSync(marker)).toBe(false)
  })

  test("ext:: and file transports are refused", async () => {
    const dir = tmp()
    const marker = path.join(dir, "pwned")
    await expect(runGit(["clone", "--", `ext::sh -c touch% ${marker}`, path.join(dir, "a")], { cwd: dir, baseEnv: base })).rejects.toBeInstanceOf(GitError)
    expect(existsSync(marker)).toBe(false)
    const source = repo()
    await expect(runGit(["clone", "--", `file://${source}`, path.join(dir, "b")], { cwd: dir, baseEnv: base })).rejects.toBeInstanceOf(GitError)
    expect(existsSync(path.join(dir, "b"))).toBe(false)
  })

  test("a failure is a GitError with git's message, credentials redacted", async () => {
    const dir = repo()
    const error = await runGit(["checkout", "https://user:hunter2@example.com/x.git"], { cwd: dir, baseEnv: base }).catch((e) => e)
    expect(error).toBeInstanceOf(GitError)
    expect(error.message).toContain("git checkout")
    expect(error.message).not.toContain("hunter2")
  })

  test("a run over its time limit is killed", async () => {
    const dir = tmp()
    const slow = path.join(dir, "slow-git")
    writeFileSync(slow, "#!/bin/sh\nsleep 10\n")
    chmodSync(slow, 0o755)
    const started = Date.now()
    const error = await runGit(["status"], { cwd: dir, baseEnv: base, binary: slow, timeoutMs: 200 }).catch((e) => e)
    expect(error).toBeInstanceOf(GitError)
    expect(error.message).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("an aborted run is killed", async () => {
    const dir = tmp()
    const slow = path.join(dir, "slow-git")
    writeFileSync(slow, "#!/bin/sh\nsleep 10\n")
    chmodSync(slow, 0o755)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const error = await runGit(["status"], { cwd: dir, baseEnv: base, binary: slow, signal: controller.signal }).catch((e) => e)
    expect(error).toBeInstanceOf(GitError)
    expect(error.message).toContain("cancelled")
  })
})

test("redact removes userinfo from URLs", () => {
  expect(redact("fatal: https://u:p@h/x and ssh://git:tok@h/y")).toBe("fatal: https://***@h/x and ssh://***@h/y")
})
