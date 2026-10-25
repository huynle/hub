// Delivers hub-minted session tokens (./agent/session-tokens.ts) to the spokes that report the sessions, with
// the sessionTokens op (feature "sessionTokens"; older spokes get nothing).
//
// On every sessions frame of a connection, the hub sends tokens for the sessions it reports for its own tenant
// (subagents included) that have none yet on that connection, whose token has less than a third of its lifetime
// left, or whose machine stamp changed (user or machine epoch, active key). Unchanged tokens are not resent. A
// reconnect is a new connection, so it gets every token again (the spoke drops its tokens when its connection
// changes). Tokens the spoke skipped, and tokens of a failed send, are retried on the next frame or sweep. A
// periodic sweep refreshes tokens nearing expiry and forgets connections that are gone.
//
// Act tokens (typ "act", decision #1 of phase 3) follow the same rules in a lane of their own: the actTokens op,
// sent only to connections announcing "actTokens" (never inside a sessionTokens frame, which older spokes hand to
// shells), without a hub URL, deduped and retried separately from the shell tokens. Launch-bound connections (a
// spoke in a sandbox, phase 5 decision #5) get session tokens but never act tokens.
// Tokens are never logged.
import {
  batchActTokens,
  batchSessionTokens,
  type ActTokensRequest,
  type ResultFor,
  type SessionToken,
  type SessionTokensRequest,
  type SpokeFeature,
} from "../protocol"
import type { Timers } from "./registry"

/** How often the sweep looks for tokens to refresh (well under a third of their lifetime). */
export const SESSION_TOKEN_SWEEP_MS = 10 * 60 * 1000
/** A token is refreshed when less than this fraction of its lifetime remains. */
export const SESSION_TOKEN_REFRESH_FRACTION = 1 / 3

/** What the push reads from the registry. */
export interface PushRegistry {
  supports(connID: string, feature: SpokeFeature): boolean
  connMachine(connID: string): string | undefined
  /** Sessions the connection reports for its own tenant. */
  reportedSessions(connID: string): string[]
  /** The launch a connection is bound to (a sandboxed spoke, phase 5): such connections get no act tokens. */
  launchOf?(connID: string): string | undefined
}

/** Mints tokens (SessionTokens). */
export interface TokenMinter {
  readonly lifetimeMs: number
  stamp(machineID: string): string | undefined
  mint(machineID: string, sessionID: string): { token: string; exp: number; stamp: string } | undefined
  /** An act token (typ "act"); without it no act tokens are sent. */
  mintAct?(machineID: string, sessionID: string): { token: string; exp: number; stamp: string } | undefined
}

export interface SessionTokenPushOptions {
  readonly registry: PushRegistry
  readonly tokens: TokenMinter
  /** Sends a sessionTokens request to a connection (SpokeHub.request). */
  send(connID: string, req: SessionTokensRequest | ActTokensRequest): Promise<ResultFor["sessionTokens"]>
  /** The URL sessions' shells reach the hub at. */
  readonly hubURL: string
  readonly now?: () => number
  readonly timers?: Timers
  readonly sweepMs?: number
  /** Largest request JSON (default: what fits in a frame). */
  readonly maxChars?: number
  log?(message: string): void
}

/** What a connection was sent for a session. */
interface Sent {
  readonly exp: number
  readonly stamp: string
}

/** One kind of token: the feature a connection must announce, how to mint one and how to batch them. */
interface Lane {
  readonly feature: SpokeFeature
  /** Launch-bound connections are left out of this lane. */
  readonly skipLaunchBound?: boolean
  mint(machineID: string, sessionID: string): { token: string; exp: number; stamp: string } | undefined
  batch(tokens: readonly SessionToken[]): Array<SessionTokensRequest | ActTokensRequest>
  /** connID → sessionID → the token last sent (or being sent). */
  readonly sent: Map<string, Map<string, Sent>>
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export class SessionTokenPush {
  readonly #lanes: readonly Lane[]
  readonly #inflight = new Set<Promise<unknown>>()
  readonly #now: () => number
  readonly #timers: Timers
  #timer: unknown
  #stopped = false

  constructor(private readonly options: SessionTokenPushOptions) {
    this.#now = options.now ?? Date.now
    this.#timers = options.timers ?? realTimers
    const { tokens, hubURL, maxChars } = options
    const max = maxChars !== undefined ? { maxChars } : {}
    const session: Lane = {
      feature: "sessionTokens",
      mint: (machineID, sessionID) => tokens.mint(machineID, sessionID),
      batch: (batch) => batchSessionTokens(batch, { hubURL, ...max }),
      sent: new Map(),
    }
    const mintAct = tokens.mintAct?.bind(tokens)
    const act: Lane | undefined = mintAct && { feature: "actTokens", skipLaunchBound: true, mint: mintAct, batch: (batch) => batchActTokens(batch, max), sent: new Map() }
    this.#lanes = act ? [session, act] : [session]
  }

  /** Handles a sessions frame of a connection: sends what is new or due. Resolves when the sends settle. */
  sessions(connID: string): Promise<void> {
    return this.#track(this.#sync(connID))
  }

  /** Refreshes tokens nearing expiry on every known connection; forgets connections that are gone. */
  sweep(): Promise<void> {
    return this.#track(this.#sweepAll())
  }

  /** Resolves when every send started so far has settled (tests). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight])
  }

  /** Arms the periodic sweep. */
  start(): void {
    this.#stopped = false
    this.#arm()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) this.#timers.clear(this.#timer)
    this.#timer = undefined
  }

  #arm(): void {
    if (this.#stopped) return
    this.#timer = this.#timers.set(() => {
      void this.#track(this.#sweepAll().finally(() => this.#arm()))
    }, this.options.sweepMs ?? SESSION_TOKEN_SWEEP_MS)
  }

  async #sweepAll(): Promise<void> {
    const conns = new Set(this.#lanes.flatMap((lane) => [...lane.sent.keys()]))
    await Promise.all([...conns].map((connID) => this.#track(this.#sync(connID))))
  }

  /** Tracks work for idle(); failures (e.g. an unreadable key file) are logged, never thrown. */
  #track(work: Promise<void>): Promise<void> {
    const safe = work.catch((cause) => this.options.log?.(`[hub] session tokens: ${reason(cause)}`))
    this.#inflight.add(safe)
    return safe.finally(() => this.#inflight.delete(safe))
  }

  async #sync(connID: string): Promise<void> {
    await Promise.all(this.#lanes.map((lane) => this.#syncLane(lane, connID)))
  }

  async #syncLane(lane: Lane, connID: string): Promise<void> {
    const { registry, tokens } = this.options
    const machineID = registry.connMachine(connID)
    const excluded = lane.skipLaunchBound === true && registry.launchOf?.(connID) !== undefined
    if (machineID === undefined || excluded || !registry.supports(connID, lane.feature)) {
      lane.sent.delete(connID)
      return
    }
    const stamp = tokens.stamp(machineID)
    if (stamp === undefined) {
      lane.sent.delete(connID)
      return
    }
    let sent = lane.sent.get(connID)
    if (!sent) lane.sent.set(connID, (sent = new Map()))
    const reported = new Set(registry.reportedSessions(connID))
    for (const sessionID of sent.keys()) if (!reported.has(sessionID)) sent.delete(sessionID)

    const now = this.#now()
    const refreshAt = tokens.lifetimeMs * SESSION_TOKEN_REFRESH_FRACTION
    const due: SessionToken[] = []
    const records = new Map<string, Sent>()
    for (const sessionID of reported) {
      const last = sent.get(sessionID)
      if (last && last.stamp === stamp && last.exp - now >= refreshAt) continue
      const minted = lane.mint(machineID, sessionID)
      if (!minted) continue
      const entry = { sessionID, token: minted.token, exp: minted.exp }
      if (!this.#fits(lane, entry)) {
        this.options.log?.(`[hub] ${lane.feature === "actTokens" ? "act" : "session"} token for ${sessionID} does not fit in a frame; not sent`)
        continue
      }
      const record = { exp: minted.exp, stamp: minted.stamp }
      sent.set(sessionID, record)
      records.set(sessionID, record)
      due.push(entry)
    }
    if (due.length === 0) return

    const forget = (sessionID: string) => {
      if (records.has(sessionID) && sent.get(sessionID) === records.get(sessionID)) sent.delete(sessionID)
    }
    const requests = lane.batch(due)
    await Promise.all(
      requests.map(async (req) => {
        try {
          const result = await this.options.send(connID, req)
          for (const { sessionID } of result.skipped) forget(sessionID)
        } catch (cause) {
          for (const { sessionID } of req.tokens) forget(sessionID)
          this.options.log?.(`[hub] sending ${lane.feature === "actTokens" ? "act" : "session"} tokens failed: ${reason(cause)}`)
        }
      }),
    )
  }

  /** Whether a token fits in a request on its own. */
  #fits(lane: Lane, entry: SessionToken): boolean {
    try {
      lane.batch([entry])
      return true
    } catch {
      return false
    }
  }
}
