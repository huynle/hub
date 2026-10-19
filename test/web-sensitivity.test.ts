// Settings → Voice → Mic sensitivity (Low / Normal / High): one table mapping each level to the Silero
// thresholds, the speech needed to start, and the energy pre-gate / fallback margins.
import { describe, expect, test } from "bun:test"
import { NORMAL_VAD, ProbabilityVad, SENSITIVITIES, SILERO_FRAME, VoiceDetector, parseSensitivity, sensitivityParams, type Sensitivity } from "../web/src/core/speech-vad"

const FRAME_MS = 32
const hold = (p: number, ms: number) => Array.from({ length: Math.round(ms / FRAME_MS) }, () => p)
const starts = (s: Sensitivity, probs: number[]) => {
  const vad = new ProbabilityVad(sensitivityParams(s))
  return probs.flatMap((p) => vad.process(new Float32Array(SILERO_FRAME), p)).filter((e) => e.type === "start").length
}

describe("sensitivity", () => {
  test("three levels, Normal by default; unknown values read as Normal", () => {
    expect(SENSITIVITIES).toEqual(["low", "normal", "high"])
    for (const v of [undefined, null, "", "loud", 3]) expect(parseSensitivity(v)).toBe("normal")
    for (const s of SENSITIVITIES) expect(parseSensitivity(s)).toBe(s)
  })

  test("Normal is the default detector tuning", () => {
    expect(sensitivityParams("normal")).toEqual(NORMAL_VAD)
  })

  test("the table: Low needs more (probability, duration, loudness) than Normal, High less", () => {
    const [low, normal, high] = SENSITIVITIES.map(sensitivityParams)
    expect(low).toMatchObject({ startProb: 0.75, endProb: 0.45, speakingStartProb: 0.92, minSpeechMs: 350, gateDb: 6, energyMarginDb: 13, energyMinSpeechMs: 400 })
    expect(normal).toMatchObject({ startProb: 0.6, endProb: 0.35, speakingStartProb: 0.85, minSpeechMs: 250, gateDb: 3, energyMarginDb: 10, energyMinSpeechMs: 300 })
    expect(high).toMatchObject({ startProb: 0.45, endProb: 0.25, speakingStartProb: 0.75, minSpeechMs: 180, gateDb: 0, energyMarginDb: 7, energyMinSpeechMs: 250 })
    for (const key of ["startProb", "endProb", "speakingStartProb", "minSpeechMs", "gateDb", "energyMarginDb", "energyMinSpeechMs"] as const) {
      expect(low![key]).toBeGreaterThan(normal![key])
      expect(normal![key]).toBeGreaterThan(high![key])
    }
    for (const p of [low!, normal!, high!]) {
      expect(p.endProb).toBeLessThan(p.startProb) // hysteresis
      expect(p.speakingStartProb).toBeGreaterThan(p.startProb) // echo guard
      expect(p.endSilenceMs).toBe(NORMAL_VAD.endSilenceMs) // turn-taking timing is not a sensitivity matter
    }
  })

  test("a mumble at 0.7 counts on Normal and High, not on Low; 0.5 only on High", () => {
    const mumble = (p: number) => [...hold(0.02, 500), ...hold(p, 600), ...hold(0.02, 800)]
    expect(SENSITIVITIES.map((s) => starts(s, mumble(0.7)))).toEqual([0, 1, 1])
    expect(SENSITIVITIES.map((s) => starts(s, mumble(0.5)))).toEqual([0, 0, 1])
  })

  test("a 220 ms word counts only on High; 300 ms on Normal too; Low needs 350 ms", () => {
    const word = (ms: number) => [...hold(0.02, 500), ...hold(0.95, ms), ...hold(0.02, 800)]
    expect(SENSITIVITIES.map((s) => starts(s, word(224)))).toEqual([0, 0, 1])
    expect(SENSITIVITIES.map((s) => starts(s, word(288)))).toEqual([0, 1, 1])
    expect(SENSITIVITIES.map((s) => starts(s, word(384)))).toEqual([1, 1, 1])
  })

  test("the detector applies a new level live (the next chunk uses it)", async () => {
    const events: string[] = []
    const d = new VoiceDetector({ sampleRate: 16_000, onEvents: (e) => events.push(...e.map((x) => x.type)), warn: () => {} })
    d.classifier = async (chunk) => (chunk[0]! > 0.1 ? 0.7 : 0.01)
    const feed = (amp: number, ms: number) => {
      for (let i = 0; i < ms / 20; i++) d.push(new Float32Array(320).fill(amp))
    }
    d.params = sensitivityParams("low")
    feed(0.001, 600)
    feed(0.3, 800)
    feed(0.001, 800)
    await new Promise((r) => setTimeout(r, 0))
    expect(events).toEqual([])
    d.params = sensitivityParams("normal")
    feed(0.3, 800)
    feed(0.001, 800)
    await new Promise((r) => setTimeout(r, 0))
    expect(events).toEqual(["start", "end"])
  })
})
