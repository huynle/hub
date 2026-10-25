// Per-machine spoke configuration, shared by every OpenCode process on the machine and edited
// from the /hub dialog. Holds the machine token, so it is written with mode 0600.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { hubEnv, type Env } from "./env"
import { APP_DIR, configBase, legacyPaths, migrateFirst } from "./migrate"
import { isHubURL } from "./protocol"

export type Mode = "off" | "always" | "session"

export interface VoiceConfig {
  readonly server: string
  readonly mode: Mode
  /** Session IDs exposed when mode is "session". */
  readonly sessions: readonly string[]
  readonly machineName: string
  /** Agent the voice orchestrator delegates work to in conversation mode. */
  readonly subagent: string
  /** Start a local hub in the background when the server is loopback and nothing answers (default true). */
  readonly autoStartLocalHub: boolean
  /** Read open sessions and workspaces from the Herdr CLI (default true; the service process only). */
  readonly herdr: boolean
  /** History window of the session listing: root sessions from the last `days` days, at most `max`. */
  readonly list: ListWindow
  /** Fast model the voice agent talks with in conversation mode ("provider/model[#variant]"). */
  readonly voiceModel?: string
  /** Model subagents work on; defaults to the session's model before conversation mode. */
  readonly workModel?: string
  readonly machineID?: string
  readonly token?: string
}

export interface ListWindow {
  readonly days: number
  readonly max: number
}

export const DEFAULT_LIST: ListWindow = Object.freeze({ days: 30, max: 100 })
const LIST_LIMITS = { days: 365, max: 500 } as const

export const DEFAULT_SERVER = "http://127.0.0.1:4097"
export const DEFAULT_SUBAGENT = "general"
const AGENT_ID = /^[A-Za-z0-9_.-]{1,64}$/
const MODEL_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:\/-]+(?:#[A-Za-z0-9_.-]+)?$/

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** "provider/model[#variant]"; the model ID may itself contain slashes (e.g. openrouter/anthropic/x). */
export function parseModelRef(value: string): ModelRef | undefined {
  if (!MODEL_REF.test(value)) return undefined
  const [ref, variant] = value.split("#") as [string, string | undefined]
  const slash = ref.indexOf("/")
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}

/** OpenCode reports a model selected without a variant as variant "default". */
export function explicitVariant(ref: ModelRef): string | undefined {
  return ref.variant && ref.variant !== "default" ? ref.variant : undefined
}

/** Drops the implicit "default" variant so the ref can be passed back to OpenCode tools. */
export function plainModelRef(ref: ModelRef): ModelRef {
  const variant = explicitVariant(ref)
  return { providerID: ref.providerID, id: ref.id, ...(variant ? { variant } : {}) }
}

export function formatModelRef(ref: ModelRef): string {
  const variant = explicitVariant(ref)
  return `${ref.providerID}/${ref.id}${variant ? `#${variant}` : ""}`
}

const modelRef = (v: unknown) => (typeof v === "string" && v.length <= 200 && MODEL_REF.test(v) ? v : undefined)

/** $HUB_SPOKE_CONFIG (legacy $OPENCODE_HUB_CONFIG, $OPENCODE_VOICE_CONFIG), else ~/.config/hub/config.json. */
export function configPath(env: Env = process.env, home: string = homedir()): string {
  const explicit = hubEnv(env).HUB_SPOKE_CONFIG
  if (explicit) return explicit
  return path.join(configBase(env, home), APP_DIR, "config.json")
}

/**
 * configPath, after copying the legacy ~/.config/opencode-hub/config.json (else the opencode-voice one) to
 * the default location on first start (never for an explicit path; the old files are kept).
 */
export function prepareConfigPath(env: Env = process.env, home: string = homedir(), log?: (message: string) => void): string {
  const file = configPath(env, home)
  if (!hubEnv(env).HUB_SPOKE_CONFIG) {
    migrateFirst(legacyPaths(configBase(env, home), "config.json"), file, log ? { log } : {})
  }
  return file
}

export function defaults(machineName: string): VoiceConfig {
  return { server: DEFAULT_SERVER, mode: "off", sessions: [], machineName, subagent: DEFAULT_SUBAGENT, autoStartLocalHub: true, herdr: true, list: { ...DEFAULT_LIST } }
}

/** Normalizes untrusted JSON into a config, falling back to defaults field by field. */
export function normalize(raw: unknown, machineName: string): VoiceConfig {
  const base = defaults(machineName)
  if (typeof raw !== "object" || raw === null) return base
  const r = raw as Record<string, unknown>
  const server = typeof r.server === "string" && /^https?:\/\/[^\s]+$/.test(r.server) ? r.server.replace(/\/+$/, "") : base.server
  const mode: Mode = r.mode === "always" || r.mode === "session" || r.mode === "off" ? r.mode : base.mode
  const sessions = Array.isArray(r.sessions) ? [...new Set(r.sessions.filter((s): s is string => typeof s === "string" && s.startsWith("ses")))] : []
  return {
    server,
    mode,
    sessions,
    machineName: typeof r.machineName === "string" && r.machineName ? r.machineName : machineName,
    subagent: typeof r.subagent === "string" && AGENT_ID.test(r.subagent) ? r.subagent : base.subagent,
    autoStartLocalHub: r.autoStartLocalHub !== false,
    herdr: r.herdr !== false,
    list: listWindow(r.list),
    ...(modelRef(r.voiceModel) ? { voiceModel: modelRef(r.voiceModel) } : {}),
    ...(modelRef(r.workModel) ? { workModel: modelRef(r.workModel) } : {}),
    ...(typeof r.machineID === "string" && r.machineID ? { machineID: r.machineID } : {}),
    ...(typeof r.token === "string" && r.token ? { token: r.token } : {}),
  }
}

const inRange = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max

/** Each field of the history window falls back to its default when missing or out of range. */
function listWindow(raw: unknown): ListWindow {
  const r = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    days: inRange(r.days, LIST_LIMITS.days) ? r.days : DEFAULT_LIST.days,
    max: inRange(r.max, LIST_LIMITS.max) ? r.max : DEFAULT_LIST.max,
  }
}

export function readConfig(file: string, machineName: string): VoiceConfig {
  try {
    return normalize(JSON.parse(readFileSync(file, "utf8")), machineName)
  } catch {
    return defaults(machineName)
  }
}

/** Atomic write with 0600 permissions. */
export function writeConfig(file: string, config: VoiceConfig): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** Changing the server URL drops the machine credentials, which belong to the old server. */
export function withServer(config: VoiceConfig, server: string): VoiceConfig {
  const next = normalize({ ...config, server }, config.machineName)
  if (next.server === config.server) return next
  const { machineID: _id, token: _token, ...rest } = next
  return rest
}

export function isExposed(config: VoiceConfig, sessionID: string): boolean {
  if (config.mode === "always") return true
  if (config.mode === "session") return config.sessions.includes(sessionID)
  return false
}

export function setSession(config: VoiceConfig, sessionID: string, on: boolean): VoiceConfig {
  const sessions = on ? [...new Set([...config.sessions, sessionID])] : config.sessions.filter((id) => id !== sessionID)
  return { ...config, sessions }
}

// ---------- launch-bound mode ----------
// A spoke inside a launch's sandbox (OpenShell, design §6.4) connects with a credential bound to that launch. The node
// writes {hubURL, token, launchID} next to node.json before the harness starts; the spoke only reads it: no enrolment,
// no local hub, no config writes.

export interface LaunchConfig {
  readonly hubURL: string
  /** The launch-bound credential (hlt1…); never logged. */
  readonly token: string
  readonly launchID: string
}

/** Where the node puts the launch config inside a sandbox. */
export const LAUNCH_CONFIG_DEFAULT = "/sandbox/.hub/config.json"
const LAUNCH_ID = /^[A-Za-z0-9_.:@/+~-]{1,300}$/
const LAUNCH_TOKEN = /^[\x21-\x7e]{1,4096}$/

/** A launch config, or undefined unless every field is present and valid. */
export function parseLaunchConfig(raw: unknown): LaunchConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (!isHubURL(r.hubURL)) return undefined
  if (typeof r.token !== "string" || !LAUNCH_TOKEN.test(r.token)) return undefined
  if (typeof r.launchID !== "string" || !LAUNCH_ID.test(r.launchID)) return undefined
  return { hubURL: r.hubURL.replace(/\/+$/, ""), token: r.token, launchID: r.launchID }
}

/** $HUB_LAUNCH_CONFIG, else LAUNCH_CONFIG_DEFAULT when it exists; undefined: not launch-bound. */
export function launchConfigPath(env: Env = process.env, exists: (file: string) => boolean = existsSync): string | undefined {
  const explicit = env.HUB_LAUNCH_CONFIG
  if (explicit) return explicit
  return exists(LAUNCH_CONFIG_DEFAULT) ? LAUNCH_CONFIG_DEFAULT : undefined
}

/** Reads a launch config; throws (without the token) when it is missing, unparsable or invalid. */
export function readLaunchConfig(file: string): LaunchConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (cause) {
    throw new Error(`Cannot read the launch config ${file}: ${cause instanceof SyntaxError ? "not JSON" : (cause as NodeJS.ErrnoException).code ?? "unreadable"}`)
  }
  const config = parseLaunchConfig(raw)
  if (!config) throw new Error(`Invalid launch config ${file}: expected {hubURL, token, launchID}`)
  return config
}
