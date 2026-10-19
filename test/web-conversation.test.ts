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

async function make() {
  const { Conversation } = await import("../web/src/voice/conversation")
  const posts: Array<{ path: string; json: unknown }> = []
  let hub = deferred<void>()
  const states: string[] = []
  const conversation = new Conversation<string>({
    sessionID: "A",
    api: async (path, init) => {
      posts.push({ path, json: (init as { json?: unknown } | undefined)?.json })
      if (path.endsWith("/conversation") && (init as any)?.json?.on === true) await hub.promise
      if (path.endsWith("/utterance")) return Response.json({ inboxID: `inb_${posts.length}` }, { status: 202 })
      if (path === "/api/transcribe") return Response.json({ text: transcript })
      return Response.json({ agent: "voice", on: true })
    },
    player: new FakeAudio() as never,
    ui: { state: (s) => states.push(s), level: () => {}, user: (t) => t, tick: () => {}, agent: () => {}, note: () => {}, ended: () => states.push("ended") },
  })
  return { conversation, posts, states, hub: () => hub, resetHub: () => (hub = deferred<void>()) }
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
