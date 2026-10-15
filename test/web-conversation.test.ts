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
const g = globalThis as any
beforeEach(() => {
  mic = deferred<unknown>()
  stopped = 0
  g.Audio = FakeAudio
  g.window = g
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } })
  g.AudioContext = class {
    state = "running"
    sampleRate = 48_000
    destination = {}
    createMediaStreamSource = node
    createGain = node
    createScriptProcessor = node
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
      return Response.json({ agent: "voice", on: true })
    },
    player: new FakeAudio() as never,
    ui: { state: (s) => states.push(s), level: () => {}, user: (t) => t, tick: () => {}, agent: () => {}, note: () => {}, ended: () => states.push("ended") },
  })
  return { conversation, posts, states, hub: () => hub, resetHub: () => (hub = deferred<void>()) }
}

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
