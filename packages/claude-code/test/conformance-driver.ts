#!/usr/bin/env bun
// The Claude Code spoke's conformance driver (testkit driver protocol) over the fake claude (fake-claude.ts), never
// the real one: `start` runs the real per-user daemon with launches on (workspace roots: the suite's project), a
// session is a hub launch create (the daemon starts the fake headless there), a prompt is a hub turn (the fake runs
// its hooks through the real bridge), and the local interrupt is an interrupt op. The fake calls no model, so there
// is no permissionToolCall (the permission check is skipped).
//
//   bun packages/claude-code/test/conformance-driver.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DRIVER_PROTOCOL_VERSION, DriverError, serveDriver, type DriverStart } from "../../testkit/src/index.ts"
import { startDaemon, type ClaudeDaemon } from "../src/daemon.ts"
import { fakeClaude } from "./fake-claude.ts"

/** What the daemon announces with launches on. */
const FEATURES = ["stop", "permission", "create", "turn", "interrupt", "deliver", "sessionTokens", "actTokens", "permissionMessage", "hubPrompt", "launch"]

let daemon: ClaudeDaemon | undefined
let project = ""
const running = () => {
  if (!daemon) throw new DriverError("not_started", "call start first")
  return daemon
}

process.stdout.write("claude-code conformance driver (fake claude) ready\n")
serveDriver({
  describe: () => ({ protocol: DRIVER_PROTOCOL_VERSION, harness: "claude-code", harnessVersion: "2.1.296", evidence: "hooks", features: FEATURES, models: ["anthropic"] }),
  async start(params: DriverStart) {
    if (daemon) throw new DriverError("started", "already started")
    project = params.directory
    const fake = fakeClaude()
    daemon = await startDaemon({
      socketPath: path.join(mkdtempSync(path.join(tmpdir(), "hcc-")), "d.sock"),
      server: params.hubURL,
      token: params.token,
      harnessVersion: "2.1.296",
      pluginVersion: "0.6.1",
      directory: params.directory,
      tokenWaitMs: 200,
      launch: { bin: fake.bin, pluginDir: () => "/plugins/conformance", roots: () => [params.directory], env: { PATH: process.env.PATH ?? "", ...params.env } },
      log: (line) => process.stderr.write(`${line}\n`),
    })
    return {}
  },
  async createSession(params) {
    const result = (await running().spoke.dispatch({ op: "create", directory: params?.directory ?? project })) as { sessionID: string }
    return { sessionID: result.sessionID }
  },
  prompt(params) {
    void running()
      .spoke.dispatch({ op: "turn", sessionID: params.sessionID, text: params.text, voiceStyle: false })
      .catch(() => undefined)
    return {}
  },
  async local(params) {
    if (params.action !== "interrupt") throw new DriverError("unsupported", `local ${params.action}`)
    await running().spoke.dispatch({ op: "interrupt", sessionID: params.sessionID })
    return {}
  },
  async stop() {
    await daemon?.stop()
    daemon = undefined
    return {}
  },
  async shutdown() {
    await daemon?.stop()
  },
})
