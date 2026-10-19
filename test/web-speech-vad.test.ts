// Voice mode's ML speech detection: the probability state machine (Silero speech probabilities with hysteresis),
// the 16 kHz chunker, and the detector that orders async model results, pre-gates on energy and falls back.
import { describe, expect, test } from "bun:test"
import { NORMAL_VAD, ProbabilityVad, Resampler, SILERO_FRAME, SILERO_RATE, VoiceDetector, type ProbabilityVadParams } from "../web/src/core/speech-vad"

const FRAME_MS = (SILERO_FRAME / SILERO_RATE) * 1000 // 32 ms
const silentFrame = () => new Float32Array(SILERO_FRAME)

type Stamped = { type: string; atMs: number; durationMs?: number; speechMs?: number; samples?: Float32Array }

/** Feeds one probability per 32 ms frame; events are stamped with the stream time at which they fired. */
function run(vad: ProbabilityVad, probs: readonly number[]): Stamped[] {
  const events: Stamped[] = []
  probs.forEach((p, i) => {
    for (const e of vad.process(silentFrame(), p)) events.push({ ...e, atMs: (i + 1) * FRAME_MS })
  })
  return events
}

/** `ms` worth of frames at probability `p`. */
const hold = (p: number, ms: number) => Array.from({ length: Math.round(ms / FRAME_MS) }, () => p)
const vad = (params: Partial<ProbabilityVadParams> = {}) => new ProbabilityVad({ ...NORMAL_VAD, ...params })
const types = (events: Stamped[]) => events.map((e) => e.type)

describe("ProbabilityVad", () => {
  test("defaults: start ≥ 0.6 for 250 ms, end below 0.35 for 350 ms", () => {
    expect(NORMAL_VAD).toMatchObject({ startProb: 0.6, endProb: 0.35, minSpeechMs: 250, endSilenceMs: 350 })
  })

  test("steady hum (probability hovering below the start threshold) produces nothing", () => {
    const hum = Array.from({ length: 200 }, (_, i) => 0.3 + 0.25 * Math.sin(i / 3)) // 0.05 … 0.55
    expect(run(vad(), hum)).toEqual([])
  })

  test("a short noise burst (160 ms at 0.95) is ignored", () => {
    expect(run(vad(), [...hold(0.02, 1000), ...hold(0.95, 160), ...hold(0.02, 1000)])).toEqual([])
  })

  test("typing clicks (isolated high frames between low ones) never start a segment", () => {
    const clicks = Array.from({ length: 150 }, (_, i) => (i % 2 === 0 ? 0.9 : 0.1)) // every other frame
    expect(run(vad(), clicks)).toEqual([])
    const sparse = Array.from({ length: 150 }, (_, i) => (i % 3 === 0 ? 0.95 : 0.05))
    expect(run(vad(), sparse)).toEqual([])
  })

  test("speech: start after 250 ms above 0.6, end 350 ms after it falls below 0.35, with pre-roll", () => {
    const events = run(vad(), [...hold(0.02, 1024), ...hold(0.92, 800), ...hold(0.05, 1000)])
    expect(types(events)).toEqual(["start", "end"])
    const [start, end] = events
    expect(start!.atMs).toBeGreaterThanOrEqual(1024 + 250)
    expect(start!.atMs).toBeLessThanOrEqual(1024 + 250 + FRAME_MS)
    expect(end!.atMs).toBeGreaterThanOrEqual(1024 + 800 + 350)
    expect(end!.atMs).toBeLessThanOrEqual(1024 + 800 + 350 + FRAME_MS)
    // pre-roll (≤ 300 ms, + up to a frame) + speech (800 ms) + ≤ 200 ms of trailing silence (+ up to a frame)
    expect(end!.durationMs!).toBeGreaterThanOrEqual(800 + 250)
    expect(end!.durationMs!).toBeLessThanOrEqual(300 + 800 + 200 + 2 * FRAME_MS)
    expect(end!.samples!.length).toBe(Math.round((end!.durationMs! * SILERO_RATE) / 1000))
    expect(end!.speechMs!).toBeGreaterThanOrEqual(800 - FRAME_MS)
    expect(end!.speechMs!).toBeLessThanOrEqual(800 + FRAME_MS)
  })

  test("hysteresis: once speaking, probabilities between 0.35 and 0.6 keep the segment open", () => {
    const events = run(vad(), [...hold(0.02, 500), ...hold(0.9, 400), ...hold(0.45, 1200), ...hold(0.9, 300), ...hold(0.02, 1000)])
    expect(types(events)).toEqual(["start", "end"])
  })

  test("a short pause inside speech does not end the segment; a long one does", () => {
    expect(types(run(vad(), [...hold(0.02, 500), ...hold(0.9, 500), ...hold(0.1, 256), ...hold(0.9, 500), ...hold(0.02, 1000)]))).toEqual(["start", "end"])
    expect(types(run(vad(), [...hold(0.02, 500), ...hold(0.9, 500), ...hold(0.1, 700), ...hold(0.9, 500), ...hold(0.02, 1000)]))).toEqual(["start", "end", "start", "end"])
  })

  test("while the agent speaks, a higher probability is needed to barge in", () => {
    const moderate = [...hold(0.02, 500), ...hold(0.75, 600), ...hold(0.02, 1000)]
    expect(types(run(vad(), moderate))).toEqual(["start", "end"])
    const speaking = vad()
    speaking.speaking = true
    expect(run(speaking, moderate)).toEqual([])
    expect(types(run(speaking, [...hold(0.02, 500), ...hold(0.97, 600), ...hold(0.02, 1000)]))).toEqual(["start", "end"])
  })

  test("segments are capped at maxSegmentMs", () => {
    const events = run(vad({ maxSegmentMs: 5000 }), [...hold(0.02, 500), ...hold(0.95, 6000)])
    const end = events.find((e) => e.type === "end") as Stamped & { forced?: boolean }
    expect(end.forced).toBe(true)
    expect(end.durationMs!).toBeLessThanOrEqual(5000 + FRAME_MS)
  })

  test("params apply live (e.g. a stricter start threshold)", () => {
    const v = vad()
    v.params = { ...v.params, startProb: 0.8 }
    expect(run(v, [...hold(0.02, 500), ...hold(0.7, 600), ...hold(0.02, 1000)])).toEqual([])
  })
})

describe("Resampler", () => {
  test("48 kHz in 20 ms frames → exact 512-sample 16 kHz chunks", () => {
    const r = new Resampler(48_000)
    const chunks: Float32Array[] = []
    for (let i = 0; i < 100; i++) chunks.push(...r.push(new Float32Array(960).fill(0.25))) // 2 s
    expect(chunks.every((c) => c.length === SILERO_FRAME)).toBe(true)
    expect(chunks.length).toBe(Math.floor((2 * SILERO_RATE) / SILERO_FRAME))
    expect(chunks[10]![100]).toBeCloseTo(0.25, 5)
  })

  test("44.1 kHz (a fractional ratio) keeps the 16 kHz count and the signal", () => {
    const r = new Resampler(44_100)
    const out: number[] = []
    let t = 0
    for (let i = 0; i < 150; i++) {
      const frame = Float32Array.from({ length: 882 }, () => Math.sin((2 * Math.PI * 200 * t++) / 44_100))
      for (const c of r.push(frame)) out.push(...c)
    }
    const expected = Math.floor((150 * 882 * SILERO_RATE) / 44_100)
    expect(out.length).toBe(expected - (expected % SILERO_FRAME))
    // A 200 Hz sine at 16 kHz: compare a few samples (box-filter averaging slightly attenuates).
    for (const i of [1000, 5000, 20_000]) expect(out[i]!).toBeCloseTo(Math.sin((2 * Math.PI * 200 * i) / SILERO_RATE), 1)
  })

  test("16 kHz passes through", () => {
    const r = new Resampler(16_000)
    expect(r.push(new Float32Array(320)).length).toBe(0)
    expect(r.push(new Float32Array(320)).length).toBe(1)
  })
})

// ---------- the detector ----------

const RATE = 48_000
const NATIVE = 960 // 20 ms
/** A native frame whose amplitude encodes the probability the fake model returns (amp ∈ [0, 1) → p = amp). */
const frameAt = (amp: number) => new Float32Array(NATIVE).fill(amp)
const feed = (d: VoiceDetector, amp: number, ms: number) => {
  for (let i = 0; i < ms / 20; i++) d.push(frameAt(amp))
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function detector(classify?: (chunk: Float32Array) => Promise<number>, opts: { warn?: (m: string) => void } = {}) {
  const events: Array<{ type: string }> = []
  const levels: number[] = []
  const d = new VoiceDetector({ sampleRate: RATE, onEvents: (e) => events.push(...e), onLevel: (l) => levels.push(l), warn: opts.warn ?? (() => {}) })
  if (classify) d.classifier = classify
  return { d, events, levels }
}

describe("VoiceDetector", () => {
  test("model probabilities drive segments (energy pre-gate passes loud frames)", async () => {
    const calls: number[] = []
    const { d, events } = detector(async (chunk) => {
      calls.push(chunk[0]!)
      return chunk[0]! > 0.2 ? 0.95 : 0.01
    })
    feed(d, 0.001, 600)
    feed(d, 0.3, 800)
    feed(d, 0.001, 1000)
    await tick()
    expect(types(events as Stamped[])).toEqual(["start", "end"])
    expect(calls.length).toBeGreaterThan(0)
  })

  test("loud non-speech (model says no) produces nothing, though energy alone would trigger", async () => {
    const { d, events } = detector(async () => 0.05)
    feed(d, 0.001, 600)
    feed(d, 0.3, 1500)
    feed(d, 0.001, 600)
    await tick()
    expect(events).toEqual([])
  })

  test("results arriving out of order are applied in stream order", async () => {
    const resolvers: Array<() => void> = []
    const { d, events } = detector(
      (chunk) =>
        new Promise<number>((resolve) => {
          const p = chunk[0]! > 0.2 ? 0.95 : 0.01
          resolvers.push(() => resolve(p))
        }),
    )
    feed(d, 0.001, 400)
    feed(d, 0.3, 800)
    feed(d, 0.001, 1000)
    // Resolve newest first.
    for (const r of resolvers.reverse()) r()
    await tick()
    expect(types(events as Stamped[])).toEqual(["start", "end"])
  })

  test("pre-gate: frames at the noise floor are not sent to the model", async () => {
    const calls: number[] = []
    const { d } = detector(async (chunk) => {
      calls.push(chunk[0]!)
      return 0.01
    })
    feed(d, 0.001, 2000) // steady quiet room
    await tick()
    expect(calls.length).toBeLessThan(10)
    expect(d.stats.skipped).toBeGreaterThan(40)
  })

  test("without a model (loading or failed) the energy VAD decides", async () => {
    const { d, events } = detector()
    feed(d, 0.001, 600)
    feed(d, 0.3, 800)
    feed(d, 0.001, 1000)
    await tick()
    expect(types(events as Stamped[])).toEqual(["start", "end"])
    expect(d.mode).toBe("energy")
  })

  test("a failing model falls back to energy and warns once", async () => {
    const warnings: string[] = []
    const { d, events } = detector(() => Promise.reject(new Error("wasm gone")), { warn: (m) => warnings.push(m) })
    feed(d, 0.001, 600)
    feed(d, 0.3, 800)
    feed(d, 0.001, 1000)
    await tick()
    feed(d, 0.001, 500)
    await tick()
    expect(types(events as Stamped[])).toEqual(["start", "end"])
    expect(warnings.length).toBe(1)
    expect(d.mode).toBe("energy")
    expect(d.classifier).toBeUndefined()
  })

  test("reports levels and inference timing", async () => {
    const { d, levels } = detector(async () => 0.01)
    feed(d, 0.001, 400)
    feed(d, 0.3, 400)
    await tick()
    expect(levels.length).toBeGreaterThan(10)
    expect(Math.max(...levels)).toBeGreaterThan(0.5)
    expect(d.mode).toBe("silero")
    expect(d.stats.frames).toBeGreaterThan(0)
    expect(d.stats.avgMs).toBeGreaterThanOrEqual(0)
  })

  test("while speaking, the energy pre-gate and the model threshold both rise", async () => {
    const { d, events } = detector(async (chunk) => (chunk[0]! > 0.2 ? 0.75 : 0.01))
    d.speaking = true
    feed(d, 0.001, 600)
    feed(d, 0.3, 800)
    feed(d, 0.001, 1000)
    await tick()
    expect(events).toEqual([])
  })

  test("reset drops pending results and the segment in progress", async () => {
    let release: (() => void) | undefined
    const { d, events } = detector(
      (chunk) =>
        new Promise<number>((resolve) => {
          const p = chunk[0]! > 0.2 ? 0.95 : 0.01
          const prev = release
          release = () => {
            prev?.()
            resolve(p)
          }
        }),
    )
    feed(d, 0.001, 400)
    feed(d, 0.3, 800)
    d.reset()
    release?.()
    await tick()
    expect(events).toEqual([])
    expect(d.active).toBe(false)
  })

  test("segments are 16 kHz audio", async () => {
    const ends: Array<{ samples: Float32Array; durationMs: number }> = []
    const d = new VoiceDetector({
      sampleRate: RATE,
      onEvents: (e) => e.forEach((x) => x.type === "end" && ends.push(x)),
      warn: () => {},
    })
    d.classifier = async (chunk) => (chunk[0]! > 0.2 ? 0.95 : 0.01)
    feed(d, 0.001, 600)
    feed(d, 0.3, 800)
    feed(d, 0.001, 1000)
    await tick()
    expect(d.sampleRate).toBe(SILERO_RATE)
    expect(ends[0]!.samples.length).toBe(Math.round((ends[0]!.durationMs * SILERO_RATE) / 1000))
  })
})
