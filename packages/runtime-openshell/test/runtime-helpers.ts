// Shared setup for the openshell runtime tests: a fake openshell (test/fake-openshell.ts), temporary git repositories
// (an "origin" reached as https://example.invalid/proj through the file transport) and a runtime over both.
import { afterEach, beforeEach } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrepareInput } from "../../runtime-sdk/src/index.ts"
import { OpenShellCli } from "../src/cli.ts"
import { OpenShellRuntime, sandboxName, type OpenShellRuntimeOptions } from "../src/runtime.ts"
import { createFakeOpenShell, type FakeOpenShell, type FakeOpenShellOptions } from "./fake-openshell.ts"

export const base = { PATH: process.env.PATH ?? "", HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1" }
export const ident = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }

/** Git in a temporary directory only (never in this checkout). */
export function gitIn(cwd: string, ...args: string[]): string {
  if (!cwd || (!cwd.startsWith(realpathSync(tmpdir())) && !cwd.startsWith(tmpdir()))) throw new Error(`gitIn: refusing to run git outside the temporary directory (cwd ${cwd})`)
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env: base, encoding: "utf8" }).trim()
}

export function commit(dir: string, file: string, text: string): string {
  writeFileSync(path.join(dir, file), text)
  gitIn(dir, "add", file)
  gitIn(dir, "commit", "-q", "-m", `edit ${file}`)
  return gitIn(dir, "rev-parse", "HEAD")
}

export let root: string
export let remotes: string
export let fake: FakeOpenShell
const fakes: FakeOpenShell[] = []

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hub-os-root-"))
  remotes = mkdtempSync(path.join(tmpdir(), "hub-os-remotes-"))
  const origin = path.join(remotes, "proj")
  mkdirSync(origin)
  gitIn(origin, "init", "-q", "-b", "main")
  commit(origin, "a.txt", "a\n")
})

afterEach(() => {
  for (const f of fakes.splice(0)) f.cleanup()
})

/** A runtime over a new fake (or, with `keep`, the current one: a restarted node against the same gateway). */
export function setup(fakeOptions: FakeOpenShellOptions = {}, options: Partial<OpenShellRuntimeOptions> = {}, keep = false) {
  if (!keep) {
    fake = createFakeOpenShell(fakeOptions)
    fakes.push(fake)
  }
  const client = new OpenShellCli({ binary: fake.binary, env: { ...base, ...ident } })
  // The file transport stands in for https: https://example.invalid/<name> is rewritten to a local repository.
  const env = {
    ...ident,
    GIT_ALLOW_PROTOCOL: "https:ssh:file",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://example.invalid/",
  }
  const rt = new OpenShellRuntime({
    client,
    roots: [root],
    hubURL: "http://127.0.0.1:4096",
    machineID: "m1",
    owner: "u1",
    git: { baseEnv: base, env },
    pollMs: 1,
    ...options,
  })
  return rt
}

export const input = (over: Partial<PrepareInput> = {}, ws: Partial<PrepareInput["workspace"]> = {}): PrepareInput => ({
  launchID: "l1",
  harness: "opencode",
  runtime: { kind: "openshell" },
  workspace: { repo: path.join(root, "proj"), mode: "clone", remote: "https://example.invalid/proj", branch: "feat", ...ws },
  ...over,
})

export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a rejection")
}

/** The sandbox's /sandbox/work directory in the fake. */
export const inside = (launchID = "l1") => path.join(fake.sandboxRoot(sandboxName(launchID)), "sandbox", "work")

