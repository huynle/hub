// Voice turn timing: speech end → transcript → utterance accepted → first say → first audio, summed up for the
// Voice bar ("last turn: 1.8 s to first audio").
import { describe, expect, test } from "bun:test"
import { TurnTimer, describeTurn } from "../web/src/core/conversation-core"

describe("TurnTimer", () => {
  test("a spoken turn: every step, completed by the first audio", () => {
    const t = new TurnTimer()
    t.mark("speechEnd", 1000)
    t.mark("transcript", 1600)
    t.mark("accepted", 1800)
    t.mark("firstSay", 2500)
    expect(t.last).toBeUndefined()
    expect(t.mark("firstAudio", 2800)).toBe(true)
    expect(t.last).toEqual({ speechEnd: 1000, transcript: 1600, accepted: 1800, firstSay: 2500, firstAudio: 2800 })
    expect(describeTurn(t.last)).toEqual({
      summary: "last turn: 1.8 s to first audio",
      detail: "transcript 0.6 s · accepted 0.2 s · first reply 0.7 s · audio 0.3 s",
    })
  })

  test("the latest segment's end starts the turn; later says and audio of the same reply do not count again", () => {
    const t = new TurnTimer()
    t.mark("speechEnd", 1000)
    t.mark("transcript", 1500)
    t.mark("speechEnd", 2000) // the user went on
    t.mark("transcript", 2400)
    t.mark("accepted", 2500)
    t.mark("firstSay", 3000)
    t.mark("firstSay", 3100)
    t.mark("firstAudio", 3200)
    expect(t.mark("firstAudio", 4000)).toBe(false)
    expect(t.last).toMatchObject({ speechEnd: 2000, transcript: 2400, firstSay: 3000, firstAudio: 3200 })
  })

  test("the first audio byte is a step between the first reply and playing (streamed speech)", () => {
    const t = new TurnTimer()
    t.mark("accepted", 500)
    expect(t.mark("firstByte", 600)).toBe(false) // no reply yet: a cue or an older sentence
    t.mark("firstSay", 1200)
    expect(t.mark("firstByte", 1400)).toBe(true)
    expect(t.mark("firstByte", 1450)).toBe(false)
    t.mark("firstAudio", 1500)
    expect(t.last).toEqual({ accepted: 500, firstSay: 1200, firstByte: 1400, firstAudio: 1500 })
    expect(describeTurn(t.last)).toEqual({ summary: "last turn: 1.0 s to first audio", detail: "first reply 0.7 s · first byte 0.2 s · audio 0.1 s" })
  })

  test("a typed turn counts from when it was accepted", () => {
    const t = new TurnTimer()
    t.mark("accepted", 500)
    t.mark("firstSay", 1200)
    t.mark("firstAudio", 1500)
    expect(describeTurn(t.last)).toEqual({ summary: "last turn: 1.0 s to first audio", detail: "first reply 0.7 s · audio 0.3 s" })
  })

  test("says and audio without a pending turn (a subagent's result later) are ignored", () => {
    const t = new TurnTimer()
    expect(t.mark("firstSay", 100)).toBe(false)
    expect(t.mark("firstAudio", 200)).toBe(false)
    expect(t.last).toBeUndefined()
    expect(describeTurn(undefined)).toBeUndefined()
  })
})
