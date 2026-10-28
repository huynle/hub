// Codex verification: readiness only from real, injectable probes (the binary runs, its app-server starts and
// answers, its provider account is ready with a live request, the hub sees its spoke), each fresh and passing.
// Detection never counts; authentication stays with the user (hub asks the app-server, never reads ~/.codex).
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findSecrets, isHarnessReady, PROBE_MAX_AGE_MS, type AdapterContext, type HarnessVerification, type VerifyHarness } from "../src/bootstrap/contracts/index.ts"
import {
  codexBinaryPath,
  codexCapabilities,
  codexVerifyExecutor,
  nodeProbeRunner,
  probeEnv,
  stdioAppServerLauncher,
  verifyCodex,
  type AppServerLauncher,
  type CodexProbes,
  type ProbeRunner,
} from "../src/bootstrap/adapters/codex/verify.ts"
import { CHATGPT_HANDLERS, CODEX_DISCOVERY_LINUX, codexDiscoveredAt, fakeAppServerChannel, type RpcHandler } from "./bootstrap/codex-fixtures.ts"
import { T0 } from "./bootstrap/fixtures.ts"

const BIN = "/home/dev/.local/share/hub/harnesses/codex/current/bin/codex"
const ctx: AdapterContext = { env: { PATH: "/usr/bin:/bin", HOME: "/home/dev", HUB_TOKEN: "mt_secret_should_not_leak", OPENAI_API_KEY: "sk-test-should-not-leak" }, home: "/home/dev", platform: "linux", arch: "x64", now: () => T0 }

interface Doubles {
  runs: { argv: readonly string[]; env: Record<string, string> }[]
  started: { binary: string; env: Record<string, string> }[]
  stopped: number
  rpc?: ReturnType<typeof fakeAppServerChannel>
}

function probes(o: { version?: { exitCode: number | null; stdout: string; error?: string }; handlers?: Record<string, RpcHandler>; launch?: "fail"; spoke?: boolean; extra?: Partial<CodexProbes> } = {}) {
  const d: Doubles = { runs: [], started: [], stopped: 0 }
  const runner: ProbeRunner = { run: async (argv, options) => (d.runs.push({ argv, env: options.env }), o.version ?? { exitCode: 0, stdout: "codex-cli 0.165.0\n" }) }
  const appServer: AppServerLauncher = {
    start: (binary, env) => {
      d.started.push({ binary, env })
      if (o.launch === "fail") throw new Error("spawn ENOENT")
      d.rpc = fakeAppServerChannel(o.handlers ?? CHATGPT_HANDLERS)
      return { channel: d.rpc.channel, stop: () => (d.stopped++, d.rpc!.channel.close()) }
    },
  }
  const p: CodexProbes = { runner, appServer, spoke: { codex: async () => ({ connected: o.spoke ?? true }) }, binary: () => BIN, clientVersion: "0.8.0", expectedVersion: "0.165.0", timeoutMs: 2000, ...o.extra }
  return { p, d }
}
const kindsOk = (v: HarnessVerification) => Object.fromEntries(v.probes.map((p) => [p.kind, p.ok]))

describe("verifyCodex", () => {
  test("all real probes pass: ready, and advertised as such", async () => {
    const { p, d } = probes()
    const v = await verifyCodex(ctx, p)
    expect(v.harness).toBe("codex")
    expect(kindsOk(v)).toEqual({ "version-exec": true, "api-health": true, "provider-auth": true, "spoke-connected": true })
    expect(isHarnessReady(v, T0)).toBe(true)
    expect(codexCapabilities(v, T0)).toEqual({ harness: "codex", ready: true, version: "0.165.0", appServer: true, provider: "chatgpt", spoke: true, observedAt: T0 })
    // Fixed argv, against the resolved binary; the app-server from the same binary; a live provider request.
    expect(d.runs.map((r) => r.argv)).toEqual([[BIN, "--version"]])
    expect(d.started.map((s) => s.binary)).toEqual([BIN])
    expect(d.rpc!.calls.map((c) => c.method)).toEqual(["initialize", "account/read", "account/rateLimits/read"])
    expect(d.rpc!.calls[1]!.params).toEqual({ refreshToken: true })
    expect(d.stopped).toBe(1)
  })

  test("probes get a minimal environment: no hub token, no provider key", async () => {
    const { p, d } = probes()
    await verifyCodex(ctx, p)
    for (const env of [...d.runs.map((r) => r.env), ...d.started.map((s) => s.env)]) expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/dev" })
    expect(probeEnv({ PATH: "/p", HOME: "/h", CODEX_HOME: "/c", HUB_TOKEN: "x", LANG: "C" })).toEqual({ PATH: "/p", HOME: "/h", CODEX_HOME: "/c", LANG: "C" })
  })

  test("no account details, emails or secrets reach the probes", async () => {
    const { p } = probes({ handlers: { ...CHATGPT_HANDLERS, "account/rateLimits/read": () => ({ error: { code: -32000, message: "token sk-live-abcdefghijklmnopqrstuvwx rejected for dev@example.com" } }) } })
    const v = await verifyCodex(ctx, p)
    const text = JSON.stringify(v)
    expect(text).not.toContain("dev@example.com")
    expect(text).not.toContain("sk-live")
    expect(findSecrets(v)).toEqual([])
    expect(kindsOk(v)["provider-auth"]).toBe(false)
  })

  const notReady: Record<string, { o: Parameters<typeof probes>[0]; failing: string[] }> = {
    binaryFails: { o: { version: { exitCode: null, stdout: "", error: "spawn ENOENT" } }, failing: ["version-exec", "api-health", "provider-auth"] },
    binaryExitsNonZero: { o: { version: { exitCode: 1, stdout: "" } }, failing: ["version-exec", "api-health", "provider-auth"] },
    otherVersion: { o: { version: { exitCode: 0, stdout: "codex-cli 0.160.0" } }, failing: ["version-exec"] },
    appServerDoesNotStart: { o: { launch: "fail" }, failing: ["api-health", "provider-auth"] },
    appServerRefusesInitialize: { o: { handlers: { ...CHATGPT_HANDLERS, initialize: () => ({ error: { code: -32600, message: "nope" } }) } }, failing: ["api-health", "provider-auth"] },
    notLoggedIn: { o: { handlers: { ...CHATGPT_HANDLERS, "account/read": () => ({ account: null, requiresOpenaiAuth: true }) } }, failing: ["provider-auth"] },
    providerRequestFails: { o: { handlers: { ...CHATGPT_HANDLERS, "account/rateLimits/read": () => ({ error: { code: -32000, message: "401" } }) } }, failing: ["provider-auth"] },
    apiKeyWithoutLiveCheck: { o: { handlers: { ...CHATGPT_HANDLERS, "account/read": () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true }) } }, failing: ["provider-auth"] },
    spokeNotConnected: { o: { spoke: false }, failing: ["spoke-connected"] },
  }
  for (const [label, { o, failing }] of Object.entries(notReady))
    test(`probe failure gives not-ready: ${label}`, async () => {
      const { p, d } = probes(o)
      const v = await verifyCodex(ctx, p)
      expect(v.probes.filter((x) => !x.ok).map((x): string => x.kind).sort()).toEqual([...failing].sort())
      for (const x of v.probes.filter((x) => !x.ok)) expect(x.detail).toBeString()
      expect(isHarnessReady(v, T0) && codexCapabilities(v, T0).ready).toBe(false)
      expect(codexCapabilities(v, T0).ready).toBe(false)
      expect(d.stopped).toBe(d.started.length - (o?.launch === "fail" ? 1 : 0))
    })

  test("not logged in tells the user to log in on the machine (user-mediated auth)", async () => {
    const { p } = probes({ handlers: { ...CHATGPT_HANDLERS, "account/read": () => ({ account: null, requiresOpenaiAuth: true }) } })
    const v = await verifyCodex(ctx, p)
    expect(v.probes.find((x) => x.kind === "provider-auth")!.detail).toContain("codex login")
  })

  test("an injected provider probe can supply the live check for other account types", async () => {
    const { p } = probes({ handlers: { ...CHATGPT_HANDLERS, "account/read": () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true }) }, extra: { providerProbe: async (account) => ({ ok: account.type === "apiKey", detail: "bounded turn answered" }) } })
    const v = await verifyCodex(ctx, p)
    expect(isHarnessReady(v, T0)).toBe(true)
    expect(codexCapabilities(v, T0).provider).toBe("apiKey")
  })

  test("no binary to run: every probe fails, nothing is spawned", async () => {
    const { p, d } = probes({ extra: { binary: () => undefined } })
    const v = await verifyCodex(ctx, p)
    expect(v.probes.every((x) => !x.ok)).toBe(true)
    expect(d.runs).toEqual([])
    expect(d.started).toEqual([])
  })

  test("readiness expires with its probes, and the advertisement only names passing capabilities", async () => {
    const { p } = probes({ spoke: false })
    const v = await verifyCodex(ctx, p)
    expect(codexCapabilities(v, T0)).toEqual({ harness: "codex", ready: false, version: "0.165.0", appServer: true, provider: "chatgpt", spoke: false, observedAt: T0 })
    const good = await verifyCodex(ctx, probes().p)
    expect(codexCapabilities(good, T0 + PROBE_MAX_AGE_MS + 1).ready).toBe(false)
  })
})

describe("codexBinaryPath", () => {
  test("prefers hub's current version, else the binary a shim resolves to, else the discovered path", () => {
    expect(codexBinaryPath(CODEX_DISCOVERY_LINUX, { preferHub: true })).toBe(BIN)
    expect(codexBinaryPath(CODEX_DISCOVERY_LINUX, { preferHub: false })).toBeUndefined()
    const shimmed = {
      ...CODEX_DISCOVERY_LINUX,
      topology: { container: "none" as const, shims: [{ name: "codex", path: "/usr/local/bin/codex", kind: "wrapper" as const, resolvesTo: "/opt/codex/bin/codex" }] },
      harnesses: CODEX_DISCOVERY_LINUX.harnesses.map((h) => (h.id === "codex" ? { ...h, installed: true, path: "/usr/local/bin/codex", installMethod: "unknown" as const } : h)),
    }
    expect(codexBinaryPath(shimmed, { preferHub: false })).toBe("/opt/codex/bin/codex")
    expect(codexBinaryPath(codexDiscoveredAt("0.160.0"), { preferHub: false })).toBe(BIN)
  })
})

describe("codexVerifyExecutor", () => {
  const action: VerifyHarness = { id: "verify-codex", kind: "verify-harness", escalation: "user", summary: "Verify Codex", harness: "codex", probes: ["version-exec", "api-health", "provider-auth", "spoke-connected"] }
  const run = async (verify: () => Promise<HarnessVerification>, a: VerifyHarness = action) => {
    const ex = codexVerifyExecutor({ verify, context: () => ctx })
    expect(ex.plan(a)).toEqual({ class: "external" })
    const change = await ex.change(a, {} as never)
    if (!change.ok || change.value.type !== "effect") return change
    return change.value.perform()
  }
  test("ready → done; not ready → harness_not_ready naming the failing probes; another harness → refused", async () => {
    expect((await run(() => verifyCodex(ctx, probes().p))).ok).toBe(true)
    const r = await run(() => verifyCodex(ctx, probes({ spoke: false }).p))
    expect(!r.ok && r.code).toBe("harness_not_ready")
    expect(!r.ok && r.message).toContain("spoke-connected")
    const other = await run(() => verifyCodex(ctx, probes().p), { ...action, harness: "opencode" })
    expect(other.ok).toBe(false)
  })
})

describe("real fixed-argv probes", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hub-codex-verify-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const fakeServer = join(import.meta.dir, "../../codex/test/fixtures/fake-app-server.ts")

  test("nodeProbeRunner runs a word list (no shell) and reports exit and output", async () => {
    const script = join(dir, "codex")
    writeFileSync(script, '#!/bin/sh\necho "codex-cli 0.165.0 $1"\n')
    chmodSync(script, 0o755)
    const r = await nodeProbeRunner.run([script, "--version; echo injected"], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5000 })
    expect(r).toMatchObject({ exitCode: 0, stdout: "codex-cli 0.165.0 --version; echo injected\n" })
    const missing = await nodeProbeRunner.run([join(dir, "nope"), "--version"], { env: {}, timeoutMs: 5000 })
    expect(missing.exitCode).toBeNull()
  })

  test("the stdio launcher starts the app-server; a server with no login is not ready", async () => {
    const stdio = stdioAppServerLauncher({ argsBefore: [fakeServer] })
    const launcher = { start: (binary: string, env: Record<string, string>) => stdio.start(binary, { ...env, FAKE_CODEX_ACCOUNT: "none" }) }
    const { p } = probes()
    const v = await verifyCodex(ctx, { ...p, binary: () => process.execPath, appServer: launcher, runner: { run: async () => ({ exitCode: 0, stdout: "codex-cli 0.165.0" }) } })
    expect(kindsOk(v)).toMatchObject({ "api-health": true, "provider-auth": false })
    expect(isHarnessReady(v, T0)).toBe(false)
  })
})
