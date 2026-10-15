// Conversation mode: joining speculative per-segment transcripts into utterances.
import { describe, expect, test } from "bun:test"
import { Endpointer } from "../web/src/core/conversation-core"

/** Manual clock for the endpointer's hold timer. */
function clock() {
  let now = 0
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id)
    },
    advance(ms: number) {
      now += ms
      for (const t of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((x) => x !== t)
        t.fn()
      }
    },
    get pending() {
      return timers.length
    },
  }
}

function setup(options = {}) {
  const c = clock()
  const sent: string[] = []
  const e = new Endpointer({ send: (text: string) => sent.push(text), setTimer: c.setTimer, clearTimer: c.clearTimer, ...options })
  /** One spoken segment: speech start → end (returns the segment id). */
  const say = (ms = 1000) => {
    e.speechStarted()
    return e.segmentEnded(ms)
  }
  return { c, sent, e, say }
}

describe("Endpointer", () => {
  test("a complete transcript is sent at once", () => {
    const { sent, e, say } = setup()
    e.transcribed(say(), "Run the tests.")
    expect(sent).toEqual(["Run the tests."])
    expect(e.held).toBe("")
  })

  test("an incomplete transcript is held, then sent when the hold expires", () => {
    const { c, sent, e, say } = setup()
    e.transcribed(say(), "Run the tests and")
    expect(sent).toEqual([])
    expect(e.held).toBe("Run the tests and")
    c.advance(1499)
    expect(sent).toEqual([])
    c.advance(1)
    expect(sent).toEqual(["Run the tests and"])
    expect(e.held).toBe("")
  })

  test("new speech during the hold joins the next segment and re-evaluates", () => {
    const { c, sent, e, say } = setup()
    e.transcribed(say(), "Run the tests and")
    c.advance(800)
    e.speechStarted() // cancels the hold
    c.advance(5000)
    expect(sent).toEqual([])
    const id = e.segmentEnded(800)
    c.advance(5000) // still transcribing: nothing is sent
    expect(sent).toEqual([])
    e.transcribed(id, "then lint everything.")
    expect(sent).toEqual(["Run the tests and then lint everything."])
  })

  test("transcripts are applied in segment order even if they return out of order", () => {
    const { sent, e, say } = setup()
    const first = say()
    const second = say()
    e.transcribed(second, "the build output.")
    expect(sent).toEqual([])
    e.transcribed(first, "Then check")
    expect(sent).toEqual(["Then check the build output."])
  })

  test("a complete segment is sent even while later segments are still transcribing", () => {
    const { sent, e, say } = setup()
    const first = say()
    const second = say()
    e.transcribed(first, "Run the tests.")
    expect(sent).toEqual(["Run the tests."])
    e.transcribed(second, "Then deploy it.")
    expect(sent).toEqual(["Run the tests.", "Then deploy it."])
  })

  test("empty and pure-filler transcripts are dropped; a held thought restarts its hold", () => {
    const { c, sent, e, say } = setup()
    e.transcribed(say(), "")
    e.transcribed(say(), "Um.")
    expect(sent).toEqual([])
    expect(c.pending).toBe(0)
    e.transcribed(say(), "check the")
    c.advance(1000)
    e.transcribed(say(), "uh")
    c.advance(1499)
    expect(sent).toEqual([])
    c.advance(1)
    expect(sent).toEqual(["check the"])
  })

  test("a command segment is sent alone at once and drops any held text", () => {
    const { sent, e, say } = setup()
    e.transcribed(say(), "and then maybe")
    e.transcribed(say(), "stop")
    expect(sent).toEqual(["stop"])
    expect(e.held).toBe("")
  })

  test("an utterance reaching the 60 s cap is sent even if incomplete", () => {
    const { sent, e, say } = setup()
    e.transcribed(say(40_000), "and so on and")
    expect(sent).toEqual([])
    e.transcribed(say(20_000), "so on and")
    expect(sent).toEqual(["and so on and so on and"])
  })

  test("reset forgets held text, pending segments and timers", () => {
    const { c, sent, e, say } = setup()
    e.transcribed(say(), "check the")
    const late = say()
    e.reset()
    e.transcribed(late, "Too late.")
    c.advance(5000)
    expect(sent).toEqual([])
    expect(e.held).toBe("")
  })
})
