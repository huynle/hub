// Backend interfaces for state the hub shares between processes (design §9). The single-process hub uses the
// in-memory implementations (./memory-*); a cluster swaps in Postgres / Valkey ones behind the same contracts.
// Everything is async so the networked implementations fit. Only new code uses these: existing state (Store,
// the live-stream EventLog, the Registry) stays where it is.

/** Milliseconds since the epoch (injectable for tests). */
export type Clock = () => number

/** Timer functions (injectable for tests); the same shape as the Registry's. */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** Values the backends store or carry: JSON-compatible data (implementations may serialize them). */
export type Data = unknown

// ---- StateStore -------------------------------------------------------------------------------------------

/** A stored value and its version (1 for the first write, +1 for every later one). */
export interface Versioned<T = Data> {
  readonly value: T
  readonly version: number
}

export interface Entry<T = Data> extends Versioned<T> {
  readonly key: string
}

/** Optimistic concurrency: `ifVersion` is the version the caller read (0: the key must not exist yet). */
export interface WriteOptions {
  readonly ifVersion?: number
}

/** A write's outcome; on a version mismatch, the version the key has now (0: it does not exist). */
export type WriteResult = { readonly ok: true; readonly version: number } | { readonly ok: false; readonly version: number }

/** Who holds a unique name (an @name, an exclusive role) in a namespace. */
export interface Claim {
  readonly namespace: string
  readonly key: string
  readonly owner: string
  readonly at: number
}

/** A claim's outcome: the claim, or (conflict) the claim someone else already holds. */
export type ClaimResult = { readonly ok: true; readonly claim: Claim } | { readonly ok: false; readonly conflict: Claim }

/**
 * Durable agent data, per user and collection, with optimistic versions; plus unique claims (a database unique
 * constraint in a cluster).
 */
export interface StateStore {
  get<T = Data>(userID: string, collection: string, key: string): Promise<Versioned<T> | undefined>
  put<T = Data>(userID: string, collection: string, key: string, value: T, options?: WriteOptions): Promise<WriteResult>
  /** Removes a key; `ok: false` on a version mismatch. Removing a missing key (without ifVersion) is ok. */
  delete(userID: string, collection: string, key: string, options?: WriteOptions): Promise<WriteResult>
  /** The user's entries in a collection, by key. */
  list<T = Data>(userID: string, collection: string): Promise<Entry<T>[]>
  /** Claims `key` in `namespace` for `owner`; claiming again for the same owner is ok (the original claim). */
  claim(namespace: string, key: string, owner: string): Promise<ClaimResult>
  /** Gives a claim up; false when `owner` does not hold it. */
  release(namespace: string, key: string, owner: string): Promise<boolean>
  claimOf(namespace: string, key: string): Promise<Claim | undefined>
  /** Makes buffered writes durable (the hub calls it on stop); stores that write through omit it. */
  flush?(): Promise<void>
}

// ---- Bus --------------------------------------------------------------------------------------------------

export type Unsubscribe = () => Promise<void>
export type BusHandler = (message: Data, topic: string) => void | Promise<void>
export type BusResponder = (message: Data, topic: string) => Data | Promise<Data>

export interface RequestOptions {
  readonly timeoutMs: number
}

/**
 * Cross-process messages: fire-and-forget publish/subscribe, and request/reply (RPC to the process holding a
 * connection). Delivery is at most once; a subscriber's failure never reaches the publisher.
 */
export interface Bus {
  /** Sends a message to the topic's current subscribers; resolves with how many there were. */
  publish(topic: string, message: Data): Promise<number>
  subscribe(topic: string, handler: BusHandler): Promise<Unsubscribe>
  /** Answers requests on a topic (one responder per topic). */
  serve(topic: string, responder: BusResponder): Promise<Unsubscribe>
  /**
   * Asks the topic's responder; rejects with BusNoResponderError when there is none, BusTimeoutError after
   * `timeoutMs`, or BusRemoteError when the responder throws.
   */
  request<T = Data>(topic: string, message: Data, options: RequestOptions): Promise<T>
}

export class BusTimeoutError extends Error {
  constructor(readonly topic: string, readonly timeoutMs: number) {
    super(`no reply on ${topic} within ${timeoutMs} ms`)
    this.name = "BusTimeoutError"
  }
}

export class BusNoResponderError extends Error {
  constructor(readonly topic: string) {
    super(`no responder on ${topic}`)
    this.name = "BusNoResponderError"
  }
}

export class BusRemoteError extends Error {
  constructor(readonly topic: string, message: string) {
    super(message)
    this.name = "BusRemoteError"
  }
}

// ---- EventLog ---------------------------------------------------------------------------------------------

export type EventMessage = { type: string; [key: string]: unknown }

export interface LogEvent {
  readonly id: string
  readonly message: EventMessage
  /** Not for this device (the one that made the change). */
  readonly exceptDevice?: string
  readonly at: number
}

/** The events after an id, or `resync` when the log cannot cover the gap (the client reloads). */
export type SinceResult = { readonly events: LogEvent[] } | { readonly resync: true }

/** Per-user replay of the live stream, bounded by count and age (a Redis Stream in a cluster). */
export interface EventLog {
  append(userID: string, message: EventMessage, options?: { readonly exceptDevice?: string }): Promise<string>
  /** The id of the user's latest event; a client holding it is covered until events are dropped. */
  latest(userID: string): Promise<string>
  since(userID: string, lastID: string): Promise<SinceResult>
}

// ---- Counters / Locks -------------------------------------------------------------------------------------

/** Fixed-window counters (rate limits, budgets): INCR + PEXPIRE NX in a cluster. */
export interface Counters {
  /** Adds one and returns the count; the first increment of a window starts its `ttlMs`. */
  incr(key: string, ttlMs: number): Promise<number>
  /** The current count (0 when unset or expired). */
  get(key: string): Promise<number>
}

/** A held lock. `fence` grows with every new acquisition of a key (fencing token). */
export interface Lease {
  readonly key: string
  readonly owner: string
  readonly fence: number
  readonly expiresAt: number
}

/** Expiring exclusive leases (SET NX PX in a cluster). */
export interface Locks {
  /** Takes the lock, or undefined while someone else holds it; the holder acquiring again renews. */
  acquire(key: string, owner: string, ttlMs: number): Promise<Lease | undefined>
  /** Extends the owner's lease; undefined when it no longer holds the lock (expired or taken). */
  renew(key: string, owner: string, ttlMs: number): Promise<Lease | undefined>
  /** Releases the owner's lease; false when it does not hold it. */
  release(key: string, owner: string): Promise<boolean>
  holder(key: string): Promise<Lease | undefined>
}

// ---- Catalog ----------------------------------------------------------------------------------------------

export type CatalogValue = Record<string, unknown>

/** What one connection reports about a session. */
export interface CatalogEntry<T extends CatalogValue = CatalogValue> {
  readonly sessionID: string
  readonly connID: string
  readonly value: T
  readonly at: number
}

/** A session as all its connections report it, merged. */
export interface CatalogSession<T extends CatalogValue = CatalogValue> {
  readonly sessionID: string
  readonly value: T
  /** The connections reporting it, oldest report first. */
  readonly connIDs: string[]
  /** When the latest report came. */
  readonly at: number
}

/** Shared session state per user, keyed by (sessionID, connID) and merged on read (a Redis hash per user). */
export interface Catalog {
  /** Records a connection's report; `ttlMs` lets reports of a dead process expire. */
  set(userID: string, sessionID: string, connID: string, value: CatalogValue, options?: { readonly ttlMs?: number }): Promise<void>
  /** Removes one connection's report of a session, or (no connID) every report of it. */
  delete(userID: string, sessionID: string, connID?: string): Promise<void>
  /** Removes everything a connection reported (it went away). */
  deleteConn(userID: string, connID: string): Promise<void>
  get(userID: string, sessionID: string): Promise<CatalogSession | undefined>
  /** The user's sessions, merged, by session id. */
  list(userID: string): Promise<CatalogSession[]>
  /** The raw reports of the user (unmerged). */
  entries(userID: string): Promise<CatalogEntry[]>
}

// ---- Bundle -----------------------------------------------------------------------------------------------

export interface Backends {
  readonly state: StateStore
  readonly bus: Bus
  readonly events: EventLog
  readonly counters: Counters
  readonly locks: Locks
  readonly catalog: Catalog
}
