// Types for web/conversation-core.js (plain ES module used by the PWA without a build step).

export type Command = "interrupt" | "pause"

/** "interrupt" for stop/cancel/never mind/stop that/hold on, "pause" for "pause listening", else undefined. */
export function parseCommand(text: string): Command | undefined

/** True when the transcript is empty or only filler words (um, uh, hmm…). */
export function isFiller(text: string): boolean

/** True when a transcript reads as a finished thought (ends with . ? ! or has 3+ words without a trailing conjunction/filler). */
export function looksComplete(text: string): boolean

/**
 * Splits an agent reply into speakable sentences: one per line (list items included), sentence boundaries
 * within lines (abbreviations, decimals and file names respected), fenced code replaced by "(code omitted)",
 * fragments shorter than `minChars` (default 4) merged forward, sentences over `maxChars` (default 300) cut.
 */
export function splitSentences(text: string, options?: { minChars?: number; maxChars?: number }): string[]

export const WAV_RATE: 16000

/** Resamples mono audio (box-filter averaging down, linear interpolation up). Always returns a new array. */
export function resample(samples: ArrayLike<number>, from: number, to: number): Float32Array

/** Encodes mono float samples at `rate` as a 16 kHz mono 16-bit PCM WAV file (44-byte header). */
export function encodeWav(samples: ArrayLike<number>, rate: number): Uint8Array<ArrayBuffer>

export interface VadOptions {
  readonly sampleRate: number
  /** Voiced time before "start" fires (also the barge-in guard). Default 250. */
  readonly minSpeechMs?: number
  /** Silence that ends a segment. Default 550. */
  readonly endSilenceMs?: number
  /** Audio kept from before the onset. Default 300. */
  readonly preRollMs?: number
  /** Hard cap on one segment. Default 60000. */
  readonly maxSegmentMs?: number
  /** dB above the adaptive noise floor that counts as voice. Default 10. */
  readonly marginDb?: number
  /** Absolute minimum level (dBFS) that counts as voice. Default -50. */
  readonly minDb?: number
  /** Extra dB required while the app is speaking (echo guard). Default 8. */
  readonly speakingBoostDb?: number
}

export type VadEvent =
  | { readonly type: "start" }
  | { readonly type: "end"; readonly samples: Float32Array; readonly durationMs: number; readonly forced: boolean }

/** Energy VAD with adaptive noise floor, hysteresis, min-speech onset, pre-roll and silence endpointing. */
export class EnergyVad {
  constructor(options: VadOptions)
  /** True while the app is playing speech: raises the voice threshold. */
  speaking: boolean
  /** True between "start" and "end". */
  readonly active: boolean
  readonly sampleRate: number
  process(frame: Float32Array): { level: number; voiced: boolean; events: VadEvent[] }
  reset(): void
}

export interface EndpointerOptions {
  /** Receives each finished utterance (or a lone voice command). */
  readonly send: (text: string) => void
  /** How long an incomplete thought waits for more speech. Default 1500. */
  readonly holdMs?: number
  /** Utterance audio cap; reaching it sends at once. Default 60000. */
  readonly maxUtteranceMs?: number
  /** Called when the held text changes ("" when nothing is held). */
  readonly onHeld?: (text: string) => void
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (id: unknown) => void
}

/**
 * Joins speculative per-segment transcripts (applied in segment order) into utterances: complete-looking
 * text is sent at once, incomplete text is held up to `holdMs` (cancelled by new speech and re-evaluated
 * with the next segment's transcript), fillers are dropped, a lone command is sent alone and drops held text.
 */
export class Endpointer {
  constructor(options: EndpointerOptions)
  /** Text currently held waiting for more speech. */
  readonly held: string
  speechStarted(): void
  /** A segment of `durationMs` went to transcription; returns its id for `transcribed`. */
  segmentEnded(durationMs: number): number
  /** The transcript of segment `id` ("" when it failed or was empty). */
  transcribed(id: number, text: string): void
  reset(): void
}

export interface SpeechQueueOptions<A> {
  /** Fetches audio for one sentence (e.g. POST /api/speak); aborted on clear. */
  readonly synth: (text: string, signal: AbortSignal) => Promise<A>
  /** Plays audio; resolves when playback ends (or is stopped). */
  readonly play: (audio: A) => Promise<void>
  /** Stops current playback immediately. */
  readonly stop: () => void
  readonly onState?: (speaking: boolean) => void
  readonly onError?: (error: unknown, text: string) => void
}

/** Speaks sentences one after another, fetching at most one sentence ahead; `clear` is the barge-in. */
export class SpeechQueue<A = unknown> {
  constructor(options: SpeechQueueOptions<A>)
  readonly speaking: boolean
  enqueue(sentences: readonly string[]): void
  clear(): void
}

/**
 * How a spoken "say" text relates to the agent bubble already streamed from deltas: "keep" (already shown),
 * "update" (replace the bubble text with `text`), or "new" (add a bubble with `text`).
 */
export function reconcileSay(bubbleText: string, sayText: string): { mode: "keep" | "update" | "new"; text: string }

export interface StatusLike {
  readonly id: string
  readonly title: string
  readonly state: string
  readonly detail?: string
}

/** Transcript notes for subagent (non-root) sessions that started, finished, failed or got blocked. */
export function statusNotes(prev: readonly StatusLike[] | undefined, next: readonly StatusLike[], rootID: string): string[]
