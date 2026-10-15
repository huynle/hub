// The app-level Voice mode controller (web/src/core/voice-controller.ts): the Voice button is a toggle per
// session, only one session is in Voice mode at a time (turning it on elsewhere turns the first one off first),
// Voice mode keeps running while the user looks at other sessions, End = toggle off, and failures leave
// everything off with the error shown for the session that failed.
import { describe, expect, test } from "bun:test"
import type { ConversationUI } from "../web/src/voice/conversation"
import { VoiceController, type VoiceConversation } from "../web/src/core/voice-controller"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

class FakeConversation implements VoiceConversation {
  paused = false
  agent: string | undefined = "voice"
  stopped = 0
  events: unknown[] = []
  statuses: unknown[] = []
  typed: string[] = []
  startResult = deferred<boolean>()
  constructor(
    readonly sessionID: string,
    readonly ui: ConversationUI<string>,
    private readonly log: string[],
  ) {}
  start() {
    this.log.push(`start ${this.sessionID}`)
    return this.startResult.promise
  }
  async stop() {
    this.stopped++
    this.log.push(`stop ${this.sessionID}`)
    this.ui.state("off")
    this.ui.ended()
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
  }
  onEvent(m: unknown) {
    this.events.push(m)
  }
  onStatus(s: unknown) {
    this.statuses.push(s)
  }
  async sendTyped(text: string) {
    this.typed.push(text)
  }
}

function harness({ autoStart = true }: { autoStart?: boolean } = {}) {
  const log: string[] = []
  const convs: FakeConversation[] = []
  const notes: Array<[string, string | undefined]> = []
  let exposeResult: (id: string) => Promise<boolean> = async () => true
  const controller = new VoiceController<FakeConversation>({
    expose: (id) => {
      log.push(`expose ${id}`)
      return exposeResult(id)
    },
    create: (id, ui) => {
      const c = new FakeConversation(id, ui, log)
      convs.push(c)
      if (autoStart) {
        // Started conversations report listening like the real one.
        c.startResult.promise.then((ok) => ok && ui.state("listening"))
        queueMicrotask(() => c.startResult.resolve(true))
      }
      return c
    },
    stopPlayback: () => log.push("stopPlayback"),
    notify: (text, kind) => notes.push([text, kind]),
  })
  return { controller, log, convs, notes, setExpose: (fn: (id: string) => Promise<boolean>) => (exposeResult = fn) }
}

describe("VoiceController", () => {
  test("toggle on, then off, in one session", async () => {
    const h = harness()
    await h.controller.toggle("A")
    expect(h.controller.state).toMatchObject({ sessionID: "A", phase: "on", voice: "listening", agent: "voice" })
    expect(h.controller.isOn("A")).toBe(true)
    expect(h.controller.isOn("B")).toBe(false)
    await h.controller.toggle("A")
    expect(h.controller.state).toMatchObject({ phase: "off", voice: "off" })
    expect(h.controller.state.sessionID).toBeUndefined()
    expect(h.convs[0]!.stopped).toBe(1)
    expect(h.log).toEqual(["expose A", "start A", "stopPlayback", "stop A"])
  })

  test("turning Voice mode on in B turns A off first (mic, playback, hub), then B on", async () => {
    const h = harness()
    await h.controller.toggle("A")
    await h.controller.toggle("B")
    expect(h.log).toEqual(["expose A", "start A", "stopPlayback", "stop A", "expose B", "start B"])
    expect(h.convs[0]!.stopped).toBe(1)
    expect(h.controller.state).toMatchObject({ sessionID: "B", phase: "on" })
  })

  test("Voice mode keeps running while another session is viewed: session views attach and detach without stopping it", async () => {
    const h = harness()
    const notesA: string[] = []
    const detachA = h.controller.attach("A", { user: (t) => t, tick: () => {}, agent: () => {}, note: (t) => notesA.push(t) })
    await h.controller.toggle("A")
    detachA() // the user went to session B
    expect(h.controller.state).toMatchObject({ sessionID: "A", phase: "on" })
    expect(h.convs[0]!.stopped).toBe(0)
    // Events of A still reach A's conversation; events of other sessions do not.
    h.controller.onEvent({ type: "say", sessionID: "A", text: "hi" })
    h.controller.onEvent({ type: "say", sessionID: "B", text: "no" })
    h.controller.onStatus("A", [{ id: "A", state: "working" }])
    h.controller.onStatus("B", [{ id: "B", state: "working" }])
    expect(h.convs[0]!.events).toEqual([{ type: "say", sessionID: "A", text: "hi" }])
    expect(h.convs[0]!.statuses).toHaveLength(1)
    // Notes of a session that is not on screen become notices.
    h.convs[0]!.ui.note("Voice mode was turned off.")
    expect(notesA).toEqual([])
    expect(h.notes.at(-1)).toEqual(["Voice mode was turned off.", undefined])
  })

  test("End (the Voice bar) is the same as toggling off", async () => {
    const h = harness()
    await h.controller.toggle("A")
    await h.controller.end()
    expect(h.controller.state.phase).toBe("off")
    expect(h.convs[0]!.stopped).toBe(1)
    expect(h.log.slice(-2)).toEqual(["stopPlayback", "stop A"])
  })

  test("if turning on B fails, A stays off and B's error is shown", async () => {
    const h = harness({ autoStart: false })
    const a = h.controller.toggle("A")
    await Bun.sleep(0)
    h.convs[0]!.startResult.resolve(true)
    await a
    const b = h.controller.toggle("B")
    await Bun.sleep(0)
    h.convs[1]!.ui.note("Microphone permission was denied.", "err")
    h.convs[1]!.ui.state("off")
    h.convs[1]!.startResult.resolve(false)
    await b
    expect(h.convs[0]!.stopped).toBe(1)
    expect(h.controller.state).toMatchObject({ phase: "off", error: { sessionID: "B", message: "Microphone permission was denied." } })
    expect(h.controller.errorFor("B")).toBe("Microphone permission was denied.")
    expect(h.controller.errorFor("A")).toBeUndefined()
    // The next attempt clears the error.
    const again = h.controller.toggle("B")
    expect(h.controller.state.error).toBeUndefined()
    await Bun.sleep(0)
    h.convs[2]!.startResult.resolve(true)
    await again
    expect(h.controller.isOn("B")).toBe(true)
  })

  test("enabling Voice for the session fails: nothing starts, the error is shown", async () => {
    const h = harness()
    h.setExpose(async () => false)
    await h.controller.toggle("A")
    expect(h.convs).toHaveLength(0)
    expect(h.controller.state).toMatchObject({ phase: "off", error: { sessionID: "A" } })
  })

  test("toggled off while starting: the starting conversation is stopped, nothing keeps listening", async () => {
    const h = harness({ autoStart: false })
    const a = h.controller.toggle("A")
    await Bun.sleep(0)
    expect(h.controller.state).toMatchObject({ sessionID: "A", phase: "starting" })
    await h.controller.toggle("A")
    expect(h.convs[0]!.stopped).toBe(1)
    h.convs[0]!.startResult.resolve(true)
    await a
    expect(h.controller.state.phase).toBe("off")
    // Stopped during "enable Voice" (before the conversation exists): it is never created.
    const slow = deferred<boolean>()
    h.setExpose(() => slow.promise)
    const b = h.controller.toggle("B")
    await h.controller.end()
    slow.resolve(true)
    await b
    expect(h.convs).toHaveLength(1)
    expect(h.controller.state.phase).toBe("off")
  })

  test("the hub turning conversation mode off (or the conversation ending itself) turns Voice mode off", async () => {
    const h = harness()
    await h.controller.toggle("A")
    h.convs[0]!.ui.state("off")
    h.convs[0]!.ui.ended()
    expect(h.controller.state).toMatchObject({ phase: "off" })
    expect(h.controller.state.sessionID).toBeUndefined()
  })

  test("hold (dictation) mutes Voice mode and the release unmutes it; mute toggles; typed text goes to the active session", async () => {
    const h = harness()
    await h.controller.toggle("A")
    const release = h.controller.hold()
    expect(h.convs[0]!.paused).toBe(true)
    release()
    expect(h.convs[0]!.paused).toBe(false)
    h.controller.mute()
    expect(h.convs[0]!.paused).toBe(true)
    // A hold while already muted does not unmute on release.
    h.controller.hold()()
    expect(h.convs[0]!.paused).toBe(true)
    h.controller.mute()
    expect(h.convs[0]!.paused).toBe(false)
    expect(await h.controller.sendTyped("A", "typed")).toBe(true)
    expect(await h.controller.sendTyped("B", "typed")).toBe(false)
    expect(h.convs[0]!.typed).toEqual(["typed"])
  })

  test("level, held text and state reach subscribers", async () => {
    const h = harness()
    let changes = 0
    h.controller.subscribe(() => changes++)
    await h.controller.toggle("A")
    h.convs[0]!.ui.level(0.5)
    h.convs[0]!.ui.held?.("so I was")
    expect(h.controller.state).toMatchObject({ level: 0.5, held: "so I was" })
    expect(changes).toBeGreaterThan(3)
  })
})
