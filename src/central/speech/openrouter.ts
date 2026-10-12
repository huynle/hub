// OpenRouter speech-to-text (/audio/transcriptions, JSON with base64 input_audio) and text-to-speech
// (/audio/speech).
import { SpeechError, upstreamDetail, withSpeedRetry, type SpeechProvider } from "./provider"

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

export interface OpenRouterOptions {
  readonly apiKey: () => Promise<string | undefined>
  readonly sttModel: string
  readonly ttsModel: string
  readonly voice: string
  readonly language?: string
  readonly baseURL?: string
  readonly fetch?: typeof globalThis.fetch
}

export class OpenRouterError extends SpeechError {
  constructor(message: string, status?: number) {
    super(message, status)
    this.name = "OpenRouterError"
  }
}

export class OpenRouter implements SpeechProvider {
  private readonly baseURL: string
  private readonly fetch: typeof globalThis.fetch

  constructor(private readonly options: OpenRouterOptions) {
    this.baseURL = options.baseURL ?? OPENROUTER_BASE_URL
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async transcribe(audio: Uint8Array, format: string, signal?: AbortSignal): Promise<string> {
    const { sttModel: model, language } = this.options
    const input_audio = { data: Buffer.from(audio).toString("base64"), format }
    const response = await this.post("/audio/transcriptions", { model, input_audio, ...(language ? { language } : {}) }, signal)
    if (!response.ok) throw await failure("transcription", response)
    const body = (await response.json()) as { text?: unknown }
    return String(body.text ?? "").trim()
  }

  async speak(text: string, speed?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const { ttsModel: model, voice } = this.options
    const response = await withSpeedRetry(
      (s) =>
        this.post("/audio/speech", { model, input: text, voice, response_format: "mp3", ...(s !== undefined ? { speed: s } : {}) }, signal),
      speed,
    )
    if (!response.ok) throw await failure("speech", response)
    return new Uint8Array(await response.arrayBuffer())
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const key = await this.options.apiKey()
    if (!key) {
      throw new OpenRouterError(
        "No OpenRouter API key: set one in the speech settings, set OPENROUTER_API_KEY, or connect OpenRouter in OpenCode",
      )
    }
    return this.fetch(`${this.baseURL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
  }
}

async function failure(kind: string, response: Response): Promise<OpenRouterError> {
  return new OpenRouterError(`OpenRouter ${kind} failed (${response.status}): ${await upstreamDetail(response)}`, response.status)
}
