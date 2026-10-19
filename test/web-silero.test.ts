// The Silero VAD v5 model (bundled at web/src/voice/vad/silero_vad.onnx) run through onnxruntime-web's wasm
// backend, as the Voice worker does: speech scores high; white noise, hum, typing clicks and silence score low.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as ort from "onnxruntime-web"
import { SileroModel } from "../web/src/voice/silero-model"
import { SILERO_FRAME, SILERO_RATE } from "../web/src/core/speech-vad"
import { readWav } from "./wav-fixture"

const MODEL = path.join(import.meta.dir, "..", "web", "src", "voice", "vad", "silero_vad.onnx")
const N = SILERO_RATE * 3

let seed = 7
const rnd = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}

let model: SileroModel
beforeAll(async () => {
  ort.env.logLevel = "error"
  model = await SileroModel.load(ort as never, new Uint8Array(readFileSync(MODEL)))
})

async function probs(audio: Float32Array): Promise<number[]> {
  model.reset()
  const out: number[] = []
  for (let i = 0; i + SILERO_FRAME <= audio.length; i += SILERO_FRAME) out.push(await model.probability(audio.subarray(i, i + SILERO_FRAME)))
  return out
}
const share = (p: number[], min: number) => p.filter((x) => x >= min).length / p.length

describe("SileroModel", () => {
  test("speech (a spoken request) scores high", async () => {
    const speech = readWav(path.join(import.meta.dir, "fixtures", "speech-16k.wav"))
    expect(speech.rate).toBe(SILERO_RATE)
    const p = await probs(speech.samples)
    expect(Math.max(...p)).toBeGreaterThan(0.95)
    expect(share(p, 0.6)).toBeGreaterThan(0.7)
  })

  test("quiet speech still scores high (the model is level-independent)", async () => {
    const speech = readWav(path.join(import.meta.dir, "fixtures", "speech-16k.wav")).samples.map((x) => x * 0.05)
    expect(share(await probs(speech), 0.6)).toBeGreaterThan(0.7)
  })

  test("white noise, typing clicks and silence score low", async () => {
    const white = Float32Array.from({ length: N }, () => (rnd() * 2 - 1) * 0.3)
    const clicks = Float32Array.from({ length: N }, (_, i) => (i % 2400 < 40 ? (rnd() * 2 - 1) * 0.6 * Math.exp(-(i % 2400) / 8) : (rnd() * 2 - 1) * 0.002))
    for (const audio of [white, clicks, new Float32Array(N)]) expect(Math.max(...(await probs(audio)))).toBeLessThan(0.6)
  })

  test("mains hum stays mostly below the start threshold", async () => {
    const hum = Float32Array.from({ length: N }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 60 * i) / SILERO_RATE) + 0.1 * Math.sin((2 * Math.PI * 120 * i) / SILERO_RATE))
    expect(share(await probs(hum), 0.6)).toBeLessThan(0.1)
  })

  test("reset clears the recurrent state (same input, same score)", async () => {
    const speech = readWav(path.join(import.meta.dir, "fixtures", "speech-16k.wav")).samples
    const first = await probs(speech.subarray(0, SILERO_FRAME * 10))
    const again = await probs(speech.subarray(0, SILERO_FRAME * 10))
    expect(again).toEqual(first)
  })

  test("a chunk of the wrong size is refused", async () => {
    await expect(model.probability(new Float32Array(480))).rejects.toThrow(/512/)
  })
})
