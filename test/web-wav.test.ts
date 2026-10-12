// Conversation mode: 16 kHz mono 16-bit WAV encoding of VAD segments for /api/transcribe.
import { describe, expect, test } from "bun:test"
import { encodeWav, resample } from "../web/conversation-core.js"

const ascii = (bytes: Uint8Array, at: number, n: number) => String.fromCharCode(...bytes.slice(at, at + n))

describe("resample", () => {
  test("downsamples 48 kHz to 16 kHz by a factor of three", () => {
    const input = new Float32Array(48_000).fill(0.5)
    const out = resample(input, 48_000, 16_000)
    expect(out.length).toBe(16_000)
    expect(out[100]).toBeCloseTo(0.5, 5)
  })

  test("handles non-integer ratios (44.1 kHz) and keeps a low tone", () => {
    const rate = 44_100
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / rate))
    const out = resample(input, rate, 16_000)
    expect(out.length).toBe(16_000)
    // Peak of a 200 Hz tone survives the low-pass averaging.
    expect(Math.max(...out.slice(1000, 2000))).toBeGreaterThan(0.9)
  })

  test("same rate is a copy", () => {
    const input = Float32Array.from([0.1, -0.2, 0.3])
    const out = resample(input, 16_000, 16_000)
    expect(Array.from(out)).toEqual(Array.from(input))
    expect(out).not.toBe(input)
  })
})

describe("encodeWav", () => {
  test("writes a PCM mono 16-bit RIFF header at 16 kHz", () => {
    const bytes = encodeWav(new Float32Array(48_000), 48_000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(ascii(bytes, 0, 4)).toBe("RIFF")
    expect(view.getUint32(4, true)).toBe(bytes.length - 8)
    expect(ascii(bytes, 8, 4)).toBe("WAVE")
    expect(ascii(bytes, 12, 4)).toBe("fmt ")
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(bytes, 36, 4)).toBe("data")
    expect(view.getUint32(40, true)).toBe(32_000)
    expect(bytes.length).toBe(44 + 32_000)
  })

  test("converts and clips samples to signed 16-bit", () => {
    const bytes = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]), 16_000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const samples = Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16384])
  })
})
