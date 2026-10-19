// OpenAI-compatible speech endpoints (OpenAI, Groq, local whisper/kokoro servers, ...):
// STT as multipart POST {baseURL}/audio/transcriptions (file, model, language?), TTS as
// POST {baseURL}/audio/speech {model, input, voice, response_format: "mp3", speed?}.
import { audioBody, audioMime, collect, SpeechError, transcriptText, upstreamDetail, wantsVerbose, withSpeedRetry, withVerboseRetry, type SpeechProvider } from "./provider"

export interface OpenAICompatibleOptions {
  /** Base URL including the version path, e.g. https://api.openai.com/v1 (no trailing slash). */
  readonly baseURL: string
  /** Optional: local servers often need no key. */
  readonly apiKey: () => Promise<string | undefined>
  readonly sttModel: string
  readonly ttsModel: string
  readonly voice: string
  readonly language?: string
  readonly fetch?: typeof globalThis.fetch
}

export class OpenAICompatible implements SpeechProvider {
  private readonly fetch: typeof globalThis.fetch
  /** Ask for verbose_json (a Whisper model whose server has not refused it). */
  private verbose: boolean

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.verbose = wantsVerbose(options.sttModel)
  }

  async transcribe(audio: Uint8Array, format: string, signal?: AbortSignal): Promise<string> {
    const headers = await this.headers()
    const send = (verbose: boolean) => {
      const form = new FormData()
      form.append("file", new File([new Uint8Array(audio)], `audio.${format}`, { type: audioMime(format) }))
      form.append("model", this.options.sttModel)
      if (this.options.language) form.append("language", this.options.language)
      // Whisper's verbose_json rates each segment's no_speech_prob: noise transcribed as "Thank you." is dropped.
      if (verbose) form.append("response_format", "verbose_json")
      return this.fetch(`${this.options.baseURL}/audio/transcriptions`, { method: "POST", headers, body: form, signal })
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
    const headers = { ...(await this.headers()), "content-type": "application/json" }
    const response = await withSpeedRetry(
      (s) =>
        this.fetch(`${this.options.baseURL}/audio/speech`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, input: text, voice, response_format: "mp3", ...(s !== undefined ? { speed: s } : {}) }),
          signal,
        }),
      speed,
    )
    if (!response.ok) throw await failure("speech", response)
    return audioBody(response)
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.options.apiKey()
    return key ? { authorization: `Bearer ${key}` } : {}
  }
}

async function failure(kind: string, response: Response): Promise<SpeechError> {
  return new SpeechError(`Speech provider ${kind} failed (${response.status}): ${await upstreamDetail(response)}`, response.status)
}
