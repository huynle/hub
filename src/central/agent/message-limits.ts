// Loop protection for agent messages (design §3.4), over the backend interfaces with an injected clock.
//
// - HopTracker: every message carries a hop. A session's (or app's) depth is the deepest hop that reached it
//   since its last human turn; what it sends carries depth + 1. The user sends hop 0, and a hop-0 message (or a
//   human turn in the session) resets the depth. A hop over HOP_CAP is delivered without waking and the user
//   is alerted (the delivery engine does both).
// - MessageLimiter: fixed windows aligned to the clock (so retryAfter is exact): messages per sender→recipient
//   pair and per user (refused with rate_limited), and wakes per recipient (exhausted: deliver without waking).
import type { Clock, Counters, StateStore } from "../backend/types"
import { type Party, partyKey } from "./envelope"
import { AgentError } from "./errors"
import { updateVersioned } from "./versioned"

/** Hops a reply chain may take without a human turn. */
export const HOP_CAP = 8
/** A depth no message refreshed for this long is forgotten. */
export const HOP_TTL_MS = 24 * 60 * 60_000

export const overHopCap = (hop: number): boolean => hop > HOP_CAP

/** StateStore collection: partyKey → HopDepth. */
const HOPS = "message-hops"

interface HopDepth {
  readonly depth: number
  readonly at: number
}

export class HopTracker {
  private readonly state: StateStore
  private readonly now: Clock

  constructor(deps: { readonly state: StateStore; readonly now?: Clock }) {
    this.state = deps.state
    this.now = deps.now ?? Date.now
  }

  /** The hop a new message from `from` carries. */
  async next(userID: string, from: Party): Promise<number> {
    return from.kind === "user" ? 0 : (await this.depth(userID, from)) + 1
  }

  /** The deepest hop that reached the party since its last human turn (0: none, or forgotten). */
  async depth(userID: string, party: Party): Promise<number> {
    return this.live((await this.state.get<HopDepth>(userID, HOPS, partyKey(party)))?.value)
  }

  /** A message with `hop` reached the party. */
  async received(userID: string, to: Party, hop: number): Promise<void> {
    if (to.kind === "user") return
    const at = this.now()
    await updateVersioned<HopDepth>(this.state, userID, HOPS, partyKey(to), (current) => ({ depth: hop === 0 ? 0 : Math.max(this.live(current), hop), at }))
  }

  /** A human turn in the session (console prompt, voice, typed in the harness): the chain starts over. */
  async humanTurn(userID: string, sessionID: string): Promise<void> {
    await this.state.delete(userID, HOPS, partyKey({ kind: "session", sessionID }))
  }

  private live(entry: HopDepth | undefined): number {
    return entry && this.now() - entry.at < HOP_TTL_MS ? entry.depth : 0
  }
}

/** The length of every limiter window. */
export const WINDOW_MS = 10 * 60_000
/** Messages per sender→recipient pair per window. */
export const PAIR_LIMIT = 20
/** Messages per user per window, across all pairs. */
export const USER_LIMIT = 300
/** Wakes per recipient per window. */
export const WAKE_BUDGET = 30

export interface MessageLimits {
  readonly pair: number
  readonly user: number
  readonly wake: number
}

export class MessageLimiter {
  private readonly counters: Counters
  private readonly now: Clock
  private readonly limits: MessageLimits

  constructor(deps: { readonly counters: Counters; readonly now?: Clock; readonly limits?: Partial<MessageLimits> }) {
    this.counters = deps.counters
    this.now = deps.now ?? Date.now
    this.limits = { pair: PAIR_LIMIT, user: USER_LIMIT, wake: WAKE_BUDGET, ...deps.limits }
  }

  /** Counts a message from → to; throws rate_limited ({retryAfter, limit}) when a cap is reached (not counted). */
  async admit(userID: string, from: Party, to: Party): Promise<void> {
    const window = this.window()
    const keys = [
      { limit: "pair" as const, key: `msg:pair:${userID}:${partyKey(from)}:${partyKey(to)}:${window.index}`, max: this.limits.pair },
      { limit: "user" as const, key: `msg:user:${userID}:${window.index}`, max: this.limits.user },
    ]
    for (const { limit, key, max } of keys) {
      if ((await this.counters.get(key)) >= max) {
        throw new AgentError("rate_limited", `Too many messages (${limit} limit)`, {
          hint: "Wait and try again",
          extra: { retryAfter: Math.ceil(window.remaining / 1000), limit },
        })
      }
    }
    for (const { key } of keys) await this.counters.incr(key, window.remaining)
  }

  /** Uses one of the recipient's wakes; false when the budget is spent (deliver without waking). */
  async wake(userID: string, to: Party): Promise<boolean> {
    const window = this.window()
    const key = `msg:wake:${userID}:${partyKey(to)}:${window.index}`
    if ((await this.counters.get(key)) >= this.limits.wake) return false
    await this.counters.incr(key, window.remaining)
    return true
  }

  private window(): { index: number; remaining: number } {
    const t = this.now()
    const index = Math.floor(t / WINDOW_MS)
    return { index, remaining: (index + 1) * WINDOW_MS - t }
  }
}
