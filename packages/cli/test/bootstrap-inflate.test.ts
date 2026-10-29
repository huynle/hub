// HBS-12: hub's own streaming DEFLATE decoder (RFC 1951) and gzip reader (RFC 1952). With the real OpenCode 2.2.0
// darwin zip, Bun 1.3.5's node:zlib streams stalled for good in about half the runs (even when the pump yielded to
// the event loop); only its one-shot sync calls are reliable, and those hold the whole output. So the archive readers
// decode by themselves: synchronously, from the staged file by offset, keeping only the 32 KiB window and one output
// chunk, and checking the CRC-32 (gzip trailer, zip directory) of everything they produce.
import { describe, expect, test } from "bun:test"
import { constants, deflateRawSync, gzipSync } from "node:zlib"
import { crc32, gunzipChunks, InflateError, inflateRawChunks } from "../src/bootstrap/adapters/inflate.ts"
import { bytesReader, CHUNK_BYTES } from "../src/bootstrap/transaction/stream.ts"

const concat = (parts: Iterable<Uint8Array>): Uint8Array => {
  const all = [...parts]
  const out = new Uint8Array(all.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}
const inflate = (deflated: Uint8Array) => concat(inflateRawChunks(bytesReader(deflated), 0, deflated.byteLength).chunks)
const gunzip = (gz: Uint8Array) => concat(gunzipChunks(bytesReader(gz)))

/** Binary-like data: runs, repeats at every distance up to the window, and noise. */
function sample(size: number, seed = 1): Uint8Array {
  const b = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    const mode = (i >> 13) % 4
    b[i] = mode === 0 ? 0 : mode === 1 ? x >>> 24 : mode === 2 ? b[Math.max(0, i - 1 - ((x >>> 16) % 32768))]! : (i * 7) & 0xff
  }
  return b
}

describe("inflateRawChunks", () => {
  test("decodes what zlib encodes, at every level and strategy (stored, fixed and dynamic Huffman blocks)", () => {
    const data = sample(600_000)
    for (const level of [0, 1, 6, 9])
      for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED, constants.Z_HUFFMAN_ONLY, constants.Z_RLE]) {
        const deflated = new Uint8Array(deflateRawSync(data, { level, strategy }))
        expect(inflate(deflated)).toEqual(data)
      }
    expect(inflate(new Uint8Array(deflateRawSync(new Uint8Array())))).toEqual(new Uint8Array())
  })

  test("output comes in chunks of at most CHUNK_BYTES, and the input it consumed is reported", () => {
    const data = new Uint8Array(5 * 1024 * 1024) // zeros: tiny input, large output
    const deflated = new Uint8Array(deflateRawSync(data))
    const padded = new Uint8Array(deflated.byteLength + 7)
    padded.set(deflated)
    const run = inflateRawChunks(bytesReader(padded), 0, padded.byteLength)
    let total = 0
    for (const chunk of run.chunks) {
      expect(chunk.byteLength).toBeLessThanOrEqual(CHUNK_BYTES)
      total += chunk.byteLength
    }
    expect(total).toBe(data.byteLength)
    expect(run.consumed()).toBe(deflated.byteLength)
  })

  test("damaged or truncated streams are InflateErrors, never garbage", () => {
    const deflated = new Uint8Array(deflateRawSync(sample(100_000)))
    expect(() => inflate(deflated.subarray(0, deflated.byteLength - 10))).toThrow(InflateError)
    expect(() => inflate(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow(InflateError) // reserved block type 3
    expect(() => inflate(new Uint8Array([0x01, 0x05, 0x00, 0x00, 0x00]))).toThrow(InflateError) // stored LEN != ~NLEN
  })
})

describe("gunzipChunks", () => {
  test("decodes gzip, also concatenated members, and checks each member's CRC-32 and size", () => {
    const a = sample(300_000, 3)
    const b = sample(70_000, 4)
    expect(gunzip(new Uint8Array(gzipSync(a)))).toEqual(a)
    expect(gunzip(concat([gzipSync(a), gzipSync(b)]))).toEqual(concat([a, b]))
    const gz = new Uint8Array(gzipSync(a))
    gz[gz.byteLength - 6]! ^= 0xff // the CRC-32 in the trailer
    expect(() => gunzip(gz)).toThrow(/CRC/)
  })

  test("not gzip, or a truncated one, is an InflateError", () => {
    expect(() => gunzip(new Uint8Array([1, 2, 3, 4]))).toThrow(InflateError)
    expect(() => gunzip(new Uint8Array([0x1f, 0x8b, 0, 0]))).toThrow(InflateError)
    const gz = new Uint8Array(gzipSync(sample(50_000)))
    expect(() => gunzip(gz.subarray(0, gz.byteLength - 4))).toThrow(InflateError)
  })
})

test("crc32 is the standard CRC-32, incremental", () => {
  const text = new TextEncoder().encode("123456789")
  expect(crc32(0, text)).toBe(0xcbf43926)
  expect(crc32(crc32(0, text.subarray(0, 4)), text.subarray(4))).toBe(0xcbf43926)
})
