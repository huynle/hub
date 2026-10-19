// Reads a 16-bit PCM mono WAV fixture (any chunk layout, e.g. macOS `say` output with an FLLR chunk).
import { readFileSync } from "node:fs"

export function readWav(file: string): { rate: number; samples: Float32Array } {
  const b = readFileSync(file)
  let rate = 0
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString("ascii", at, at + 4)
    const size = b.readUInt32LE(at + 4)
    if (id === "fmt ") rate = b.readUInt32LE(at + 12)
    if (id === "data") {
      const pcm = new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + size))
      return { rate, samples: Float32Array.from(pcm, (x) => x / 32768) }
    }
    at += 8 + size + (size & 1)
  }
  throw new Error(`${file}: no data chunk`)
}
