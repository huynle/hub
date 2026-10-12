// Central voice server configuration: environment variables over the optional hub config file
// (~/.config/opencode-voice/hub.json or $VOICE_HUB_CONFIG) over built-in defaults. The file's speech
// settings sit between the phone's saved settings and the env (see speech/settings.ts).
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { updateSpeech, type StoredSpeech } from "./speech/settings"

export interface CentralConfig {
  readonly host: string
  readonly port: number
  /** Origin used in links, cookies (Secure when https) and CSRF checks; no trailing slash. */
  readonly publicURL: string
  readonly stateDir: string
  readonly apiKey: string | undefined
  readonly sttModel: string
  readonly ttsModel: string
  readonly voice: string
  readonly maxAudioBytes: number
  readonly maxSpeechChars: number
  readonly turnTimeoutMs: number
  /** VAPID subject (mailto: or https: URL) sent to push services. */
  readonly vapidSubject: string
  /** Speech settings from hub.json (below the phone's saved settings, above the env). */
  readonly speech?: StoredSpeech
}

/** hub.json, validated. */
export interface HubFile {
  readonly host?: string
  readonly port?: number
  readonly publicURL?: string
  readonly stateDir?: string
  readonly speech?: StoredSpeech
}

type Env = Readonly<Record<string, string | undefined>>

const HUB_KEYS = new Set(["host", "port", "publicURL", "stateDir", "speech"])

function int(value: string | undefined, fallback: number, min = 1): number {
  if (value === undefined || value.trim() === "") return fallback
  const n = Number(value)
  return Number.isInteger(n) && n >= min ? n : fallback
}

const expandHome = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p)

export function hubConfigPath(env: Env = process.env, home: string = homedir()): string {
  if (env.VOICE_HUB_CONFIG) return env.VOICE_HUB_CONFIG
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode-voice", "hub.json")
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Removes apiKey from both speech sections; true when there was one. */
function stripKeys(speech: Record<string, unknown>): boolean {
  let found = false
  for (const kind of ["stt", "tts"]) {
    const section = speech[kind]
    if (isObj(section) && "apiKey" in section) {
      found = true
      const { apiKey: _drop, ...rest } = section
      speech[kind] = rest
    }
  }
  return found
}

/**
 * Reads and validates hub.json. A missing file yields no settings. Invalid JSON or values throw (with
 * the file name). API keys are refused, with a warning, when the file is readable by group or others.
 */
export function readHubFile(file: string, home: string = homedir()): { file?: HubFile; warnings: string[] } {
  if (!existsSync(file)) return { warnings: [] }
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (cause) {
    return fail(`not valid JSON (${cause instanceof Error ? cause.message : cause})`)
  }
  if (!isObj(raw)) return fail("expected a JSON object")

  const warnings: string[] = []
  for (const key of Object.keys(raw)) if (!HUB_KEYS.has(key)) warnings.push(`${file}: unknown key "${key}" ignored`)

  const hub: { -readonly [K in keyof HubFile]: HubFile[K] } = {}
  if (raw.host !== undefined) {
    if (typeof raw.host !== "string" || !raw.host.trim()) fail("host must be a non-empty string")
    hub.host = (raw.host as string).trim()
  }
  if (raw.port !== undefined) {
    const port = raw.port
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) fail("port must be an integer from 0 to 65535")
    hub.port = port as number
  }
  if (raw.publicURL !== undefined) {
    if (typeof raw.publicURL !== "string" || !raw.publicURL.trim()) fail("publicURL must be a string")
    hub.publicURL = (raw.publicURL as string).trim()
  }
  if (raw.stateDir !== undefined) {
    if (typeof raw.stateDir !== "string" || !raw.stateDir.trim()) fail("stateDir must be a non-empty string")
    hub.stateDir = expandHome((raw.stateDir as string).trim(), home)
  }
  if (raw.speech !== undefined) {
    if (!isObj(raw.speech)) fail("speech must be an object with stt and/or tts")
    const speech = { ...(raw.speech as Record<string, unknown>) }
    const shared = (statSync(file).mode & 0o044) !== 0
    if (shared && stripKeys(speech)) {
      warnings.push(`${file} is readable by other users, so its API keys are ignored. Fix it with: chmod 600 ${file}`)
    }
    try {
      hub.speech = updateSpeech({}, speech)
    } catch (cause) {
      fail(`speech: ${cause instanceof Error ? cause.message : cause}`)
    }
  }
  return { file: hub, warnings }
}

export function centralConfig(env: Env = process.env, home: string = homedir(), file: HubFile = {}): CentralConfig {
  const host = env.VOICE_HOST || file.host || "127.0.0.1"
  const port = int(env.VOICE_PORT, file.port ?? 4097, 0)
  // A wildcard bind address is no origin a browser uses: default to the loopback one (Docker -p 127.0.0.1:…).
  const linkHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  const publicURL = (env.VOICE_PUBLIC_URL || file.publicURL || `http://${linkHost.includes(":") ? `[${linkHost}]` : linkHost}:${port}`).replace(/\/+$/, "")
  if (!/^https?:\/\/[^\s/]+$/.test(publicURL)) {
    throw new Error(`VOICE_PUBLIC_URL must be an http(s) origin without a path, got ${JSON.stringify(publicURL)}`)
  }
  return {
    host,
    port,
    publicURL,
    stateDir: env.VOICE_STATE_DIR || file.stateDir || path.join(home, ".local", "state", "opencode-voice"),
    apiKey: env.OPENROUTER_API_KEY || undefined,
    sttModel: env.VOICE_STT_MODEL || "openai/gpt-4o-mini-transcribe",
    ttsModel: env.VOICE_TTS_MODEL || "microsoft/mai-voice-2.1-flash",
    voice: env.VOICE_VOICE || "en-US-Harper:MAI-Voice-2.1-Flash",
    maxAudioBytes: int(env.VOICE_MAX_AUDIO_BYTES, 10 * 1024 * 1024),
    maxSpeechChars: int(env.VOICE_MAX_SPEECH_CHARS, 800),
    turnTimeoutMs: int(env.VOICE_TURN_TIMEOUT_MS, 600_000),
    // Push services want a contact: an https URL or mailto. The public URL works for hosted hubs.
    vapidSubject: env.VOICE_VAPID_SUBJECT || (publicURL.startsWith("https://") ? publicURL : "mailto:opencode-voice@localhost"),
    ...(file.speech ? { speech: file.speech } : {}),
  }
}

/** Reads hub.json (if any) and the environment. Throws on an invalid file or public URL. */
export function loadCentralConfig(
  env: Env = process.env,
  home: string = homedir(),
): { config: CentralConfig; warnings: string[]; path: string; loaded: boolean } {
  const file = hubConfigPath(env, home)
  const { file: hub, warnings } = readHubFile(file, home)
  return { config: centralConfig(env, home, hub), warnings, path: file, loaded: hub !== undefined }
}
