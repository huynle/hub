// Server-sent events (GET /api/agent/watch): an incremental parser, and the event stream of a response.
import { HubTransportError } from "./errors.ts"
import type { WatchEvent } from "./types.ts"

/** Parses SSE text incrementally: feed chunks, get complete events (events without data are skipped). */
export class SseParser {
  #buffer = ""
  /** The last `id:` seen (it carries over to later events, as in EventSource). */
  #id = ""

  push(chunk: string): WatchEvent[] {
    this.#buffer += chunk.replace(/\r\n?/g, "\n")
    const out: WatchEvent[] = []
    let end: number
    while ((end = this.#buffer.indexOf("\n\n")) >= 0) {
      const block = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 2)
      let event = "message"
      const data: string[] = []
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
        if (field === "event") event = value
        else if (field === "data") data.push(value)
        else if (field === "id" && !value.includes("\0")) this.#id = value
      }
      if (data.length) out.push({ event, data: data.join("\n"), ...(this.#id ? { id: this.#id } : {}) })
    }
    return out
  }
}

/** The named events of a heartbeat the hub sends to keep the stream open. */
const HEARTBEAT = "ping"

/**
 * The events of an SSE response until it ends (heartbeats skipped). Ends quietly once `signal` aborts; a stream that
 * breaks otherwise is a `stream` HubTransportError.
 */
export async function* sseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<WatchEvent, void, undefined> {
  if (!response.body) throw new HubTransportError("bad_response", "the hub sent no watch stream")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const stop = () => void reader.cancel().catch(() => {})
  signal?.addEventListener("abort", stop, { once: true })
  try {
    for (;;) {
      if (signal?.aborted) return
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (cause) {
        if (signal?.aborted) return
        throw new HubTransportError("stream", `the watch stream failed (${cause instanceof Error ? cause.message : String(cause)})`, { cause })
      }
      if (chunk.done || signal?.aborted) return
      for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        if (event.event === HEARTBEAT) continue
        yield event
        if (signal?.aborted) return
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop)
    stop()
  }
}
