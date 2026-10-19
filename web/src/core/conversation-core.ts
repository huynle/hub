// Pure logic for hands-free conversation mode (no DOM, no audio APIs): voice activity detection,
// endpointing, voice commands, sentence splitting, WAV encoding and the sentence speech queue.

// ---------- words ----------

export type Command = "interrupt" | "pause"

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "eh", "ah", "hmm", "hm", "mm", "mmm", "mhm", "mm-hmm", "uh-huh"])
/** Words that leave a thought hanging when they end a transcript. */
const DANGLING = new Set([...FILLERS, "and", "but", "so", "or", "because", "cause", "then", "with", "to", "the", "a", "an", "of", "for", "if", "that", "like", "maybe"])
const COMMANDS = new Map<string, Command>([
  ["stop", "interrupt"],
  ["cancel", "interrupt"],
  ["never mind", "interrupt"],
  ["nevermind", "interrupt"],
  ["stop that", "interrupt"],
  ["hold on", "interrupt"],
  ["pause listening", "pause"],
])

/** Lowercase words without punctuation (apostrophes and inner hyphens kept). */
function words(text: unknown): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ""))
    .filter(Boolean)
}

/** "interrupt" for stop/cancel/never mind/stop that/hold on, "pause" for "pause listening", else undefined. */
export function parseCommand(text: string): Command | undefined {
  return COMMANDS.get(words(text).join(" "))
}

/** True when the transcript is empty or only filler words (um, uh, hmm…). */
export function isFiller(text: string): boolean {
  return words(text).every((w) => FILLERS.has(w))
}

/** True when a transcript reads as a finished thought. */
export function looksComplete(text: string): boolean {
  const trimmed = String(text ?? "").trim()
  const list = words(trimmed)
  if (!list.length || DANGLING.has(list[list.length - 1]!)) return false
  if (/(\.\.\.|…|[,;:\-–—])["'”’)\]]*$/.test(trimmed)) return false
  if (/[.?!]["'”’)\]]*$/.test(trimmed)) return true
  return list.length >= 3
}

// ---------- sentences ----------

/** Tokens ending in "." that rarely end a sentence (compared lowercase). */
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "mr.", "mrs.", "ms.", "dr.", "st.", "vs.", "cf.", "prof.", "jr.", "sr.", "approx.", "no.", "fig."])
const SENTENCE_END = /[.?!…]+["'”’)\]]*(?=\s|$)/g

/**
 * Splits an agent reply into speakable sentences: one per line (list items included), sentence
 * boundaries within lines, fenced code replaced by "(code omitted)", fragments shorter than
 * `minChars` merged forward and sentences longer than `maxChars` cut at a comma or space.
 */
export function splitSentences(text: string, { minChars = 4, maxChars = 300 }: { minChars?: number; maxChars?: number } = {}): string[] {
  const lines = String(text ?? "")
    .replace(/```[\s\S]*?(?:```|$)/g, "\n(code omitted)\n")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
  const sentences = lines.flatMap(splitLine)
  const merged: string[] = []
  let carry = ""
  for (const sentence of sentences) {
    const joined = carry ? `${carry} ${sentence}` : sentence
    if (joined.length < minChars) carry = joined
    else {
      merged.push(joined)
      carry = ""
    }
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1] += ` ${carry}`
    else merged.push(carry)
  }
  return merged.flatMap((s) => cut(s, maxChars))
}

function splitLine(line: string): string[] {
  const out: string[] = []
  let start = 0
  for (const match of line.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    if (end >= line.length) break
    const next = line.slice(end).trimStart()[0] ?? ""
    if (!/[?!]/.test(match[0])) {
      const tokenStart = line.lastIndexOf(" ", match.index) + 1
      const token = line.slice(tokenStart, end).toLowerCase()
      const numbering = tokenStart === 0 && /^\d+[.)]$/.test(token) // "1." list marker
      if (ABBREVIATIONS.has(token.replace(/["'”’)\]]+$/, "")) || numbering || /\p{Ll}/u.test(next)) continue
    }
    out.push(line.slice(start, end).trim())
    start = end
  }
  const rest = line.slice(start).trim()
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

function cut(sentence: string, max: number): string[] {
  const parts: string[] = []
  let rest = sentence
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "))
    at = at > max / 2 ? at + 1 : window.lastIndexOf(" ")
    if (at <= 0) at = max
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

// ---------- audio ----------

export const WAV_RATE = 16_000

/** Resamples mono audio: box-filter averaging when downsampling (anti-aliasing), linear interpolation when upsampling. */
export function resample(samples: ArrayLike<number>, from: number, to: number): Float32Array {
  if (from === to) return Float32Array.from(samples)
  const length = Math.floor((samples.length * to) / from)
  const out = new Float32Array(length)
  const ratio = from / to
  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
      let sum = 0
      for (let j = start; j < end; j++) sum += samples[j]!
      out[i] = sum / (end - start)
    }
  } else {
    for (let i = 0; i < length; i++) {
      const at = i * ratio
      const j = Math.floor(at)
      const next = samples[Math.min(j + 1, samples.length - 1)]!
      out[i] = samples[j]! + (next - samples[j]!) * (at - j)
    }
  }
  return out
}

/** Encodes mono float samples at `rate` as a 16 kHz mono 16-bit PCM WAV file. */
export function encodeWav(samples: ArrayLike<number>, rate: number): Uint8Array<ArrayBuffer> {
  const pcm = resample(samples, rate, WAV_RATE)
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i)
  }
  ascii(0, "RIFF")
  view.setUint32(4, bytes.length - 8, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, WAV_RATE, true)
  view.setUint32(28, WAV_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!))
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true)
  }
  return bytes
}

// ---------- turn-taking timings ----------

/**
 * Voice mode's turn-taking timings, in one place. `minSpeechMs` of voice starts a segment (shorter knocks and
 * echo blips never count; it also delays barge-in), `endSilenceMs` of silence ends it (keeping `trailingKeepMs`
 * of that silence and `preRollMs` from before the onset), and the endpointer holds an unfinished-looking
 * transcript for `holdMs` waiting for more speech.
 */
export const VOICE_TIMINGS = Object.freeze({ minSpeechMs: 300, endSilenceMs: 350, trailingKeepMs: 200, preRollMs: 300, holdMs: 800 })

// ---------- voice activity detection ----------

const TRAILING_KEEP_MS = VOICE_TIMINGS.trailingKeepMs // silence kept at the end of a segment
const ONSET_GAP_MS = 120 // dip tolerated while an onset is still being confirmed
const HYSTERESIS_DB = 4

export interface VadOptions {
  readonly sampleRate: number
  readonly minSpeechMs?: number
  readonly endSilenceMs?: number
  readonly preRollMs?: number
  readonly maxSegmentMs?: number
  readonly marginDb?: number
  readonly minDb?: number
  readonly speakingBoostDb?: number
}

export type VadEvent =
  | { readonly type: "start" }
  | { readonly type: "end"; readonly samples: Float32Array; readonly durationMs: number; readonly forced: boolean }

interface Frame {
  samples: Float32Array
  ms: number
}

const duration = (frames: readonly Frame[]) => frames.reduce((ms, f) => ms + f.ms, 0)

function trimFront(frames: Frame[], maxMs: number): void {
  while (frames.length > 1 && duration(frames) - frames[0]!.ms >= maxMs) frames.shift()
}

/**
 * Energy VAD: frame RMS in dBFS against an adaptive noise floor (falls fast, rises slowly), with hysteresis.
 * "start" fires after `minSpeechMs` of voice (so short knocks and echo blips never count); "end" fires after
 * `endSilenceMs` of silence with the segment's samples, including `preRollMs` of audio from before the onset.
 */
export class EnergyVad {
  readonly sampleRate: number
  minSpeechMs: number
  endSilenceMs: number
  preRollMs: number
  maxSegmentMs: number
  marginDb: number
  minDb: number
  speakingBoostDb: number
  /** True while the app is playing speech: raises the voice threshold. */
  speaking = false
  floor: number | undefined = undefined
  state: "silence" | "onset" | "speech" = "silence"
  private preroll: Frame[] = []
  private frames: Frame[] = []
  private segmentMs = 0
  private voicedMs = 0
  private gapMs = 0
  private silenceMs = 0

  constructor({
    sampleRate,
    minSpeechMs = VOICE_TIMINGS.minSpeechMs,
    endSilenceMs = VOICE_TIMINGS.endSilenceMs,
    preRollMs = VOICE_TIMINGS.preRollMs,
    maxSegmentMs = 60_000,
    marginDb = 10,
    minDb = -50,
    speakingBoostDb = 8,
  }: VadOptions) {
    this.sampleRate = sampleRate
    this.minSpeechMs = minSpeechMs
    this.endSilenceMs = endSilenceMs
    this.preRollMs = preRollMs
    this.maxSegmentMs = maxSegmentMs
    this.marginDb = marginDb
    this.minDb = minDb
    this.speakingBoostDb = speakingBoostDb
    this.reset()
  }

  get active(): boolean {
    return this.state === "speech"
  }

  reset(): void {
    this.state = "silence"
    this.preroll = []
    this.frames = []
    this.segmentMs = 0
    this.voicedMs = 0
    this.gapMs = 0
    this.silenceMs = 0
  }

  process(input: ArrayLike<number>): { level: number; voiced: boolean; events: VadEvent[] } {
    const frame: Frame = { samples: Float32Array.from(input), ms: (input.length / this.sampleRate) * 1000 }
    let sum = 0
    for (const x of frame.samples) sum += x * x
    const db = 20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(1, input.length)), 1e-7))
    this.floor ??= db
    const on = Math.max(this.floor + this.marginDb, this.minDb) + (this.speaking ? this.speakingBoostDb : 0)
    const voiced = db >= (this.state === "speech" ? on - HYSTERESIS_DB : on)
    const level = Math.max(0, Math.min(1, (db - this.floor) / 36))
    // Noise floor: follow quiet frames quickly, louder ones slowly (slower still during speech).
    const rise = frame.ms / (this.state === "speech" ? 15_000 : 4_000)
    this.floor += (db - this.floor) * (db < this.floor ? 0.2 : Math.min(1, rise))

    const events: VadEvent[] = []
    if (this.state === "silence") {
      if (voiced) {
        this.state = "onset"
        this.frames = [...this.preroll, frame]
        this.segmentMs = duration(this.frames)
        this.preroll = []
        this.voicedMs = frame.ms
        this.gapMs = 0
      } else {
        this.preroll.push(frame)
        trimFront(this.preroll, this.preRollMs)
      }
    } else if (this.state === "onset") {
      this.frames.push(frame)
      this.segmentMs += frame.ms
      if (voiced) {
        this.voicedMs += frame.ms
        this.gapMs = 0
      } else if ((this.gapMs += frame.ms) > ONSET_GAP_MS) {
        this.preroll = this.frames
        trimFront(this.preroll, this.preRollMs)
        this.frames = []
        this.state = "silence"
      }
      if (this.state === "onset" && this.voicedMs >= this.minSpeechMs) {
        this.state = "speech"
        this.silenceMs = 0
        events.push({ type: "start" })
      }
    } else {
      this.frames.push(frame)
      this.segmentMs += frame.ms
      this.silenceMs = voiced ? 0 : this.silenceMs + frame.ms
      if (this.silenceMs >= this.endSilenceMs) {
        let drop = this.silenceMs - TRAILING_KEEP_MS
        while (this.frames.length && this.frames[this.frames.length - 1]!.ms <= drop) drop -= this.frames.pop()!.ms
        events.push(this.finish(false))
      } else if (this.segmentMs >= this.maxSegmentMs) {
        events.push(this.finish(true))
      }
    }
    return { level, voiced, events }
  }

  private finish(forced: boolean): VadEvent {
    const samples = new Float32Array(this.frames.reduce((n, f) => n + f.samples.length, 0))
    let at = 0
    for (const f of this.frames) {
      samples.set(f.samples, at)
      at += f.samples.length
    }
    this.reset()
    return { type: "end", samples, durationMs: (samples.length / this.sampleRate) * 1000, forced }
  }
}

// ---------- endpointing ----------

export interface EndpointerOptions {
  readonly send: (text: string) => void
  readonly holdMs?: number
  readonly maxUtteranceMs?: number
  readonly onHeld?: (text: string) => void
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (id: any) => void
}

/**
 * Joins speculative per-segment transcripts into utterances. Segments are transcribed as soon as the VAD
 * ends them; transcripts are applied in segment order. Complete-looking text is sent at once; incomplete
 * text is held up to `holdMs`, and new speech during the hold cancels the timer so the next segment's
 * transcript is appended and re-evaluated. Fillers are dropped; a lone voice command is sent by itself
 * (dropping held text); an utterance reaching `maxUtteranceMs` of audio is sent as is.
 */
export class Endpointer {
  private sendFn: (text: string) => void
  private holdMs: number
  private maxUtteranceMs: number
  private onHeld?: (text: string) => void
  private setTimer: (fn: () => void, ms: number) => unknown
  private clearTimer: (id: any) => void
  private nextID = 1
  private pending: Array<{ id: number; ms: number; text?: string }> = []
  private text = ""
  private ms = 0
  private speaking = false
  private timer: unknown

  constructor({ send, holdMs = VOICE_TIMINGS.holdMs, maxUtteranceMs = 60_000, onHeld, setTimer = setTimeout, clearTimer = clearTimeout }: EndpointerOptions) {
    this.sendFn = send
    this.holdMs = holdMs
    this.maxUtteranceMs = maxUtteranceMs
    this.onHeld = onHeld
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.reset()
  }

  /** Text currently held waiting for more speech. */
  get held(): string {
    return this.text
  }

  reset(): void {
    this.cancelHold()
    this.pending = []
    this.text = ""
    this.ms = 0
    this.speaking = false
    this.onHeld?.("")
  }

  speechStarted(): void {
    this.speaking = true
    this.cancelHold()
  }

  /** A segment of `durationMs` went to transcription; returns its id for `transcribed`. */
  segmentEnded(durationMs: number): number {
    this.speaking = false
    const id = this.nextID++
    this.pending.push({ id, ms: durationMs })
    return id
  }

  /** The transcript of segment `id` ("" when it failed or was empty). */
  transcribed(id: number, text: string): void {
    const segment = this.pending.find((s) => s.id === id)
    if (!segment) return // reset since
    segment.text = String(text ?? "").replace(/\s+/g, " ").trim()
    while (this.pending[0]?.text !== undefined) this.apply(this.pending.shift() as { text: string; ms: number })
    this.evaluate()
  }

  private apply({ text, ms }: { text: string; ms: number }): void {
    if (parseCommand(text)) {
      this.cancelHold()
      this.text = ""
      this.ms = 0
      this.sendFn(text)
      return
    }
    if (isFiller(text)) return
    this.text = this.text ? `${this.text} ${text}` : text
    this.ms += ms
    if (looksComplete(this.text) || this.ms >= this.maxUtteranceMs) this.flush()
  }

  private evaluate(): void {
    this.onHeld?.(this.text)
    if (!this.text || this.speaking || this.pending.length) return
    this.cancelHold()
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.flush()
    }, this.holdMs)
  }

  private flush(): void {
    this.cancelHold()
    const text = this.text
    this.text = ""
    this.ms = 0
    if (text) this.sendFn(text)
    this.onHeld?.("")
  }

  private cancelHold(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
  }
}

// ---------- speech out ----------

export interface SpeechQueueOptions<A> {
  readonly synth: (text: string, signal: AbortSignal) => Promise<A>
  readonly play: (audio: A) => Promise<void>
  readonly stop: () => void
  readonly onState?: (speaking: boolean) => void
  readonly onError?: (error: any, text: string) => void
}

/** Sentences synthesized ahead of the one playing (or of the one being fetched for playback). */
const PREFETCH_AHEAD = 2

/** Speaks sentences one after another, fetching up to two sentences ahead; `clear` is the barge-in. */
export class SpeechQueue<A = unknown> {
  private synth: SpeechQueueOptions<A>["synth"]
  private play: SpeechQueueOptions<A>["play"]
  private stop: SpeechQueueOptions<A>["stop"]
  private onState?: SpeechQueueOptions<A>["onState"]
  private onError?: SpeechQueueOptions<A>["onError"]
  private items: Array<{ text: string; audio?: Promise<A> }> = []
  private generation = 0
  private controller = new AbortController()
  speaking = false
  private playing = false

  constructor({ synth, play, stop, onState, onError }: SpeechQueueOptions<A>) {
    this.synth = synth
    this.play = play
    this.stop = stop
    this.onState = onState
    this.onError = onError
  }

  enqueue(sentences: readonly string[]): void {
    for (const text of sentences) if (String(text ?? "").trim()) this.items.push({ text: String(text).trim() })
    if (!this.items.length) return
    if (!this.speaking) void this.run(this.generation)
    else this.prefetch()
  }

  /** While a sentence plays, the next two are fetched; while one is being fetched, so are the two after it. */
  private prefetch(): void {
    for (const item of this.items.slice(0, this.playing ? PREFETCH_AHEAD : PREFETCH_AHEAD + 1)) this.fetch(item)
  }

  clear(): void {
    this.generation++
    this.controller.abort()
    this.controller = new AbortController()
    this.items = []
    this.playing = false
    this.stop()
    this.setSpeaking(false)
  }

  private fetch(item: { text: string; audio?: Promise<A> } | undefined): void {
    if (item && !item.audio) {
      item.audio = this.synth(item.text, this.controller.signal)
      item.audio.catch(() => {}) // handled when the item's turn comes
    }
  }

  private async run(generation: number): Promise<void> {
    this.setSpeaking(true)
    while (generation === this.generation && this.items.length) {
      const item = this.items[0]!
      this.prefetch()
      let audio: A
      try {
        audio = await (item.audio as Promise<A>)
      } catch (error) {
        if (generation !== this.generation) return
        this.items.shift()
        this.onError?.(error, item.text)
        continue
      }
      if (generation !== this.generation) return
      this.items.shift()
      this.playing = true
      this.prefetch()
      try {
        await this.play(audio)
      } catch (error) {
        if (generation === this.generation) this.onError?.(error, item.text)
      } finally {
        if (generation === this.generation) this.playing = false
      }
    }
    if (generation === this.generation) this.setSpeaking(false)
  }

  private setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return
    this.speaking = speaking
    this.onState?.(speaking)
  }
}

// ---------- incremental speech ----------

/** An SSE say: root text comes one sentence at a time (`seq` per message text part); worker results whole. */
export interface SayInput {
  readonly messageID?: string
  readonly ordinal?: number
  readonly seq?: number
  readonly text: string
}

interface SayPart {
  next: number
  held: Map<number, string>
  texts: string[]
  muted: boolean
}

/**
 * Orders and dedupes incremental says. `accept` returns the sentences to speak now (in order, each through
 * splitSentences so code becomes "(code omitted)") and the text part so far for the transcript bubble, or
 * undefined for a duplicate or a sentence waiting for an earlier one. `mute` (barge-in) silences the rest of
 * the replies heard so far; later replies speak normally.
 */
export class SayAssembler {
  private parts = new Map<string, SayPart>()
  private limit: number

  constructor({ limit = 50 }: { limit?: number } = {}) {
    this.limit = limit
  }

  get size(): number {
    return this.parts.size
  }

  accept(say: SayInput): { sentences: string[]; text: string } | undefined {
    const text = String(say.text ?? "")
    if (typeof say.seq !== "number") return { sentences: splitSentences(text), text }
    const key = `${say.messageID ?? ""} ${say.ordinal ?? 0}`
    let part = this.parts.get(key)
    if (!part) {
      part = { next: 0, held: new Map(), texts: [], muted: false }
      this.parts.set(key, part)
      if (this.parts.size > this.limit) this.parts.delete(this.parts.keys().next().value!)
    }
    if (say.seq < part.next || part.held.has(say.seq)) return undefined
    part.held.set(say.seq, text)
    const released: string[] = []
    while (part.held.has(part.next)) {
      released.push(part.held.get(part.next)!)
      part.held.delete(part.next++)
    }
    if (!released.length) return undefined
    part.texts.push(...released)
    return { sentences: part.muted ? [] : released.flatMap((s) => splitSentences(s)), text: part.texts.join(" ") }
  }

  mute(): void {
    for (const part of this.parts.values()) part.muted = true
  }
}

// ---------- turn timing ----------

/** Steps of a Voice turn, in order: the user stops speaking … the reply starts playing. */
export type TurnMark = "speechEnd" | "transcript" | "accepted" | "firstSay" | "firstAudio"
export type Turn = Readonly<Partial<Record<TurnMark, number>>>

/**
 * Times one Voice turn at a time. Speech end and transcript wait for the utterance to be accepted (the latest
 * segment counts); then the first say and the first reply audio complete it into `last`. Marks out of order
 * (a subagent's say with no turn waiting) are ignored.
 */
export class TurnTimer {
  private pending: Partial<Record<TurnMark, number>> = {}
  private turn: Partial<Record<TurnMark, number>> | undefined
  last: Turn | undefined

  /** Records a step; true when it was recorded. */
  mark(name: TurnMark, at: number): boolean {
    switch (name) {
      case "speechEnd":
        this.pending = { speechEnd: at }
        return true
      case "transcript":
        if (this.pending.speechEnd === undefined) return false
        this.pending.transcript = at
        return true
      case "accepted":
        this.turn = { ...this.pending, accepted: at }
        this.pending = {}
        return true
      case "firstSay":
        if (!this.turn || this.turn.firstSay !== undefined) return false
        this.turn.firstSay = at
        return true
      case "firstAudio":
        if (this.turn?.firstSay === undefined) return false
        this.last = { ...this.turn, firstAudio: at }
        this.turn = undefined
        return true
    }
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** "last turn: 1.8 s to first audio" and the steps (for the Voice bar's tooltip). */
export function describeTurn(turn: Turn | undefined): { summary: string; detail: string } | undefined {
  const start = turn?.speechEnd ?? turn?.accepted
  if (!turn || start === undefined || turn.firstAudio === undefined) return undefined
  const steps: Array<[TurnMark, string]> = [
    ["transcript", "transcript"],
    ["accepted", "accepted"],
    ["firstSay", "first reply"],
    ["firstAudio", "audio"],
  ]
  const parts: string[] = []
  let previous = start
  for (const [mark, label] of steps) {
    const at = turn[mark]
    if (at === undefined || (mark === "accepted" && turn.speechEnd === undefined)) continue
    parts.push(`${label} ${seconds(at - previous)}`)
    previous = at
  }
  return { summary: `last turn: ${seconds(turn.firstAudio - start)} to first audio`, detail: parts.join(" · ") }
}

// ---------- transcript ----------

const MIN_OVERLAP = 12
const squash = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim()

/** How a spoken "say" text relates to the agent bubble already streamed from deltas. */
export function reconcileSay(bubbleText: string, sayText: string): { mode: "keep" | "update" | "new"; text: string } {
  const bubble = squash(bubbleText)
  const say = squash(sayText)
  if (!bubble) return { mode: "new", text: sayText }
  if (bubble.includes(say)) return { mode: "keep", text: bubbleText }
  if (say.startsWith(bubble)) return { mode: "update", text: sayText }
  // The bubble ends with the start of this text (an earlier part, then this one partially streamed).
  for (let k = Math.min(bubble.length, say.length - 1); k >= MIN_OVERLAP; k--) {
    if (bubble.endsWith(say.slice(0, k))) return { mode: "update", text: bubble + say.slice(k) }
  }
  return { mode: "new", text: sayText }
}

export interface StatusLike {
  readonly id: string
  readonly title?: string
  readonly state: string
  readonly detail?: string
}

/** Transcript notes for subagent (non-root) sessions that started, finished, failed or got blocked. */
export function statusNotes(prev: readonly StatusLike[] | undefined, next: readonly StatusLike[], rootID: string): string[] {
  const before = new Map((prev ?? []).map((s) => [s.id, s]))
  const notes: string[] = []
  const name = (s: StatusLike) => `Subagent “${s.title || s.id}”`
  for (const s of next) {
    if (s.id === rootID) continue
    const was = before.get(s.id)?.state
    before.delete(s.id)
    if (s.state === was) continue
    if (s.state === "working") notes.push(`${name(s)} is working`)
    else if (s.state === "error") notes.push(`${name(s)} failed${s.detail ? `: ${s.detail}` : ""}`)
    else if (s.state === "blocked") notes.push(`${name(s)} needs you`)
    else if (was === "working" || was === "blocked") notes.push(`${name(s)} finished`)
  }
  for (const s of before.values()) {
    if (s.id !== rootID && (s.state === "working" || s.state === "blocked")) notes.push(`${name(s)} finished`)
  }
  return notes
}
