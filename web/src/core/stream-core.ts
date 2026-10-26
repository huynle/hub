// When the console's live stream (/api/events) is open, and with what: a page hidden for HIDDEN_CLOSE_MS closes
// it (no bandwidth or battery spent while nobody looks; push notifications cover that time) unless Voice mode
// runs; showing the page reopens it at once with the last event id, so the hub replays what was missed. A stream
// that brought no message and no heartbeat for STALE_MS is taken for dead and reopened. Pure: timers and the
// EventSource are injected.

/** A hidden page keeps its stream this long (a quick app switch or lock/unlock costs nothing). */
export const HIDDEN_CLOSE_MS = 30_000
/** The hub sends a heartbeat every 20 s: nothing for this long means the stream is dead. */
export const STALE_MS = 45_000

/** Why the stream (re)opens: start(), a scope change, resuming a paused page, a dead stream, or any other reopen. */
export type OpenReason = "start" | "scope" | "resume" | "stale" | "reconnect"

export interface StreamScope {
  /** Leave out streamed text and reasoning (except of `session`'s tree). */
  readonly lite: boolean
  /** The session the page shows. */
  readonly session?: string
}

/** The stream's URL for a scope, resuming after `last` when given. */
export function streamURL(scope: StreamScope, last?: string): string {
  const params = new URLSearchParams()
  if (scope.lite) params.set("lite", "1")
  if (scope.session) params.set("session", scope.session)
  if (last) params.set("last", last)
  const query = params.toString().replace(/\+/g, "%20")
  return query ? `/api/events?${query}` : "/api/events"
}

export interface KeeperDeps {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Opens the stream at `url` (closing any other first is the keeper's job), for `reason`. */
  open(url: string, reason: OpenReason): void
  close(): void
  /** Voice mode runs: never pause. */
  keepOpen(): boolean
  hiddenMs?: number
  staleMs?: number
}

export class StreamKeeper {
  state: "open" | "paused" | "stopped" = "stopped"
  /** Id of the last message received (EventSource's lastEventId). */
  lastID?: string
  private scope: StreamScope = { lite: false }
  private hideTimer?: unknown
  private staleTimer?: unknown

  constructor(private readonly deps: KeeperDeps) {}

  start(scope: StreamScope): void {
    this.scope = scope
    this.reopen("start")
  }

  /** A message or heartbeat arrived (`id`: its event id, if any). */
  received(id?: string): void {
    if (id) this.lastID = id
    if (this.state === "open") this.watch()
  }

  setScope(scope: StreamScope): void {
    const same = scope.lite === this.scope.lite && scope.session === this.scope.session
    this.scope = scope
    if (!same && this.state === "open") this.reopen("scope")
  }

  hidden(): void {
    if (this.state !== "open" || this.hideTimer !== undefined) return
    this.hideTimer = this.deps.setTimer(() => {
      this.hideTimer = undefined
      if (this.state !== "open" || this.deps.keepOpen()) return
      this.clear()
      this.state = "paused"
      this.deps.close()
    }, this.deps.hiddenMs ?? HIDDEN_CLOSE_MS)
  }

  visible(): void {
    if (this.hideTimer !== undefined) {
      this.deps.clearTimer(this.hideTimer)
      this.hideTimer = undefined
    }
    if (this.state === "paused") this.reopen("resume")
  }

  /** Opens (or reopens) the stream now, resuming after the last id. */
  reopen(reason: OpenReason = "reconnect"): void {
    if (this.state === "open") this.deps.close()
    this.clear()
    this.state = "open"
    this.deps.open(streamURL(this.scope, this.lastID), reason)
    this.watch()
  }

  stop(): void {
    if (this.state === "stopped") return
    this.clear()
    const wasOpen = this.state === "open"
    this.state = "stopped"
    if (wasOpen) this.deps.close()
  }

  private watch(): void {
    if (this.staleTimer !== undefined) this.deps.clearTimer(this.staleTimer)
    this.staleTimer = this.deps.setTimer(() => {
      this.staleTimer = undefined
      if (this.state === "open") this.reopen("stale")
    }, this.deps.staleMs ?? STALE_MS)
  }

  private clear(): void {
    for (const handle of [this.hideTimer, this.staleTimer]) if (handle !== undefined) this.deps.clearTimer(handle)
    this.hideTimer = this.staleTimer = undefined
  }
}

/** The console's stream connection (lib/store Connection). */
export type StreamConnection = "connecting" | "live" | "down" | "paused"

/**
 * What the console shows when the stream (re)opens: switching the scope of a live stream (navigating to or from
 * a session) is no reconnect, so it stays live without the "Reconnecting…" note; the first open is plain
 * connecting; anything else (a drop, a pause, a dead stream) is a reconnect.
 */
export function streamOpening(current: StreamConnection, reason: OpenReason): { connection: StreamConnection; reconnecting: boolean } {
  if (reason === "scope" && current === "live") return { connection: "live", reconnecting: false }
  return { connection: "connecting", reconnecting: current !== "connecting" }
}
