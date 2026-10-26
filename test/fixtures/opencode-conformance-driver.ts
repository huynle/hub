#!/usr/bin/env bun
// The OpenCode spoke's conformance driver (testkit driver protocol): the REAL OpenCode spoke (src/spoke/spoke.ts, the
// plugin's Spoke class, with its SpokeConnection) over a fake OpenCode host (fake-opencode.ts) that asks the suite's
// stub model (OpenAI chat completions). `start` writes the spoke's machine config (the hub URL and machine token, mode
// always, no local hub, no Herdr) in the suite's isolated HOME and starts the spoke; a session is one the local user
// opens; a prompt is typed in the TUI; every tool call the model makes asks permission (permissionToolCall).
// No real OpenCode runs: the host is what the plugin context would give the spoke.
//
//   hub-conformance spoke --driver "bun test/fixtures/opencode-conformance-driver.ts"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { DRIVER_PROTOCOL_VERSION, DriverError, serveDriver, type DriverStart } from "../../packages/testkit/src/index.ts"
import { defaults, writeConfig } from "../../src/config"
import { SPOKE_FEATURES } from "../../src/protocol"
import { Spoke } from "../../src/spoke/spoke"
import { FakeOpenCode } from "./fake-opencode"

const VERSION = "2.0.26"
let running: { spoke: Spoke; host: FakeOpenCode } | undefined
const started = () => {
  if (!running) throw new DriverError("not_started", "call start first")
  return running
}

process.stdout.write("opencode conformance driver (real Spoke, fake OpenCode host) ready\n")
serveDriver({
  describe: () => ({ protocol: DRIVER_PROTOCOL_VERSION, harness: "opencode", harnessVersion: VERSION, evidence: "native", features: [...SPOKE_FEATURES], models: ["chat"] }),
  start(params: DriverStart) {
    if (running) throw new DriverError("started", "already started")
    if (params.model.format !== "chat") throw new DriverError("unsupported", `model format ${params.model.format}`)
    const home = params.env.HOME ?? params.directory
    const configFile = path.join(home, ".config", "hub", "config.json")
    mkdirSync(path.dirname(configFile), { recursive: true })
    writeConfig(configFile, { ...defaults("conformance"), server: params.hubURL, mode: "always", token: params.token, autoStartLocalHub: false, herdr: false })
    const host = new FakeOpenCode({ directory: params.directory, version: VERSION, modelBaseURL: params.model.baseURL })
    const spoke = new Spoke(host.host, {
      configFile,
      machineName: "conformance",
      kind: "standalone",
      processID: `proc_conformance${process.pid}`,
      pid: process.pid,
      pluginVersion: "0.6.1",
      snapshotDebounceMs: 10,
      seedDebounceMs: 10,
      turnTimeoutMs: 20_000,
      backoff: { minMs: 100, maxMs: 1000 },
    })
    spoke.start()
    running = { spoke, host }
    return {}
  },
  createSession: (params) => ({ sessionID: started().host.createSession(params?.directory ? { directory: params.directory } : {}) }),
  prompt: (params) => (started().host.type(params.sessionID, params.text), {}),
  async local(params) {
    const { host } = started()
    if (params.action === "interrupt") await host.host.interrupt(params.sessionID)
    else throw new DriverError("unsupported", `local ${params.action}`)
    return {}
  },
  permissionToolCall: () => ({ name: "bash", input: { command: "echo conformance" } }),
  stop: () => (running?.spoke.stop(), (running = undefined), {}),
  shutdown: () => running?.spoke.stop(),
})
