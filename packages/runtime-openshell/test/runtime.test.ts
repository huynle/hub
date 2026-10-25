// The openshell runtime (design §6.4) against the fake openshell CLI (test/fake-openshell.ts) and real temporary git
// repositories: prepare clones on the host under the node's roots, creates a sandbox (policy, providers, labels),
// waits for Ready, uploads a seed bundle and clones it inside. No real sandboxes: `sandbox exec` runs locally in the
// fake's directory for the sandbox.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { RuntimeError } from "../../runtime-sdk/src/index.ts"
import { OpenShellCli } from "../src/cli.ts"
import { normalizeOpenShellProfiles, ProfileError } from "../src/profiles.ts"
import { labelValue, SANDBOX_WORKDIR, sandboxName } from "../src/runtime.ts"
import { base, fake, gitIn, inside, input, rejection, root, setup } from "./runtime-helpers.ts"

// Every fake call starts a process: a whole launch takes a few seconds.
setDefaultTimeout(60_000)

describe("names", () => {
  test("sandbox names are hub-<20 hex of sha256(launchID)>: deterministic DNS labels", () => {
    const a = sandboxName("l1")
    expect(a).toMatch(/^hub-[0-9a-f]{20}$/)
    expect(sandboxName("l1")).toBe(a)
    expect(sandboxName("l2")).not.toBe(a)
    expect(sandboxName("user/launch:with@odd+chars~" + "x".repeat(250))).toMatch(/^hub-[0-9a-f]{20}$/)
  })

  test("launch labels keep a label-safe ID and hash any other", () => {
    expect(labelValue("01HXYZ-abc_1.2")).toBe("01HXYZ-abc_1.2")
    expect(labelValue("a/b:c")).toMatch(/^[0-9a-f]{20}$/)
    expect(labelValue("x".repeat(64))).toMatch(/^[0-9a-f]{20}$/)
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

