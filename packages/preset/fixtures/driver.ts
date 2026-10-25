#!/usr/bin/env bun
// The preset spoke's conformance driver (testkit driver protocol): a preset for the fake terminal harness
// (fake-tui.ts) run by the preset spoke in a real tmux on a private socket (-L hub-cf-<random>, -f /dev/null), never
// the user's tmux server. The server is killed on stop.
//
//   hub-conformance spoke --driver "bun packages/preset/fixtures/driver.ts"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import path from "node:path"
import type { HarnessPreset } from "../../protocol/src/index.ts"
import { DRIVER_PROTOCOL_VERSION, DriverError, serveDriver, type DriverStart, type LocalAction } from "../../testkit/src/index.ts"
import { PresetSpoke } from "../src/spoke.ts"
import { tmuxBackend, tmuxRunner, type TerminalBackend } from "../src/tmux.ts"

export const FAKE_TUI_PRESET: HarnessPreset = {
  name: "preset-fake-tui",
  description: "The preset spoke's test harness",
  command: [process.execPath, path.join(import.meta.dir, "fake-tui.ts")],
  nativeID: { source: "screen", pattern: "fake-tui session ([0-9a-f]+)" },
  delivery: "paste",
  evidence: "screen",
}

const socket = `hub-cf-${randomBytes(4).toString("hex")}`
const log = (line: string) => process.stderr.write(`[preset driver] ${line}\n`)
const backendFor = (env: NodeJS.ProcessEnv) => tmuxBackend({ socket, config: "/dev/null", run: tmuxRunner("tmux", env) })
const spokeFor = (backend: TerminalBackend, hubURL: string, token: string, directory: string) =>
  new PresetSpoke({ preset: FAKE_TUI_PRESET, backend, server: hubURL, token, pluginVersion: "0.0.1", directory, sampleMs: 300, log })

let running: { spoke: PresetSpoke; backend: TerminalBackend } | undefined
const started = () => {
  if (!running) throw new DriverError("not_started", "call start first")
  return running
}
const paneOf = (sessionID: string) => {
  const pane = started().spoke.pane(sessionID)
  if (!pane) throw new DriverError("failed", `no pane for ${sessionID}`)
  return pane
}
/** Kills the private server and removes its socket file (tmux leaves it behind). */
function killServer(): void {
  const where = spawnSync("tmux", ["-L", socket, "display-message", "-p", "#{socket_path}"], { encoding: "utf8" }).stdout?.trim()
  spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" })
  // tmux's own default when the server is already gone: $TMUX_TMPDIR or /tmp, then tmux-<uid>/<socket>.
  rmSync(where || `${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid?.() ?? 0}/${socket}`, { force: true })
}

serveDriver({
  describe: () => ({
    protocol: DRIVER_PROTOCOL_VERSION,
    harness: FAKE_TUI_PRESET.name,
    harnessVersion: "",
    evidence: "screen",
    features: [...spokeFor(backendFor(process.env), "http://127.0.0.1:1", "unused", "/").spoke.features],
    models: ["chat"],
  }),
  start(params: DriverStart) {
    if (running) throw new DriverError("started", "already started")
    const backend = backendFor({ ...process.env, ...params.env })
    const spoke = spokeFor(backend, params.hubURL, params.token, params.directory)
    spoke.start()
    running = { spoke, backend }
    return {}
  },
  async createSession(params) {
    const { spoke } = started()
    const launched = await spoke.launch({ cwd: params?.directory ?? process.cwd() })
    log(`session ${launched.sessionID} in ${launched.pane.target} (${launched.attach})`)
    return { sessionID: launched.sessionID }
  },
  async prompt(params) {
    await started().backend.paste(paneOf(params.sessionID), params.text, { submit: true })
    return {}
  },
  async local(params: { sessionID: string; action: LocalAction }) {
    const { backend } = started()
    if (params.action === "interrupt") await backend.interrupt(paneOf(params.sessionID))
    else if (params.action === "exit") await backend.kill(paneOf(params.sessionID))
    else throw new DriverError("unsupported", `a preset harness has no ${params.action} (no permission dialogs)`)
    return {}
  },
  stop() {
    running?.spoke.stop()
    killServer()
    return {}
  },
  shutdown() {
    running?.spoke.stop()
    killServer()
  },
})
