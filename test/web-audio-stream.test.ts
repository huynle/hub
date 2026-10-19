// Streaming reply audio: a sentence's MP3 is played while it downloads. AudioClip buffers the bytes of one
// /api/speak response (prefetched sentences keep downloading while they wait), `feed` appends them to a
// MediaSource SourceBuffer one at a time, and `canStreamMp3` picks MediaSource or the whole-blob fallback.
import { describe, expect, test } from "bun:test"
import { AudioClip, canStreamMp3, clipFrom, feed, type AppendSink } from "../web/src/core/audio-stream"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const bytes = (...xs: number[]) => new Uint8Array(xs)

/** A body the test controls chunk by chunk. */
function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
  return { body, send: (...xs: number[]) => controller.enqueue(bytes(...xs)), close: () => controller.close(), error: (e: unknown) => controller.error(e) }
}

/** A SourceBuffer stand-in: each append completes when the test says so; overlapping appends are an error. */
function fakeSink() {
  const appended: number[][] = []
  const pending: Array<() => void> = []
  let busy = false
  let ended = 0
  const sink: AppendSink = {
    append(chunk) {
      if (busy) throw new Error("append while updating")
      busy = true
      appended.push([...chunk])
      return new Promise<void>((resolve) =>
        pending.push(() => {
          busy = false
          resolve()
        }),
      )
    },
    end() {
      ended++
    },
  }
  return { sink, appended, finish: () => pending.shift()?.(), ended: () => ended, busy: () => busy }
}

describe("AudioClip", () => {
  test("buffers a response body as it arrives; firstByte resolves with the first chunk; whole waits for the end", async () => {
    const { body, send, close } = controlledBody()
    const clip = clipFrom(body)
    let first = false
    void clip.firstByte.then(() => (first = true))
    await tick()
    expect(first).toBe(false)
    send(1, 2)
    await tick()
    expect(first).toBe(true)
    expect(clip.chunks.map((c) => [...c])).toEqual([[1, 2]])
    expect(clip.done).toBe(false)
    let whole: Uint8Array[] | undefined
    void clip.whole().then((w) => (whole = w))
    send(3)
    await tick()
    expect(whole).toBeUndefined()
    close()
    await tick()
    expect(clip.done).toBe(true)
    expect(whole!.map((c) => [...c])).toEqual([[1, 2], [3]])
  })

  test("read() yields what is buffered, then live chunks, and ends with the clip", async () => {
    const clip = new AudioClip()
    clip.push(bytes(1))
    const got: number[][] = []
    const reading = (async () => {
      for await (const chunk of clip.read()) got.push([...chunk])
    })()
    await tick()
    expect(got).toEqual([[1]])
    clip.push(bytes(2))
    await tick()
    expect(got).toEqual([[1], [2]])
    clip.end()
    await reading
    expect(got).toEqual([[1], [2]])
  })

  test("an aborted or failed download fails the clip: readers and whole() reject, firstByte never resolves late", async () => {
    const abort = new AbortController()
    const { body, send } = controlledBody()
    const clip = clipFrom(body, abort.signal)
    send(1)
    await tick()
    const reader = (async () => {
      for await (const _ of clip.read()) {
        // drain
      }
    })()
    abort.abort()
    await expect(reader).rejects.toMatchObject({ name: "AbortError" })
    await expect(clip.whole()).rejects.toMatchObject({ name: "AbortError" })
    expect(clip.error).toBeDefined()

    const broken = controlledBody()
    const other = clipFrom(broken.body)
    broken.error(new Error("network"))
    await expect(other.whole()).rejects.toThrow("network")
    await expect(other.firstByte).rejects.toThrow("network")
  })

  test("an empty body ends at once", async () => {
    const clip = clipFrom(null)
    expect(await clip.whole()).toEqual([])
  })
})

describe("feed", () => {
  test("appends chunks one at a time as they arrive (waiting for each append), then ends the stream", async () => {
    const clip = new AudioClip()
    const { sink, appended, finish, ended } = fakeSink()
    const done = feed(clip, sink)
    clip.push(bytes(1))
    clip.push(bytes(2))
    await tick()
    expect(appended).toEqual([[1]]) // the second waits for the first append to finish
    finish()
    await tick()
    expect(appended).toEqual([[1], [2]])
    finish()
    clip.push(bytes(3))
    clip.end()
    await tick()
    finish()
    expect(await done).toBe(true)
    expect(appended).toEqual([[1], [2], [3]])
    expect(ended()).toBe(1)
  })

  test("stops without ending the stream when aborted (barge-in) or when the download fails", async () => {
    const clip = new AudioClip()
    const abort = new AbortController()
    const { sink, appended, finish, ended } = fakeSink()
    const done = feed(clip, sink, abort.signal)
    clip.push(bytes(1))
    await tick()
    abort.abort()
    finish()
    clip.push(bytes(2))
    expect(await done).toBe(false)
    expect(appended).toEqual([[1]])
    expect(ended()).toBe(0)

    const failing = new AudioClip()
    const second = fakeSink()
    const result = feed(failing, second.sink)
    failing.fail(new Error("network"))
    expect(await result).toBe(false)
    expect(second.ended()).toBe(0)
  })
})

describe("canStreamMp3", () => {
  test("MediaSource with audio/mpeg streams; otherwise (iOS Safari, old browsers) the blob fallback", () => {
    expect(canStreamMp3({ MediaSource: { isTypeSupported: (t: string) => t === "audio/mpeg" } })).toBe(true)
    expect(canStreamMp3({ MediaSource: { isTypeSupported: () => false } })).toBe(false)
    expect(canStreamMp3({})).toBe(false)
    expect(
      canStreamMp3({
        MediaSource: {
          isTypeSupported: () => {
            throw new Error("nope")
          },
        },
      }),
    ).toBe(false)
  })
})
