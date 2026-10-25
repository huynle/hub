// The openshell runtime (design §6.4) against the fake openshell CLI (test/fake-openshell.ts) and real temporary git
// repositories: the node clones on the host under its roots, creates a sandbox (policy, providers, labels), waits
// for Ready, uploads a seed bundle and clones it inside; start hands the harness its hub config; collect brings a
// bundle back and fast-forwards the host clone; cleanup deletes (or only stops) the sandbox and removes the host
// clone per policy. No real sandboxes: `sandbox exec` runs locally in the fake's directory for the sandbox.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PreparedWorkspace } from "../../protocol/src/index.ts"
import { RuntimeError, type PrepareInput } from "../../runtime-sdk/src/index.ts"
import { OpenShellCli } from "../src/cli.ts"
import { normalizeOpenShellProfiles, ProfileError } from "../src/profiles.ts"
import { launchLabel, OpenShellRuntime, SANDBOX_WORKDIR, sandboxName, type OpenShellRuntimeOptions } from "../src/runtime.ts"
import { createFakeOpenShell, type FakeOpenShell, type FakeOpenShellOptions } from "./fake-openshell.ts"

// Every fake call starts a process: a whole launch takes a few seconds.
setDefaultTimeout(60_000)

const base = { PATH: process.env.PATH ?? "", HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1" }
const ident = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }

/** Git in a temporary directory only (never in this checkout). */
function gitIn(cwd: string, ...args: string[]): string {
  if (!cwd || (!cwd.startsWith(realpathSync(tmpdir())) && !cwd.startsWith(tmpdir()))) throw new Error(`gitIn: refusing to run git outside the temporary directory (cwd ${cwd})`)
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env: base, encoding: "utf8" }).trim()
}

function commit(dir: string, file: string, text: string): string {
  writeFileSync(path.join(dir, file), text)
  gitIn(dir, "add", file)
  gitIn(dir, "commit", "-q", "-m", `edit ${file}`)
  return gitIn(dir, "rev-parse", "HEAD")
}

let root: string
let remotes: string
let fake: FakeOpenShell
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
function setup(fakeOptions: FakeOpenShellOptions = {}, options: Partial<OpenShellRuntimeOptions> = {}, keep = false) {
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

const input = (over: Partial<PrepareInput> = {}, ws: Partial<PrepareInput["workspace"]> = {}): PrepareInput => ({
  launchID: "l1",
  harness: "opencode",
  runtime: { kind: "openshell" },
  workspace: { repo: path.join(root, "proj"), mode: "clone", remote: "https://example.invalid/proj", branch: "feat", ...ws },
  ...over,
})

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a rejection")
}

/** The sandbox's /sandbox/work directory in the fake. */
const inside = (launchID = "l1") => path.join(fake.sandboxRoot(sandboxName(launchID)), "sandbox", "work")

describe("names", () => {
  test("sandbox names are hub-<20 hex of sha256(launchID)>: deterministic DNS labels", () => {
    const a = sandboxName("l1")
    expect(a).toMatch(/^hub-[0-9a-f]{20}$/)
    expect(sandboxName("l1")).toBe(a)
    expect(sandboxName("l2")).not.toBe(a)
    expect(sandboxName("user/launch:with@odd+chars~" + "x".repeat(250))).toMatch(/^hub-[0-9a-f]{20}$/)
  })

  test("launch labels keep a label-safe ID and hash any other", () => {
    expect(launchLabel("01HXYZ-abc_1.2")).toBe("01HXYZ-abc_1.2")
    expect(launchLabel("a/b:c")).toMatch(/^[0-9a-f]{20}$/)
    expect(launchLabel("x".repeat(64))).toMatch(/^[0-9a-f]{20}$/)
  })
})

describe("prepare", () => {
  test("clones on the host, creates the sandbox with policy, providers and labels, and clones the seed inside", async () => {
    const profiles = normalizeOpenShellProfiles({ coder: { image: "hub-sandbox:9", providers: ["anthropic"], endpoints: ["registry.npmjs.org:443"] } })
    const rt = setup({}, { profiles })
    const ws = await rt.prepare(input({ runtime: { kind: "openshell", profile: "coder" } }))
    const host = path.join(realpathSync(root), "proj")
    const name = sandboxName("l1")
    expect(ws).toMatchObject({ repo: host, directory: SANDBOX_WORKDIR, mode: "clone", branch: "feat", reused: false, runtime: { kind: "openshell", sandbox: name, profile: "coder" } })
    expect(ws.head).toBe(gitIn(host, "rev-parse", "HEAD"))
    expect(SANDBOX_WORKDIR).toBe("/sandbox/work")

    const sb = fake.sandbox(name)!
    expect(sb.labels).toEqual({ "hub.launch": "l1", "hub.machine": "m1", "hub.owner": "u1" })
    expect(sb.from).toBe("hub-sandbox:9")
    expect(sb.providers).toEqual(["anthropic"])
    expect(sb.policy).toContain('host: "host.openshell.internal"')
    expect(sb.policy).toContain('host: "registry.npmjs.org"')
    expect(sb.env).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" })

    expect(gitIn(inside(), "rev-parse", "HEAD")).toBe(ws.head!)
    expect(gitIn(inside(), "symbolic-ref", "--short", "HEAD")).toBe("feat")
    // No credentials or host paths inside: the clone's origin is the seed bundle, not the host's remote.
    expect(gitIn(inside(), "remote", "get-url", "origin")).not.toContain("example.invalid")
  })

  test("the default profile and image when the launch names none", async () => {
    const rt = setup({}, { image: "img:1" })
    const ws = await rt.prepare(input())
    expect(ws.runtime).toEqual({ kind: "openshell", sandbox: sandboxName("l1"), profile: "default" })
    expect(fake.sandbox(sandboxName("l1"))!.from).toBe("img:1")
    expect(fake.sandbox(sandboxName("l1"))!.providers).toEqual([])
  })

  test("waits for the sandbox to be Ready", async () => {
    const rt = setup({ readyAfterGets: 3 })
    await rt.prepare(input())
    const gets = fake.calls().filter((c) => c.command === "sandbox get").length
    expect(gets).toBeGreaterThanOrEqual(3)
    expect(fake.sandbox(sandboxName("l1"))!.phase).toBe("Ready")
  })

  test("a sandbox that ends in Error fails prepare with a RuntimeError", async () => {
    const rt = setup({ readyAfterGets: 1_000_000 })
    let settled = false
    const outcome = rejection(rt.prepare(input())).finally(() => (settled = true))
    // Turn it to Error while prepare polls (again and again: a racing `sandbox get` may write the old phase back).
    while (!settled) {
      if (fake.sandbox(sandboxName("l1"))) fake.update((s) => Object.values(s.sandboxes).forEach((sb) => (sb.phase = "Error")))
      await Bun.sleep(20)
    }
    const error = await outcome
    expect(error).toBeInstanceOf(RuntimeError)
    expect(error.message).toMatch(/is Error/)
  })

  test("refuses other runtimes, harnesses and workspace modes, and unknown or unsupported profiles", async () => {
    const profiles = normalizeOpenShellProfiles({ big: { cpu: 4 } })
    const rt = setup({}, { profiles })
    expect(await rejection(rt.prepare(input({ runtime: { kind: "host" } })))).toBeInstanceOf(RuntimeError)
    expect(await rejection(rt.prepare(input({ harness: "claude" })))).toBeInstanceOf(RuntimeError)
    expect((await rejection(rt.prepare(input({}, { mode: "worktree", remote: undefined })))).message).toMatch(/clone/)
    const unknown = await rejection(rt.prepare(input({ runtime: { kind: "openshell", profile: "nope" } })))
    expect(unknown).toBeInstanceOf(ProfileError)
    expect((unknown as ProfileError).code).toBe("not_found")
    expect(((await rejection(rt.prepare(input({ runtime: { kind: "openshell", profile: "big" } })))) as ProfileError).code).toBe("unsupported")
    expect(fake.calls().filter((c) => c.command === "sandbox create")).toEqual([])
    expect(existsSync(path.join(root, "proj"))).toBe(false)
  })

  test("is idempotent: a repeated prepare (also by a restarted node) reuses the host clone and the sandbox", async () => {
    const first = await setup().prepare(input())
    const second = await setup({}, {}, true).prepare(input())
    expect(second).toEqual(first)
    expect(fake.calls().filter((c) => c.command === "sandbox create")).toHaveLength(1)
  })

  test("never takes over a sandbox of the same name labelled for another launch", async () => {
    const rt = setup()
    const name = sandboxName("l1")
    const policy = path.join(mkdtempSync(path.join(tmpdir(), "hub-os-p-")), "p.yaml")
    writeFileSync(policy, "version: 1\n")
    await new OpenShellCli({ binary: fake.binary, env: base }).create({ name, labels: { "hub.launch": "other" }, policyFile: policy })
    const error = await rejection(rt.prepare(input()))
    expect(error).toBeInstanceOf(RuntimeError)
    expect(error.message).toMatch(/another launch/)
    expect(fake.sandbox(name)!.labels["hub.launch"]).toBe("other")
    expect(fake.calls().some((c) => c.command === "sandbox delete")).toBe(false)
  })

  test("a host clone another launch made is refused", async () => {
    const rt = setup()
    await rt.prepare(input({ launchID: "l0" }))
    const error = await rejection(rt.prepare(input()))
    expect(error).toBeInstanceOf(RuntimeError)
    expect(fake.sandbox(sandboxName("l1"))).toBeUndefined()
  })
})

