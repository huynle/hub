// Speech for the hub: builds the configured provider for each request from the stored settings (so
// changes apply at once), proxies model lists for the settings page, and caches them for 10 minutes.
import { OpenAICompatible } from "./openai"
import { OpenRouter } from "./openrouter"
import { SpeechError, upstreamDetail, type SpeechProvider } from "./provider"
import {
  resolveStt,
  resolveTts,
  speechView,
  updateSpeech,
  type Resolved,
  type SpeechDefaults,
  type SpeechView,
  type StoredSpeech,
} from "./settings"

export const MODELS_CACHE_MS = 10 * 60_000
const MODELS_TIMEOUT_MS = 10_000

export interface SpeechSettingsStore {
  speechSettings(): StoredSpeech
  setSpeechSettings(settings: StoredSpeech): void
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

  view(): SpeechView {
    return speechView(this.options.store.speechSettings(), this.options.defaults)
  }

  /** Partial update (see updateSpeech); throws ValidationError without saving anything. */
  update(input: unknown): SpeechView {
    this.options.store.setSpeechSettings(updateSpeech(this.options.store.speechSettings(), input, this.options.defaults.file))
    this.cache.clear()
    return this.view()
  }

  transcribe(audio: Uint8Array, format: string, signal?: AbortSignal): Promise<string> {
    return this.provider("stt").transcribe(audio, format, signal)
  }

  speak(text: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const tts = resolveTts(this.options.store.speechSettings(), this.options.defaults)
    return this.provider("tts").speak(text, tts.speed, signal)
  }

  /** Models offered by the configured provider for `kind`. */
  async models(kind: SpeechKind): Promise<ModelInfo[]> {
    const settings = this.options.store.speechSettings()
    const resolved: Resolved = kind === "stt" ? resolveStt(settings, this.options.defaults) : resolveTts(settings, this.options.defaults)
    const openrouter = resolved.provider === "openrouter"
    const url = openrouter
      ? `${resolved.baseURL}/models?output_modalities=${kind === "stt" ? "transcription" : "speech"}`
      : `${resolved.baseURL}/models`
    const cached = this.cache.get(url)
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
    this.cache.set(url, { at: this.now(), models })
    return models
  }

  private provider(kind: SpeechKind): SpeechProvider {
    const settings = this.options.store.speechSettings()
    const stt = resolveStt(settings, this.options.defaults)
    const tts = resolveTts(settings, this.options.defaults)
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
