// Voice mode's microphone processing: the browser's echo cancellation, noise suppression and gain control on a
// mono track, and the detector's echo guard (stricter while the agent or a cue speaks, and briefly after).
import { describe, expect, test } from "bun:test"
import { micConstraints } from "../web/src/core/conversation-core"
import { SPEAKING_TAIL_MS, VoiceDetector } from "../web/src/core/speech-vad"

describe("micConstraints", () => {
  test("asks for echo cancellation, noise suppression, auto gain and one channel", () => {
    expect(micConstraints()).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
  })

  test("a chosen microphone is required exactly", () => {
    expect(micConstraints("mic-2")).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, deviceId: { exact: "mic-2" } },
    })
  })
})

const RATE = 16_000
const FRAME = 320
const feed = (d: VoiceDetector, amp: number, ms: number) => {
  for (let i = 0; i < ms / 20; i++) d.push(new Float32Array(FRAME).fill(amp))
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function detector(prob: (amp: number) => number) {
  const events: string[] = []
  const d = new VoiceDetector({ sampleRate: RATE, onEvents: (e) => events.push(...e.map((x) => x.type)), warn: () => {} })
  d.classifier = async (chunk) => prob(chunk[0]!)
  return { d, events }
}

describe("echo guard", () => {
  test("reply echo the canceller left over (moderate probability) does not barge in; a clear voice does", async () => {
    const echo = detector((amp) => (amp > 0.1 ? 0.8 : 0.01))
    echo.d.speaking = true
    feed(echo.d, 0.001, 600)
    feed(echo.d, 0.3, 1500)
    feed(echo.d, 0.001, 800)
    await tick()
    expect(echo.events).toEqual([])

    const voice = detector((amp) => (amp > 0.1 ? 0.97 : 0.01))
    voice.d.speaking = true
    feed(voice.d, 0.001, 600)
    feed(voice.d, 0.3, 800)
    feed(voice.d, 0.001, 800)
    await tick()
    expect(voice.events).toEqual(["start", "end"])
  })

  test(`the guard stays up for ${SPEAKING_TAIL_MS} ms after speech stops (room echo tail), then drops`, async () => {
    const { d, events } = detector((amp) => (amp > 0.1 ? 0.8 : 0.01))
    d.speaking = true
    feed(d, 0.001, 600)
    d.speaking = false
    feed(d, 0.3, 320) // echo tail right after the reply ends (long enough to count as speech without the guard)
    feed(d, 0.001, 800)
    await tick()
    expect(events).toEqual([])
    feed(d, 0.3, 800) // the user, well after
    feed(d, 0.001, 800)
    await tick()
    expect(events).toEqual(["start", "end"])
  })

  test(`${SPEAKING_TAIL_MS} ms is short (a quick reply after the agent stops still counts)`, () => {
    expect(SPEAKING_TAIL_MS).toBeGreaterThanOrEqual(350)
    expect(SPEAKING_TAIL_MS).toBeLessThanOrEqual(600)
  })
})
