// Conversation mode: voice commands, filler detection and "looks complete" endpointing heuristics.
import { describe, expect, test } from "bun:test"
import { isFiller, looksComplete, parseCommand } from "../web/src/core/conversation-core"

describe("parseCommand", () => {
  test("interrupt commands, case and punctuation insensitive", () => {
    for (const text of ["stop", "Stop.", "STOP!", "cancel", "Cancel.", "never mind", "Never mind.", "Nevermind", "stop that", "Stop that!", "hold on", "Hold on…", "  hold   on  "]) {
      expect(parseCommand(text)).toBe("interrupt")
    }
  })

  test("pause listening turns conversation mode off", () => {
    expect(parseCommand("Pause listening.")).toBe("pause")
    expect(parseCommand("pause listening")).toBe("pause")
  })

  test("commands only match the whole utterance", () => {
    for (const text of ["stop the server", "don't stop", "cancel the build please", "hold on to that file", "", "please pause listening to the logs"]) {
      expect(parseCommand(text)).toBeUndefined()
    }
  })
})

describe("isFiller", () => {
  test("empty and pure filler transcripts", () => {
    for (const text of ["", "   ", "Um.", "uh", "Uh, um...", "Hmm?", "mm-hmm", "Ah"]) expect(isFiller(text)).toBe(true)
  })

  test("real words are not filler", () => {
    for (const text of ["Yes.", "um, run the tests", "no", "OK"]) expect(isFiller(text)).toBe(false)
  })
})

describe("looksComplete", () => {
  test("terminal punctuation means complete", () => {
    expect(looksComplete("Run the tests.")).toBe(true)
    expect(looksComplete("Why?")).toBe(true)
    expect(looksComplete("Yes!")).toBe(true)
    expect(looksComplete('He said "go."')).toBe(true)
  })

  test("trailing off (ellipsis, comma, dash) is not complete", () => {
    expect(looksComplete("I was thinking...")).toBe(false)
    expect(looksComplete("I was thinking…")).toBe(false)
    expect(looksComplete("Run the tests,")).toBe(false)
    expect(looksComplete("Run the tests -")).toBe(false)
  })

  test("three or more words without a trailing conjunction or filler is complete", () => {
    expect(looksComplete("run the tests")).toBe(true)
    expect(looksComplete("check the build output now")).toBe(true)
  })

  test("short or dangling phrases are incomplete", () => {
    expect(looksComplete("run tests")).toBe(false)
    expect(looksComplete("")).toBe(false)
    for (const tail of ["and", "but", "so", "um", "uh", "because", "then", "with", "to", "the", "a", "maybe"]) {
      expect(looksComplete(`check the build ${tail}`)).toBe(false)
    }
    expect(looksComplete("Check the build and.")).toBe(false) // transcribers add periods to cut-offs
  })
})
