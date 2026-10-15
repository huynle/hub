// Progress cue output: fixed phrases are synthesized once and cached; playback uses the chosen speed.
import { describe, expect, test } from "bun:test"
import { CuePlayer } from "../web/src/core/cues"

class FakeAudio {
  src = ""
  paused = true
  playbackRate = 1
  defaultPlaybackRate = 1
  preservesPitch = false
  onended: (() => void) | null = null
  onpause: (() => void) | null = null
  onerror: (() => void) | null = null
  async play() {
    this.paused = false
  }
  pause() {
    this.paused = true
    this.onpause?.()
  }
  end() {
    this.paused = true
    this.onended?.()
  }
}

let urls = 0
;(URL as any).createObjectURL = () => `blob:${++urls}`
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup({ fail = false } = {}) {
  const calls: string[] = []
  const speaking: boolean[] = []
  const audio = new FakeAudio()
  const api = async (_path: string, init: { json: { text: string } }) => {
    calls.push(init.json.text)
    if (fail) throw new Error("tts down")
    return new Response(new Blob([init.json.text]))
  }
  const player = new CuePlayer({ api, speed: () => 1.5, onSpeaking: (on: boolean) => speaking.push(on), audio })
  return { player, calls, speaking, audio }
}

describe("CuePlayer", () => {
  test("a phrase is fetched once and reused", async () => {
    const { player, calls, audio } = setup()
    const a = player.say("Working on it.")
    await tick()
    audio.end()
    await a
    const b = player.say("Working on it.")
    await tick()
    audio.end()
    await b
    expect(calls).toEqual(["Working on it."])
  })

  test("plays at the chosen speed with pitch preserved and reports speaking", async () => {
    const { player, speaking, audio } = setup()
    const done = player.say("Still working.")
    await tick()
    expect(audio.playbackRate).toBe(1.5)
    expect(audio.defaultPlaybackRate).toBe(1.5)
    expect(audio.preservesPitch).toBe(true)
    expect(player.speaking).toBe(true)
    audio.end()
    await done
    expect(speaking).toEqual([true, false])
  })

  test("stop() ends a phrase early", async () => {
    const { player, speaking, audio } = setup()
    const done = player.say("Still working.")
    await tick()
    player.stop()
    await done
    expect(audio.paused).toBe(true)
    expect(speaking).toEqual([true, false])
  })

  test("a failed synthesis is not cached and stays silent", async () => {
    const { player, calls, speaking } = setup({ fail: true })
    await player.say("Working on it.")
    await player.say("Working on it.")
    expect(calls.length).toBe(2)
    expect(speaking).toEqual([])
  })

  test("earcons without an unlocked audio context are a no-op", () => {
    const { player } = setup()
    expect(() => player.play([{ type: "earcon", name: "heard" }])).not.toThrow()
  })
})
