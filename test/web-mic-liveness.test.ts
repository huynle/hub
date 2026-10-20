// Voice mode's microphone liveness (web/src/core/mic-liveness.ts): Android Chrome stops or mutes the mic when the
// screen turns off; Voice mode must notice (no frames, track muted/ended, AudioContext suspended) and say it is
// paused instead of "listening", and only claim listening again once frames arrive.
import { describe, expect, test } from "bun:test"
import { FRAME_GAP_MS, MicLiveness, recoveryDelay } from "../web/src/core/mic-liveness"

function make() {
  const changes: Array<[boolean, string | undefined]> = []
  const watch = new MicLiveness({ onChange: (live, reason) => changes.push([live, reason]) })
  watch.start(0)
  return { watch, changes }
}

describe("MicLiveness: losing the microphone", () => {
  test("starts live; frames keep it live", () => {
    const { watch, changes } = make()
    for (let t = 20; t <= 5000; t += 20) {
      watch.frame(t)
      watch.tick(t)
    }
    expect(watch.live).toBe(true)
    expect(changes).toEqual([])
  })

  test(`no frames for more than ${FRAME_GAP_MS} ms → lost (frames)`, () => {
    const { watch, changes } = make()
    watch.frame(100)
    watch.tick(100 + FRAME_GAP_MS)
    expect(watch.live).toBe(true)
    watch.tick(100 + FRAME_GAP_MS + 1)
    expect(watch.live).toBe(false)
    expect(watch.reason).toBe("frames")
    expect(changes).toEqual([[false, "frames"]])
    watch.tick(9000)
    expect(changes).toHaveLength(1)
  })

  test("track mute → lost at once, even though frames (silence) keep coming; unmute + a frame → live", () => {
    const { watch, changes } = make()
    watch.muted(true, 50)
    expect(watch.live).toBe(false)
    expect(watch.reason).toBe("muted")
    watch.frame(60)
    expect(watch.live).toBe(false)
    watch.muted(false, 70)
    expect(watch.live).toBe(false) // never claims listening without frames
    watch.frame(80)
    expect(watch.live).toBe(true)
    expect(changes).toEqual([
      [false, "muted"],
      [true, undefined],
    ])
  })

  test("track ended → lost and needs a new mic; frames from the old graph do not revive it; a new track does", () => {
    const { watch } = make()
    watch.ended(10)
    expect(watch.live).toBe(false)
    expect(watch.reason).toBe("ended")
    expect(watch.needsMic).toBe(true)
    watch.frame(20)
    expect(watch.live).toBe(false)
    watch.replaced(30)
    expect(watch.needsMic).toBe(false)
    expect(watch.live).toBe(false)
    watch.frame(40)
    expect(watch.live).toBe(true)
  })

  test("AudioContext suspended or interrupted → lost; running + a frame → live", () => {
    for (const state of ["suspended", "interrupted"]) {
      const { watch, changes } = make()
      watch.audio(state, 10)
      expect(watch.live).toBe(false)
      expect(watch.reason).toBe("suspended")
      watch.audio("running", 20)
      expect(watch.live).toBe(false)
      watch.frame(30)
      expect(watch.live).toBe(true)
      expect(changes).toEqual([
        [false, "suspended"],
        [true, undefined],
      ])
    }
  })

  test("page hidden while frames continue: still live (best-effort listening with the screen off works)", () => {
    const { watch } = make()
    watch.visibility(false, 10)
    for (let t = 20; t <= 4000; t += 20) {
      watch.frame(t)
      watch.tick(t)
    }
    expect(watch.live).toBe(true)
  })

  test("page hidden and frames stop → lost; visible again → wants recovery; frames → live", () => {
    const { watch } = make()
    watch.visibility(false, 10)
    expect(watch.wantsRecovery).toBe(false)
    watch.tick(10 + FRAME_GAP_MS + 1)
    expect(watch.live).toBe(false)
    expect(watch.wantsRecovery).toBe(false) // hidden: nothing to retry with the screen off
    watch.visibility(true, 3000)
    expect(watch.wantsRecovery).toBe(true)
    watch.frame(3010)
    expect(watch.live).toBe(true)
    expect(watch.wantsRecovery).toBe(false)
  })

  test("after a recovery, a new gap is measured from the last frame", () => {
    const { watch } = make()
    watch.tick(FRAME_GAP_MS + 1)
    watch.frame(5000)
    expect(watch.live).toBe(true)
    watch.tick(5000 + FRAME_GAP_MS)
    expect(watch.live).toBe(true)
    watch.tick(5000 + FRAME_GAP_MS + 1)
    expect(watch.live).toBe(false)
  })

  test("the most specific reason wins: ended over muted over suspended over frames", () => {
    const { watch } = make()
    watch.tick(FRAME_GAP_MS + 1)
    expect(watch.reason).toBe("frames")
    watch.audio("suspended", 2000)
    expect(watch.reason).toBe("suspended")
    watch.muted(true, 2001)
    expect(watch.reason).toBe("muted")
    watch.ended(2002)
    expect(watch.reason).toBe("ended")
  })

  test("start() resets everything (a new Voice mode run)", () => {
    const { watch } = make()
    watch.ended(10)
    watch.start(100)
    expect(watch.live).toBe(true)
    expect(watch.needsMic).toBe(false)
    watch.tick(100 + FRAME_GAP_MS + 1)
    expect(watch.live).toBe(false)
  })
})

describe("recoveryDelay: retry with backoff while visible", () => {
  test("doubles from 500 ms up to 8 s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(recoveryDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000])
  })
})
