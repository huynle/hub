// `hub node run | install | uninstall | status` (design §6.3; decision znbg8xa5 #6): `run` is the node daemon
// (packages/node runNode) until SIGINT/SIGTERM. `install` renders the service template embedded in this program (a
// launchd agent on macOS, a systemd user unit on Linux; renderServiceUnit, the same renderer `hubctl setup` uses)
// with the argv of what runs this command (programLayout: the standalone hubctl itself, or the runtime and the CLI
// entry), writes the file, and prints the launchctl / systemctl commands that load it. Nothing here starts a process:
// loading, unloading and inspecting the service are always left to the user (printed, never run). --dry-run
// prints the file instead of writing it. The same machinery (ServiceSpec) installs the harness spokes' services
// (spoke-services.ts: `hub claude-code install`, `hub codex-spoke install`).
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { nodeConfigPath, readNodeConfig, readSpokeCredentials, runNode } from "../../node/src/index.ts"
import { renderServiceUnit } from "./bootstrap/adapters/node-services/render.ts"
import { isAbsolutePath, programLayout, type ServiceID, type ServiceManagerID } from "./bootstrap/contracts/index.ts"
import type { Env } from "./credentials"
import { CliError, EXIT } from "./http"

export const NODE_LABEL = "io.github.huynle.hub-node"
export const NODE_UNIT = "hub-node.service"

/** A per-user hub service installed from the embedded templates (hub node, and the harness spokes' services). */
export interface ServiceSpec {
  /** The service (its embedded template and the subcommand the unit runs). */
  readonly service: ServiceID
  /** The CLI command that installs it ("hub node"), for the written files' header and messages. */
  readonly command: string
  /** The launchd label; the macOS template is scripts/<label>.plist. */
  readonly label: string
  /** The systemd unit name; the Linux template is scripts/<unit>. */
  readonly unit: string
  /** Its log file in ~/.local/state/hub (launchd). */
  readonly log: string
  /** Settings the service must see as this shell does (where its config and state live). */
  readonly carried: readonly string[]
  /** What to tell users on platforms without launchd or systemd. */
  readonly elsewhere: string
}

export const NODE_SERVICE: ServiceSpec = {
  service: "node",
  command: "hub node",
  label: NODE_LABEL,
  unit: NODE_UNIT,
  log: "node.log",
  carried: ["HUB_SPOKE_CONFIG", "XDG_CONFIG_HOME"],
  elsewhere: "Run `hub node run` under your own service manager",
}

/** What runs the CLI: the runtime binary and the CLI's entry file. */
export interface Program {
  readonly execPath: string
  readonly entry: string
}

export interface NodeIo {
  readonly env: Env
  readonly home: string
  readonly platform: NodeJS.Platform
  readonly uid: number
  readonly program: Program
}

export type ServiceKind = "launchd" | "systemd"

export interface NodeService {
  readonly kind: ServiceKind
  /** Where the unit file goes. */
  readonly file: string
  /** Its content, as install writes it. */
  readonly content: string
  /** Directories the service needs (its log). */
  readonly dirs: readonly string[]
  /** Commands that load (or reload) it, for the user to run. */
  readonly load: readonly string[]
  /** Commands that stop it once the file is removed. */
  readonly unload: readonly string[]
  /** How to see its state and logs. */
  readonly check: readonly string[]
  /** Settings this shell has that the unit cannot carry (not an absolute path). */
  readonly skipped: readonly string[]
}

/** Extra settings a service's unit carries beyond the shell's (spoke-services.ts: the hub-installed Codex). */
export type ExtraEnvironment = (io: NodeIo) => Readonly<Record<string, string>>

/** This process as a Program: the runtime and the real path of the entry it runs. */
export function currentProgram(): Program {
  const entry = process.argv[1] ?? ""
  let real = entry
  try {
    real = realpathSync(entry)
  } catch {}
  return { execPath: process.execPath, entry: real }
}

/** A path quoted for sh (printed commands). */
const sh = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

/** The settings this shell has that the unit carries (absolute, single-line paths only), and those it cannot. */
function carried(spec: ServiceSpec, io: NodeIo, extra?: ExtraEnvironment): { environment: Record<string, string>; skipped: string[] } {
  const environment: Record<string, string> = { ...(extra?.(io) ?? {}) }
  const skipped: string[] = []
  for (const key of spec.carried) {
    const value = io.env[key]
    if (!value) continue
    if (isAbsolutePath(value)) environment[key] = value
    else skipped.push(key)
  }
  return { environment, skipped }
}

/** The unit's text: the embedded template rendered with this program's argv (one word per <string> / ExecStart word). */
function render(spec: ServiceSpec, io: NodeIo, manager: ServiceManagerID, extra?: ExtraEnvironment): { content: string; skipped: string[] } {
  const { environment, skipped } = carried(spec, io, extra)
  const r = renderServiceUnit({ service: spec.service, manager, layout: programLayout(io.program), home: io.home, environment, writtenBy: spec.command })
  if (!r.ok) throw new CliError(EXIT.usage, `cannot write the ${spec.command} service: ${r.issues.map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`).join("; ")}`)
  return { content: r.value.text, skipped }
}

function launchd(spec: ServiceSpec, io: NodeIo, extra?: ExtraEnvironment): NodeService {
  const file = path.join(io.home, "Library", "LaunchAgents", `${spec.label}.plist`)
  const domain = `gui/${io.uid}`
  const { content, skipped } = render(spec, io, "launchd", extra)
  const log = path.join(io.home, ".local", "state", "hub")
  return {
    kind: "launchd",
    file,
    content,
    skipped,
    dirs: [log],
    load: [`launchctl bootout ${domain}/${spec.label} 2>/dev/null || true`, `launchctl bootstrap ${domain} ${sh(file)}`],
    unload: [`launchctl bootout ${domain}/${spec.label}`],
    check: [`launchctl print ${domain}/${spec.label}`, `tail -f ${sh(path.join(log, spec.log))}`],
  }
}

function systemd(spec: ServiceSpec, io: NodeIo, extra?: ExtraEnvironment): NodeService {
  const unit = spec.unit
  const dir = path.join(io.env.XDG_CONFIG_HOME || path.join(io.home, ".config"), "systemd", "user")
  const file = path.join(dir, unit)
  const { content, skipped } = render(spec, io, "systemd-user", extra)
  return {
    kind: "systemd",
    file,
    content,
    skipped,
    dirs: [],
    load: ["systemctl --user daemon-reload", `systemctl --user enable --now ${unit}`, `systemctl --user restart ${unit}   # when it was already running`, 'loginctl enable-linger "$USER"   # optional: keep it running while you are logged out'],
    unload: [`systemctl --user stop ${unit}`, `rm -f ${sh(path.join(dir, "default.target.wants", unit))}`, "systemctl --user daemon-reload"],
    check: [`systemctl --user status ${unit}`, `journalctl --user -u ${unit} -f`],
  }
}

/** `spec`'s service for this platform; unsupported (exit 7) elsewhere. */
export function serviceFor(spec: ServiceSpec, io: NodeIo, extra?: ExtraEnvironment): NodeService {
  if (io.platform === "darwin") return launchd(spec, io, extra)
  if (io.platform === "linux") return systemd(spec, io, extra)
  throw new CliError(EXIT.unavailable, `${spec.command} install supports macOS (launchd) and Linux (systemd), not ${io.platform}`, spec.elsewhere)
}

/** The node's service for this platform; unsupported (exit 7) elsewhere. */
export const nodeService = (io: NodeIo): NodeService => serviceFor(NODE_SERVICE, io)

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** Why the installed service would not do anything yet (never the token). */
export function readinessProblems(env: Env, home: string): string[] {
  const problems: string[] = []
  if (!readSpokeCredentials(env, home)) problems.push("this machine is not enrolled with a hub yet (no machine token in config.json): enroll it with `hubctl machine enroll --server <hub URL>`")
  const file = nodeConfigPath(env, home)
  const { config, problems: found } = readNodeConfig(file)
  problems.push(...found.map((p) => `${file}: ${p}`))
  if (config.workspaceRoots.length === 0) problems.push(`${file} lists no workspaceRoots, so the service would exit 78; add e.g. {"workspaceRoots": ["${home}/projects"]}`)
  return problems
}

const commands = (title: string, lines: readonly string[]) => [title, ...lines.map((l) => `  ${l}`)].join("\n")
const NOT_RUN = "(not run by hub; run them yourself)"

export interface NodeCommandOutput {
  readonly stdout: string
  readonly warnings: readonly string[]
}

export function installNode(io: NodeIo, options: { readonly dryRun: boolean }): NodeCommandOutput {
  return installService(NODE_SERVICE, io, options, readinessProblems(io.env, io.home))
}

/** Writes `spec`'s service file (or prints it, dry run) and prints the commands that load it; `warnings` go to stderr. */
export function installService(spec: ServiceSpec, io: NodeIo, options: { readonly dryRun: boolean }, given: readonly string[], extra?: ExtraEnvironment): NodeCommandOutput {
  const service = serviceFor(spec, io, extra)
  const warnings = [...given, ...service.skipped.map((key) => `${key} is not an absolute path, so the service does not carry it`)]
  const load = commands(`Load it ${NOT_RUN}:`, service.load)
  if (options.dryRun) return { stdout: `would write ${service.file}:\n\n${service.content}\n${load}`, warnings }
  const current = readText(service.file)
  for (const dir of service.dirs) mkdirSync(dir, { recursive: true })
  if (current === service.content) return { stdout: `${service.file} is up to date\n${load}`, warnings }
  mkdirSync(path.dirname(service.file), { recursive: true })
  writeFileSync(service.file, service.content, { mode: 0o644 })
  return { stdout: `${current === undefined ? "wrote" : "updated"} ${service.file}\n${load}`, warnings }
}

export function uninstallNode(io: NodeIo, options: { readonly dryRun: boolean }): NodeCommandOutput {
  return uninstallService(NODE_SERVICE, io, options)
}

/** Removes `spec`'s service file (dry run: says it would) and prints the commands that stop it. */
export function uninstallService(spec: ServiceSpec, io: NodeIo, options: { readonly dryRun: boolean }): NodeCommandOutput {
  const service = serviceFor(spec, io)
  if (!existsSync(service.file)) return { stdout: `not installed (no ${service.file})`, warnings: [] }
  const stop = commands(`Stop the service ${NOT_RUN}:`, service.unload)
  if (options.dryRun) return { stdout: `would remove ${service.file}\n${stop}`, warnings: [] }
  rmSync(service.file)
  return { stdout: `removed ${service.file}\n${stop}`, warnings: [] }
}

export type ServiceState = { readonly kind: ServiceKind; readonly file: string; readonly installed: boolean; readonly current: boolean; readonly check: readonly string[] } | { readonly kind: "unsupported"; readonly platform: string }

/** Whether `spec`'s service file is there and is what install would write now. */
export function serviceState(spec: ServiceSpec, io: NodeIo, extra?: ExtraEnvironment): ServiceState {
  try {
    const s = serviceFor(spec, io, extra)
    const text = readText(s.file)
    return { kind: s.kind, file: s.file, installed: text !== undefined, current: text === s.content, check: s.check }
  } catch {
    return { kind: "unsupported", platform: io.platform }
  }
}

/** The status lines about `spec`'s service file. */
export function serviceStateLine(spec: ServiceSpec, s: ServiceState): string {
  if (s.kind === "unsupported") return `service: ${spec.command} install does not support ${s.platform}`
  if (!s.installed) return `service: not installed (${spec.command} install)`
  return `service: installed, ${s.current ? "up to date" : `differs from what this CLI writes (${spec.command} install updates it)`} (${s.file})`
}

/** How to see an installed service (not run). */
export const serviceCheckLines = (s: ServiceState): string[] => (s.kind !== "unsupported" && s.installed ? [commands(`See the service ${NOT_RUN}:`, s.check)] : [])

export interface NodeStatus {
  readonly service: ServiceState
  readonly enrolled?: { readonly server: string; readonly machineID?: string }
  readonly config: { readonly file: string; readonly workspaceRoots: readonly string[]; readonly slots: number; readonly labels: Readonly<Record<string, string>>; readonly problems: readonly string[] }
}

export function nodeStatus(io: NodeIo): NodeStatus {
  const service = serviceState(NODE_SERVICE, io)
  const credentials = readSpokeCredentials(io.env, io.home)
  const file = nodeConfigPath(io.env, io.home)
  const { config, problems } = readNodeConfig(file)
  return {
    service,
    ...(credentials ? { enrolled: { server: credentials.server, ...(credentials.machineID ? { machineID: credentials.machineID } : {}) } } : {}),
    config: { file, workspaceRoots: config.workspaceRoots, slots: config.slots, labels: config.labels, problems },
  }
}

export function nodeStatusText(status: NodeStatus): string {
  const s = status.service
  const lines: string[] = [serviceStateLine(NODE_SERVICE, s)]
  lines.push(status.enrolled ? `machine: enrolled with ${status.enrolled.server}${status.enrolled.machineID ? ` as ${status.enrolled.machineID}` : ""}` : "machine: not enrolled (enroll it with `hubctl machine enroll --server <hub URL>`)")
  const c = status.config
  lines.push(`node.json: ${c.file}`, `  workspace roots: ${c.workspaceRoots.length ? c.workspaceRoots.join(", ") : "none (the node would exit 78)"}`, `  slots: ${c.slots}`)
  const labels = Object.entries(c.labels).map(([k, v]) => `${k}=${v}`)
  if (labels.length) lines.push(`  labels: ${labels.join(" ")}`)
  for (const p of c.problems) lines.push(`  problem: ${p}`)
  lines.push(...serviceCheckLines(s))
  return lines.join("\n")
}

/** `hub node run`: the daemon until `signal` aborts; runNode's exit code. */
export function runNodeCommand(io: { readonly env: Env; readonly home: string; readonly signal?: AbortSignal; stderr(s: string): void }): Promise<number> {
  return runNode({ env: io.env, home: io.home, signal: io.signal ?? new AbortController().signal, log: (line) => io.stderr(`[hub node] ${line}\n`) })
}
