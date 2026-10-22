// Progress cue output: fixed phrases are prefetched when Voice mode starts (kept in memory and, keyed by
// voice and text, in Cache Storage for later page loads); playback uses the chosen speed; a phrase that is not
// ready yet falls back to a short tone instead of waiting for synthesis.
import { afterEach, describe, expect, test } from "bun:test"
import { CUE_CACHE, CuePlayer, PREFETCH_CONCURRENCY } from "../web/src/core/cues"

class FakeAudio {
  src = ""
  volume = 0.5
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

/** Cache Storage stand-in (shared across "page loads" like the real one). */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>()
  const url = (r: RequestInfo | URL) => (typeof r === "string" ? r : r instanceof URL ? r.href : r.url)
  return {
    stores,
    async delete(name: string) {
      return stores.delete(name)
    },
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)!
      return {
        async match(r: RequestInfo | URL) {
          return store.get(url(r))?.clone()
        },
        async put(r: RequestInfo | URL, res: Response) {
          store.set(url(r), res)
        },
        async keys() {
          return [...store.keys()].map((u) => new Request(u))
        },
        async delete(r: RequestInfo | URL) {
          return store.delete(url(r))
        },
      }
    },
  }
}

let urls = 0
/** What each object URL points at (the audio a cue plays). */
const objects = new Map<string, Blob>()
;(URL as any).createObjectURL = (blob: Blob) => {
  const url = `blob:${++urls}`
  objects.set(url, blob)
  return url
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const g = globalThis as any
afterEach(() => {
  delete g.caches
})

type Normalize = (audio: Blob, target: number) => Promise<Blob>

function setup({ fail = false, slow = false, normalize, target }: { fail?: boolean; slow?: boolean; normalize?: Normalize; target?: (key: string | undefined) => number } = {}) {
  const calls: string[] = []
  const speaking: boolean[] = []
  const earcons: string[] = []
  const audio = new FakeAudio()
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const aborted: string[] = []
  const api = async (_path: string, init: { json: { text: string }; signal?: AbortSignal }) => {
    calls.push(init.json.text)
    if (slow)
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve)
        init.signal?.addEventListener("abort", () => {
          aborted.push(init.json.text)
          reject(new Error("aborted"))
        })
      })
    if (fail) throw new Error("tts down")
    return new Response(new Blob([`mp3:${init.json.text}`], { type: "audio/mpeg" }))
  }
  const player = new CuePlayer({ api, speed: () => 1.5, onSpeaking: (on: boolean) => speaking.push(on), audio, normalize, target })
  player.earcon = (name) => void earcons.push(name)
  return { player, calls, speaking, audio, earcons, release, aborted }
}

const PHRASES = ["Working on it.", "Started a subagent.", "Still working."]

describe("CuePlayer", () => {
  test("prefetch synthesizes at most PREFETCH_CONCURRENCY (2) phrases at a time, in order, each once", async () => {
    const { player, calls, release } = setup({ slow: true })
    const many = [...PHRASES, "One.", "Two.", "Three.", "Four."]
    const all = player.prefetch(many)
    await tick()
    expect(PREFETCH_CONCURRENCY).toBe(2) // leaves the browser's ~6 HTTP/1.1 connections for replies and events
    expect(calls).toEqual(many.slice(0, PREFETCH_CONCURRENCY))
    release()
    await all
    expect(calls).toEqual(many)
    expect(many.every((p) => player.ready(p))).toBe(true)
  })

  test("close() cancels a prefetch: in-flight requests are aborted and queued phrases are not requested", async () => {
    const { player, calls, release, aborted } = setup({ slow: true })
    const many = [...PHRASES, "One.", "Two.", "Three.", "Four."]
    const all = player.prefetch(many)
    await tick()
    player.close()
    release()
    await all
    expect(calls).toEqual(many.slice(0, PREFETCH_CONCURRENCY))
    expect(aborted).toEqual(many.slice(0, PREFETCH_CONCURRENCY))
    expect(many.some((p) => player.ready(p))).toBe(false)
  })

  test("prefetch synthesizes the phrases once; later says reuse them", async () => {
    const { player, calls, release } = setup({ slow: true })
    const all = player.prefetch(PHRASES)
    await tick()
    expect(calls).toEqual(PHRASES.slice(0, PREFETCH_CONCURRENCY)) // the first ones in flight before any answered
    expect(player.ready("Working on it.")).toBe(false)
    const again = player.prefetch(PHRASES) // already loading: no second request
    release()
    await all
    await again
    expect(calls).toEqual(PHRASES)
    expect(PHRASES.every((p) => player.ready(p))).toBe(true)
  })

  test("a ready phrase starts playing synchronously (no fetch on the trigger)", async () => {
    const { player, calls, audio } = setup()
    await player.prefetch(PHRASES)
    expect(player.ready("Working on it.")).toBe(true)
    const done = player.say("Working on it.")
    expect(audio.src).toMatch(/^blob:/)
    expect(audio.paused).toBe(false)
    audio.end()
    await done
    const again = player.say("Working on it.")
    audio.end()
    await again
    expect(calls).toEqual(PHRASES)
  })

  test("a phrase that is not ready yet plays a short tone instead and keeps loading", async () => {
    const { player, calls, audio, earcons, release } = setup({ slow: true })
    void player.prefetch(PHRASES)
    await player.say("Working on it.")
    expect(earcons).toEqual(["pending"])
    expect(audio.src).toBe("")
    release()
    await tick()
    await tick()
    expect(player.ready("Working on it.")).toBe(true)
    expect(calls).toEqual(PHRASES)
  })

  test("plays at the chosen speed with pitch preserved and reports speaking", async () => {
    const { player, speaking, audio } = setup()
    await player.prefetch(["Still working."])
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
    await player.prefetch(["Still working."])
    const done = player.say("Still working.")
    await tick()
    player.stop()
    await done
    expect(audio.paused).toBe(true)
    expect(speaking).toEqual([true, false])
  })

  test("a failed synthesis is not cached: the tone plays and the next prefetch tries again", async () => {
    const { player, calls, speaking, earcons } = setup({ fail: true })
    await player.prefetch(["Working on it."])
    await player.say("Working on it.")
    expect(earcons).toEqual(["pending"])
    await player.prefetch(["Working on it."])
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(speaking).toEqual([])
  })

  test("with a voice key, phrases persist in Cache Storage: the next page load needs no synthesis", async () => {
    g.caches = fakeCaches()
    const first = setup()
    await first.player.prefetch(PHRASES, "openrouter|tts-1|alloy|1")
    expect(first.calls).toEqual(PHRASES)
    expect([...g.caches.stores.values()][0].size).toBe(3)
    const second = setup()
    await second.player.prefetch(PHRASES, Promise.resolve("openrouter|tts-1|alloy|1"))
    expect(second.calls).toEqual([])
    expect(second.player.ready("Still working.")).toBe(true)
    // Another voice: synthesized again, and the old voice's entries are dropped.
    const third = setup()
    await third.player.prefetch(PHRASES, "openrouter|tts-1|nova|1")
    expect(third.calls).toEqual(PHRASES)
    const keys = [...[...g.caches.stores.values()][0].keys()]
    expect(keys).toHaveLength(3)
    expect(keys.every((k) => k.includes("nova"))).toBe(true)
  })

  test("without a key (or Cache Storage) phrases are kept in memory only", async () => {
    g.caches = fakeCaches()
    const { player } = setup()
    await player.prefetch(PHRASES, undefined)
    expect(g.caches.stores.size).toBe(0)
    delete g.caches
    const other = setup()
    await other.player.prefetch(PHRASES, "k")
    expect(other.player.ready("Working on it.")).toBe(true)
  })

  test("earcons without an unlocked audio context are a no-op", () => {
    const player = new CuePlayer({ api: async () => new Response(""), audio: new FakeAudio() })
    expect(() => player.play([{ type: "earcon", name: "heard" }])).not.toThrow()
    expect(() => player.earcon("pending")).not.toThrow()
  })
})

describe("CuePlayer loudness normalisation", () => {
  /** A fake normaliser: "wav(<target>):<input>" and a log of its calls. */
  function normalizer({ fail = false } = {}) {
    const calls: Array<{ input: string; target: number }> = []
    const normalize: Normalize = async (audio, target) => {
      const input = await audio.text()
      calls.push({ input, target })
      if (fail) throw new Error("cannot decode")
      return new Blob([`wav(${target}):${input}`], { type: "audio/wav" })
    }
    return { calls, normalize }
  }
  const played = async (audio: FakeAudio) => objects.get(audio.src)!.text()

  test("the cue cache is a new version (old un-normalised cues are dropped)", async () => {
    expect(CUE_CACHE).toBe("hub-cues-v2")
    g.caches = fakeCaches()
    await g.caches.open("hub-cues-v1")
    const { player } = setup({ normalize: normalizer().normalize })
    await player.prefetch(PHRASES, "voice")
    expect([...g.caches.stores.keys()]).toEqual(["hub-cues-v2"])
  })

  test("phrases are normalised to the voice's target while prefetching, before they are ready", async () => {
    const { calls, normalize } = normalizer()
    const targets: Array<string | undefined> = []
    const { player, audio } = setup({ normalize, target: (key) => (targets.push(key), -18) })
    await player.prefetch(["Still working."], "voice-a")
    expect(calls).toEqual([{ input: "mp3:Still working.", target: -18 }])
    expect(targets).toContain("voice-a")
    const done = player.say("Still working.")
    expect(await played(audio)).toBe("wav(-18):mp3:Still working.")
    audio.end()
    await done
    expect(calls).toHaveLength(1) // nothing happens at play time
  })

  test("without a target function the default −19.5 LUFS is used", async () => {
    const { calls, normalize } = normalizer()
    const { player } = setup({ normalize })
    await player.prefetch(["Hang on."])
    expect(calls[0]!.target).toBe(-19.5)
  })

  test("a phrase whose audio cannot be normalised plays the original", async () => {
    const { normalize } = normalizer({ fail: true })
    const { player, audio } = setup({ normalize })
    await player.prefetch(["On it."])
    expect(player.ready("On it.")).toBe(true)
    void player.say("On it.")
    expect(await played(audio)).toBe("mp3:On it.")
  })

  test("normalised phrases are cached: the next load neither synthesizes nor normalises", async () => {
    g.caches = fakeCaches()
    const first = normalizer()
    await setup({ normalize: first.normalize, target: () => -20 }).player.prefetch(PHRASES, "voice")
    expect(first.calls).toHaveLength(3)
    const second = normalizer()
    const again = setup({ normalize: second.normalize, target: () => -20.6 })
    await again.player.prefetch(PHRASES, "voice")
    expect(again.calls).toEqual([])
    expect(second.calls).toEqual([])
    void again.player.say("Still working.")
    expect(await played(again.audio)).toBe("wav(-20):mp3:Still working.")
  })

  test("a target that moved by more than 1 dB re-normalises the cached audio (no new synthesis) and caches it", async () => {
    g.caches = fakeCaches()
    await setup({ normalize: normalizer().normalize, target: () => -20 }).player.prefetch(["Still working."], "voice")
    const moved = normalizer()
    const next = setup({ normalize: moved.normalize, target: () => -17 })
    await next.player.prefetch(["Still working."], "voice")
    expect(next.calls).toEqual([])
    expect(moved.calls).toEqual([{ input: "wav(-20):mp3:Still working.", target: -17 }])
    const third = normalizer()
    await setup({ normalize: third.normalize, target: () => -17 }).player.prefetch(["Still working."], "voice")
    expect(third.calls).toEqual([])
  })

  test("cached audio that was never normalised (decode failed) is tried again", async () => {
    g.caches = fakeCaches()
    await setup({ normalize: normalizer({ fail: true }).normalize }).player.prefetch(["On it."], "voice")
    const retry = normalizer()
    const next = setup({ normalize: retry.normalize })
    await next.player.prefetch(["On it."], "voice")
    expect(next.calls).toEqual([])
    expect(retry.calls).toEqual([{ input: "mp3:On it.", target: -19.5 }])
  })

  test("cues play at full volume, like replies", async () => {
    const { player, audio } = setup()
    await player.prefetch(["Still working."])
    void player.say("Still working.")
    expect(audio.volume).toBe(1)
  })
})
