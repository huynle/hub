// Pure logic for hands-free conversation mode (no DOM, no audio APIs): voice activity detection,
// endpointing, voice commands, sentence splitting, WAV encoding and the sentence speech queue.
// Imported by web/conversation.js in the browser and by bun tests.

// ---------- words ----------

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "eh", "ah", "hmm", "hm", "mm", "mmm", "mhm", "mm-hmm", "uh-huh"])
/** Words that leave a thought hanging when they end a transcript. */
const DANGLING = new Set([...FILLERS, "and", "but", "so", "or", "because", "cause", "then", "with", "to", "the", "a", "an", "of", "for", "if", "that", "like", "maybe"])
const COMMANDS = new Map([
  ["stop", "interrupt"],
  ["cancel", "interrupt"],
  ["never mind", "interrupt"],
  ["nevermind", "interrupt"],
  ["stop that", "interrupt"],
  ["hold on", "interrupt"],
  ["pause listening", "pause"],
])

/** Lowercase words without punctuation (apostrophes and inner hyphens kept). */
function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ""))
    .filter(Boolean)
}

/** "interrupt" for stop/cancel/never mind/stop that/hold on, "pause" for "pause listening", else undefined. */
export function parseCommand(text) {
  return COMMANDS.get(words(text).join(" "))
}

/** True when the transcript is empty or only filler words (um, uh, hmm…). */
export function isFiller(text) {
  return words(text).every((w) => FILLERS.has(w))
}

/** True when a transcript reads as a finished thought. */
export function looksComplete(text) {
  const trimmed = String(text ?? "").trim()
  const list = words(trimmed)
  if (!list.length || DANGLING.has(list[list.length - 1])) return false
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
export function splitSentences(text, { minChars = 4, maxChars = 300 } = {}) {
  const lines = String(text ?? "")
    .replace(/```[\s\S]*?(?:```|$)/g, "\n(code omitted)\n")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
  const sentences = lines.flatMap(splitLine)
  const merged = []
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

function splitLine(line) {
  const out = []
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

function cut(sentence, max) {
  const parts = []
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
export function resample(samples, from, to) {
  if (from === to) return Float32Array.from(samples)
  const length = Math.floor((samples.length * to) / from)
  const out = new Float32Array(length)
  const ratio = from / to
  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
      let sum = 0
      for (let j = start; j < end; j++) sum += samples[j]
      out[i] = sum / (end - start)
    }
  } else {
    for (let i = 0; i < length; i++) {
      const at = i * ratio
      const j = Math.floor(at)
      const next = samples[Math.min(j + 1, samples.length - 1)]
      out[i] = samples[j] + (next - samples[j]) * (at - j)
    }
  }
  return out
}

/** Encodes mono float samples at `rate` as a 16 kHz mono 16-bit PCM WAV file. */
export function encodeWav(samples, rate) {
  const pcm = resample(samples, rate, WAV_RATE)
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at, text) => {
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
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true)
  }
  return bytes
}

// ---------- voice activity detection ----------

const TRAILING_KEEP_MS = 200 // silence kept at the end of a segment
const ONSET_GAP_MS = 120 // dip tolerated while an onset is still being confirmed
const HYSTERESIS_DB = 4

/**
 * Energy VAD: frame RMS in dBFS against an adaptive noise floor (falls fast, rises slowly), with hysteresis.
 * "start" fires after `minSpeechMs` of voice (so short knocks and echo blips never count); "end" fires after
 * `endSilenceMs` of silence with the segment's samples, including `preRollMs` of audio from before the onset.
 */
export class EnergyVad {
  constructor({
    sampleRate,
    minSpeechMs = 250,
    endSilenceMs = 550,
    preRollMs = 300,
    maxSegmentMs = 60_000,
    marginDb = 10,
    minDb = -50,
    speakingBoostDb = 8,
  }) {
    Object.assign(this, { sampleRate, minSpeechMs, endSilenceMs, preRollMs, maxSegmentMs, marginDb, minDb, speakingBoostDb })
    this.speaking = false
    this.floor = undefined
    this.reset()
  }

  get active() {
    return this.state === "speech"
  }

  reset() {
    this.state = "silence"
    this.preroll = []
    this.frames = []
    this.segmentMs = 0
    this.voicedMs = 0
    this.gapMs = 0
    this.silenceMs = 0
  }

  process(input) {
    const frame = { samples: Float32Array.from(input), ms: (input.length / this.sampleRate) * 1000 }
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

    const events = []
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
        while (this.frames.length && this.frames[this.frames.length - 1].ms <= drop) drop -= this.frames.pop().ms
        events.push(this.finish(false))
      } else if (this.segmentMs >= this.maxSegmentMs) {
        events.push(this.finish(true))
      }
    }
    return { level, voiced, events }
  }

  finish(forced) {
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

const duration = (frames) => frames.reduce((ms, f) => ms + f.ms, 0)

function trimFront(frames, maxMs) {
  while (frames.length > 1 && duration(frames) - frames[0].ms >= maxMs) frames.shift()
}

// ---------- endpointing ----------

/**
 * Joins speculative per-segment transcripts into utterances. Segments are transcribed as soon as the VAD
 * ends them; transcripts are applied in segment order. Complete-looking text is sent at once; incomplete
 * text is held up to `holdMs`, and new speech during the hold cancels the timer so the next segment's
 * transcript is appended and re-evaluated. Fillers are dropped; a lone voice command is sent by itself
 * (dropping held text); an utterance reaching `maxUtteranceMs` of audio is sent as is.
 */
export class Endpointer {
  constructor({ send, holdMs = 1500, maxUtteranceMs = 60_000, onHeld, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { sendFn: send, holdMs, maxUtteranceMs, onHeld, setTimer, clearTimer })
    this.nextID = 1
    this.reset()
  }

  get held() {
    return this.text
  }

  reset() {
    this.cancelHold()
    this.pending = [] // [{ id, ms, text? }] in segment order
    this.text = ""
    this.ms = 0
    this.speaking = false
    this.onHeld?.("")
  }

  speechStarted() {
    this.speaking = true
    this.cancelHold()
  }

  segmentEnded(durationMs) {
    this.speaking = false
    const id = this.nextID++
    this.pending.push({ id, ms: durationMs })
    return id
  }

  transcribed(id, text) {
    const segment = this.pending.find((s) => s.id === id)
    if (!segment) return // reset since
    segment.text = String(text ?? "").replace(/\s+/g, " ").trim()
    while (this.pending[0]?.text !== undefined) this.apply(this.pending.shift())
    this.evaluate()
  }

  apply({ text, ms }) {
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

  evaluate() {
    this.onHeld?.(this.text)
    if (!this.text || this.speaking || this.pending.length) return
    this.cancelHold()
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.flush()
    }, this.holdMs)
  }

  flush() {
    this.cancelHold()
    const text = this.text
    this.text = ""
    this.ms = 0
    if (text) this.sendFn(text)
    this.onHeld?.("")
  }

  cancelHold() {
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
  }
}

// ---------- speech out ----------

/** Speaks sentences one after another, fetching at most one sentence ahead; `clear` is the barge-in. */
export class SpeechQueue {
  constructor({ synth, play, stop, onState, onError }) {
    Object.assign(this, { synth, play, stop, onState, onError })
    this.items = [] // [{ text, audio?: Promise }]
    this.generation = 0
    this.controller = new AbortController()
    this.speaking = false
    this.playing = false
  }

  enqueue(sentences) {
    for (const text of sentences) if (String(text ?? "").trim()) this.items.push({ text: String(text).trim() })
    if (!this.items.length) return
    if (!this.speaking) this.run(this.generation)
    else this.prefetch()
  }

  /** While a sentence plays, the next one is fetched; while one is being fetched, so is the one after it. */
  prefetch() {
    this.fetch(this.items[0])
    if (!this.playing) this.fetch(this.items[1])
  }

  clear() {
    this.generation++
    this.controller.abort()
    this.controller = new AbortController()
    this.items = []
    this.playing = false
    this.stop()
    this.setSpeaking(false)
  }

  fetch(item) {
    if (item && !item.audio) {
      item.audio = this.synth(item.text, this.controller.signal)
      item.audio.catch(() => {}) // handled when the item's turn comes
    }
  }

  async run(generation) {
    this.setSpeaking(true)
    while (generation === this.generation && this.items.length) {
      const item = this.items[0]
      this.prefetch()
      let audio
      try {
        audio = await item.audio
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

  setSpeaking(speaking) {
    if (speaking === this.speaking) return
    this.speaking = speaking
    this.onState?.(speaking)
  }
}

// ---------- transcript ----------

const MIN_OVERLAP = 12
const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim()

/** How a spoken "say" text relates to the agent bubble already streamed from deltas. */
export function reconcileSay(bubbleText, sayText) {
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

/** Transcript notes for subagent (non-root) sessions that started, finished, failed or got blocked. */
export function statusNotes(prev, next, rootID) {
  const before = new Map((prev ?? []).map((s) => [s.id, s]))
  const notes = []
  const name = (s) => `Subagent “${s.title || s.id}”`
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
