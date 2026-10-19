// OpenRouter speech-to-text (/audio/transcriptions as OpenAI-style multipart: the audio goes up as binary,
// not as base64 JSON, a third smaller and no encoding) and text-to-speech (/audio/speech).
import { audioBody, audioMime, collect, SpeechError, transcriptText, upstreamDetail, wantsVerbose, withSpeedRetry, withVerboseRetry, type SpeechProvider } from "./provider"

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
  /** Ask for verbose_json (a Whisper model whose provider has not refused it). */
  private verbose: boolean

  constructor(private readonly options: OpenRouterOptions) {
    this.baseURL = options.baseURL ?? OPENROUTER_BASE_URL
    this.fetch = options.fetch ?? globalThis.fetch
    this.verbose = wantsVerbose(options.sttModel)
  }

  async transcribe(audio: Uint8Array, format: string, signal?: AbortSignal): Promise<string> {
    const { sttModel: model, language } = this.options
    // OpenRouter documents multipart file/model/language (up to 25 MB; an utterance is at most ~2 MB of WAV), and
    // response_format verbose_json (segments with Whisper's no_speech_prob) for OpenAI-compatible providers.
    const send = (verbose: boolean) => {
      const form = new FormData()
      form.append("file", new File([new Uint8Array(audio)], `audio.${format}`, { type: audioMime(format) }))
      form.append("model", model)
      if (language) form.append("language", language)
      if (verbose) form.append("response_format", "verbose_json")
      return this.post("/audio/transcriptions", form, signal)
    }
    const response = await withVerboseRetry(send, this.verbose, () => (this.verbose = false))
    if (!response.ok) throw await failure("transcription", response)
    return transcriptText(await response.json())
  }

  async speak(text: string, speed?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    return collect(await this.speakStream(text, speed, signal))
  }

  async speakStream(text: string, speed?: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const { ttsModel: model, voice } = this.options
    const response = await withSpeedRetry(
      (s) =>
        this.post("/audio/speech", { model, input: text, voice, response_format: "mp3", ...(s !== undefined ? { speed: s } : {}) }, signal),
      speed,
    )
    if (!response.ok) throw await failure("speech", response)
    return audioBody(response)
  }

  /** POSTs JSON, or a form as multipart (fetch sets its content type with the boundary). */
  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const key = await this.options.apiKey()
    if (!key) {
      throw new OpenRouterError(
        "No OpenRouter API key: set one in the speech settings, set OPENROUTER_API_KEY, or connect OpenRouter in OpenCode",
      )
    }
    const form = body instanceof FormData
    return this.fetch(`${this.baseURL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, ...(form ? {} : { "content-type": "application/json" }) },
      body: form ? body : JSON.stringify(body),
      signal,
    })
  }
}

async function failure(kind: string, response: Response): Promise<OpenRouterError> {
  return new OpenRouterError(`OpenRouter ${kind} failed (${response.status}): ${await upstreamDetail(response)}`, response.status)
}
