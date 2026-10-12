// Speech for the hub: builds the configured provider for each request from the stored settings (so
// changes apply at once), proxies model lists for the settings page, and caches them for 10 minutes.
import { OpenAICompatible } from "./openai"
import { OpenRouter } from "./openrouter"
import { SpeechError, upstreamDetail, type SpeechProvider } from "./provider"
import {
  lowerLayers,
  resolveStt,
  resolveTts,
  speechView,
  updateSpeech,
  userSpeechView,
  type Resolved,
  type SpeechDefaults,
  type SpeechView,
  type StoredSpeech,
  type UserSpeechView,
} from "./settings"

export const MODELS_CACHE_MS = 10 * 60_000
const MODELS_TIMEOUT_MS = 10_000

export interface SpeechSettingsStore {
  /** The server default. */
  speechSettings(): StoredSpeech
  setSpeechSettings(settings: StoredSpeech): void
  /** A user's own settings (multi-user hubs). */
  userSpeech?(userID: string): StoredSpeech
  setUserSpeech?(userID: string, settings: StoredSpeech): void
}

/** Speech for one scope: a user (their settings over the default) or, without a user, the server default. */
export interface ScopedSpeech {
  transcribe(audio: Uint8Array, format: string): Promise<string>
  speak(text: string): Promise<Uint8Array<ArrayBuffer>>
}

export interface SpeechServiceOptions {
  readonly store: SpeechSettingsStore
  readonly defaults: SpeechDefaults
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export type SpeechKind = "stt" | "tts"

export interface ModelInfo {
  readonly id: string
  readonly name: string
}

export class SpeechService {
  private readonly fetch: typeof globalThis.fetch
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; models: ModelInfo[] }>()

  constructor(private readonly options: SpeechServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  /** The server default's view, or a user's view (own settings over the default). */
  view(): SpeechView
  view(userID: string | undefined): SpeechView | UserSpeechView
  view(userID?: string): SpeechView | UserSpeechView {
    const stored = this.options.store.speechSettings()
    if (userID === undefined) return speechView(stored, this.options.defaults)
    return userSpeechView(stored, this.options.defaults, this.userSettings(userID) ?? {})
  }

  /** Partial update of the server default, or of a user's own settings; throws ValidationError without saving anything. */
  update(input: unknown, userID?: string): SpeechView | UserSpeechView {
    const { store, defaults } = this.options
    if (userID === undefined) store.setSpeechSettings(updateSpeech(store.speechSettings(), input, defaults.file))
    else {
      if (!store.setUserSpeech) throw new Error("per-user speech settings are not supported by this store")
      // Validated against (and keys dropped relative to) the layers below: server default and hub.json.
      store.setUserSpeech(userID, updateSpeech(this.userSettings(userID) ?? {}, input, lowerLayers(store.speechSettings(), defaults)))
    }
    this.cache.clear()
    return this.view(userID)
  }

  /** Speech with a user's effective settings (undefined: the server default). */
  forUser(userID: string | undefined): ScopedSpeech {
    return {
      transcribe: (audio, format) => this.transcribe(audio, format, undefined, userID),
      speak: (text) => this.speak(text, undefined, userID),
    }
  }

  transcribe(audio: Uint8Array, format: string, signal?: AbortSignal, userID?: string): Promise<string> {
    return this.provider("stt", userID).transcribe(audio, format, signal)
  }

  speak(text: string, signal?: AbortSignal, userID?: string): Promise<Uint8Array<ArrayBuffer>> {
    const tts = resolveTts(this.options.store.speechSettings(), this.options.defaults, this.userSettings(userID))
    return this.provider("tts", userID).speak(text, tts.speed, signal)
  }

  /** Models offered by the configured provider for `kind` (a user's effective provider when given). */
  async models(kind: SpeechKind, userID?: string): Promise<ModelInfo[]> {
    const settings = this.options.store.speechSettings()
    const user = this.userSettings(userID)
    const resolved: Resolved = kind === "stt" ? resolveStt(settings, this.options.defaults, user) : resolveTts(settings, this.options.defaults, user)
    const openrouter = resolved.provider === "openrouter"
    const url = openrouter
      ? `${resolved.baseURL}/models?output_modalities=${kind === "stt" ? "transcription" : "speech"}`
      : `${resolved.baseURL}/models`
    // Per scope: a list fetched with one user's key is never served to another.
    const cacheKey = `${userID ?? ""} ${url}`
    const cached = this.cache.get(cacheKey)
    if (cached && this.now() - cached.at < MODELS_CACHE_MS) return cached.models

    let models: ModelInfo[]
    try {
      // OpenRouter's list is public: no key is sent. Other providers usually need theirs.
      const headers: Record<string, string> = !openrouter && resolved.apiKey ? { authorization: `Bearer ${resolved.apiKey}` } : {}
      const response = await this.fetch(url, { headers, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) })
      if (!response.ok) throw new SpeechError(`Model list failed (${response.status}): ${await upstreamDetail(response)}`, response.status)
      models = parseModels(await response.json())
    } catch (cause) {
      if (!openrouter) return []
      throw cause instanceof SpeechError ? cause : new SpeechError(`Model list failed: ${cause instanceof Error ? cause.message : cause}`)
    }
    this.cache.set(cacheKey, { at: this.now(), models })
    return models
  }

  private userSettings(userID: string | undefined): StoredSpeech | undefined {
    return userID === undefined ? undefined : (this.options.store.userSpeech?.(userID) ?? {})
  }

  private provider(kind: SpeechKind, userID?: string): SpeechProvider {
    const settings = this.options.store.speechSettings()
    const user = this.userSettings(userID)
    const stt = resolveStt(settings, this.options.defaults, user)
    const tts = resolveTts(settings, this.options.defaults, user)
    const active = kind === "stt" ? stt : tts
    const options = {
      apiKey: async () => active.apiKey,
      sttModel: stt.model,
      ttsModel: tts.model,
      voice: tts.voice,
      ...(stt.language ? { language: stt.language } : {}),
      baseURL: active.baseURL,
      fetch: this.fetch,
    }
    return active.provider === "openrouter" ? new OpenRouter(options) : new OpenAICompatible(options)
  }
}

function parseModels(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const models: ModelInfo[] = []
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id !== "string" || !id) continue
    const name = (entry as { name?: unknown }).name
    models.push({ id, name: typeof name === "string" && name ? name : id })
  }
  return models
}
