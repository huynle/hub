// `hub claude-code install | uninstall | status` and `hub codex-spoke install | uninstall | status`: the harness
// spokes' per-user services (`hub claude-code daemon`, `hub codex-spoke serve`) as a launchd agent (macOS) or a
// systemd user unit (Linux), written from the templates in scripts/ the way `hub node install` writes the node's
// (node.ts). `hub claude` and `hub codex` start these processes on demand; installed, they keep running, so the hub
// can place claude-code and codex launches on the machine without a wrapper run first. Like `hub node install`,
// nothing here starts a process: loading, unloading and inspecting the service are printed for the user, never run.
import { findExecutable } from "../../node/src/harnesses.ts"
import { readSpokeCredentials } from "../../node/src/config.ts"
import { socketPath } from "../../claude-code/src/paths.ts"
import { daemonSocketPath, readServicePid } from "../../codex/src/paths.ts"
import type { Env } from "./credentials"
import { installService, serviceCheckLines, serviceState, serviceStateLine, uninstallService, type NodeCommandOutput, type NodeIo, type ServiceSpec, type ServiceState } from "./node"

/** The subcommands `hub claude-code` and `hub codex-spoke` take for their service (the others are the spokes' own). */
export const SERVICE_VERBS = ["install", "uninstall", "status"] as const
export type ServiceVerb = (typeof SERVICE_VERBS)[number]
export const isServiceVerb = (verb: string | undefined): verb is ServiceVerb => (SERVICE_VERBS as readonly string[]).includes(verb ?? "")

/** Where config.json and the hub state dir are (shared by every hub spoke). */
const HUB_PLACES = ["HUB_SPOKE_CONFIG", "XDG_CONFIG_HOME", "HUB_STATE_DIR"] as const

export const CLAUDE_CODE_SERVICE: ServiceSpec = {
  command: "hub claude-code",
  label: "io.github.huynle.hub-claude-code",
  unit: "hub-claude-code.service",
  log: "claude-code.log",
  // The hooks find the daemon by HUB_CLAUDE_SOCKET / HUB_STATE_DIR: the service must listen where they look.
  carried: [...HUB_PLACES, "HUB_CLAUDE_SOCKET", "HUB_CLAUDE_BIN"],
  elsewhere: "Run `hub claude-code daemon` under your own service manager (or let `hub claude` start it)",
}

export const CODEX_SPOKE_SERVICE: ServiceSpec = {
  command: "hub codex-spoke",
  label: "io.github.huynle.hub-codex-spoke",
  unit: "hub-codex-spoke.service",
  log: "codex-spoke.log",
  // HUB_CODEX_CONFIG (one override per line) is not carried: a unit's Environment= cannot hold several lines.
  carried: [...HUB_PLACES, "CODEX_HOME", "HUB_CODEX_BIN", "HUB_CODEX_DAEMON_SOCKET"],
  elsewhere: "Run `hub codex-spoke serve` under your own service manager (or let `hub codex` start it)",
}

const SPECS = { "claude-code": CLAUDE_CODE_SERVICE, "codex-spoke": CODEX_SPOKE_SERVICE } as const
export type SpokeServiceName = keyof typeof SPECS
export const spokeServiceSpec = (name: SpokeServiceName): ServiceSpec => SPECS[name]

/** Why the installed service would not do anything yet (never the token). */
function readiness(env: Env, home: string): string[] {
  return readSpokeCredentials(env, home) ? [] : ["this machine is not enrolled with a hub yet (no machine token in config.json): enrol it with the OpenCode plugin's /hub dialog; until then the service exits and is restarted"]
}

export function installSpokeService(name: SpokeServiceName, io: NodeIo, options: { readonly dryRun: boolean }): NodeCommandOutput {
  return installService(SPECS[name], io, options, readiness(io.env, io.home))
}

export function uninstallSpokeService(name: SpokeServiceName, io: NodeIo, options: { readonly dryRun: boolean }): NodeCommandOutput {
  return uninstallService(SPECS[name], io, options)
}

export interface SpokeServiceStatus {
  readonly service: ServiceState
  readonly enrolled?: { readonly server: string; readonly machineID?: string }
  /** The harness CLI as this shell finds it (the service looks on its own PATH, see the unit). */
  readonly harness: { readonly bin: string; readonly found?: string }
  /** claude-code: the daemon's socket (hooks look there). */
  readonly socket?: string
  /** codex-spoke: the running service's pid (its pid file), and the Codex daemon socket it attaches to. */
  readonly running?: number
  readonly daemonSocket?: string
}

export function spokeServiceStatus(name: SpokeServiceName, io: NodeIo): SpokeServiceStatus {
  const credentials = readSpokeCredentials(io.env, io.home)
  const bin = name === "claude-code" ? io.env.HUB_CLAUDE_BIN || "claude" : io.env.HUB_CODEX_BIN || "codex"
  const found = findExecutable(bin, io.env)
  const base = {
    service: serviceState(SPECS[name], io),
    ...(credentials ? { enrolled: { server: credentials.server, ...(credentials.machineID ? { machineID: credentials.machineID } : {}) } } : {}),
    harness: { bin, ...(found ? { found } : {}) },
  }
  if (name === "claude-code") return { ...base, socket: socketPath(io.env, io.home) }
  const running = readServicePid(io.env, io.home)
  const daemonSocket = daemonSocketPath(io.env, io.home)
  return { ...base, ...(running !== undefined ? { running } : {}), ...(daemonSocket ? { daemonSocket } : {}) }
}

export function spokeServiceStatusText(name: SpokeServiceName, status: SpokeServiceStatus): string {
  const spec = SPECS[name]
  const lines = [serviceStateLine(spec, status.service)]
  lines.push(status.enrolled ? `machine: enrolled with ${status.enrolled.server}${status.enrolled.machineID ? ` as ${status.enrolled.machineID}` : ""}` : "machine: not enrolled (enrol it with the OpenCode plugin's /hub dialog)")
  const what = name === "claude-code" ? "Claude Code CLI" : "Codex CLI"
  lines.push(status.harness.found ? `${what}: ${status.harness.found}` : `${what}: ${status.harness.bin} not found on this shell's PATH (no hub launches${name === "claude-code" ? "" : " of new threads"} until it is)`)
  if (status.socket) lines.push(`daemon socket: ${status.socket}`)
  if (name === "codex-spoke") {
    lines.push(status.running !== undefined ? `running: pid ${status.running}` : "running: no")
    lines.push(`Codex daemon socket: ${status.daemonSocket ?? "off"}`)
  }
  lines.push(...serviceCheckLines(status.service))
  return lines.join("\n")
}
