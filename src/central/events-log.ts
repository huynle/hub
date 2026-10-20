// Recent live-stream messages per user, so a console that reconnects (phone unlocked, tab back in view, network
// blip) gets what it missed (EventSource's Last-Event-ID) instead of a full reload. Ids are `<epoch>.<n>`: n
// counts per user from 1; the epoch changes with every hub start, so an id from before a restart is never
// mistaken for a current one. Bounded by count and age per user.

export type LoggedMessage = { type: string; [key: string]: unknown }

export interface Logged {
  readonly id: string
  readonly message: LoggedMessage
  /** Not for this device (the one that made the change). */
  readonly exceptDevice?: string
  readonly at: number
}

/** Events kept per user. */
export const EVENT_LOG_MAX = 2000
/** Events older than this are dropped. */
export const EVENT_LOG_AGE_MS = 5 * 60_000

interface UserLog {
  /** n of the last appended event (0: none yet). */
  last: number
  events: Logged[]
}

export class EventLog {
  readonly epoch: string
  private readonly max: number
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly logs = new Map<string, UserLog>()

  constructor(options: { max?: number; maxAgeMs?: number; now?: () => number; epoch?: string } = {}) {
    this.max = options.max ?? EVENT_LOG_MAX
    this.maxAgeMs = options.maxAgeMs ?? EVENT_LOG_AGE_MS
    this.now = options.now ?? Date.now
    this.epoch = options.epoch ?? `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
  }

  /** Records a message for a user; returns its id. */
  append(userID: string, message: LoggedMessage, exceptDevice?: string): string {
    const log = this.log(userID)
    const id = `${this.epoch}.${++log.last}`
    log.events.push({ id, message, at: this.now(), ...(exceptDevice ? { exceptDevice } : {}) })
    if (log.events.length > this.max) log.events.splice(0, log.events.length - this.max)
    this.prune(log)
    return id
  }

  /** The id of the user's latest event (`<epoch>.0` before the first). */
  latest(userID: string): string {
    return `${this.epoch}.${this.logs.get(userID)?.last ?? 0}`
  }

  /**
   * The user's events after `lastID`, oldest first; undefined when the log cannot cover the gap (another hub
   * start, an id it never gave out, a user it does not know, or events since dropped).
   */
  since(userID: string, lastID: string): Logged[] | undefined {
    const log = this.logs.get(userID)
    const match = /^([a-z0-9]+)\.(\d+)$/.exec(lastID)
    if (!log || !match || match[1] !== this.epoch) return undefined
    const n = Number(match[2])
    if (!Number.isSafeInteger(n) || n > log.last) return undefined
    this.prune(log)
    if (n === log.last) return []
    const first = log.events[0]
    // The next event the client needs (n + 1) must still be here.
    if (!first || this.number(first.id) > n + 1) return undefined
    return log.events.filter((event) => this.number(event.id) > n)
  }

  /** Users with a log (they connected or were sent something since the hub started). */
  users(): string[] {
    return [...this.logs.keys()]
  }

  /** Starts a user's log (so a reconnect after their first message can be replayed). */
  open(userID: string): void {
    this.log(userID)
  }

  private log(userID: string): UserLog {
    let log = this.logs.get(userID)
    if (!log) this.logs.set(userID, (log = { last: 0, events: [] }))
    return log
  }

  private prune(log: UserLog): void {
    const oldest = this.now() - this.maxAgeMs
    let drop = 0
    while (drop < log.events.length && log.events[drop]!.at < oldest) drop++
    if (drop) log.events.splice(0, drop)
  }

  private number(id: string): number {
    return Number(id.slice(id.lastIndexOf(".") + 1))
  }
}
