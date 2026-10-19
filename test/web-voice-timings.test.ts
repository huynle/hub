// Voice mode turn-taking timings: one table (VOICE_TIMINGS) drives the VAD and the endpointer defaults.
import { describe, expect, test } from "bun:test"
import { Endpointer, EnergyVad, VOICE_TIMINGS } from "../web/src/core/conversation-core"

const RATE = 16_000
const FRAME = 320 // 20 ms
const quiet = (ms: number) => Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => ((i * 7919) % 13) / 13 / 1000)
const tone = (ms: number) => Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE))
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
function run(audio: Float32Array) {
  const vad = new EnergyVad({ sampleRate: RATE })
  const events: Array<{ type: string; atMs: number }> = []
  for (let at = 0; at + FRAME <= audio.length; at += FRAME) {
    for (const e of vad.process(audio.subarray(at, at + FRAME)).events) events.push({ type: e.type, atMs: ((at + FRAME) / RATE) * 1000 })
  }
  return events
}

describe("VOICE_TIMINGS", () => {
  test("the tighter turn-taking values", () => {
    expect(VOICE_TIMINGS).toEqual({ minSpeechMs: 300, endSilenceMs: 350, trailingKeepMs: 200, preRollMs: 300, holdMs: 800 })
    expect(Object.isFrozen(VOICE_TIMINGS)).toBe(true)
  })

  test("the VAD and the endpointer default to them", () => {
    const vad = new EnergyVad({ sampleRate: RATE })
    expect(vad.minSpeechMs).toBe(VOICE_TIMINGS.minSpeechMs)
    expect(vad.endSilenceMs).toBe(VOICE_TIMINGS.endSilenceMs)
    expect(vad.preRollMs).toBe(VOICE_TIMINGS.preRollMs)
  })

  test("speech ends 350 ms after the voice stops", () => {
    const events = run(concat(quiet(1000), tone(600), quiet(1000)))
    expect(events.map((e) => e.type)).toEqual(["start", "end"])
    expect(events[1]!.atMs).toBeGreaterThanOrEqual(1600 + 340)
    expect(events[1]!.atMs).toBeLessThanOrEqual(1600 + 380)
  })

  test("hangover safety: less than 300 ms of voice is never speech", () => {
    expect(run(concat(quiet(1000), tone(260), quiet(1000)))).toEqual([])
    expect(run(concat(quiet(1000), tone(340), quiet(1000))).map((e) => e.type)).toEqual(["start", "end"])
  })

  test("the endpointer holds an unfinished-looking transcript for 800 ms", () => {
    const sent: string[] = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    const e = new Endpointer({ send: (t) => sent.push(t), setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {} })
    e.speechStarted()
    e.transcribed(e.segmentEnded(800), "Check the build and")
    expect(sent).toEqual([])
    expect(timers.map((t) => t.ms)).toEqual([800])
    timers[0]!.fn()
    expect(sent).toEqual(["Check the build and"])
  })
})
