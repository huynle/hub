// HBS-06: OpenCode readiness is real probes (contract §3.10, T14). The binary the PATH entry resolves to (never the
// shim) runs with a fixed argv through an injected runner (no shell); a harmless provider/model listing must answer;
// the hub must see the spoke. Any failure, a missing probe, a container shim, an OpenCode 1.x, or install alone is
// not ready. Probe details are one line, never the harness's raw output, never a credential.
import { describe, expect, test } from "bun:test"
import { isHarnessReady, type AdapterContext } from "../src/bootstrap/contracts/index.ts"
import { locateOpencodeBinary, OPENCODE_PROBE_ARGV, verifyOpencode, type ProcessRequest, type ProcessRunner } from "../src/bootstrap/adapters/opencode/verify.ts"
import { MAC_HOME, MAC_NATIVE, MAC_NO_HARNESS, exe, link, memoryProbe, MACHO, LINUX_CONTAINER_SHIM, type HostSpec } from "./bootstrap/discovery-fixtures.ts"
import { T0 } from "./bootstrap/fixtures.ts"

const context = (now = T0): AdapterContext => ({ env: { HOME: MAC_HOME, PATH: "/usr/bin:/bin", OPENAI_API_KEY: "placeholder-not-a-key" }, home: MAC_HOME, platform: "darwin", arch: "arm64", now: () => now })

/** A fake runner: answers by argv, records every request. */
function fakeRunner(answers: Record<string, { exitCode: number | null; stdout?: string; timedOut?: boolean } | Error>): ProcessRunner & { calls: ProcessRequest[] } {
  const calls: ProcessRequest[] = []
  return {
    calls,
    async run(request) {
      calls.push(request)
      const answer = answers[request.argv.join(" ")]
      if (!answer) return { exitCode: 127, stdout: "", timedOut: false }
      if (answer instanceof Error) throw answer
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", timedOut: answer.timedOut ?? false }
    },
  }
}

const HEALTHY = { "--version": { exitCode: 0, stdout: "opencode v2.2.0\n" }, models: { exitCode: 0, stdout: "anthropic/claude-sonnet-4-5\nopenai/gpt-5\n" } }
const connected = { connected: async () => ({ ok: true, detail: "spoke online" }) }
const BIN = `${MAC_HOME}/.opencode/bin/opencode`

describe("verifyOpencode", () => {
  test("ready: version, provider and spoke probes all pass, fresh", async () => {
    const runner = fakeRunner(HEALTHY)
    const v = await verifyOpencode(context(), { runner, binary: BIN, spoke: connected })
    expect(v.harness).toBe("opencode")
    expect(v.probes.map((p) => [p.kind, p.ok])).toEqual([
      ["version-exec", true],
      ["provider-auth", true],
      ["spoke-connected", true],
    ])
    expect(v.probes[0]!.detail).toBe("opencode 2.2.0")
    expect(v.probes[1]!.detail).toBe("2 models from 2 providers")
    expect(isHarnessReady(v, T0)).toBe(true)
  })

  test("argv is fixed and absolute, env is the user's own, never a shell", async () => {
    const runner = fakeRunner(HEALTHY)
    await verifyOpencode(context(), { runner, binary: BIN, spoke: connected })
    expect(OPENCODE_PROBE_ARGV).toEqual({ version: ["--version"], models: ["models"] })
    expect(runner.calls.map((c) => [c.file, ...c.argv])).toEqual([
      [BIN, "--version"],
      [BIN, "models"],
    ])
    for (const c of runner.calls) {
      expect(c.timeoutMs).toBeGreaterThan(0)
      expect(c.maxOutputBytes).toBeGreaterThan(0)
      expect(c.env.OPENAI_API_KEY).toBe("placeholder-not-a-key")
    }
  })

  test("not ready: each failing probe on its own", async () => {
    const cases: [Record<string, { exitCode: number | null; stdout?: string; timedOut?: boolean } | Error>, typeof connected | undefined, string][] = [
      [{ ...HEALTHY, "--version": { exitCode: 1 } }, connected, "version-exec"],
      [{ ...HEALTHY, "--version": { exitCode: 0, stdout: "opencode v1.19.5" } }, connected, "version-exec"],
      [{ ...HEALTHY, "--version": new Error("spawn EACCES") }, connected, "version-exec"],
      [{ ...HEALTHY, models: { exitCode: 0, stdout: "" } }, connected, "provider-auth"],
      [{ ...HEALTHY, models: { exitCode: null, timedOut: true } }, connected, "provider-auth"],
      [{ ...HEALTHY, models: { exitCode: 1, stdout: "Error: no providers" } }, connected, "provider-auth"],
      [HEALTHY, { connected: async () => ({ ok: false, detail: "no spoke for this machine" }) }, "spoke-connected"],
      [HEALTHY, { connected: async () => Promise.reject(new Error("offline")) }, "spoke-connected"],
      [HEALTHY, undefined, "spoke-connected"],
    ]
    for (const [answers, spoke, failing] of cases) {
      const v = await verifyOpencode(context(), { runner: fakeRunner(answers), binary: BIN, ...(spoke ? { spoke } : {}) })
      expect(v.probes.filter((p) => !p.ok).map((p) => p.kind as string)).toEqual([failing])
      expect(isHarnessReady(v, T0)).toBe(false)
    }
  })

  // HBS-12 acceptance (E2): on a cold start OpenCode's background service can take longer than the CLI's ~5 s to
  // activate its plugins, so the first `opencode models` fails with HTTP 503 "Location plugins did not finish
  // activating". That one failure is retried once; any other failure is not.
  const COLD = { exitCode: 1, stdout: "", stderr: "Error: Location plugins did not finish activating (HTTP 503)\n" }
  function sequence(answers: Record<string, Array<{ exitCode: number | null; stdout?: string; stderr?: string }>>): ProcessRunner & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      async run(request) {
        const key = request.argv.join(" ")
        calls.push(key)
        const next = answers[key]!.shift()!
        return { exitCode: next.exitCode, stdout: next.stdout ?? "", stderr: next.stderr ?? "", timedOut: false }
      },
    }
  }

  test("a cold-start activation failure (503) is retried once, then passes", async () => {
    const runner = sequence({ "--version": [{ exitCode: 0, stdout: "opencode v2.2.0" }], models: [COLD, { exitCode: 0, stdout: "anthropic/claude-sonnet-4-5\n" }] })
    const v = await verifyOpencode(context(), { runner, binary: BIN, spoke: connected, activationRetryDelayMs: 0 })
    expect(runner.calls).toEqual(["--version", "models", "models"])
    expect(v.probes.map((p) => p.ok)).toEqual([true, true, true])
  })

  test("the version probe is retried the same way", async () => {
    const runner = sequence({ "--version": [COLD, { exitCode: 0, stdout: "opencode v2.2.0" }], models: [{ exitCode: 0, stdout: "anthropic/claude-sonnet-4-5\n" }] })
    const v = await verifyOpencode(context(), { runner, binary: BIN, spoke: connected, activationRetryDelayMs: 0 })
    expect(runner.calls).toEqual(["--version", "--version", "models"])
    expect(v.probes[0]!.ok).toBe(true)
  })

  test("only once, and only for the activation failure", async () => {
    const twice = sequence({ "--version": [{ exitCode: 0, stdout: "opencode v2.2.0" }], models: [COLD, COLD] })
    const v = await verifyOpencode(context(), { runner: twice, binary: BIN, spoke: connected, activationRetryDelayMs: 0 })
    expect(twice.calls).toEqual(["--version", "models", "models"])
    expect(v.probes[1]).toMatchObject({ kind: "provider-auth", ok: false })
    expect(v.probes[1]!.detail).toContain("did not finish activating")

    const loggedOut = sequence({ "--version": [{ exitCode: 0, stdout: "opencode v2.2.0" }], models: [{ exitCode: 1, stderr: "no providers" }] })
    await verifyOpencode(context(), { runner: loggedOut, binary: BIN, spoke: connected, activationRetryDelayMs: 0 })
    expect(loggedOut.calls).toEqual(["--version", "models"])
  })

  test("an expected (pinned) version must be the one that runs", async () => {
    const v = await verifyOpencode(context(), { runner: fakeRunner(HEALTHY), binary: BIN, spoke: connected, expectVersion: "2.1.0" })
    expect(v.probes[0]).toMatchObject({ kind: "version-exec", ok: false })
  })

  test("no binary: every probe fails, and nothing is run", async () => {
    const runner = fakeRunner(HEALTHY)
    const v = await verifyOpencode(context(), { runner, binary: undefined, spoke: connected })
    expect(v.probes.every((p) => !p.ok)).toBe(true)
    expect(runner.calls).toEqual([])
  })

  test("details never carry raw output or a credential", async () => {
    const leaky = { "--version": { exitCode: 0, stdout: "opencode v2.2.0 sk-live-abcdefghijklmnopqrstuvwx" }, models: { exitCode: 1, stdout: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" } }
    const v = await verifyOpencode(context(), { runner: fakeRunner(leaky), binary: BIN, spoke: { connected: async () => ({ ok: false, detail: "token hat_abcdefghijklmnopqrstuvwxyz rejected" }) } })
    const all = JSON.stringify(v)
    expect(all).not.toContain("sk-live")
    expect(all).not.toContain("Bearer")
    expect(all).not.toContain("hat_")
  })

  test("stale probes stop counting", async () => {
    const v = await verifyOpencode(context(T0), { runner: fakeRunner(HEALTHY), binary: BIN, spoke: connected })
    expect(isHarnessReady(v, T0 + 16 * 60_000)).toBe(false)
  })
})

describe("locateOpencodeBinary", () => {
  test("a native install: the binary on PATH", () => {
    expect(locateOpencodeBinary(memoryProbe(MAC_NATIVE))).toEqual({ ok: true, value: BIN })
  })

  test("hub's current version wins, resolved through the current link to its version directory", () => {
    const spec: HostSpec = {
      ...MAC_NO_HARNESS,
      files: {
        ...MAC_NO_HARNESS.files,
        [`${MAC_HOME}/.local/share/hub/harnesses/opencode/2.2.0/bin/opencode`]: exe(MACHO),
        [`${MAC_HOME}/.local/share/hub/harnesses/opencode/current`]: link("2.2.0"),
      },
    }
    expect(locateOpencodeBinary(memoryProbe(spec))).toEqual({ ok: true, value: `${MAC_HOME}/.local/share/hub/harnesses/opencode/2.2.0/bin/opencode` })
  })

  test("a link on PATH resolves to what it points at; a container shim is refused (it would not test this host)", () => {
    const spec: HostSpec = {
      ...MAC_NO_HARNESS,
      env: { ...MAC_NO_HARNESS.env, PATH: `${MAC_HOME}/bin:/usr/bin:/bin` },
      files: { ...MAC_NO_HARNESS.files, [`${MAC_HOME}/bin/opencode`]: link(`${MAC_HOME}/apps/opencode/opencode`), [`${MAC_HOME}/apps/opencode/opencode`]: exe(MACHO) },
    }
    expect(locateOpencodeBinary(memoryProbe(spec))).toEqual({ ok: true, value: `${MAC_HOME}/apps/opencode/opencode` })
    const shim = locateOpencodeBinary(memoryProbe(LINUX_CONTAINER_SHIM))
    expect(shim.ok).toBe(false)
    expect(locateOpencodeBinary(memoryProbe(MAC_NO_HARNESS)).ok).toBe(false)
  })
})
