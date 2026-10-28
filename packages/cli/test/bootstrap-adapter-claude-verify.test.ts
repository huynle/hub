// Claude Code readiness needs real probes (contracts §3.10): the binary hub resolved runs and prints the expected
// version, the user's own login is in place (`claude auth status`, user-mediated: hubctl never reads or keeps a
// credential), and the spoke is connected and conformant. Any failing, missing or stale probe means not ready, and
// the claude-code capability is not offered until they all pass.
import { describe, expect, test } from "bun:test"
import { findSecrets, type AdapterContext, type VerifyHarness } from "../src/bootstrap/contracts/index.ts"
import { AUTH_STATUS_ARGV, claudeReadiness, claudeVerifyExecutor, verifyClaude, VERSION_ARGV, type ClaudeProbes } from "../src/bootstrap/adapters/claude/verify.ts"
import type { RunResult } from "../src/bootstrap/adapters/claude/ports.ts"
import { FakeRunner } from "./bootstrap/claude-adapter-fixtures.ts"
import { T0 } from "./bootstrap/fixtures.ts"

const BIN = "/Users/dev/.local/share/hub/harnesses/claude-code/current/claude"
/** Credential-shaped values planted where a careless adapter could pick them up. */
const PLANTED = { oauth: "sk-ant-oat01-PLANTEDplantedPLANTEDplanted0123456789", email: "dev@example.com", hub: "hat_PLANTEDhubtoken0123456789abcdef" }

const ctx: AdapterContext = {
  env: { PATH: "/usr/bin:/bin", HOME: "/Users/dev", ANTHROPIC_API_KEY: PLANTED.oauth, HUB_TOKEN: PLANTED.hub, BUN_BE_BUN: "1" },
  home: "/Users/dev",
  platform: "darwin",
  arch: "arm64",
  now: () => T0,
}

type Script = { version?: RunResult; auth?: RunResult }
const runner = (script: Script = {}) =>
  new FakeRunner((_file, args) => {
    if (args[0] === "--version") return script.version ?? { kind: "exited", code: 0, stdout: "2.1.90 (Claude Code)\n" }
    if (args[0] === "auth") return script.auth ?? { kind: "exited", code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: PLANTED.email, token: PLANTED.oauth }) }
    return { kind: "error", message: "unexpected" }
  })

const good: Omit<ClaudeProbes, "runner"> = {
  binary: () => ({ path: BIN, version: "2.1.90" }),
  spoke: async () => ({ connected: true, harness: "claude-code", evidence: "hooks", features: ["stop", "permission", "deliver"] }),
  conformance: async () => ({ ok: true, detail: "spoke conformance passed" }),
}

const kinds = (v: { probes: readonly { kind: string; ok: boolean }[] }) => Object.fromEntries(v.probes.map((p) => [p.kind, p.ok]))

describe("verifyClaude", () => {
  test("every real probe passes: ready, and only then the capability", async () => {
    const r = runner()
    const v = await verifyClaude({ ...good, runner: r }, ctx)
    expect(kinds(v)).toEqual({ "version-exec": true, "provider-auth": true, "spoke-connected": true })
    expect(v.probes.every((p) => p.observedAt === T0)).toBe(true)
    expect(claudeReadiness(v, T0)).toEqual({ ready: true, capability: "claude-code", problems: [] })
  })

  test("probes are fixed argv against the resolved binary, never a shell", async () => {
    const r = runner()
    await verifyClaude({ ...good, runner: r }, ctx)
    expect(r.calls.map((c) => [c.file, ...c.args])).toEqual([
      [BIN, ...VERSION_ARGV],
      [BIN, ...AUTH_STATUS_ARGV],
    ])
    expect(VERSION_ARGV).toEqual(["--version"])
    expect(AUTH_STATUS_ARGV).toEqual(["auth", "status"])
  })

  test("the version probe runs with a minimal environment and updates switched off", async () => {
    const r = runner()
    await verifyClaude({ ...good, runner: r }, ctx)
    const env = r.calls[0]!.env
    expect(Object.keys(env).sort()).toEqual(["DISABLE_AUTOUPDATER", "DISABLE_UPDATES", "HOME", "PATH"])
    expect(env.DISABLE_AUTOUPDATER).toBe("1")
  })

  test("the login check never gets hub's own credentials or BUN_BE_BUN", async () => {
    const r = runner()
    await verifyClaude({ ...good, runner: r }, ctx)
    const env = r.calls[1]!.env
    expect(env.HUB_TOKEN).toBeUndefined()
    expect(env.BUN_BE_BUN).toBeUndefined()
    expect(env.DISABLE_AUTOUPDATER).toBe("1")
  })

  test("nothing a probe printed, and no credential, reaches the verification", async () => {
    const v = await verifyClaude({ ...good, runner: runner() }, ctx)
    const text = JSON.stringify(v)
    for (const planted of Object.values(PLANTED)) expect(text).not.toContain(planted)
    expect(findSecrets(v)).toEqual([])
    const notLoggedIn = await verifyClaude({ ...good, runner: runner({ auth: { kind: "exited", code: 1, stdout: `{"loggedIn":false,"email":"${PLANTED.email}","x":"${PLANTED.oauth}"}` } }) }, ctx)
    expect(JSON.stringify(notLoggedIn)).not.toContain(PLANTED.email)
    expect(findSecrets(notLoggedIn)).toEqual([])
  })

  test("a binary that does not run, or reports another version, is not ready", async () => {
    for (const version of [{ kind: "not-found" }, { kind: "timeout" }, { kind: "exited", code: 1, stdout: "" }, { kind: "exited", code: 0, stdout: "2.1.85 (Claude Code)\n" }, { kind: "exited", code: 0, stdout: "garbage" }] as RunResult[]) {
      const v = await verifyClaude({ ...good, runner: runner({ version }) }, ctx)
      expect(kinds(v)["version-exec"]).toBe(false)
      expect(claudeReadiness(v, T0)).toMatchObject({ ready: false })
      expect(claudeReadiness(v, T0).capability).toBeUndefined()
    }
  })

  test("without a resolvable binary nothing is run and nothing is ready", async () => {
    const r = runner()
    const v = await verifyClaude({ ...good, binary: () => ({ problem: "claude is a shim into a container" }), runner: r }, ctx)
    expect(r.calls).toEqual([])
    expect(kinds(v)).toMatchObject({ "version-exec": false, "provider-auth": false })
    expect(claudeReadiness(v, T0).problems.join(" ")).toContain("shim")
  })

  test("not logged in is not ready, and says the user logs in themselves", async () => {
    const v = await verifyClaude({ ...good, runner: runner({ auth: { kind: "exited", code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' } }) }, ctx)
    expect(kinds(v)["provider-auth"]).toBe(false)
    expect(v.probes.find((p) => p.kind === "provider-auth")!.detail).toContain("claude auth login")
    const none = await verifyClaude({ ...good, runner: runner({ auth: { kind: "exited", code: 0, stdout: '{"loggedIn":false,"authMethod":"none"}' } }) }, ctx)
    expect(kinds(none)["provider-auth"]).toBe(false)
  })

  test("the spoke must be connected, be the claude-code hooks spoke, and pass conformance", async () => {
    const cases: Partial<ClaudeProbes>[] = [
      { spoke: undefined },
      { conformance: undefined },
      { spoke: async () => ({ connected: false }) },
      { spoke: async () => ({ connected: true, harness: "codex", evidence: "rpc", features: [] }) },
      { spoke: async () => ({ connected: true, harness: "claude-code", evidence: "screen", features: [] }) },
      { conformance: async () => ({ ok: false, detail: "permission round trip failed" }) },
      { spoke: async () => Promise.reject(new Error("socket refused")) },
      { conformance: async () => Promise.reject(new Error("boom")) },
    ]
    for (const patch of cases) {
      const v = await verifyClaude({ ...good, ...patch, runner: runner() }, ctx)
      expect(kinds(v)["spoke-connected"]).toBe(false)
      expect(claudeReadiness(v, T0).ready).toBe(false)
    }
  })

  test("stale probes stop counting", async () => {
    const v = await verifyClaude({ ...good, runner: runner() }, ctx)
    expect(claudeReadiness(v, T0 + 16 * 60_000).ready).toBe(false)
  })
})

describe("claudeVerifyExecutor", () => {
  const action: VerifyHarness = { id: "verify-claude-code", kind: "verify-harness", escalation: "user", summary: "Verify Claude Code", harness: "claude-code", probes: ["version-exec", "provider-auth", "spoke-connected"] }
  const run = async (exec: ReturnType<typeof claudeVerifyExecutor>, a: VerifyHarness = action) => {
    const change = await exec.change(a, {} as never)
    if (!change.ok) return change
    if (change.value.type !== "effect") throw new Error("expected an effect")
    return change.value.perform()
  }

  test("is an external step that passes only when ready, reporting the verification", async () => {
    const seen: unknown[] = []
    const exec = claudeVerifyExecutor({ verify: () => verifyClaude({ ...good, runner: runner() }, ctx), now: () => T0, onVerified: (v) => seen.push(v) })
    expect(exec.plan(action)).toEqual({ class: "external" })
    expect((await run(exec)).ok).toBe(true)
    expect(seen).toHaveLength(1)
  })

  test("not ready fails the step with harness_not_ready", async () => {
    const exec = claudeVerifyExecutor({ verify: () => verifyClaude({ ...good, spoke: undefined, runner: runner() }, ctx), now: () => T0 })
    const r = await run(exec)
    expect(r.ok ? "ok" : r.code).toBe("harness_not_ready")
  })

  test("refuses to verify another harness", async () => {
    const exec = claudeVerifyExecutor({ verify: () => verifyClaude({ ...good, runner: runner() }, ctx), now: () => T0 })
    const check = await exec.check!({ ...action, harness: "codex" }, {} as never)
    expect(check.ok).toBe(false)
  })
})
