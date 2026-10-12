// Owner-configurable speech settings (persisted in state.json): which provider, model, voice, key and
// base URL to use for speech-to-text and text-to-speech. Precedence, per direction and field: the phone's
// saved settings > hub.json (`speech`) > the hub's environment (OPENROUTER_API_KEY, VOICE_STT_MODEL,
// VOICE_TTS_MODEL, VOICE_VOICE). Keys are only ever shown masked ({set, last4, source}).
import { ValidationError } from "../auth"
import { OPENROUTER_BASE_URL } from "./openrouter"

export const SPEECH_PROVIDERS = ["openrouter", "openai-compatible"] as const
export type SpeechProviderName = (typeof SPEECH_PROVIDERS)[number]

export interface StoredStt {
  provider?: SpeechProviderName
  model?: string
  apiKey?: string
  baseURL?: string
  language?: string
}

export interface StoredTts {
  provider?: SpeechProviderName
  model?: string
  voice?: string
  apiKey?: string
  baseURL?: string
  speed?: number
}

export interface StoredSpeech {
  stt?: StoredStt
  tts?: StoredTts
}

/** Hub environment defaults (see CentralConfig). */
export interface SpeechDefaults {
  /** OPENROUTER_API_KEY; only ever used with the openrouter provider. */
  readonly apiKey?: string
  readonly sttModel: string
  readonly ttsModel: string
  readonly voice: string
  /** Speech settings from hub.json, layered under the saved ones. */
  readonly file?: StoredSpeech
}

export type KeySource = "settings" | "config" | "env" | "none"

export interface KeyView {
  readonly set: boolean
  readonly last4?: string
  readonly source: KeySource
}

/** Effective settings of one direction, including the key to use (never sent to clients). */
export interface Resolved {
  readonly provider: SpeechProviderName
  readonly model: string
  readonly baseURL: string
  readonly apiKey?: string
  readonly keySource: KeySource
}

export interface ResolvedStt extends Resolved {
  readonly language?: string
}

export interface ResolvedTts extends Resolved {
  readonly voice: string
  readonly speed?: number
}

export interface SttView {
  readonly provider: SpeechProviderName
  readonly model: string
  readonly baseURL?: string
  readonly language?: string
  readonly apiKey: KeyView
}

export interface TtsView {
  readonly provider: SpeechProviderName
  readonly model: string
  readonly voice: string
  readonly baseURL?: string
  readonly speed?: number
  readonly apiKey: KeyView
}

/** GET /api/settings/speech */
export interface SpeechView {
  readonly stt: SttView
  readonly tts: TtsView
  readonly voiceHints: Readonly<Record<string, readonly string[]>>
  /** Whether each direction is usable (see speechReady). */
  readonly ready: SpeechReady
}

/** Voices known to work, keyed by model ID prefix (voices are model-specific). */
export const VOICE_HINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "microsoft/mai-voice": ["en-US-Harper:MAI-Voice-2.1-Flash"],
  "hexgrad/kokoro-82m": ["af_heart", "af_bella", "af_nicole", "af_sky", "am_adam", "am_michael", "bf_emma", "bm_george"],
  "openai/": ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"],
})

export const MAX_NAME_CHARS = 200
export const MIN_SPEED = 0.5
export const MAX_SPEED = 2
const MAX_KEY_CHARS = 500
const MAX_URL_CHARS = 500
/** Keys go into an Authorization header: printable ASCII without spaces. */
const KEY_PATTERN = /^[\x21-\x7e]+$/
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Hosts on a private network, where plain http:// is acceptable for self-hosted speech servers:
 * loopback, RFC 1918 and Tailscale (100.64/10) addresses, single-label names (Docker services) and
 * .local / .lan / .internal / .home.arpa names.
 */
export function isPrivateHost(hostname: string): boolean {
  if (LOCAL_HOSTS.has(hostname)) return true
  const ip = hostname.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (!hostname.includes(".")) return /^[a-z0-9-]+$/i.test(hostname)
  return /\.(local|lan|internal|home\.arpa)$/i.test(hostname)
}

/**
 * One direction's saved settings over hub.json's. The file's section is ignored when the saved provider
 * differs from it, and its key is dropped when the saved base URL differs: a key never follows the
 * settings to another endpoint.
 */
export function layer<T extends StoredStt | StoredTts>(file: T | undefined, saved: T | undefined): T | undefined {
  if (!file) return saved
  if (saved?.provider !== undefined && saved.provider !== (file.provider ?? "openrouter")) return saved
  const merged: T = { ...file, ...saved }
  if (saved?.baseURL !== undefined && saved.baseURL !== file.baseURL && saved.apiKey === undefined) delete merged.apiKey
  return merged
}

function resolve(saved: StoredStt | StoredTts | undefined, merged: StoredStt | StoredTts | undefined, model: string, defaults: SpeechDefaults): Resolved {
  const provider = merged?.provider ?? "openrouter"
  const envKey = provider === "openrouter" ? defaults.apiKey : undefined
  const apiKey = merged?.apiKey ?? envKey
  return {
    provider,
    model: merged?.model ?? model,
    baseURL: merged?.baseURL ?? OPENROUTER_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    keySource: saved?.apiKey ? "settings" : merged?.apiKey ? "config" : envKey ? "env" : "none",
  }
}

export function resolveStt(stored: StoredSpeech, defaults: SpeechDefaults): ResolvedStt {
  const stt = layer(defaults.file?.stt, stored.stt)
  return { ...resolve(stored.stt, stt, defaults.sttModel, defaults), ...(stt?.language ? { language: stt.language } : {}) }
}

export function resolveTts(stored: StoredSpeech, defaults: SpeechDefaults): ResolvedTts {
  const tts = layer(defaults.file?.tts, stored.tts)
  return {
    ...resolve(stored.tts, tts, defaults.ttsModel, defaults),
    voice: tts?.voice ?? defaults.voice,
    ...(tts?.speed !== undefined ? { speed: tts.speed } : {}),
  }
}

function keyView(resolved: Resolved): KeyView {
  const key = resolved.apiKey
  if (!key) return { set: false, source: "none" }
  return { set: true, ...(key.length >= 12 ? { last4: key.slice(-4) } : {}), source: resolved.keySource }
}

/** Settings as shown to the phone: effective values, keys masked. */
export function speechView(stored: StoredSpeech, defaults: SpeechDefaults): SpeechView {
  const stt = resolveStt(stored, defaults)
  const tts = resolveTts(stored, defaults)
  return {
    stt: {
      provider: stt.provider,
      model: stt.model,
      ...(layer(defaults.file?.stt, stored.stt)?.baseURL ? { baseURL: stt.baseURL } : {}),
      ...(stt.language ? { language: stt.language } : {}),
      apiKey: keyView(stt),
    },
    tts: {
      provider: tts.provider,
      model: tts.model,
      voice: tts.voice,
      ...(layer(defaults.file?.tts, stored.tts)?.baseURL ? { baseURL: tts.baseURL } : {}),
      ...(tts.speed !== undefined ? { speed: tts.speed } : {}),
      apiKey: keyView(tts),
    },
    voiceHints: VOICE_HINTS,
    ready: speechReady(stt, tts),
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** https:// anywhere, or plain http:// to a private-network host (self-hosted speech servers). Credentials, query and fragment refused. */
export function validBaseURL(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length > MAX_URL_CHARS) throw new ValidationError(`${field} must be a URL`)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ValidationError(`${field} must be a URL`)
  }
  const local = url.protocol === "http:" && isPrivateHost(url.hostname)
  if (url.protocol !== "https:" && !local) {
    throw new ValidationError(`${field} must start with https:// (http:// only for private-network hosts)`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ValidationError(`${field} must not contain credentials, a query or a fragment`)
  }
  return url.toString().replace(/\/+$/, "")
}

type Section = Record<string, unknown>

/** Applies one optional text field: null or "" clears, a string sets (validated), absent keeps. */
function text(next: Section, input: Section, key: string, field: string, check?: (value: string) => boolean): void {
  if (!(key in input)) return
  const value = input[key]
  if (value === null || value === "") return void delete next[key]
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_NAME_CHARS || /[\x00-\x1f\x7f]/.test(trimmed) || (check && !check(trimmed))) {
    throw new ValidationError(`${field} is not valid`)
  }
  next[key] = trimmed
}

function section<T extends StoredStt | StoredTts>(prev: T | undefined, input: unknown, kind: "stt" | "tts", file?: T): T | undefined {
  if (input === undefined) return prev
  if (!isObj(input)) throw new ValidationError(`${kind} must be an object`)
  const next: Section = { ...prev }

  if ("provider" in input) {
    if (input.provider === null) delete next.provider
    else if (!SPEECH_PROVIDERS.includes(input.provider as SpeechProviderName)) {
      throw new ValidationError(`${kind}.provider must be one of ${SPEECH_PROVIDERS.join(", ")}`)
    } else next.provider = input.provider
  }
  text(next, input, "model", `${kind}.model`)
  if (kind === "stt") text(next, input, "language", "stt.language", (v) => LANGUAGE_PATTERN.test(v))
  if (kind === "tts") {
    text(next, input, "voice", "tts.voice")
    if ("speed" in input) {
      const speed = input.speed
      if (speed === null) delete next.speed
      else if (typeof speed !== "number" || !Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
        throw new ValidationError(`tts.speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}`)
      } else next.speed = speed
    }
  }
  if ("baseURL" in input) {
    if (input.baseURL === null || input.baseURL === "") delete next.baseURL
    else next.baseURL = validBaseURL(input.baseURL, `${kind}.baseURL`)
  }

  if ("apiKey" in input) {
    const key = input.apiKey
    if (key === null || key === "") delete next.apiKey
    else if (typeof key !== "string" || key.trim().length > MAX_KEY_CHARS || !KEY_PATTERN.test(key.trim())) {
      // Never echo the value: it may be a real key with a typo.
      throw new ValidationError(`${kind}.apiKey must be a single token of printable characters`)
    } else next.apiKey = key.trim()
  } else if ((prev?.provider ?? file?.provider ?? "openrouter") !== (next.provider ?? file?.provider ?? "openrouter") || prev?.baseURL !== next.baseURL) {
    // A stored key never follows the settings to a different endpoint.
    delete next.apiKey
  }

  const effective = layer(file, next as T)
  if (effective?.provider === "openai-compatible" && !effective.baseURL) {
    throw new ValidationError(`${kind}.baseURL is required for the openai-compatible provider`)
  }
  return next as T
}

/** Partial update from untrusted input (validated together with hub.json's layer); throws ValidationError and returns a new object. */
export function updateSpeech(prev: StoredSpeech, input: unknown, file: StoredSpeech = {}): StoredSpeech {
  if (!isObj(input)) throw new ValidationError("Expected {stt?, tts?}")
  const stt = section(prev.stt, input.stt, "stt", file.stt)
  const tts = section(prev.tts, input.tts, "tts", file.tts)
  return { ...(stt ? { stt } : {}), ...(tts ? { tts } : {}) }
}

export interface SpeechReady {
  readonly stt: boolean
  readonly tts: boolean
  /** Why speech is not usable yet (absent when both directions are ready). */
  readonly reason?: string
}

/** Whether a direction can work at all: openrouter needs a key, openai-compatible a base URL. */
function missing(resolved: Resolved): string | undefined {
  if (resolved.provider === "openrouter") return resolved.apiKey ? undefined : "an OpenRouter API key"
  return resolved.baseURL ? undefined : "a base URL"
}

export function speechReady(stt: Resolved, tts: Resolved): SpeechReady {
  const needs = [
    ["Speech-to-text", missing(stt)],
    ["Text-to-speech", missing(tts)],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined)
  const ready = { stt: !missing(stt), tts: !missing(tts) }
  if (needs.length === 0) return ready
  return { ...ready, reason: `${needs.map(([what, need]) => `${what} needs ${need}`).join("; ")}. Set it in Settings → Speech.` }
}
