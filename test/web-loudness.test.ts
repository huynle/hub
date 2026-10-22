// Progress cue loudness: cue phrases are measured (BS.1770 K-weighted gated loudness), trimmed of long
// leading/trailing silence and gained to the loudness of spoken replies (peak kept at or below −1 dBFS), then
// re-encoded as 16-bit mono WAV. The reply loudness target is a running median per TTS voice.
import { describe, expect, test } from "bun:test"
import {
  CEILING_DB,
  DEFAULT_TARGET_LUFS,
  cueTarget,
  encodeWav16,
  loudness,
  normalizeCue,
  peakDb,
  recordReplyLoudness,
  replyHistory,
  trimSilence,
} from "../web/src/core/loudness"

const RATE = 24_000
const sine = (amplitude: number, seconds: number, freq = 997, rate = RATE) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * freq * i) / rate))
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const db = (x: number) => 20 * Math.log10(x)

describe("loudness", () => {
  test("a 997 Hz sine at −20 dBFS peak in mono is −23 LUFS (BS.1770)", () => {
    expect(loudness(sine(0.1, 3), RATE)).toBeCloseTo(-23.01, 0)
  })

  test("works at other sample rates", () => {
    expect(loudness(sine(0.1, 3, 997, 48_000), 48_000)).toBeCloseTo(-23.01, 0)
    expect(loudness(sine(0.1, 3, 997, 16_000), 16_000)).toBeCloseTo(-23.01, 0)
  })

  test("6 dB more amplitude is 6 dB louder", () => {
    expect(loudness(sine(0.2, 2), RATE) - loudness(sine(0.1, 2), RATE)).toBeCloseTo(6.02, 1)
  })

  test("silence padding is gated out", () => {
    // Ungated, 5 s of silence around 2 s of tone would read −28.5 LUFS; gating leaves only the edge blocks.
    const padded = concat(new Float32Array(RATE * 2), sine(0.1, 2), new Float32Array(RATE * 3))
    expect(Math.abs(loudness(padded, RATE) - -23.01)).toBeLessThan(1)
  })

  test("a clip shorter than one gating block is still measured", () => {
    expect(loudness(sine(0.1, 0.25), RATE)).toBeCloseTo(-23.01, 0)
  })

  test("silence is −Infinity", () => {
    expect(loudness(new Float32Array(RATE), RATE)).toBe(-Infinity)
    expect(loudness(new Float32Array(0), RATE)).toBe(-Infinity)
  })
})

describe("peakDb", () => {
  test("is the largest absolute sample in dBFS", () => {
    expect(peakDb(Float32Array.from([0.1, -0.5, 0.25]))).toBeCloseTo(db(0.5), 5)
    expect(peakDb(new Float32Array(4))).toBe(-Infinity)
  })
})

describe("trimSilence", () => {
  test("keeps at most 80 ms of silence at each end", () => {
    const tone = sine(0.1, 0.5)
    const out = trimSilence(concat(new Float32Array(RATE / 2), tone, new Float32Array(RATE)), RATE)
    const pad = Math.round(0.08 * RATE)
    expect(Math.abs(out.length - (tone.length + 2 * pad))).toBeLessThanOrEqual(2)
  })

  test("leaves short silence alone", () => {
    const clip = concat(new Float32Array(RATE * 0.05), sine(0.1, 0.5), new Float32Array(RATE * 0.03))
    expect(trimSilence(clip, RATE).length).toBe(clip.length)
  })

  test("returns silence unchanged", () => {
    const clip = new Float32Array(RATE)
    expect(trimSilence(clip, RATE).length).toBe(RATE)
  })
})

describe("normalizeCue", () => {
  test("gains a quiet clip up to the target loudness", () => {
    const { samples, gainDb } = normalizeCue(sine(0.05, 2), RATE, -20)
    expect(loudness(samples, RATE)).toBeCloseTo(-20, 0)
    expect(gainDb).toBeCloseTo(-20 - (-23.01 - 6.02), 0)
  })

  test("turns a loud clip down to the target loudness", () => {
    const { samples } = normalizeCue(sine(0.5, 2), RATE, -20)
    expect(loudness(samples, RATE)).toBeCloseTo(-20, 0)
  })

  test("caps the gain so the peak stays at or below −1 dBFS", () => {
    // A very peaky clip: a loud click on a quiet tone.
    const clip = sine(0.02, 2)
    clip[RATE] = 0.5
    const { samples } = normalizeCue(clip, RATE, -14)
    expect(peakDb(samples)).toBeLessThanOrEqual(CEILING_DB + 1e-6)
  })

  test("a peaky clip still reaches the target: its peaks are limited to −1 dBFS instead of capping the gain", () => {
    // Real cue: "Let me see." measured −23.1 LUFS with a −0.4 dBFS peak (a plosive).
    const clip = sine(0.05, 2)
    for (let i = 0; i < 4; i++) for (let j = 0; j < 24; j++) clip[Math.round(RATE * (0.3 + i * 0.4)) + j] = 0.95 * (j % 2 ? -1 : 1)
    expect(loudness(clip, RATE)).toBeLessThan(-21) // needs > 2 dB more…
    expect(peakDb(clip)).toBeGreaterThan(-1) // …but has no headroom
    const { samples } = normalizeCue(clip, RATE, -19)
    expect(peakDb(samples)).toBeLessThanOrEqual(CEILING_DB + 1e-6)
    expect(loudness(samples, RATE)).toBeCloseTo(-19, 0)
  })

  test("trims long silence and leaves silence ungained", () => {
    const { samples, gainDb } = normalizeCue(concat(new Float32Array(RATE), sine(0.1, 1), new Float32Array(RATE)), RATE, -20)
    expect(samples.length).toBeLessThan(RATE * 1.2)
    expect(normalizeCue(new Float32Array(RATE), RATE, -20).gainDb).toBe(0)
    expect(gainDb).toBeGreaterThan(0)
  })
})

describe("encodeWav16", () => {
  const ascii = (bytes: Uint8Array, at: number, n: number) => String.fromCharCode(...bytes.slice(at, at + n))

  test("writes mono 16-bit PCM at the given rate (no resampling)", () => {
    const bytes = encodeWav16(new Float32Array(24_000), 24_000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(ascii(bytes, 0, 4)).toBe("RIFF")
    expect(view.getUint32(4, true)).toBe(bytes.length - 8)
    expect(ascii(bytes, 8, 4)).toBe("WAVE")
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(24_000)
    expect(view.getUint32(28, true)).toBe(48_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(bytes, 36, 4)).toBe("data")
    expect(view.getUint32(40, true)).toBe(48_000)
    expect(bytes.length).toBe(44 + 48_000)
  })

  test("clips samples to signed 16-bit", () => {
    const bytes = encodeWav16(Float32Array.from([0, 1, -1, 2, -2, 0.5]), 8_000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16384])
  })
})

describe("reply loudness target", () => {
  function memory() {
    const data = new Map<string, string>()
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
  }

  test("defaults to −19.5 LUFS without measurements", () => {
    expect(DEFAULT_TARGET_LUFS).toBe(-19.5)
    expect(cueTarget(memory(), "voice-a")).toBe(-19.5)
    expect(cueTarget(memory(), undefined)).toBe(-19.5)
  })

  test("is the median of the voice's measured replies", () => {
    const store = memory()
    for (const v of [-20, -18, -25, -19]) recordReplyLoudness(store, "voice-a", v)
    expect(cueTarget(store, "voice-a")).toBe(-19.5)
    recordReplyLoudness(store, "voice-a", -17)
    expect(cueTarget(store, "voice-a")).toBe(-19)
  })

  test("is kept per voice", () => {
    const store = memory()
    recordReplyLoudness(store, "voice-a", -16)
    recordReplyLoudness(store, "voice-b", -22)
    expect(cueTarget(store, "voice-a")).toBe(-16)
    expect(cueTarget(store, "voice-b")).toBe(-22)
    expect(cueTarget(store, "voice-c")).toBe(-19.5)
  })

  test("is clamped to −26…−14 LUFS", () => {
    const store = memory()
    recordReplyLoudness(store, "quiet", -30)
    recordReplyLoudness(store, "loud", -10)
    expect(cueTarget(store, "quiet")).toBe(-26)
    expect(cueTarget(store, "loud")).toBe(-14)
  })

  test("ignores silence and nonsense, and remembers only recent measurements", () => {
    const store = memory()
    recordReplyLoudness(store, "v", -Infinity)
    recordReplyLoudness(store, "v", Number.NaN)
    recordReplyLoudness(store, "v", -60)
    expect(replyHistory(store, "v")).toEqual([])
    for (let i = 0; i < 40; i++) recordReplyLoudness(store, "v", -20)
    for (let i = 0; i < 30; i++) recordReplyLoudness(store, "v", -16)
    expect(cueTarget(store, "v")).toBe(-16)
    expect(replyHistory(store, "v").length).toBeLessThanOrEqual(25)
  })

  test("survives corrupt or unavailable storage", () => {
    const store = memory()
    store.setItem("voice.replyLoudness", "{not json")
    expect(cueTarget(store, "v")).toBe(-19.5)
    recordReplyLoudness(store, "v", -18)
    expect(cueTarget(store, "v")).toBe(-18)
    const broken = { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("denied") } }
    expect(() => recordReplyLoudness(broken, "v", -18)).not.toThrow()
    expect(cueTarget(broken, "v")).toBe(-19.5)
  })
})
