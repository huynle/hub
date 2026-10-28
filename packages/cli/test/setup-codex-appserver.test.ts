// Codex readiness against the packages/codex fake app-server (HBS-13 integration item 5): the bootstrap adapter's
// app-server probes (initialize, account/read, account/rateLimits/read) over the same stdio launcher and
// CODEX_APP_SERVER_ARGS the Codex spoke uses. Only the binary's --version and the hub's spoke view are faked.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { isHarnessReady } from "../src/bootstrap/contracts/index.ts"
import { stdioAppServerLauncher, verifyCodex, type ProbeRunner } from "../src/bootstrap/adapters/codex/verify.ts"
import { CODEX_APP_SERVER_ARGS } from "../../codex/src/spoke.ts"

const FAKE = path.join(import.meta.dir, "..", "..", "codex", "test", "fixtures", "fake-app-server.ts")
const runner: ProbeRunner = { run: async () => ({ exitCode: 0, stdout: "codex-cli 0.160.0\n" }) }
const ctx = (env: Record<string, string>) => ({ env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", ...env }, home: "/tmp", platform: process.platform, arch: process.arch, now: Date.now })

describe("Codex readiness against the fake app-server", () => {
  test("CODEX_APP_SERVER_ARGS is the stdio app-server the spoke starts", () => {
    expect([...CODEX_APP_SERVER_ARGS]).toEqual(["app-server", "--listen", "stdio://"])
  })

  test("a ChatGPT login whose live rate-limit read answers, and a connected spoke: ready", async () => {
    const v = await verifyCodex(ctx({}), { runner, appServer: stdioAppServerLauncher({ argsBefore: [FAKE] }), spoke: { codex: async () => ({ connected: true }) }, binary: () => process.execPath, clientVersion: "0.7.1", timeoutMs: 10_000 })
    expect(v.probes.map((p) => [p.kind, p.ok])).toEqual([
      ["version-exec", true],
      ["api-health", true],
      ["provider-auth", true],
      ["spoke-connected", true],
    ])
    expect(isHarnessReady(v, Date.now())).toBe(true)
  }, 20_000)

  test("no login: provider-auth fails with the login hint", async () => {
    const appServer = stdioAppServerLauncher({ argsBefore: [FAKE] })
    const launcher = { start: (binary: string, env: Record<string, string>) => appServer.start(binary, { ...env, FAKE_CODEX_ACCOUNT: "none" }) }
    const v = await verifyCodex(ctx({}), { runner, appServer: launcher, spoke: { codex: async () => ({ connected: true }) }, binary: () => process.execPath, clientVersion: "0.7.1", timeoutMs: 10_000 })
    const auth = v.probes.find((p) => p.kind === "provider-auth")!
    expect(auth.ok).toBe(false)
    expect(auth.detail).toContain("codex login")
  }, 20_000)
})
