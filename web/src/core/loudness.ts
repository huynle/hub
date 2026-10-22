// Loudness of speech clips (pure; tested with bun). Progress cue phrases are short TTS clips whose loudness
// varies by several dB from phrase to phrase and from the spoken replies, so each cue is measured (ITU-R
// BS.1770 K-weighted, gated loudness, mono), trimmed of long leading/trailing silence, gained to the replies'
// loudness (the peak kept at or below −1 dBFS) and re-encoded as a 16-bit mono WAV. The target is the running
// median of measured replies per TTS voice (localStorage), −19.5 LUFS until replies were measured.
// The browser side (decoding) is in web/src/voice/cue-loudness.ts.

/** Highest sample peak a normalised cue may reach, in dBFS. */
export const CEILING_DB = -1
/** Loudness of the replies of the default voice (measured: −19…−20 LUFS) until replies are measured here. */
export const DEFAULT_TARGET_LUFS = -19.5
/** A measured reply target is clamped to this range (a broken measurement must not blast or mute cues). */
export const MIN_TARGET_LUFS = -26
export const MAX_TARGET_LUFS = -14
/** Leading/trailing silence kept around the speech (the rest is trimmed: cues start sooner). */
export const KEEP_SILENCE_MS = 80
/** Samples quieter than this are silence for trimming. */
const SILENCE_DB = -50
/** Never gain a cue up by more than this (a near-silent clip is noise, not speech). */
const MAX_GAIN_DB = 20

const BLOCK_S = 0.4
const STEP_S = 0.1
const ABSOLUTE_GATE = -70
const RELATIVE_GATE = -10

const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity)
const energyToLufs = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity)

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number }

/** The two K-weighting stages (shelf, then high-pass) for any sample rate (coefficients as in libebur128). */
function kWeighting(rate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / rate)
  const Vh = 10 ** (G / 20)
  const Vb = Vh ** 0.4996667741545416
  let a0 = 1 + K / Q + K * K
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / rate)
  a0 = 1 + K / Q + K * K
  const highPass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }
  return [shelf, highPass]
}

function filter(input: ArrayLike<number>, f: Biquad): Float64Array {
  const out = new Float64Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i]!
    const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

/** Integrated loudness of mono samples in LUFS (BS.1770 gating); −Infinity for silence. */
export function loudness(samples: ArrayLike<number>, rate: number): number {
  if (!samples.length) return -Infinity
  const [shelf, highPass] = kWeighting(rate)
  const weighted = filter(filter(samples, shelf), highPass)
  // Prefix sums of squares: each 400 ms block's energy in O(1).
  const sums = new Float64Array(weighted.length + 1)
  for (let i = 0; i < weighted.length; i++) sums[i + 1] = sums[i]! + weighted[i]! * weighted[i]!
  const block = Math.round(BLOCK_S * rate)
  const step = Math.round(STEP_S * rate)
  if (weighted.length < block) {
    // Shorter than one gating block: the whole clip is the block.
    const meanSquare = sums[weighted.length]! / weighted.length
    const lufs = energyToLufs(meanSquare)
    return lufs > ABSOLUTE_GATE ? lufs : -Infinity
  }
  const energies: number[] = []
  for (let start = 0; start + block <= weighted.length; start += step) {
    const energy = (sums[start + block]! - sums[start]!) / block
    if (energyToLufs(energy) > ABSOLUTE_GATE) energies.push(energy)
  }
  if (!energies.length) return -Infinity
  const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length
  const threshold = energyToLufs(mean(energies)) + RELATIVE_GATE
  const kept = energies.filter((e) => energyToLufs(e) > threshold)
  return energyToLufs(mean(kept.length ? kept : energies))
}

/** Largest absolute sample in dBFS; −Infinity for silence. */
export function peakDb(samples: ArrayLike<number>): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!))
  return toDb(peak)
}

/** Drops leading and trailing silence beyond `KEEP_SILENCE_MS`; silence alone is returned unchanged. */
export function trimSilence(samples: Float32Array, rate: number): Float32Array {
  const threshold = 10 ** (SILENCE_DB / 20)
  let first = 0
  while (first < samples.length && Math.abs(samples[first]!) <= threshold) first++
  if (first === samples.length) return samples
  let last = samples.length - 1
  while (last > first && Math.abs(samples[last]!) <= threshold) last--
  const pad = Math.round((KEEP_SILENCE_MS / 1000) * rate)
  const start = Math.max(0, first - pad)
  const end = Math.min(samples.length, last + 1 + pad)
  return start === 0 && end === samples.length ? samples : samples.slice(start, end)
}

export interface NormalizedCue {
  samples: Float32Array
  /** Gain applied, in dB. */
  gainDb: number
  /** Loudness before normalisation (LUFS). */
  loudness: number
}

/** Trims a cue's silence and gains it to `target` LUFS, keeping the peak at or below `CEILING_DB`. */
export function normalizeCue(input: Float32Array, rate: number, target: number): NormalizedCue {
  const trimmed = trimSilence(input, rate)
  const measured = loudness(trimmed, rate)
  if (!Number.isFinite(measured)) return { samples: trimmed, gainDb: 0, loudness: measured }
  const gainDb = Math.min(target - measured, CEILING_DB - peakDb(trimmed), MAX_GAIN_DB)
  const gain = 10 ** (gainDb / 20)
  const samples = new Float32Array(trimmed.length)
  for (let i = 0; i < trimmed.length; i++) samples[i] = trimmed[i]! * gain
  return { samples, gainDb, loudness: measured }
}

/** Encodes mono float samples as a 16-bit PCM WAV file at `rate` (no resampling). */
export function encodeWav16(samples: ArrayLike<number>, rate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2)
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
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true)
  }
  return bytes
}

// ---------- reply loudness target ----------

export type LoudnessStore = { getItem(key: string): string | null; setItem(key: string, value: string): void }

const STORE_KEY = "voice.replyLoudness"
/** Measurements kept per voice (the most recent). */
const HISTORY = 21
/** Voices remembered (the most recently measured). */
const VOICES = 8

function readAll(store: LoudnessStore): Record<string, number[]> {
  try {
    const parsed = JSON.parse(store.getItem(STORE_KEY) ?? "{}") as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number[]>) : {}
  } catch {
    return {}
  }
}

/** The measured reply loudness values (LUFS) of a voice, oldest first. */
export function replyHistory(store: LoudnessStore, key: string): number[] {
  const list = readAll(store)[key]
  return Array.isArray(list) ? list.filter((v) => typeof v === "number" && Number.isFinite(v)) : []
}

/** Remembers a reply's measured loudness for its voice (silence and nonsense are ignored). Never throws. */
export function recordReplyLoudness(store: LoudnessStore, key: string, lufs: number): void {
  if (!Number.isFinite(lufs) || lufs < -50 || lufs > 0) return
  try {
    const all = readAll(store)
    const list = [...replyHistory(store, key), Math.round(lufs * 10) / 10].slice(-HISTORY)
    delete all[key]
    all[key] = list
    const keys = Object.keys(all)
    for (const old of keys.slice(0, Math.max(0, keys.length - VOICES))) delete all[old]
    store.setItem(STORE_KEY, JSON.stringify(all))
  } catch {
    // storage full or denied: the default target stays
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Loudness (LUFS) cues are normalised to: the median of the voice's measured replies, clamped. */
export function cueTarget(store: LoudnessStore, key: string | undefined): number {
  let history: number[] = []
  try {
    if (key !== undefined) history = replyHistory(store, key)
  } catch {
    history = []
  }
  if (!history.length) return DEFAULT_TARGET_LUFS
  return Math.min(MAX_TARGET_LUFS, Math.max(MIN_TARGET_LUFS, median(history)))
}
