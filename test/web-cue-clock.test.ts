// Event-driven progress cues: CueClock arms one timer for the scheduler's next deadline (no polling).
import { describe, expect, test } from "bun:test"
import { CueClock, CueScheduler, type Cue, type CueName } from "../web/src/core/feedback-core"

const speak = (cue: CueName) => [{ type: "speak" as const, cue, text: expect.any(String) }]

function setup({ ready = () => true }: { ready?: () => boolean } = {}) {
  let now = 0
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let next = 1
  const played: Array<{ at: number; cues: Cue[] }> = []
  const scheduler = new CueScheduler()
  const clock = new CueClock({
    scheduler,
    play: (cues) => played.push({ at: now, cues }),
    ready,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = next++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id)
    },
  })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const t = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!t) break
      now = t.at
      timers = timers.filter((x) => x !== t)
      t.fn()
    }
    now = end
  }
  return { scheduler, clock, played, advance, timers: () => timers, at: (t: number) => (now = t) }
}

describe("CueScheduler defaults", () => {
  test("the acknowledgement 2.5 s after the end of speech", () => {
    expect(new CueScheduler().ackMs).toBe(2500)
  })

  test("the acknowledgement is measured from the local end of speech, not from the hub's heard", () => {
    const c = new CueScheduler()
    c.awaitReply(1000) // speech ended at 1000; the utterance was sent later
    c.working(true, 1600)
    c.heard(1900, { tone: false })
    expect(c.tick(3499)).toEqual([])
    expect(c.tick(3500)).toEqual(speak("working"))
  })

  test("nextDue: the next deadline; none when idle, gated or disabled", () => {
    const c = new CueScheduler()
    expect(c.nextDue(0)).toBeUndefined()
    c.awaitReply(0)
    expect(c.nextDue(0)).toBeUndefined() // not working: nothing to acknowledge yet
    c.working(true, 100)
    expect(c.nextDue(100)).toBe(2500)
    c.userTalking(true, 200)
    expect(c.nextDue(200)).toBeUndefined()
    c.userTalking(false, 300)
    expect(c.nextDue(300)).toBe(2500)
    c.agentSaid(400)
    expect(c.nextDue(400)).toBe(400 + 40_000)
    c.subagentStarted(5000)
    expect(c.nextDue(5000)).toBe(5000)
    c.enabled = false
    expect(c.nextDue(5000)).toBeUndefined()
  })
})

describe("CueClock", () => {
  test("arms one timer for the next deadline and plays the cue right on it", () => {
    const { scheduler, clock, played, advance, timers } = setup()
    clock.poke()
    expect(timers()).toEqual([]) // idle: no polling timer at all
    scheduler.awaitReply(0)
    scheduler.working(true, 0)
    clock.poke()
    expect(timers().map((t) => t.at)).toEqual([2500])
    advance(2499)
    expect(played).toEqual([])
    advance(1)
    expect(played).toEqual([{ at: 2500, cues: speak("working") }])
    expect(timers().map((t) => t.at)).toEqual([2500 + 40_000]) // then the still-working cue
  })

  test("pokes replace the timer; agent speech cancels the acknowledgement", () => {
    const { scheduler, clock, played, advance, timers, at } = setup()
    scheduler.awaitReply(0)
    scheduler.working(true, 0)
    clock.poke()
    clock.poke()
    expect(timers()).toHaveLength(1)
    at(1000)
    scheduler.agentSaid(1000)
    clock.poke()
    advance(10_000)
    expect(played).toEqual([])
    expect(timers().map((t) => t.at)).toEqual([41_000])
  })

  test("a due cue plays at once on poke (subagent started)", () => {
    const { scheduler, clock, played, at } = setup()
    scheduler.working(true, 0)
    at(10_000)
    scheduler.subagentStarted(10_000)
    clock.poke()
    expect(played).toEqual([{ at: 10_000, cues: speak("subagent") }])
  })

  test("while gated (user talking) nothing is armed; the ungating poke plays what is due", () => {
    const { scheduler, clock, played, advance, timers, at } = setup()
    scheduler.awaitReply(0)
    scheduler.working(true, 0)
    scheduler.userTalking(true, 100)
    clock.poke()
    expect(timers()).toEqual([])
    advance(5000)
    scheduler.userTalking(false, 5000)
    clock.poke()
    expect(played).toEqual([{ at: 5000, cues: speak("working") }])
    at(6000)
  })

  test("not ready (paused): nothing armed or played until a poke while ready; stop clears the timer", () => {
    let ready = false
    const { scheduler, clock, played, advance, timers } = setup({ ready: () => ready })
    scheduler.awaitReply(0)
    scheduler.working(true, 0)
    clock.poke()
    expect(timers()).toEqual([])
    advance(3000)
    ready = true
    clock.poke()
    expect(played.map((p) => p.at)).toEqual([3000])
    clock.stop()
    expect(timers()).toEqual([])
  })
})

describe("CueClock default timers", () => {
  test("calls the global setTimeout/clearTimeout unbound (browsers throw Illegal invocation for a method call)", () => {
    const g = globalThis as any
    const real = { set: g.setTimeout, clear: g.clearTimeout }
    const calls: string[] = []
    // Like the browser's: only callable with the global object (or nothing) as `this`.
    g.setTimeout = function (this: unknown, fn: () => void, ms: number) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation")
      calls.push(`set ${ms}`)
      return 1
    }
    g.clearTimeout = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation")
      calls.push("clear")
    }
    try {
      const scheduler = new CueScheduler()
      const clock = new CueClock({ scheduler, play: () => {}, now: () => 0 })
      scheduler.working(true, 0)
      scheduler.awaitReply(0)
      expect(() => clock.poke()).not.toThrow()
      expect(() => clock.poke()).not.toThrow()
      expect(calls).toContain("clear")
      expect(calls.some((c) => c.startsWith("set "))).toBe(true)
    } finally {
      g.setTimeout = real.set
      g.clearTimeout = real.clear
    }
  })
})
