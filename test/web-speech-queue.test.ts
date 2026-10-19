// Conversation mode: per-sentence TTS queue with two-ahead prefetch, sequential playback and barge-in clear.
import { describe, expect, test } from "bun:test"
import { SpeechQueue } from "../web/src/core/conversation-core"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const synths = new Map<string, { d: ReturnType<typeof deferred<string>>; signal: AbortSignal }>()
  const plays: Array<{ audio: string; d: ReturnType<typeof deferred<void>> }> = []
  const log: string[] = []
  const errors: string[] = []
  let stops = 0
  const q = new SpeechQueue({
    synth: (text: string, signal: AbortSignal) => {
      const d = deferred<string>()
      synths.set(text, { d, signal })
      log.push(`synth ${text}`)
      return d.promise
    },
    play: (audio: string) => {
      const d = deferred<void>()
      plays.push({ audio, d })
      log.push(`play ${audio}`)
      return d.promise
    },
    stop: () => {
      stops++
    },
    onState: (speaking: boolean) => log.push(`speaking ${speaking}`),
    onError: (_error: unknown, text: string) => errors.push(text),
  })
  return { q, synths, plays, log, errors, stops: () => stops }
}

describe("SpeechQueue", () => {
  test("plays sentences in order, prefetching up to two ahead", async () => {
    const { q, synths, plays, log } = setup()
    q.enqueue(["A.", "B.", "C.", "D."])
    await tick()
    expect([...synths.keys()]).toEqual(["A.", "B.", "C."]) // D waits
    expect(q.speaking).toBe(true)
    synths.get("B.")!.d.resolve("audio-B") // out of order: B arrives first, still waits for A
    await tick()
    expect(plays).toEqual([])
    synths.get("A.")!.d.resolve("audio-A")
    await tick()
    expect(plays.map((p) => p.audio)).toEqual(["audio-A"])
    plays[0]!.d.resolve()
    await tick()
    expect(plays.map((p) => p.audio)).toEqual(["audio-A", "audio-B"])
    expect([...synths.keys()]).toEqual(["A.", "B.", "C.", "D."]) // C and D prefetched while B plays
    synths.get("C.")!.d.resolve("audio-C")
    synths.get("D.")!.d.resolve("audio-D")
    plays[1]!.d.resolve()
    await tick()
    plays[2]!.d.resolve()
    await tick()
    plays[3]!.d.resolve()
    await tick()
    expect(q.speaking).toBe(false)
    expect(log.filter((l) => l.startsWith("speaking"))).toEqual(["speaking true", "speaking false"])
  })

  test("sentences enqueued while speaking are appended", async () => {
    const { q, synths, plays } = setup()
    q.enqueue(["A."])
    await tick()
    synths.get("A.")!.d.resolve("audio-A")
    await tick()
    q.enqueue(["B."])
    await tick()
    expect(synths.has("B.")).toBe(true)
    synths.get("B.")!.d.resolve("audio-B")
    plays[0]!.d.resolve()
    await tick()
    expect(plays.map((p) => p.audio)).toEqual(["audio-A", "audio-B"])
  })

  test("clear (barge-in) stops playback, aborts fetches and drops the queue", async () => {
    const { q, synths, plays, log, stops } = setup()
    q.enqueue(["A.", "B.", "C.", "X."])
    await tick()
    synths.get("A.")!.d.resolve("audio-A")
    await tick()
    expect(plays.length).toBe(1)
    q.clear()
    expect(stops()).toBe(1)
    expect(synths.get("B.")!.signal.aborted).toBe(true)
    expect(q.speaking).toBe(false)
    plays[0]!.d.resolve() // the paused element settles
    synths.get("B.")!.d.resolve("audio-B")
    await tick()
    expect(plays.length).toBe(1)
    expect(synths.get("C.")!.signal.aborted).toBe(true)
    expect(synths.has("X.")).toBe(false)
    expect(log.filter((l) => l.startsWith("speaking"))).toEqual(["speaking true", "speaking false"])
    // Works again afterwards.
    q.enqueue(["D."])
    await tick()
    synths.get("D.")!.d.resolve("audio-D")
    await tick()
    expect(plays.map((p) => p.audio)).toEqual(["audio-A", "audio-D"])
  })

  test("a failed synth is reported and skipped", async () => {
    const { q, synths, plays, errors } = setup()
    q.enqueue(["A.", "B."])
    await tick()
    synths.get("A.")!.d.reject(new Error("tts down"))
    synths.get("B.")!.d.resolve("audio-B")
    await tick()
    await tick()
    expect(errors).toEqual(["A."])
    expect(plays.map((p) => p.audio)).toEqual(["audio-B"])
  })

  test("clear when idle is harmless; blank sentences are ignored", async () => {
    const { q, synths, stops } = setup()
    q.clear()
    expect(stops()).toBe(1)
    q.enqueue(["", "  "])
    await tick()
    expect(synths.size).toBe(0)
    expect(q.speaking).toBe(false)
  })
})
