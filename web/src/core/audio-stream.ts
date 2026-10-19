// Streaming reply audio (pure parts; tested with bun). A sentence's MP3 from /api/speak is played while it
// downloads: an AudioClip buffers the bytes of one response (a prefetched sentence keeps downloading while it
// waits for its turn), `feed` appends them to a MediaSource SourceBuffer one append at a time, and
// `canStreamMp3` decides between MediaSource and the whole-blob fallback (iOS Safari has no MSE for MP3 in
// some versions). The browser side (MediaSource, <audio>) is in web/src/voice/conversation.ts.

/** Where streamed chunks go: a SourceBuffer in the browser, a fake in tests. One append at a time. */
export interface AppendSink {
  append(chunk: Uint8Array): Promise<void>
  /** All audio was appended (MediaSource.endOfStream). */
  end(): void
}

const abortError = () => Object.assign(new Error("The download was aborted"), { name: "AbortError" })

/** The bytes of one synthesized sentence, as they arrive; readable from the start any number of times. */
export class AudioClip {
  readonly chunks: Uint8Array[] = []
  /** Resolves with the first chunk (rejects when the download fails before it). */
  readonly firstByte: Promise<void>
  done = false
  error: unknown
  private resolveFirst!: () => void
  private rejectFirst!: (error: unknown) => void
  private waiters: Array<() => void> = []

  constructor() {
    this.firstByte = new Promise<void>((resolve, reject) => {
      this.resolveFirst = resolve
      this.rejectFirst = reject
    })
    this.firstByte.catch(() => {}) // observed by whoever cares
  }

  push(chunk: Uint8Array): void {
    if (this.done || this.error !== undefined || !chunk.byteLength) return
    this.chunks.push(chunk)
    if (this.chunks.length === 1) this.resolveFirst()
    this.wake()
  }

  end(): void {
    if (this.done || this.error !== undefined) return
    this.done = true
    this.resolveFirst() // an empty clip: nothing to wait for
    this.wake()
  }

  fail(error: unknown): void {
    if (this.done || this.error !== undefined) return
    this.error = error ?? new Error("The download failed")
    this.rejectFirst(this.error)
    this.wake()
  }

  /** Every chunk from the start: the buffered ones, then live ones until the clip ends (throws if it fails). */
  async *read(signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    let index = 0
    for (;;) {
      if (signal?.aborted) throw abortError()
      if (index < this.chunks.length) {
        yield this.chunks[index++]!
        continue
      }
      if (this.error !== undefined) throw this.error
      if (this.done) return
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        signal?.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  }

  /** All chunks once the download is complete (the fallback plays them as one blob). */
  async whole(): Promise<Uint8Array[]> {
    for await (const _ of this.read()) {
      // wait for the end
    }
    return this.chunks
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }
}

/** Starts reading a response body into a new clip; `signal` (the barge-in) cancels the download. */
export function clipFrom(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AudioClip {
  const clip = new AudioClip()
  if (!body) {
    clip.end()
    return clip
  }
  const reader = body.getReader()
  const onAbort = () => {
    clip.fail(abortError())
    reader.cancel().catch(() => {})
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) clip.push(value)
      }
      clip.end()
    } catch (error) {
      clip.fail(signal?.aborted ? abortError() : error)
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  })()
  return clip
}

/**
 * Appends a clip's chunks to `sink` as they arrive, waiting for each append to finish. Resolves true once
 * everything was appended and the stream ended; false when aborted or when the download failed (the stream is
 * then left open: playback stops with whatever was appended).
 */
export async function feed(clip: AudioClip, sink: AppendSink, signal?: AbortSignal): Promise<boolean> {
  try {
    for await (const chunk of clip.read(signal)) {
      await sink.append(chunk)
      if (signal?.aborted) return false
    }
  } catch {
    return false
  }
  if (signal?.aborted) return false
  sink.end()
  return true
}

/** True when this browser can play MP3 through MediaSource (Chrome, Android, Firefox); else use whole blobs. */
export function canStreamMp3(env: { MediaSource?: { isTypeSupported?: (type: string) => boolean } }): boolean {
  try {
    return env.MediaSource?.isTypeSupported?.("audio/mpeg") === true
  } catch {
    return false
  }
}
