// Voice mode's junk transcript filter: what speech-to-text makes of noise (Whisper's "Thank you.", "you",
// "Thanks for watching!", sound tags…) is dropped; real short answers and commands are kept.
import { describe, expect, test } from "bun:test"
import { SHORT_SPEECH_MS, junkTranscript } from "../web/src/core/junk-transcript"

const LONG = 1200 // ms of speech: plenty
const SHORT = 250

describe("junkTranscript", () => {
  test.each([
    ["", "empty"],
    ["   ", "empty"],
    ["...", "no words"],
    ["?!", "no words"],
    ["♪", "no words"],
    ["♪♪♪", "no words"],
    ["- -", "no words"],
    ["[Music]", "sound"],
    ["[BLANK_AUDIO]", "sound"],
    ["(applause)", "sound"],
    ["(Laughter)", "sound"],
    ["*coughs*", "sound"],
    ["♪ la la la ♪", "sound"],
    ["a", "too short"],
    ["I.", "too short"],
    ["Thank you.", "noise"],
    ["thank you", "noise"],
    ["Thank you!", "noise"],
    ["THANK YOU VERY MUCH.", "noise"],
    ["Thanks for watching!", "noise"],
    ["Thank you for watching.", "noise"],
    ["Thanks for watching, and see you next time!", "noise"],
    ["Please subscribe to my channel.", "noise"],
    ["you", "noise"],
    ["You.", "noise"],
    ["Bye.", "noise"],
    ["Bye-bye.", "noise"],
    ["Subtitles by the Amara.org community", "noise"],
    ["Subtitles by Steve", "noise"],
    ["Captions by GetTranscribed.com", "noise"],
    ["Transcribed by ESO, translated by —", "noise"],
    ["Amara.org", "noise"],
    ["ご視聴ありがとうございました", "noise"],
    ["Продолжение следует...", "noise"],
    ["the the the", "repeated"],
    ["you you you you", "repeated"],
    ["Okay okay okay okay okay", undefined],
  ])("%p → %p (whatever the length)", (text, reason) => {
    expect(junkTranscript(text, { speechMs: LONG })).toBe(reason as string | undefined)
  })

  test.each(["Yes.", "No.", "no", "Yeah.", "Okay.", "OK", "Sure.", "Stop!", "stop", "Cancel.", "Wait.", "Go ahead.", "Cancel that.", "Stop that.", "Never mind.", "Hold on.", "Pause listening.", "No, no, no.", "Yes please.", "No thanks.", "Continue.", "Next.", "Do it."])(
    "a short command is kept, even when spoken quickly: %p",
    (text) => {
      expect(junkTranscript(text, { speechMs: SHORT })).toBeUndefined()
      expect(junkTranscript(text, { speechMs: LONG })).toBeUndefined()
    },
  )

  test.each(["Hmm.", "Okay, so.", "Over there.", "Oh wow.", "Hello."])("one or two words from a blip of sound are dropped: %p", (text) => {
    // "Okay, so." has a keep word: kept.
    const expected = /okay/i.test(text) ? undefined : "short"
    expect(junkTranscript(text, { speechMs: SHORT })).toBe(expected)
  })

  test("the same words with enough speech behind them are kept", () => {
    for (const text of ["Hmm.", "Over there.", "Oh wow.", "Hello."]) expect(junkTranscript(text, { speechMs: SHORT_SPEECH_MS })).toBeUndefined()
  })

  test("three or more words are never dropped for being short", () => {
    expect(junkTranscript("Run the tests.", { speechMs: SHORT })).toBeUndefined()
  })

  test("without a duration the length rule does not apply", () => {
    expect(junkTranscript("Hello.")).toBeUndefined()
  })

  test("real requests are kept, including ones that contain a hallucination phrase", () => {
    for (const text of [
      "Can you check whether the build passed on main?",
      "Thank you, now deploy it to staging.",
      "Say thank you to the reviewer in the PR.",
      "Add subtitles to the video player.",
      "Why did you stop?",
    ]) {
      expect(junkTranscript(text, { speechMs: LONG })).toBeUndefined()
    }
  })

  test(`SHORT_SPEECH_MS is ${SHORT_SPEECH_MS} ms`, () => {
    expect(SHORT_SPEECH_MS).toBe(400)
  })
})
