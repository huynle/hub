// The openshell runtime's collect and cleanup against the fake openshell: collect bundles the launch's branch inside
// the sandbox, downloads and verifies it, and fast-forwards the host clone (never a forced update); cleanup deletes
// the sandbox only when nothing would be lost (else stops it and says why) and removes the host clone through the
// host runtime's rules (uncommitted or unpushed work keeps it).
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { RuntimeError } from "../../runtime-sdk/src/index.ts"
import { OpenShellCli } from "../src/cli.ts"
import { sandboxName } from "../src/runtime.ts"
import { base, commit, fake, gitIn, inside, input, rejection, root, setup } from "./runtime-helpers.ts"

setDefaultTimeout(60_000)

const host = () => path.join(realpathSync(root), "proj")
const prepared = async (fakeOptions = {}) => {
  const rt = setup(fakeOptions)
  const workspace = await rt.prepare(input({}, { base: "main" }))
  return { rt, workspace, handle: { launchID: "l1", workspace } }
}

describe("collect", () => {
  test("fast-forwards the host clone to the sandbox's branch and reports it", async () => {
    const { rt, handle } = await prepared()
    commit(inside(), "b.txt", "b\n")
    const head = commit(inside(), "c.txt", "c\n")
    const artifacts = await rt.collect(handle)
    expect(artifacts).toEqual({ branch: "feat", base: "main", head, commits: 2, dirty: false })
    expect(gitIn(host(), "rev-parse", "HEAD")).toBe(head)
    expect(gitIn(host(), "status", "--porcelain")).toBe("")
    // Idempotent: collecting again changes nothing.
    expect(await rt.collect(handle)).toEqual(artifacts)
  })

  test("no new commits: the host clone stays where it was", async () => {
    const { rt, workspace, handle } = await prepared()
    expect(await rt.collect(handle)).toEqual({ branch: "feat", base: "main", head: workspace.head!, commits: 0, dirty: false })
  })

  test("uncommitted work in the sandbox is reported dirty (and not brought back)", async () => {
    const { rt, handle } = await prepared()
    writeFileSync(path.join(inside(), "wip.txt"), "wip\n")
    const artifacts = await rt.collect(handle)
    expect(artifacts.dirty).toBe(true)
    expect(existsSync(path.join(host(), "wip.txt"))).toBe(false)
  })

  test("a sandbox branch that does not fast-forward the host clone fails and leaves the host branch alone", async () => {
    const { rt, handle } = await prepared()
    commit(inside(), "b.txt", "inside\n")
    const hostHead = commit(host(), "h.txt", "host\n")
    const error = await rejection(rt.collect(handle))
    expect(error).toBeInstanceOf(RuntimeError)
    expect(error.message).toMatch(/fast-forward/)
    expect(gitIn(host(), "rev-parse", "HEAD")).toBe(hostHead)
  })

  test("a failed download fails collect with a RuntimeError", async () => {
    const { rt, workspace, handle } = await prepared()
    commit(inside(), "b.txt", "b\n")
    fake.fail({ command: "sandbox download" })
    expect(await rejection(rt.collect(handle))).toBeInstanceOf(RuntimeError)
    expect(gitIn(host(), "rev-parse", "HEAD")).toBe(workspace.head!)
  })

  test("the sandbox is gone: collect reports the host clone as it is", async () => {
    const { rt, workspace, handle } = await prepared()
    await new OpenShellCli({ binary: fake.binary, env: base }).delete(sandboxName("l1"))
    expect(await rt.collect(handle)).toEqual({ branch: "feat", base: "main", head: workspace.head!, commits: 0, dirty: false })
  })

  test("refuses a handle for another launch's sandbox", async () => {
    const { rt, workspace } = await prepared()
    expect(await rejection(rt.collect({ launchID: "l2", workspace }))).toBeInstanceOf(RuntimeError)
  })
})

describe("cleanup", () => {
  test("remove: nothing to lose deletes the sandbox and the host clone", async () => {
    const { rt, handle } = await prepared({ deleteAfterGets: 2 })
    expect(await rt.cleanup(handle, "remove")).toEqual({ removed: true })
    expect(fake.sandbox(sandboxName("l1"))).toBeUndefined()
    expect(existsSync(host())).toBe(false)
  })

  test("remove after collecting work: the sandbox goes, the host clone with its unpushed commits stays", async () => {
    const { rt, handle } = await prepared()
    commit(inside(), "b.txt", "b\n")
    await rt.collect(handle)
    const result = await rt.cleanup(handle, "remove")
    expect(result.removed).toBe(false)
    expect(result.reason).toMatch(/host clone: .*unpushed/)
    expect(fake.sandbox(sandboxName("l1"))).toBeUndefined()
    expect(existsSync(host())).toBe(true)
  })

  test("commits that were never collected keep the sandbox (stopped)", async () => {
    const { rt, handle } = await prepared()
    commit(inside(), "b.txt", "b\n")
    const result = await rt.cleanup(handle, "remove")
    expect(result.removed).toBe(false)
    expect(result.reason).toMatch(/sandbox: .*not collected/)
    expect(fake.sandbox(sandboxName("l1"))!.phase).toBe("Stopped")
  })

  test("uncommitted work keeps the sandbox (stopped)", async () => {
    const { rt, handle } = await prepared()
    writeFileSync(path.join(inside(), "wip.txt"), "wip\n")
    const result = await rt.cleanup(handle, "remove")
    expect(result.removed).toBe(false)
    expect(result.reason).toMatch(/sandbox: .*uncommitted/)
    expect(fake.sandbox(sandboxName("l1"))!.phase).toBe("Stopped")
    expect(fake.calls().some((c) => c.command === "sandbox delete")).toBe(false)
  })

  test("keep stops the sandbox and keeps the host clone", async () => {
    const { rt, handle } = await prepared()
    const result = await rt.cleanup(handle, "keep")
    expect(result.removed).toBe(false)
    expect(result.reason).toMatch(/keep/)
    expect(fake.sandbox(sandboxName("l1"))!.phase).toBe("Stopped")
    expect(existsSync(host())).toBe(true)
  })

  test("a sandbox already gone: only the host clone is cleaned up", async () => {
    const { rt, handle } = await prepared()
    await new OpenShellCli({ binary: fake.binary, env: base }).delete(sandboxName("l1"))
    expect(await rt.cleanup(handle, "remove")).toEqual({ removed: true })
    expect(existsSync(host())).toBe(false)
  })

  test("never touches another launch's sandbox", async () => {
    const { rt, workspace } = await prepared()
    expect(await rejection(rt.cleanup({ launchID: "l2", workspace }, "remove"))).toBeInstanceOf(RuntimeError)
    expect(fake.sandbox(sandboxName("l1"))!.phase).toBe("Ready")
  })
})
