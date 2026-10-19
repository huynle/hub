// Conversation mode: energy-based voice activity detection on synthetic audio frames.
import { describe, expect, test } from "bun:test"
import { EnergyVad } from "../web/src/core/conversation-core"

const RATE = 16_000
const FRAME = 320 // 20 ms

let seed = 1
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}
const noise = (amp: number, ms: number) => Float32Array.from({ length: (RATE * ms) / 1000 }, () => (random() * 2 - 1) * amp)
const tone = (amp: number, ms: number, hz = 220) =>
  Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE) + (random() * 2 - 1) * 0.001)
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

type Event = { type: string; atMs: number; durationMs?: number; samples?: Float32Array; forced?: boolean }

/** Feeds audio in 20 ms frames; returns events stamped with the stream time at which they fired, plus levels. */
function run(vad: EnergyVad, audio: Float32Array) {
  const events: Event[] = []
  const levels: number[] = []
  for (let at = 0; at + FRAME <= audio.length; at += FRAME) {
    const result = vad.process(audio.subarray(at, at + FRAME))
    levels.push(result.level)
    for (const e of result.events) events.push({ ...e, atMs: ((at + FRAME) / RATE) * 1000 })
  }
  return { events, levels }
}

const vad = (options = {}) => new EnergyVad({ sampleRate: RATE, ...options })

describe("EnergyVad", () => {
  test("silence and room noise produce no events", () => {
    expect(run(vad(), noise(0.001, 2000)).events).toEqual([])
  })

  test("a blip shorter than 300 ms is ignored", () => {
    expect(run(vad(), concat(noise(0.001, 1000), tone(0.3, 160), noise(0.001, 1000))).events).toEqual([])
  })

  test("speech: start after 300 ms sustained, end after 350 ms silence, with 300 ms pre-roll", () => {
    const { events } = run(vad(), concat(noise(0.001, 1000), tone(0.3, 600), noise(0.001, 1000)))
    expect(events.map((e) => e.type)).toEqual(["start", "end"])
    const [start, end] = events
    expect(start!.atMs).toBeGreaterThanOrEqual(1290)
    expect(start!.atMs).toBeLessThanOrEqual(1350)
    expect(end!.atMs).toBeGreaterThanOrEqual(1600 + 340)
    expect(end!.atMs).toBeLessThanOrEqual(1600 + 400)
    // pre-roll (300) + speech (600) + up to 200 ms of trailing silence
    expect(end!.durationMs).toBeGreaterThanOrEqual(880)
    expect(end!.durationMs).toBeLessThanOrEqual(1120)
    expect(end!.samples!.length).toBe((end!.durationMs! * RATE) / 1000)
    expect(end!.forced).toBeFalsy()
  })

  test("a short pause inside speech does not end the segment; a long one does", () => {
    const short = run(vad(), concat(noise(0.001, 500), tone(0.3, 500), noise(0.001, 300), tone(0.3, 500), noise(0.001, 1000)))
    expect(short.events.map((e) => e.type)).toEqual(["start", "end"])
    const long = run(vad(), concat(noise(0.001, 500), tone(0.3, 500), noise(0.001, 700), tone(0.3, 500), noise(0.001, 1000)))
    expect(long.events.map((e) => e.type)).toEqual(["start", "end", "start", "end"])
  })

  test("adapts to a steady background hum, then still hears speech over it", () => {
    const { events } = run(vad(), concat(noise(0.03, 3000), tone(0.4, 600), noise(0.03, 1000)))
    expect(events.map((e) => e.type)).toEqual(["start", "end"])
    expect(events[0]!.atMs).toBeGreaterThan(3000)
  })

  test("while speaking (TTS playing) the threshold rises to resist echo", () => {
    const quiet = concat(noise(0.001, 1000), tone(0.008, 600), noise(0.001, 1000))
    expect(run(vad(), quiet).events.map((e) => e.type)).toEqual(["start", "end"])
    const speaking = vad()
    speaking.speaking = true
    expect(run(speaking, quiet).events).toEqual([])
    const loud = concat(noise(0.001, 1000), tone(0.3, 600), noise(0.001, 1000))
    expect(run(speaking, loud).events.map((e) => e.type)).toEqual(["start", "end"])
  })

  test("segments are capped at maxSegmentMs", () => {
    const { events } = run(vad({ maxSegmentMs: 5000 }), concat(noise(0.001, 500), tone(0.3, 6000)))
    const end = events.find((e) => e.type === "end")!
    expect(end.forced).toBe(true)
    expect(end.durationMs).toBeLessThanOrEqual(5000)
    expect(end.durationMs).toBeGreaterThanOrEqual(4900)
  })

  test("level is near 0 in silence and high during speech", () => {
    const { levels } = run(vad(), concat(noise(0.001, 1000), tone(0.3, 600)))
    expect(levels[40]!).toBeLessThan(0.15)
    expect(levels[levels.length - 1]!).toBeGreaterThan(0.6)
    for (const l of levels) {
      expect(l).toBeGreaterThanOrEqual(0)
      expect(l).toBeLessThanOrEqual(1)
    }
  })

  test("reset drops an in-progress segment", () => {
    const v = vad()
    const first = run(v, concat(noise(0.001, 500), tone(0.3, 400)))
    expect(first.events.map((e) => e.type)).toEqual(["start"])
    expect(v.active).toBe(true)
    v.reset()
    expect(v.active).toBe(false)
    expect(run(v, noise(0.001, 1000)).events).toEqual([])
  })
})
