// The session tokens the hub sent this spoke (sessionTokens op), one per session, kept in memory only. The spoke
// hands a session's current token to its shells (P1-T6, plugin hooks), so `hub` there acts as that session.
// A newer token replaces the older one; expired ones are dropped when read. Tokens never appear in JSON, inspect
// or string output, so logging the store (or an object holding it) cannot leak them.

export interface StoredSessionToken {
  readonly token: string
  /** Expiry, ms since the epoch. */
  readonly exp: number
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom")

export class SessionTokenStore {
  /** The URL the sessions' shells reach the hub at, as the hub last sent it. */
  hubURL?: string
  readonly #tokens = new Map<string, StoredSessionToken>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Stores the session's token, replacing its older one; false (nothing stored) when `exp` has passed. */
  set(sessionID: string, token: string, exp: number): boolean {
    if (exp <= this.#now()) return false
    this.#tokens.set(sessionID, { token, exp })
    return true
  }

  /** The session's current token, or undefined when it has none or it expired (then it is dropped). */
  get(sessionID: string): StoredSessionToken | undefined {
    const entry = this.#tokens.get(sessionID)
    if (!entry) return undefined
    if (entry.exp > this.#now()) return entry
    this.#tokens.delete(sessionID)
    return undefined
  }

  /** Sessions holding an unexpired token. */
  sessions(): string[] {
    this.prune()
    return [...this.#tokens.keys()]
  }

  get size(): number {
    this.prune()
    return this.#tokens.size
  }

  /** Drops expired tokens. */
  prune(): void {
    const now = this.#now()
    for (const [sessionID, entry] of this.#tokens) if (entry.exp <= now) this.#tokens.delete(sessionID)
  }

  delete(sessionID: string): void {
    this.#tokens.delete(sessionID)
  }

  /** Forgets every token and the hub URL. */
  clear(): void {
    this.#tokens.clear()
    this.hubURL = undefined
  }

  toJSON(): { sessions: number; hubURL?: string } {
    return { sessions: this.size, ...(this.hubURL !== undefined ? { hubURL: this.hubURL } : {}) }
  }

  toString(): string {
    return `SessionTokenStore(${this.size} sessions)`
  }

  [INSPECT](): string {
    return this.toString()
  }
}
