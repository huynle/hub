// Speech provider interface shared by OpenRouter and OpenAI-compatible endpoints, the typed upstream
// error (mapped to 502 by the hub), audio format detection, and the speed-retry rule.

/** Speech-to-text and text-to-speech against one configured provider. */
export interface SpeechProvider {
  transcribe(audio: Uint8Array, format: string, signal?: AbortSignal): Promise<string>
  /** MP3 audio. `speed` is optional; providers that reject it get one retry without it. */
  speak(text: string, speed?: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
  /** The same MP3 as a stream, passed through as the provider sends it (errors are thrown before any byte). */
  speakStream(text: string, speed?: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>
}

/** A successful upstream response's body (an empty stream when it has none). */
export function audioBody(response: Response): ReadableStream<Uint8Array> {
  return response.body ?? new ReadableStream({ start: (controller) => controller.close() })
}

/** Reads a whole audio stream into one buffer. */
export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The speech provider refused or failed a request (or is not configured). Never carries the API key. */
export class SpeechError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "SpeechError"
  }
}

const FORMATS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
}

const MIME: Record<string, string> = {
  webm: "audio/webm",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
}

/** Maps a browser recording's Content-Type to an audio format name (webm, m4a, wav, ...). */
export function audioFormat(contentType: string | null | undefined): string | undefined {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase()
  return mime ? FORMATS[mime] : undefined
}

/** Content type for an audio format name. */
export const audioMime = (format: string): string => MIME[format] ?? "application/octet-stream"

/** Upstream error message: the JSON `error.message` when present, else the body, capped. */
export async function upstreamDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "")
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof parsed.error === "string") return parsed.error.slice(0, 300)
    if (parsed.error?.message) return String(parsed.error.message).slice(0, 300)
    if (typeof parsed.message === "string") return parsed.message.slice(0, 300)
  } catch {}
  return raw.slice(0, 300)
}

/** Sends with `speed`; when that is refused with 400, sends once more without it. */
export async function withSpeedRetry(send: (speed?: number) => Promise<Response>, speed?: number): Promise<Response> {
  const response = await send(speed)
  if (response.status !== 400 || speed === undefined) return response
  await response.body?.cancel().catch(() => {})
  return send(undefined)
}
