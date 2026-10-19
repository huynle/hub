// Voice mode's junk transcript filter (pure). Speech-to-text models, Whisper especially, turn noise and silence
// into stock phrases ("Thank you.", "you", "Thanks for watching!", "Subtitles by the Amara.org community",
// "[Music]" …). Such transcripts, and one or two words from a blip of sound, are dropped before they reach the
// agent; short answers and commands ("yes", "no", "stop", "go ahead", "cancel that") are always kept.

/** Less voiced speech than this, with at most two words and no command word, reads as a blip of noise. */
export const SHORT_SPEECH_MS = 400

/** Words that make a short transcript a real answer or command. */
const KEEP_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "no", "nope", "nah", "ok", "okay", "sure", "right", "correct",
  "stop", "cancel", "wait", "pause", "hold", "go", "continue", "next", "done", "again", "undo", "never", "nevermind", "do", "please", "thanks",
])

/** Whole transcripts (normalized) that are stock speech-to-text output for noise or silence. */
const NOISE_PHRASES = new Set([
  "you",
  "bye",
  "bye bye",
  "thank you",
  "thank you very much",
  "thank you so much",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching and see you next time",
  "thank you for watching and see you next time",
  "thanks for listening",
  "thank you for listening",
  "see you next time",
  "see you in the next video",
  "please subscribe",
  "please subscribe to my channel",
  "like and subscribe",
  "the end",
  // Whisper's silence output in other languages
  "ご視聴ありがとうございました",
  "продолжение следует",
  "字幕由amara org社区提供",
  "untertitel im auftrag des zdf für funk 2017",
])

/** Credits lines Whisper learned from subtitled videos. */
const CREDITS = [/^(?:subtitles?|captions?|subtitled|captioned|transcribed|transcription|translated|translation)\b.*\bby\b/, /\bamara\s*\.?\s*org\b/, /^sous-titr/, /^untertitel\b/]

/** "[Music]", "(applause)", "*coughs*", "♪ la la ♪": a sound described, not words said. */
const SOUND_TAG = /^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪[^♪]*♪|\s)+$/u

/** Lowercase words without punctuation (apostrophes kept), joined by single spaces. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Why a transcript should be dropped ("empty", "no words", "sound", "too short", "noise", "repeated", "short"),
 * or undefined to keep it. `speechMs`: the segment's voiced time (the length rule applies only when known).
 */
export function junkTranscript(text: string, { speechMs }: { speechMs?: number } = {}): string | undefined {
  const raw = String(text ?? "").trim()
  if (!raw) return "empty"
  if (!/[\p{L}\p{N}]/u.test(raw)) return "no words"
  if (SOUND_TAG.test(raw)) return "sound"
  const phrase = normalize(raw)
  if (phrase.replace(/\s/g, "").length < 2) return "too short"
  if (NOISE_PHRASES.has(phrase) || NOISE_PHRASES.has(phrase.replace(/ /g, "")) || CREDITS.some((re) => re.test(phrase) || re.test(raw.toLowerCase()))) return "noise"
  const words = phrase.split(" ")
  const kept = words.some((w) => KEEP_WORDS.has(w))
  if (words.length > 1 && words.every((w) => w === words[0]) && !kept) return "repeated"
  if (speechMs !== undefined && speechMs < SHORT_SPEECH_MS && words.length <= 2 && !kept) return "short"
  return undefined
}
