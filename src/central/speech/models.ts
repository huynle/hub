// Speech model lists of OpenAI-compatible providers. Their GET /models usually lists every model of the
// gateway (chat, image, embedding, music…) without a speech filter, so the models are classified here: speech-
// to-text by name ("transcribe", "whisper", "stt", "asr") or as audio-in/text-out audio models; text-to-speech by
// name ("tts", "text-to-speech", "speech", "voice") or by speech/audio output, never music or audio chat models.
// The configured model is always offered first (gateways may serve models they do not list), and when nothing is
// labeled for a kind the full list is shown with a note.

export type SpeechModelKind = "stt" | "tts"

export interface SpeechModelInfo {
  readonly id: string
  readonly name: string
  /** The model configured for this kind right now. */
  readonly current?: true
}

export interface SpeechModelList {
  readonly models: SpeechModelInfo[]
  /** Set when the list could not be narrowed to speech models. */
  readonly note?: string
}

export const SPEECH_UNLABELED_NOTE = "This provider doesn't label speech models; showing all"

const STT_NAME = /transcri|whisper|(^|[^a-z])stt|speech-to-text|(^|[^a-z])asr/i
const TTS_NAME = /(^|[^a-z])tts|text-to-speech|speech(?!-to-text)|voice/i
const EXPLICIT_TTS = /(^|[^a-z])tts|text-to-speech/i
const MUSIC = /lyria|music|gpt-audio\b/i
const NOT_SPEECH_TYPES = new Set(["chat", "embedding", "image", "rerank"])

interface RawModel {
  readonly id: string
  readonly name: string
  readonly type?: string
  readonly output: readonly string[] | undefined
}

const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : undefined)

/** `{data: [{id, name?, type?, output_modalities?}]}` entries with an id. */
function rawModels(body: unknown): RawModel[] {
  const data = (body as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) return []
  const out: RawModel[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    const e = entry as Record<string, unknown> | null
    const id = typeof e?.id === "string" ? e.id : ""
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = typeof e!.name === "string" && e!.name ? e!.name : id
    out.push({ id, name, ...(typeof e!.type === "string" ? { type: e!.type.toLowerCase() } : {}), output: strings(e!.output_modalities) })
  }
  return out
}

function isStt(model: RawModel): boolean {
  if (model.type && NOT_SPEECH_TYPES.has(model.type)) return false
  const label = `${model.id} ${model.name}`
  if (STT_NAME.test(label) || model.output?.includes("transcription")) return true
  // Unlabeled audio models that only answer with text (nova, parakeet, chirp…).
  return model.type === "audio" && !TTS_NAME.test(label) && !MUSIC.test(label) && (!model.output || model.output.every((x) => x === "text"))
}

function isTts(model: RawModel): boolean {
  if (model.type && NOT_SPEECH_TYPES.has(model.type)) return false
  const label = `${model.id} ${model.name}`
  if (STT_NAME.test(label)) return false
  if (MUSIC.test(label) && !EXPLICIT_TTS.test(label)) return false
  if (TTS_NAME.test(label) || model.output?.includes("speech")) return true
  return model.type === "audio" && !!model.output?.includes("audio")
}

/** The models of `kind` in a provider's /models answer, with the configured model `current` first. */
export function speechModelList(kind: SpeechModelKind, body: unknown, current: string): SpeechModelList {
  const all = rawModels(body)
  const matching = all.filter(kind === "stt" ? isStt : isTts)
  const unlabeled = all.length > 0 && matching.length === 0
  return withCurrent((unlabeled ? all : matching).map(({ id, name }) => ({ id, name })), current, unlabeled ? SPEECH_UNLABELED_NOTE : undefined)
}

/** Puts the configured model first, marked current (added when the list does not have it). */
export function withCurrent(models: readonly SpeechModelInfo[], current: string, note?: string): SpeechModelList {
  const id = current.trim()
  const rest = models.filter((m) => m.id !== id).map(({ id, name }) => ({ id, name }))
  const found = models.find((m) => m.id === id)
  const list = id ? [{ id, name: found?.name ?? id, current: true as const }, ...rest] : rest
  return { models: list, ...(note ? { note } : {}) }
}
