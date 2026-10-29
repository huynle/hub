// The per-harness dispatchers (HBS-13 integration item 1): the engine holds one executor per action kind and
// builtinExecutors one HarnessSource, but three adapters each supply install-harness sources, verify-harness and
// register-mcp-server executors. The dispatchers route by `action.harness` and refuse (never throw) for a harness
// nothing was registered for.
import { describe, expect, test } from "bun:test"
import type { HarnessID, InstallHarness, VerifyHarness } from "../src/bootstrap/contracts/index.ts"
import type { HarnessSource } from "../src/bootstrap/transaction/builtin.ts"
import type { ActionExecutor, StepContext } from "../src/bootstrap/transaction/executor.ts"
import { txOk } from "../src/bootstrap/transaction/result.ts"
import { dispatchByHarness, dispatchHarnessSource } from "../src/setup/dispatch.ts"
import { memoryStaging } from "../src/bootstrap/transaction/stream.ts"
import { ACTIONS, INSTALL_CLAUDE, INSTALL_CODEX } from "./bootstrap/fixtures.ts"

const VERIFY = (harness: HarnessID): VerifyHarness => ({ id: `verify-${harness}`, kind: "verify-harness", escalation: "user", summary: "verify", harness, probes: ["version-exec"] })

function verifier(name: string, seen: string[]): ActionExecutor<"verify-harness"> {
  return {
    kind: "verify-harness",
    plan: () => ({ class: "external" }),
    check: async (a) => (seen.push(`${name}:check:${a.harness}`), txOk(undefined)),
    change: async (a) => (seen.push(`${name}:change:${a.harness}`), txOk({ type: "none", reason: name })),
    undo: async (a) => (seen.push(`${name}:undo:${a.harness}`), txOk(undefined)),
  }
}

const ctx = {} as StepContext

describe("dispatchByHarness", () => {
  test("routes check, change and undo to the executor of action.harness", async () => {
    const seen: string[] = []
    const exec = dispatchByHarness("verify-harness", { opencode: verifier("oc", seen), codex: verifier("cx", seen) })
    expect(exec.kind).toBe("verify-harness")
    expect(exec.plan(VERIFY("codex"))).toEqual({ class: "external" })
    await exec.check!(VERIFY("codex"), ctx)
    await exec.change(VERIFY("opencode"), ctx)
    await exec.undo!(VERIFY("codex"), {} as never)
    expect(seen).toEqual(["cx:check:codex", "oc:change:opencode", "cx:undo:codex"])
  })

  test("a harness without an executor is refused at check and change, never thrown", async () => {
    const exec = dispatchByHarness("verify-harness", { opencode: verifier("oc", []) })
    const check = await exec.check!(VERIFY("claude-code"), ctx)
    expect(check.ok).toBe(false)
    expect(!check.ok && check.code).toBe("internal")
    expect(!check.ok && check.message).toContain("claude-code")
    const change = await exec.change(VERIFY("claude-code"), ctx)
    expect(change.ok).toBe(false)
  })

  test("the step plan of an unregistered harness keeps the kind's journal class (install-harness: harness)", () => {
    const exec = dispatchByHarness("install-harness", {})
    expect(exec.plan(INSTALL_CODEX as InstallHarness)).toEqual({ class: "harness", path: (INSTALL_CODEX as InstallHarness).path })
  })
})

describe("dispatchHarnessSource", () => {
  const source = (name: string, calls: string[]): HarnessSource => ({
    manifest: {} as HarnessSource["manifest"],
    fetch: async (a, staging) => (calls.push(`${name}:fetch:${a.harness}`), { file: await staging.write("a", new Uint8Array([1]), { maxBytes: 1 }), evidence: [] }),
    unpack: async (a) => (calls.push(`${name}:unpack:${a.harness}`), txOk([])),
    installed: (h) => (h === "opencode" ? { version: "2.2.0", sha256: `sha256:${"a".repeat(64)}` } : undefined),
    floor: () => "2.0.0",
  })

  test("routes fetch, unpack, installed and floor by harness", async () => {
    const calls: string[] = []
    const manifest = {} as HarnessSource["manifest"]
    const src = dispatchHarnessSource({ manifest, sources: { opencode: source("oc", calls), "claude-code": source("cc", calls) }, allowDowngrade: true })
    expect(src.manifest).toBe(manifest)
    expect(src.allowDowngrade).toBe(true)
    const staging = memoryStaging()
    const { file } = await src.fetch(ACTIONS["install-harness"] as InstallHarness, staging)
    await src.unpack(INSTALL_CLAUDE as InstallHarness, file, staging)
    expect(calls).toEqual(["oc:fetch:opencode", "cc:unpack:claude-code"])
    expect(src.installed!("opencode")?.version).toBe("2.2.0")
    expect(src.floor!("claude-code")).toBe("2.0.0")
    expect(src.installed!("codex")).toBeUndefined()
  })

  test("a harness without a source: unpack refuses, fetch rejects with a typed failure", async () => {
    const src = dispatchHarnessSource({ manifest: {} as HarnessSource["manifest"], sources: {} })
    const staging = memoryStaging()
    const unpacked = await src.unpack(INSTALL_CODEX as InstallHarness, await staging.write("a", new Uint8Array(), { maxBytes: 1 }), staging)
    expect(unpacked.ok).toBe(false)
    await expect(src.fetch(INSTALL_CODEX as InstallHarness, staging)).rejects.toThrow(/codex/)
  })
})
