// Per-machine spoke configuration, shared by every OpenCode process on the machine and edited
// from the /voice dialog. Holds the machine token, so it is written with mode 0600.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

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
  /** Fast model the voice agent talks with in conversation mode ("provider/model[#variant]"). */
  readonly voiceModel?: string
  /** Model subagents work on; defaults to the session's model before conversation mode. */
  readonly workModel?: string
  readonly machineID?: string
  readonly token?: string
}

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

export function configPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.OPENCODE_VOICE_CONFIG) return env.OPENCODE_VOICE_CONFIG
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return path.join(base, "opencode-voice", "config.json")
}

export function defaults(machineName: string): VoiceConfig {
  return { server: DEFAULT_SERVER, mode: "off", sessions: [], machineName, subagent: DEFAULT_SUBAGENT, autoStartLocalHub: true }
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
    ...(modelRef(r.voiceModel) ? { voiceModel: modelRef(r.voiceModel) } : {}),
    ...(modelRef(r.workModel) ? { workModel: modelRef(r.workModel) } : {}),
    ...(typeof r.machineID === "string" && r.machineID ? { machineID: r.machineID } : {}),
    ...(typeof r.token === "string" && r.token ? { token: r.token } : {}),
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
