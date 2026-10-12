export interface VoiceOptions {
  readonly host: string
  readonly port: number
  /** Base URL used in /voice links when the page is reached through a proxy (e.g. tailscale serve). */
  readonly publicURL?: string
  readonly sttModel: string
  readonly ttsModel: string
  readonly voice: string
  /** Fallback when neither the OpenCode openrouter integration nor OPENROUTER_API_KEY is set. */
  readonly apiKey?: string
  readonly maxAudioBytes: number
  readonly maxSpeechChars: number
  readonly turnTimeoutMs: number
}

const string = (value: unknown, fallback: string) => (typeof value === "string" && value ? value : fallback)
const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback

export function parseOptions(raw: Readonly<Record<string, unknown>>): VoiceOptions {
  return {
    host: string(raw.host, "127.0.0.1"),
    port: positive(raw.port, 4097),
    ...(typeof raw.publicURL === "string" && raw.publicURL ? { publicURL: raw.publicURL.replace(/\/+$/, "") } : {}),
    sttModel: string(raw.sttModel, "openai/gpt-4o-mini-transcribe"),
    ttsModel: string(raw.ttsModel, "microsoft/mai-voice-2.1-flash"),
    voice: string(raw.voice, "en-US-Harper:MAI-Voice-2.1-Flash"),
    ...(typeof raw.apiKey === "string" && raw.apiKey ? { apiKey: raw.apiKey } : {}),
    maxAudioBytes: positive(raw.maxAudioBytes, 10 * 1024 * 1024),
    maxSpeechChars: positive(raw.maxSpeechChars, 800),
    turnTimeoutMs: positive(raw.turnTimeoutMs, 10 * 60 * 1000),
  }
}
