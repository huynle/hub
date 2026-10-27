// GET /api/agent/watch (design §4; lifecycle design "Events"): a live SSE view of the canonical agent event journal
// (events.ts), for orchestrator loops. The same events, visibility and filters as GET /api/agent/events, read with
// the same read() (events-routes.ts), so the two never define events differently. Not the console's /api/events.
//
//   ?blocked=1        blocker events only (blocker.*)
//   ?session=<addr>   only that session's tree (an address resolved for the caller; several for a @@role)
//   ?cursor=… or Last-Event-ID: resume after a cursor this stream (or GET /api/agent/events) gave; a bad one is
//                     400 invalid_cursor before the stream starts
//
// Frames (each `data:` line one JSON object; `id:` lines carry the resumable cursor):
//   {type: "ready", at}                                  first, once subscribed
//   {id: "evt_…", at, type, subject, data}               a journal event (no free text)
//   {type: "reset", at, refresh: [...]}                  the cursor was no longer covered: re-read those
//   event: ping                                          every heartbeat while idle (default 20 s), with the cursor
// When the hub drains (shutting down), the stream ends with `retry: 2000` (reconnect, to another pod, after it).
import type { AgentActor } from "./actor"
import type { AgentEvent } from "./events"
import { read, RESET_REFRESH, type EventsPage, type EventsRouteDeps } from "./events-routes"

export const WATCH_HEARTBEAT_MS = 20_000
/** Draining: the `retry:` (ms) an ending watch stream sends. */
export const WATCH_RETRY_MS = 2_000
const RETRY = `retry: ${WATCH_RETRY_MS}\n\n`
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
const PAGE = 200

export interface WatchOptions {
  readonly events: EventsRouteDeps
  readonly userID: string
  readonly actor: AgentActor
  readonly signal: AbortSignal
  /** Resume after this cursor (none: from now). */
  readonly cursor?: string
  /** Only these event types (exact, or `blocker.*`). */
  readonly types?: readonly string[]
  /** Only events of these sessions or of trees rooted at them. */
  readonly sessions?: ReadonlySet<string>
  readonly heartbeatMs?: number
  readonly now?: () => number
  /** Aborted when the hub drains: the stream ends with a `retry:` hint. */
  readonly draining?: AbortSignal
}

/** The watch stream; throws invalid_cursor (before streaming) for a cursor this hub did not give this user. */
export async function watchStream(options: WatchOptions): Promise<Response> {
  if (options.draining?.aborted) return new Response(RETRY, { headers: SSE_HEADERS })
  const { userID, actor } = options
  const now = options.now ?? Date.now
  const heartbeatMs = options.heartbeatMs ?? WATCH_HEARTBEAT_MS
  const filters = { limit: PAGE, types: options.types ?? [], ...(options.sessions ? { sessions: options.sessions } : {}) }
  const first = await read(options.events, userID, actor, { ...filters, ...(options.cursor ? { cursor: options.cursor } : {}), wait: 0 })
  const encoder = new TextEncoder()
  const stop = new AbortController()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const close = () => {
        if (!open) return
        open = false
        stop.abort()
        try {
          controller.close()
        } catch {}
      }
      const write = (chunk: string) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          close()
        }
      }
      const frame = (data: object, id?: string) => write(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
      const emit = (page: EventsPage) => {
        if (page.reset) return frame({ type: "reset", at: now(), refresh: page.refresh ?? RESET_REFRESH }, page.cursor)
        if (page.events.length === 0) return write(`event: ping\nid: ${page.cursor}\ndata: 0\n\n`)
        page.events.forEach((event: AgentEvent, i) => frame(event, i === page.events.length - 1 ? page.cursor : undefined))
      }
      options.signal.addEventListener("abort", () => close(), { once: true })
      options.draining?.addEventListener(
        "abort",
        () => {
          write(RETRY)
          close()
        },
        { once: true },
      )
      frame({ type: "ready", at: now() }, options.cursor && !first.reset ? options.cursor : first.cursor)
      if (first.reset || first.events.length) emit(first)
      let cursor = first.cursor
      while (open && !stop.signal.aborted) {
        let page: EventsPage
        try {
          page = await read(options.events, userID, actor, { ...filters, cursor, wait: heartbeatMs / 1000 }, stop.signal)
        } catch (cause) {
          console.error(`[hub] agent watch read failed: ${(cause as Error).message}`)
          write(RETRY)
          return close()
        }
        if (stop.signal.aborted) break
        emit(page)
        cursor = page.cursor
      }
      close()
    },
    cancel() {
      stop.abort()
    },
  })
  return new Response(stream, { headers: SSE_HEADERS })
}
