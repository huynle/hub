// Voice mode's Conversation (web/src/voice/conversation.ts) start/stop race: stopping while start() still
// waits for the microphone or the hub must not leave a listening conversation behind (it would keep sending
// what the user says to that session after they moved to another one). Browser APIs are stubbed.
import { beforeEach, describe, expect, test } from "bun:test"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

class FakeAudio {
  src = ""
  paused = true
  play() {
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  removeAttribute() {}
  load() {}
  setAttribute() {}
}

let mic: ReturnType<typeof deferred<unknown>>
let stopped: number
/** Earcon oscillators started on any fake AudioContext: [frequency, start time]. */
let tones: Array<[number, number]>
const g = globalThis as any
beforeEach(() => {
  mic = deferred<unknown>()
  stopped = 0
  tones = []
  g.Audio = FakeAudio
  g.window = g
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } })
  g.AudioContext = class {
    state = "running"
    sampleRate = 48_000
    currentTime = 5
    destination = {}
    createMediaStreamSource = node
    createScriptProcessor = node
    createGain() {
      const param = { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }
      return { connect: (x: unknown) => x, disconnect() {}, gain: param }
    }
    createOscillator() {
      const osc = { type: "", frequency: { value: 0 }, connect: (x: unknown) => x, start: (t: number) => tones.push([osc.frequency.value, t]), stop() {} }
      return osc
    }
    resume() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
  }
  g.document = { visibilityState: "hidden", addEventListener() {}, removeEventListener() {} }
  Object.defineProperty(g, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => mic.promise } },
  })
})

const stream = () => ({ getTracks: () => [{ stop: () => stopped++ }], getAudioTracks: () => [] })

async function make(options: Record<string, unknown> = {}) {
  const { Conversation } = await import("../web/src/voice/conversation")
  const posts: Array<{ path: string; json: unknown }> = []
  let hub = deferred<void>()
  const states: string[] = []
  const notes: Array<[string, string | undefined]> = []
  const player = new FakeAudio() as FakeAudio & { onended?: (() => void) | null }
  const conversation = new Conversation<string>({
    sessionID: "A",
    api: async (path, init) => {
      posts.push({ path, json: (init as { json?: unknown } | undefined)?.json })
      if (path.endsWith("/conversation") && (init as any)?.json?.on === true) await hub.promise
      if (path.endsWith("/utterance")) return Response.json({ inboxID: `inb_${posts.length}` }, { status: 202 })
      if (path === "/api/transcribe") return Response.json({ text: transcript })
      return Response.json({ agent: "voice", on: true })
    },
    player: player as never,
    ui: { state: (s) => states.push(s), level: () => {}, user: (t) => t, tick: () => {}, agent: () => {}, note: (text, kind) => notes.push([text, kind]), ended: () => states.push("ended") },
    options,
  })
  return { conversation, posts, states, notes, player, hub: () => hub, resetHub: () => (hub = deferred<void>()) }
}

let transcript = ""
const RATE = 48_000
const frame = (amp: number) => Float32Array.from({ length: RATE / 50 }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE) + ((i * 7919) % 13) / 13e4)
/** Feeds `ms` of audio in 20 ms frames straight into the conversation's VAD tap. */
const feed = (c: unknown, amp: number, ms: number) => {
  for (let t = 0; t < ms; t += 20) (c as { frame(s: Float32Array): void }).frame(frame(amp))
}

async function listening() {
  const made = await make()
  const started = made.conversation.start()
  mic.resolve(stream())
  made.hub().resolve()
  expect(await started).toBe(true)
  return made
}

describe("Conversation: instant acknowledgement", () => {
  test("the heard tone plays as soon as the VAD ends a segment, not again when the hub reports it heard", async () => {
    transcript = "Run the tests."
    const { conversation, posts } = await listening()
    feed(conversation, 0.001, 600)
    feed(conversation, 0.3, 700)
    expect(tones).toEqual([])
    feed(conversation, 0.001, 340)
    expect(tones).toEqual([])
    feed(conversation, 0.001, 40) // end of speech: 350 ms of silence
    expect(tones).toEqual([[880, 5.01]])
    await Bun.sleep(5)
    const utterance = posts.find((p) => p.path.endsWith("/utterance"))
    expect(utterance?.json).toEqual({ text: "Run the tests." })
    conversation.onEvent({ type: "heard", sessionID: "A", inboxID: `inb_${posts.indexOf(utterance!) + 1}` })
    expect(tones).toEqual([[880, 5.01]])
    await conversation.stop()
  })

  test("noise too short to be speech plays no tone", async () => {
    const { conversation } = await listening()
    feed(conversation, 0.001, 600)
    feed(conversation, 0.3, 200)
    feed(conversation, 0.001, 800)
    expect(tones).toEqual([])
    await conversation.stop()
  })

  test("typed text in Voice mode: the tone plays when the hub reports it heard", async () => {
    const { conversation, posts } = await listening()
    await conversation.sendTyped("hello there")
    expect(tones).toEqual([])
    const utterance = posts.find((p) => p.path.endsWith("/utterance"))!
    conversation.onEvent({ type: "heard", sessionID: "A", inboxID: `inb_${posts.indexOf(utterance) + 1}` })
    expect(tones).toEqual([[880, 5.01]])
    await conversation.stop()
  })
})

describe("Conversation start/stop race", () => {
  test("stopped while waiting for the microphone: start fails, the mic is released, the hub is never asked", async () => {
    const { conversation, posts } = await make()
    const started = conversation.start()
    await conversation.stop()
    mic.resolve(stream())
    expect(await started).toBe(false)
    expect(conversation.active).toBe(false)
    expect(stopped).toBe(1)
    expect(posts.filter((p) => (p.json as any)?.on === true)).toEqual([])
  })

  test("stopped while the hub turns conversation mode on: start fails and conversation mode is turned off again", async () => {
    const { conversation, posts, hub } = await make()
    const started = conversation.start()
    mic.resolve(stream())
    await Bun.sleep(1)
    expect(posts.map((p) => p.json)).toEqual([{ on: true }])
    await conversation.stop()
    hub().resolve()
    expect(await started).toBe(false)
    expect(conversation.active).toBe(false)
    expect(stopped).toBe(1)
    expect(posts.map((p) => p.json)).toEqual([{ on: true }, { on: false }])
  })
})

describe("Conversation: barge-in", () => {
  const say = (seq: number, text: string) => ({ type: "say", sessionID: "A", messageID: "msg_reply", ordinal: 0, seq, text })
  const spoken = (posts: Array<{ path: string; json: unknown }>, text: string) => posts.filter((p) => p.path === "/api/speak" && (p.json as any)?.text === text).length

  test("speaking while a reply is still being written drops its unspoken rest, also between two sentences", async () => {
    transcript = "Actually, check staging too."
    const { conversation, posts, player } = await listening()
    conversation.onEvent(say(0, "First sentence of the reply."))
    for (let i = 0; i < 20 && !player.onended; i++) await Bun.sleep(1)
    expect(spoken(posts, "First sentence of the reply.")).toBe(1)
    player.onended!() // the first sentence ends; the next is not written yet
    await Bun.sleep(5)
    feed(conversation, 0.001, 600)
    feed(conversation, 0.3, 700) // the user starts talking
    conversation.onEvent(say(1, "Second sentence nobody wants now."))
    feed(conversation, 0.001, 400)
    await Bun.sleep(10)
    expect(spoken(posts, "Second sentence nobody wants now.")).toBe(0)
    // The utterance steers the agent; nothing is interrupted (background workers keep running).
    expect(posts.find((p) => p.path.endsWith("/utterance"))?.json).toEqual({ text: "Actually, check staging too." })
    expect(posts.filter((p) => p.path.endsWith("/interrupt"))).toEqual([])
    // A new reply speaks again.
    conversation.onEvent({ type: "say", sessionID: "A", messageID: "msg_next", ordinal: 0, seq: 0, text: "Checking staging now." })
    await Bun.sleep(5)
    expect(spoken(posts, "Checking staging now.")).toBe(1)
    await conversation.stop()
  })

  test("a stop phrase interrupts the agent's turn at once", async () => {
    transcript = "Stop."
    const { conversation, posts } = await listening()
    feed(conversation, 0.001, 600)
    feed(conversation, 0.3, 700)
    feed(conversation, 0.001, 400)
    await Bun.sleep(10)
    expect(posts.filter((p) => p.path.endsWith("/interrupt"))).toHaveLength(1)
    expect(posts.filter((p) => p.path.endsWith("/utterance"))).toEqual([])
    await conversation.stop()
  })
})

describe("Conversation: the phone stops the microphone (screen off)", () => {
  /** A fake mic track: mute/unmute/ended are dispatched like the browser does. */
  class FakeTrack {
    enabled = true
    muted = false
    readyState = "live"
    private listeners = new Map<string, Array<() => void>>()
    addEventListener(type: string, fn: () => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
    }
    removeEventListener(type: string, fn: () => void) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn))
    }
    emit(type: string) {
      if (type === "mute") this.muted = true
      if (type === "unmute") this.muted = false
      if (type === "ended") this.readyState = "ended"
      for (const fn of this.listeners.get(type) ?? []) fn()
    }
    stop() {
      this.readyState = "ended"
    }
  }
  const micStream = (track: FakeTrack) => ({ getTracks: () => [track], getAudioTracks: () => [track] })
  const docListeners = new Map<string, Array<() => void>>()
  const setVisible = (visible: boolean) => {
    g.document.visibilityState = visible ? "visible" : "hidden"
    for (const fn of docListeners.get("visibilitychange") ?? []) fn()
  }
  let resumes: number
  let contexts: any[]
  let gum: Array<() => Promise<unknown>>
  let media: { playbackState: string }
  let realNow: () => number
  let clock: number

  beforeEach(() => {
    docListeners.clear()
    resumes = 0
    contexts = []
    gum = []
    media = { playbackState: "none" }
    g.document = {
      visibilityState: "visible",
      addEventListener: (type: string, fn: () => void) => docListeners.set(type, [...(docListeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: () => void) => docListeners.set(type, (docListeners.get(type) ?? []).filter((f) => f !== fn)),
    }
    const Base = g.AudioContext
    g.AudioContext = class extends Base {
      onstatechange: (() => void) | null = null
      constructor() {
        super()
        contexts.push(this)
      }
      resume() {
        resumes++
        if (this.state !== "running") {
          this.state = "running"
          this.onstatechange?.()
        }
        return Promise.resolve()
      }
      suspend() {
        this.state = "suspended"
        this.onstatechange?.()
      }
    }
    Object.defineProperty(g, "navigator", {
      configurable: true,
      value: {
        mediaSession: media,
        mediaDevices: { getUserMedia: () => (gum.shift() ?? (() => mic.promise))() },
      },
    })
    realNow = Date.now
    clock = realNow()
    Date.now = () => clock
  })
  const restore = () => (Date.now = realNow)

  async function live(options: Record<string, unknown> = {}) {
    const track = new FakeTrack()
    const made = await make(options)
    const started = made.conversation.start()
    mic.resolve(micStream(track))
    made.hub().resolve()
    expect(await started).toBe(true)
    feed(made.conversation, 0.001, 100)
    const freqs = () => tones.map(([f]) => f)
    const check = () => (made.conversation as any).checkMic()
    return { ...made, track, freqs, check }
  }

  test("track muted → suspended (not listening), descending tone, media session paused; unmute + audio → listening, ascending tone", async () => {
    const { conversation, states, track, freqs } = await live({ background: true })
    expect(states.at(-1)).toBe("listening")
    expect(media.playbackState).toBe("playing")
    track.emit("mute")
    expect(states.at(-1)).toBe("suspended")
    expect(media.playbackState).toBe("paused")
    expect(freqs()).toEqual([784, 523])
    // Silence frames of a muted track do not count as listening.
    feed(conversation, 0.001, 100)
    expect(states.at(-1)).toBe("suspended")
    track.emit("unmute")
    expect(states.at(-1)).toBe("suspended")
    feed(conversation, 0.001, 40)
    expect(states.at(-1)).toBe("listening")
    expect(media.playbackState).toBe("playing")
    expect(freqs()).toEqual([784, 523, 523, 784])
    await conversation.stop()
    restore()
  })

  test("frames stop while hidden → suspended; speech fed meanwhile is never sent; visible → AudioContext resumed, audio → listening", async () => {
    transcript = "Hello."
    const { conversation, states, posts, check } = await live()
    setVisible(false)
    const ctx = contexts.at(-1)
    clock += 1600
    check()
    expect(states.at(-1)).toBe("suspended")
    ctx.suspend()
    // Whatever trickles in from a suspended graph is not listened to.
    feed(conversation, 0.3, 700)
    feed(conversation, 0.001, 400)
    await Bun.sleep(5)
    expect(states.at(-1)).toBe("suspended")
    const before = resumes
    setVisible(true)
    expect(resumes).toBeGreaterThan(before)
    feed(conversation, 0.001, 40)
    expect(states.at(-1)).toBe("listening")
    expect(posts.filter((p) => p.path.endsWith("/utterance"))).toEqual([])
    await conversation.stop()
    restore()
  })

  test("AudioContext suspended → suspended; while hidden, resume is retried periodically", async () => {
    const { conversation, states, check } = await live({ background: true })
    setVisible(false)
    const ctx = contexts.at(-1)
    ctx.suspend()
    expect(states.at(-1)).toBe("suspended")
    ctx.resume = () => {
      resumes++
      return Promise.resolve()
    } // the phone keeps it suspended
    const before = resumes
    clock += 5000
    check()
    expect(resumes).toBeGreaterThan(before)
    expect(states.at(-1)).toBe("suspended")
    await conversation.stop()
    restore()
  })

  test("track ended → on visible the microphone is requested again and listening resumes with the new track's audio", async () => {
    const { conversation, states, track } = await live()
    const fresh = new FakeTrack()
    let asked = 0
    gum.push(async () => (asked++, micStream(fresh)))
    track.emit("ended")
    expect(states.at(-1)).toBe("suspended")
    setVisible(true)
    for (let i = 0; i < 20 && !asked; i++) await Bun.sleep(1)
    expect(asked).toBe(1)
    await Bun.sleep(1)
    feed(conversation, 0.001, 40)
    expect(states.at(-1)).toBe("listening")
    // The new track is watched too.
    fresh.emit("mute")
    expect(states.at(-1)).toBe("suspended")
    await conversation.stop()
    restore()
  })

  test("track ended and the browser wants a tap for the mic → Tap to start Voice mode", async () => {
    const { conversation, notes, track } = await live()
    g.navigator.permissions = { query: async () => ({ state: "prompt" }) }
    g.navigator.userActivation = { hasBeenActive: false }
    gum.push(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" })
    })
    track.emit("ended")
    setVisible(true)
    for (let i = 0; i < 20 && !notes.some(([, k]) => k === "gesture"); i++) await Bun.sleep(1)
    expect(notes).toContainEqual(["Tap to start Voice mode", "gesture"])
    await conversation.stop()
    restore()
  })
})
