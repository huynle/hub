// EventLog in process memory (a cluster uses Redis Streams). Same semantics and bounds as the live stream's log
// (../events-log.ts), which it reuses as its ring; it is a separate instance, the live stream keeps its own.
import { EventLog as Ring, EVENT_LOG_AGE_MS, EVENT_LOG_MAX } from "../events-log"
import type { Clock, EventLog, EventMessage, LogEvent, SinceResult } from "./types"

export interface MemoryEventLogOptions {
  readonly now?: Clock
  /** Events kept per user (default EVENT_LOG_MAX). */
  readonly max?: number
  /** Events older than this are dropped (default EVENT_LOG_AGE_MS). */
  readonly maxAgeMs?: number
  /** Id prefix; new for every instance by default, so ids from another run are never mistaken for current ones. */
  readonly epoch?: string
}

const newEpoch = () => `${Date.now().toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`

export class MemoryEventLog implements EventLog {
  private readonly ring: Ring

  constructor(options: MemoryEventLogOptions = {}) {
    this.ring = new Ring({
      max: options.max ?? EVENT_LOG_MAX,
      maxAgeMs: options.maxAgeMs ?? EVENT_LOG_AGE_MS,
      now: options.now ?? Date.now,
      epoch: options.epoch ?? newEpoch(),
    })
  }

  async append(userID: string, message: EventMessage, options: { readonly exceptDevice?: string } = {}): Promise<string> {
    return this.ring.append(userID, structuredClone(message), options.exceptDevice)
  }

  async latest(userID: string): Promise<string> {
    // Opening the user's log lets a client holding this id be covered before the first event.
    this.ring.open(userID)
    return this.ring.latest(userID)
  }

  async since(userID: string, lastID: string): Promise<SinceResult> {
    const events = this.ring.since(userID, lastID)
    if (!events) return { resync: true }
    return { events: events.map((event): LogEvent => structuredClone(event)) }
  }
}
