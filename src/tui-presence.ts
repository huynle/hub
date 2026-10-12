// TUI presence: the TUI tells its server-side spoke which sessions it shows (the current route's root
// session and its open tabs) over RPC voice.presence, on change (the route is polled every 2 s) and every
// 15 s, so the phone can list them as open. See docs/session-view.md.

export const PRESENCE_POLL_MS = 2000
export const PRESENCE_HEARTBEAT_MS = 15_000

/** The root of the session the route shows, plus the open tabs (root sessions), deduplicated. */
export function shownSessions(input: {
  route: { type: string; sessionID?: string }
  root: (sessionID: string) => string
  tabs?: readonly string[]
}): string[] {
  const out = new Set<string>()
  const current = input.route.type === "session" ? input.route.sessionID : undefined
  if (current) {
    let root = current
    try {
      root = input.root(current) || current
    } catch {
      // not synced yet: the session itself
    }
    out.add(root)
  }
  for (const id of input.tabs ?? []) if (id) out.add(id)
  return [...out]
}

export interface PresenceReporterOptions {
  /** The sessions shown right now. */
  readonly read: () => readonly string[]
  /** Reports them (errors are ignored: the next tick retries). */
  readonly send: (sessionIDs: readonly string[]) => Promise<unknown>
  readonly pollMs?: number
  readonly heartbeatMs?: number
}

export class PresenceReporter {
  private timers: Array<ReturnType<typeof setInterval>> = []
  private last?: string

  constructor(private readonly options: PresenceReporterOptions) {}

  start(): void {
    if (this.timers.length) return
    this.tick(true)
    this.every(this.options.pollMs ?? PRESENCE_POLL_MS, () => this.tick(false))
    this.every(this.options.heartbeatMs ?? PRESENCE_HEARTBEAT_MS, () => this.tick(true))
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  /** Reads now and reports when changed (or always, for the heartbeat). */
  tick(always = false): void {
    let ids: readonly string[]
    try {
      ids = this.options.read()
    } catch {
      return
    }
    const key = [...ids].sort().join(" ")
    if (!always && key === this.last) return
    this.last = key
    this.options.send(ids).catch(() => {})
  }

  private every(ms: number, run: () => void): void {
    const timer = setInterval(run, ms)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.push(timer)
  }
}
