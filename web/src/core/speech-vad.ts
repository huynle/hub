// Pure logic for Voice mode's ML speech detection (no DOM, no audio APIs, no model): Silero speech
// probabilities with hysteresis (ProbabilityVad), a streaming 16 kHz resampler cutting 512-sample chunks
// (Resampler), and the detector tying them together (VoiceDetector): it pre-gates quiet chunks on energy,
// applies the model's asynchronous results in stream order, and falls back to the energy VAD while the model
// loads or when it fails. The model itself runs in a worker (web/src/voice/silero-worker.ts).
import { EnergyMeter, Segmenter, VOICE_TIMINGS, type VadEvent } from "./conversation-core"

/** Silero VAD v5 runs on 16 kHz audio in 512-sample (32 ms) chunks. */
export const SILERO_RATE = 16_000
export const SILERO_FRAME = 512
const FRAME_MS = (SILERO_FRAME / SILERO_RATE) * 1000

export interface ProbabilityVadParams {
  /** Probability that counts as speech while waiting for speech. */
  readonly startProb: number
  /** Probability below which speech counts as ended (hysteresis: lower than startProb). */
  readonly endProb: number
  /** startProb while the agent is speaking (barge-in needs to be clearer than echo). */
  readonly speakingStartProb: number
  /** Voiced time before a segment starts. */
  readonly minSpeechMs: number
  readonly endSilenceMs: number
  readonly maxSegmentMs: number
  /** Energy pre-gate: chunks less than this many dB above the noise floor skip the model (counted as silence). */
  readonly gateDb: number
  /** Energy fallback (no model): dB above the noise floor that count as voice, and the voiced time to start. */
  readonly energyMarginDb: number
  readonly energyMinSpeechMs: number
}

export const NORMAL_VAD: ProbabilityVadParams = Object.freeze({
  startProb: 0.6,
  endProb: 0.35,
  speakingStartProb: 0.85,
  minSpeechMs: 250,
  endSilenceMs: VOICE_TIMINGS.endSilenceMs,
  maxSegmentMs: 60_000,
  gateDb: 3,
  energyMarginDb: 10,
  energyMinSpeechMs: VOICE_TIMINGS.minSpeechMs,
})

/** Settings → Voice → Mic sensitivity (per device). */
export type Sensitivity = "low" | "normal" | "high"
export const SENSITIVITIES: readonly Sensitivity[] = Object.freeze(["low", "normal", "high"])

/** A stored value as a level; anything unknown is Normal. */
export function parseSensitivity(value: unknown): Sensitivity {
  return SENSITIVITIES.includes(value as Sensitivity) ? (value as Sensitivity) : "normal"
}

const SENSITIVITY_PARAMS: Readonly<Record<Sensitivity, ProbabilityVadParams>> = Object.freeze({
  // Low: noisy places; only clear, sustained, louder speech counts.
  low: Object.freeze({ ...NORMAL_VAD, startProb: 0.75, endProb: 0.45, speakingStartProb: 0.92, minSpeechMs: 350, gateDb: 6, energyMarginDb: 13, energyMinSpeechMs: 400 }),
  normal: NORMAL_VAD,
  // High: quiet rooms, soft voices, short answers.
  high: Object.freeze({ ...NORMAL_VAD, startProb: 0.45, endProb: 0.25, speakingStartProb: 0.75, minSpeechMs: 180, gateDb: 0, energyMarginDb: 7, energyMinSpeechMs: 250 }),
})

/** The detector tuning of a sensitivity level (thresholds, speech to start, energy pre-gate and fallback margins). */
export function sensitivityParams(level: Sensitivity): ProbabilityVadParams {
  return SENSITIVITY_PARAMS[parseSensitivity(level)]
}

/**
 * The echo guard (stricter thresholds while the agent speaks) stays up this long after playback stops: the
 * player reports the end before the speaker and the room are quiet (output latency, reverb).
 */
export const SPEAKING_TAIL_MS = 400

/** Share of an onset that must be voiced: isolated high frames (typing clicks) never add up to speech. */
const MIN_VOICED_RATIO = 0.75

/**
 * Speech segments from per-chunk speech probabilities: voice starts at `startProb` (`speakingStartProb` while the
 * agent speaks) sustained for `minSpeechMs`, and ends after `endSilenceMs` below `endProb`. `processEnergy` feeds
 * an energy decision instead (the fallback), with the energy VAD's onset rules.
 */
export class ProbabilityVad {
  speaking = false
  private segmenter: Segmenter
  private current: ProbabilityVadParams

  constructor(params: ProbabilityVadParams, sampleRate = SILERO_RATE) {
    this.current = params
    this.segmenter = new Segmenter({ sampleRate, endSilenceMs: params.endSilenceMs, maxSegmentMs: params.maxSegmentMs })
  }

  get params(): ProbabilityVadParams {
    return this.current
  }

  set params(params: ProbabilityVadParams) {
    this.current = params
    this.segmenter.endSilenceMs = params.endSilenceMs
    this.segmenter.maxSegmentMs = params.maxSegmentMs
  }

  get state(): Segmenter["state"] {
    return this.segmenter.state
  }

  get active(): boolean {
    return this.segmenter.active
  }

  reset(): void {
    this.segmenter.reset()
  }

  process(samples: ArrayLike<number>, prob: number): VadEvent[] {
    const p = this.current
    this.segmenter.minSpeechMs = p.minSpeechMs
    this.segmenter.minVoicedRatio = MIN_VOICED_RATIO
    const threshold = this.segmenter.state === "speech" ? p.endProb : this.speaking ? p.speakingStartProb : p.startProb
    return this.segmenter.process(samples, prob >= threshold)
  }

  processEnergy(samples: ArrayLike<number>, voiced: boolean): VadEvent[] {
    this.segmenter.minSpeechMs = this.current.energyMinSpeechMs
    this.segmenter.minVoicedRatio = 0
    return this.segmenter.process(samples, voiced)
  }
}

/**
 * Streaming resampler to 16 kHz (box-filter averaging when downsampling, linear interpolation when upsampling),
 * returning complete 512-sample chunks; the remainder waits for the next push.
 */
export class Resampler {
  private readonly ratio: number
  private input = new Float32Array(0)
  private pos = 0
  private out = new Float32Array(SILERO_FRAME)
  private filled = 0

  constructor(readonly from: number) {
    this.ratio = from / SILERO_RATE
  }

  push(samples: ArrayLike<number>): Float32Array[] {
    const input = new Float32Array(this.input.length + samples.length)
    input.set(this.input)
    input.set(samples as ArrayLike<number>, this.input.length)
    const chunks: Float32Array[] = []
    const emit = (x: number) => {
      this.out[this.filled++] = x
      if (this.filled === SILERO_FRAME) {
        chunks.push(this.out)
        this.out = new Float32Array(SILERO_FRAME)
        this.filled = 0
      }
    }
    const ratio = this.ratio
    if (ratio >= 1) {
      for (;;) {
        const start = Math.floor(this.pos + 1e-9)
        const end = Math.max(start + 1, Math.floor(this.pos + ratio + 1e-9))
        if (end > input.length) break
        let sum = 0
        for (let j = start; j < end; j++) sum += input[j]!
        emit(sum / (end - start))
        this.pos += ratio
      }
    } else {
      for (;;) {
        const j = Math.floor(this.pos)
        if (j + 1 >= input.length) break
        emit(input[j]! + (input[j + 1]! - input[j]!) * (this.pos - j))
        this.pos += ratio
      }
    }
    const consumed = Math.min(input.length, Math.floor(this.pos + 1e-9))
    this.input = input.slice(consumed)
    this.pos -= consumed
    return chunks
  }
}

export type DetectorMode = "silero" | "energy"

export interface VoiceDetectorOptions {
  /** The mic's (AudioContext's) sample rate; segments come out at 16 kHz. */
  readonly sampleRate: number
  readonly params?: ProbabilityVadParams
  readonly onEvents: (events: VadEvent[]) => void
  readonly onLevel?: (level: number) => void
  readonly warn?: (message: string) => void
  readonly now?: () => number
}

interface Pending {
  readonly chunk: Float32Array
  readonly energyVoiced: boolean
  /** The echo guard was up for this chunk. */
  readonly guarded: boolean
  prob?: number
  energy?: boolean
}

/** Model calls in flight (~2 s of audio) at which the model counts as stalled and is dropped for energy. */
const MAX_IN_FLIGHT = 64

/**
 * Voice mode's speech detector: native mic frames in, speech segments (16 kHz) out. With a classifier (the Silero
 * model in a worker), chunks above the energy pre-gate get a speech probability; chunks at the noise floor are
 * silence without asking the model. Results apply in stream order. Without a classifier (loading, failed, or
 * backlogged) the energy VAD decides; a failing classifier is dropped with one warning.
 */
export class VoiceDetector {
  readonly sampleRate = SILERO_RATE
  readonly stats = { frames: 0, avgMs: 0, maxMs: 0, skipped: 0 }
  private resampler: Resampler
  private meter: EnergyMeter
  private vad: ProbabilityVad
  private onEvents: VoiceDetectorOptions["onEvents"]
  private onLevel?: VoiceDetectorOptions["onLevel"]
  private warn: (message: string) => void
  private now: () => number
  private model: ((chunk: Float32Array) => Promise<number>) | undefined
  private queue: Pending[] = []
  private inFlight = 0
  private generation = 0
  private warned = new Set<string>()
  private speakingOn = false
  /** Chunks the echo guard stays up after speaking stops. */
  private tail = 0

  constructor({ sampleRate, params = NORMAL_VAD, onEvents, onLevel, warn = (m) => console.warn(m), now = () => performance.now() }: VoiceDetectorOptions) {
    this.resampler = new Resampler(sampleRate)
    this.meter = new EnergyMeter({ marginDb: params.energyMarginDb })
    this.vad = new ProbabilityVad(params)
    this.onEvents = onEvents
    this.onLevel = onLevel
    this.warn = warn
    this.now = now
  }

  /** The speech model: a chunk of 512 16 kHz samples → speech probability. */
  get classifier(): ((chunk: Float32Array) => Promise<number>) | undefined {
    return this.model
  }

  set classifier(fn: ((chunk: Float32Array) => Promise<number>) | undefined) {
    this.model = fn
  }

  get mode(): DetectorMode {
    return this.model ? "silero" : "energy"
  }

  get params(): ProbabilityVadParams {
    return this.vad.params
  }

  set params(params: ProbabilityVadParams) {
    this.vad.params = params
    this.meter.marginDb = params.energyMarginDb
  }

  get speaking(): boolean {
    return this.speakingOn
  }

  /**
   * True while the agent (or a cue) speaks: the echo guard raises the energy threshold and the model probability
   * needed for a barge-in, until SPEAKING_TAIL_MS after it stops.
   */
  set speaking(on: boolean) {
    if (this.speakingOn && !on) this.tail = Math.ceil(SPEAKING_TAIL_MS / FRAME_MS)
    this.speakingOn = on
  }

  get active(): boolean {
    return this.vad.active
  }

  reset(): void {
    this.generation++
    this.queue = []
    this.inFlight = 0
    this.vad.reset()
  }

  push(frame: ArrayLike<number>): void {
    for (const chunk of this.resampler.push(frame)) this.chunk(chunk)
  }

  private chunk(chunk: Float32Array): void {
    const guarded = this.speakingOn || this.tail > 0
    if (!this.speakingOn && this.tail > 0) this.tail--
    this.meter.speaking = guarded
    const inSpeech = this.vad.state === "speech"
    const { db, floor, level, voiced } = this.meter.measure(chunk, FRAME_MS, inSpeech)
    this.onLevel?.(level)
    const entry: Pending = { chunk, energyVoiced: voiced, guarded }
    this.queue.push(entry)
    if (this.model && this.inFlight >= MAX_IN_FLIGHT) this.drop("stalled")
    const model = this.model
    if (!model) {
      entry.energy = true
    } else if (!inSpeech && db < floor + this.vad.params.gateDb + (guarded ? this.meter.speakingBoostDb : 0)) {
      entry.prob = 0
      this.stats.skipped++
    } else {
      const generation = this.generation
      const started = this.now()
      this.inFlight++
      model(chunk).then(
        (prob) => {
          if (generation !== this.generation) return
          this.inFlight--
          this.record(this.now() - started)
          entry.prob = prob
          this.drain()
        },
        (error) => {
          if (generation !== this.generation) return
          this.inFlight--
          entry.energy = true
          if (this.model === model) this.drop(error?.message ?? String(error))
          this.drain()
        },
      )
    }
    this.drain()
  }

  /** Drops a failed or stalled model: chunks still waiting for it get the energy decision. */
  private drop(reason: string): void {
    this.model = undefined
    this.generation++
    this.inFlight = 0
    for (const entry of this.queue) if (entry.prob === undefined) entry.energy = true
    this.warnOnce("failed", `Voice: on-device speech detection stopped (${reason}); using the energy detector`)
  }

  private record(ms: number): void {
    const s = this.stats
    s.frames++
    s.avgMs += (ms - s.avgMs) / s.frames
    s.maxMs = Math.max(s.maxMs, ms)
  }

  private drain(): void {
    const events: VadEvent[] = []
    while (this.queue.length && (this.queue[0]!.energy || this.queue[0]!.prob !== undefined)) {
      const entry = this.queue.shift()!
      this.vad.speaking = entry.guarded
      events.push(...(entry.energy ? this.vad.processEnergy(entry.chunk, entry.energyVoiced) : this.vad.process(entry.chunk, entry.prob!)))
    }
    if (events.length) this.onEvents(events)
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.warn(message)
  }
}
