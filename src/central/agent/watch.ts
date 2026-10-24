// GET /api/agent/watch (design §4): a lite SSE stream of compact JSON events about one user's sessions, for
// orchestrator loops. Not the console's /api/events (cookie/device keyed, with replay and streamed text): this one
// is per actor, has no replay and never carries text deltas.
//
//   ?blocked=1        blocker events only
//   ?session=<addr>   only that session's tree (an address resolved for the caller; several for a @@role)
//
// Events (each `data:` line one JSON object with `type` and `at`):
//   {type: "ready"}                                         first, once subscribed
//   {type: "state", sessionID, rootID, state, prev?}        a session's own state changed
//   {type: "blocker.opened", sessionID, rootID, blocker: {kind, id, summary}}
//   {type: "blocker.closed", sessionID, rootID, id}         answered, cancelled or gone
//   {type: "session.added", sessionID, title} / {type: "session.removed", sessionID}   catalog changes
// A `ping` event every heartbeat (default 20 s). Only status messages of the caller's tenant are read; catalog
// changes are diffed against the caller's own sessions.
import type { LiveStatus, RegistryMessage } from "../registry"
import type { ReadRegistry } from "./read-routes"

export const WATCH_HEARTBEAT_MS = 20_000

export interface WatchRegistry extends Pick<ReadRegistry, "catalog" | "sessionTenant"> {
  subscribe(listener: (message: RegistryMessage, tenant?: string) => void): () => void
}

export interface WatchOptions {
  readonly registry: WatchRegistry
  readonly userID: string
  readonly signal: AbortSignal
  /** Only blocker events. */
  readonly blocked?: boolean
  /** Only events of these sessions or of trees rooted at them. */
  readonly sessions?: ReadonlySet<string>
  readonly heartbeatMs?: number
  readonly now?: () => number
}

interface Known {
  state: string
  blockers: Set<string>
}

type WatchEvent = { type: string; sessionID?: string; rootID?: string } & Record<string, unknown>

export function watchStream(options: WatchOptions): Response {
  const { registry, userID } = options
  const now = options.now ?? Date.now
  const encoder = new TextEncoder()
  /** Per session (roots and subagents): its own state and open blocker IDs. */
  const known = new Map<string, Known>()
  /** Catalog sessions of the user, ID → title. */
  let catalog = new Map<string, string>()

  const own = () => {
    const out = new Map<string, { title: string; status: LiveStatus[] }>()
    for (const machine of registry.catalog()) {
      for (const process of machine.processes) {
        for (const s of process.sessions) {
          if (!out.has(s.id) && registry.sessionTenant(s.id) === userID) out.set(s.id, { title: s.title, status: s.status })
        }
      }
    }
    return out
  }
  const remember = (entry: LiveStatus) => known.set(entry.id, { state: entry.state, blockers: new Set(entry.blockers.map((b) => b.id)) })
  const seed = () => {
    const sessions = own()
    for (const { status } of sessions.values()) for (const entry of status) if (!known.has(entry.id)) remember(entry)
    return sessions
  }
  catalog = new Map([...seed()].map(([id, s]) => [id, s.title]))

  const wanted = (event: WatchEvent) => {
    if (options.blocked && !event.type.startsWith("blocker.")) return false
    if (!options.sessions) return true
    return (event.sessionID !== undefined && options.sessions.has(event.sessionID)) || (event.rootID !== undefined && options.sessions.has(event.rootID))
  }

  /** Events for a status tree (root first), against what was known. */
  const statusEvents = (rootID: string, sessions: readonly LiveStatus[]): WatchEvent[] => {
    const out: WatchEvent[] = []
    for (const entry of sessions) {
      const before = known.get(entry.id)
      const open = new Set(entry.blockers.map((b) => b.id))
      for (const b of entry.blockers) {
        if (!before?.blockers.has(b.id)) out.push({ type: "blocker.opened", sessionID: entry.id, rootID, blocker: { kind: b.kind, id: b.id, summary: b.summary } })
      }
      for (const id of before?.blockers ?? []) if (!open.has(id)) out.push({ type: "blocker.closed", sessionID: entry.id, rootID, id })
      if (before?.state !== entry.state) out.push({ type: "state", sessionID: entry.id, rootID, state: entry.state, ...(before ? { prev: before.state } : {}) })
      remember(entry)
    }
    return out
  }

  const catalogEvents = (): WatchEvent[] => {
    const sessions = seed()
    const out: WatchEvent[] = []
    for (const [id, s] of sessions) if (!catalog.has(id)) out.push({ type: "session.added", sessionID: id, title: s.title })
    for (const id of catalog.keys()) if (!sessions.has(id)) out.push({ type: "session.removed", sessionID: id })
    catalog = new Map([...sessions].map(([id, s]) => [id, s.title]))
    return out
  }

  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }
      const send = (event: WatchEvent) => write(`data: ${JSON.stringify({ ...event, at: now() })}\n\n`)
      const unsubscribe = registry.subscribe((message, tenant) => {
        let events: WatchEvent[] = []
        if (message.type === "catalog") events = catalogEvents()
        else if (message.type === "status" && tenant === userID) events = statusEvents(message.sessionID, message.sessions)
        for (const event of events) if (wanted(event)) send(event)
      })
      // A named event (not a comment) so clients can tell a live stream from a dead one.
      const heartbeat = setInterval(() => write("event: ping\ndata: 0\n\n"), options.heartbeatMs ?? WATCH_HEARTBEAT_MS)
      cleanup = () => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      options.signal.addEventListener("abort", () => cleanup(), { once: true })
      send({ type: "ready" })
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
}
