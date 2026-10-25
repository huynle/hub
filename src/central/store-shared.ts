// The Store's shared persistence (cluster mode; decision vkxkqiuf §3, §4): each record is a row in a StateStore
// (Postgres) under user "_hub", and each pod keeps the whole StateData as a cache for the Store's synchronous reads.
//
// Rows (collection/key → value):
//   users/<id>, machines/<id>, devices/<id>          the records
//   push/<sha256(endpoint)>                          push subscriptions
//   settings/vapid | speech | agentsActingPaused     hub-wide settings
//   audit/<time>-<seq>-<random>                      audit entries (sorted by key = by time)
//   machine-tokens/<tokenHash>, device-tokens/<tokenHash>   {id}: O(1) token lookups on any pod
//   user-emails/<email>                              {id}: one user per email, also across pods
//
// Mutations run on the cache, then write the rows they touched with the version the cache had (ifVersion); on a
// conflict the touched rows are re-read and the mutation runs again on fresh data. Records and settings are
// versioned this way; audit, token and email index rows are inserted with ifVersion 0 (an email row in use means
// the user exists: the mutation runs again and finds it) and deleted unconditionally. After a write, the pod
// publishes store.changed {from, rows: [[collection, key, version]]} (never values); other pods re-read those rows.
// The Bus is at most once (a reconnect loses messages), so the cache is also reloaded every ttlMs, and
// security-relevant reads (token lookups, epochs, disabled users) re-read their rows first (Store.recheck).
import { createHash, randomBytes } from "node:crypto"
import { realTimers } from "./backend/memory-bus"
import type { Bus, StateStore, Timers, Unsubscribe } from "./backend/types"
import type { AuditEntry, StateData } from "./store"

/** The StateStore "user" the Store's rows live under. */
export const HUB_ROWS = "_hub"
/** Bus topic of the Store's row changes. */
export const STORE_CHANGED_TOPIC = "store.changed"
/** How often a pod reloads its whole cache (covers store.changed messages lost on a Bus reconnect). */
export const STORE_CACHE_TTL_MS = 30_000
/** Attempts of a mutation that keeps hitting version conflicts. */
const MAX_ATTEMPTS = 20

export type Collection = "users" | "machines" | "devices" | "push" | "settings" | "audit" | "machine-tokens" | "device-tokens" | "user-emails"

const RECORDS = ["users", "machines", "devices", "push", "settings", "audit"] as const
const SETTINGS = ["vapid", "speech", "agentsActingPaused"] as const

export interface RowRef {
  readonly collection: Collection
  readonly key: string
}

const refID = (ref: RowRef) => `${ref.collection}\u0000${ref.key}`

/** Versioned records (ifVersion writes) versus insert-only rows (ifVersion 0, unconditional delete). */
const versioned = (collection: Collection) => collection === "users" || collection === "machines" || collection === "devices" || collection === "push" || collection === "settings"

export const pushKey = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex")

/** What a mutation touched (rows to write); the file Store only needs to know whether it is dirty. */
export class StoreTx {
  readonly refs = new Map<string, RowRef>()

  touch(collection: Collection, key: string): void {
    this.refs.set(refID({ collection, key }), { collection, key })
  }

  get dirty(): boolean {
    return this.refs.size > 0
  }
}

/** A mutation touched rows another pod changed meanwhile, again and again. */
export class StoreConflictError extends Error {
  constructor() {
    super("The hub state kept changing during this update; try again")
    this.name = "StoreConflictError"
  }
}

export interface SharedStoreOptions {
  readonly state: StateStore
  readonly bus: Bus
  readonly now?: () => number
  /** The TTL reload timer (injectable for tests; default real, unref'd timers). */
  readonly timers?: Timers
  /** Cache reload interval (default STORE_CACHE_TTL_MS). */
  readonly ttlMs?: number
  /** Names this pod in store.changed (default random); its own messages are ignored. */
  readonly instanceID?: string
  readonly warn?: (message: string) => void
}

interface Write {
  readonly ref: RowRef
  readonly value: unknown
  readonly expected: number
}

interface ChangedMessage {
  readonly from: string
  readonly rows: [string, string, number][]
}

const emptyState = (): StateData => ({ machines: [], devices: [], push: [], users: [], audit: [] })

const byCreated = (a: { created: number; id: string }, b: { created: number; id: string }) =>
  a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export class SharedRows {
  readonly instanceID: string
  private readonly store: StateStore
  private readonly bus: Bus
  private readonly timers: Timers
  private readonly ttlMs: number
  private readonly warn: (message: string) => void
  /** refID → the version the cache holds (versioned rows only). */
  private versions = new Map<string, number>()
  /** Audit entry → its row key. */
  private readonly auditKeys = new WeakMap<AuditEntry, string>()
  private loading?: Promise<void>
  /** The first load finished: mutations run their first attempt synchronously. */
  private loaded = false
  private timer?: unknown
  private unsubscribe?: Unsubscribe
  private closed = false

  constructor(
    options: SharedStoreOptions,
    private readonly cache: { get(): StateData; set(state: StateData): void },
  ) {
    this.store = options.state
    this.bus = options.bus
    this.timers = options.timers ?? realTimers
    this.ttlMs = options.ttlMs ?? STORE_CACHE_TTL_MS
    this.warn = options.warn ?? ((message) => console.warn(message))
    this.instanceID = options.instanceID ?? randomBytes(8).toString("hex")
  }

  static emptyState = emptyState

  /** Subscribes to store.changed and loads the cache, once (a failure is retried by the next call). */
  ready(): Promise<void> {
    this.loading ??= this.start().catch((error: unknown) => {
      this.loading = undefined
      throw error
    })
    return this.loading
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    await unsubscribe?.()
  }

  private async start(): Promise<void> {
    // Subscribed before loading, so no change between the two is missed.
    this.unsubscribe ??= await this.bus.subscribe(STORE_CHANGED_TOPIC, (message) => this.onChanged(message))
    await this.load()
    this.loaded = true
    this.schedule()
  }

  private schedule(): void {
    if (this.closed) return
    this.timer = this.timers.set(() => {
      this.timer = undefined
      this.load()
        .catch((error: unknown) => this.warn(`[hub] state cache reload failed: ${(error as Error)?.message ?? error}`))
        .finally(() => this.schedule())
    }, this.ttlMs)
  }

  /** Reads every record row into a new cache. */
  async load(): Promise<void> {
    const [users, machines, devices, push, settings, audit] = await Promise.all(RECORDS.map((collection) => this.store.list(HUB_ROWS, collection)))
    const versions = new Map<string, number>()
    const note = (collection: Collection, rows: { key: string; version: number }[]) => {
      for (const row of rows) versions.set(refID({ collection, key: row.key }), row.version)
    }
    note("users", users!)
    note("machines", machines!)
    note("devices", devices!)
    note("push", push!)
    note("settings", settings!)
    const state = emptyState()
    state.users = users!.map((row) => row.value as StateData["users"][number]).sort(byCreated)
    state.machines = machines!.map((row) => row.value as StateData["machines"][number]).sort(byCreated)
    state.devices = devices!.map((row) => row.value as StateData["devices"][number]).sort(byCreated)
    state.push = push!
      .map((row) => row.value as StateData["push"][number])
      .sort((a, b) => a.created - b.created || (a.endpoint < b.endpoint ? -1 : 1))
    for (const row of settings!) setSetting(state, row.key, row.value)
    state.audit = audit!.map((row) => {
      const entry = row.value as AuditEntry
      this.auditKeys.set(entry, row.key)
      return entry
    })
    this.versions = versions
    this.cache.set(state)
  }

  /** A new row key for an audit entry (sorted by time). */
  keyAudit(entry: AuditEntry): string {
    // After every key the cache holds, so entries keep their order across pods when clocks tie or skew a little.
    const last = this.cache.get().audit.reduce<string | undefined>((max, e) => {
      const key = this.auditKeys.get(e)
      return key && (!max || key > max) ? key : max
    }, undefined)
    const key = nextAuditKey(last, entry.at, randomBytes(4).toString("hex"))
    this.auditKeys.set(entry, key)
    return key
  }

  /**
   * Adds the audit rows the cache lacks (entries other pods wrote that store.changed has not brought yet, or never
   * will after a lost message), so the next keyAudit sorts after every entry written before it on any pod.
   */
  async syncAudit(): Promise<void> {
    await this.ready()
    const rows = await this.store.list<AuditEntry>(HUB_ROWS, "audit")
    const known = new Set(this.cache.get().audit.map((entry) => this.auditKeys.get(entry)))
    for (const row of rows) if (!known.has(row.key)) applyRow(this.cache.get(), { collection: "audit", key: row.key }, row.value, this)
  }

  auditKey(entry: AuditEntry): string | undefined {
    return this.auditKeys.get(entry)
  }

  /** Records the row key of an audit entry read from the database. */
  rememberAudit(entry: AuditEntry, key: string): void {
    this.auditKeys.set(entry, key)
  }

  /**
   * Runs `fn` on the cache and writes what it touched; on a version conflict, re-reads those rows and runs it
   * again. Once loaded, the first run happens synchronously (like the file Store: a caller that does not await
   * still sees its change in the cache at once); the writes follow.
   */
  mutate<T>(fn: (tx: StoreTx) => T): Promise<T> {
    if (!this.loaded) return this.ready().then(() => this.attempt(fn))
    try {
      return this.attempt(fn)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** One run of `fn` (synchronous), then its writes and any retries. */
  private attempt<T>(fn: (tx: StoreTx) => T, attempt = 1): Promise<T> {
    const tx = new StoreTx()
    const result = fn(tx)
    if (!tx.dirty) return Promise.resolve(result)
    const writes = [...tx.refs.values()].map((ref) => this.snapshot(ref))
    return this.write(fn, writes, result, attempt)
  }

  private async write<T>(fn: (tx: StoreTx) => T, writes: readonly Write[], result: T, attempt: number): Promise<T> {
    let ok: boolean
    try {
      ok = await this.commit(writes)
    } catch (error) {
      // The cache holds the change that was not written: put the rows back as they are.
      await Promise.allSettled(writes.map((write) => this.refresh(write.ref)))
      throw error
    }
    if (ok) return result
    if (attempt >= MAX_ATTEMPTS) {
      await Promise.allSettled(writes.map((write) => this.refresh(write.ref)))
      throw new StoreConflictError()
    }
    await Promise.all(writes.map((write) => this.refresh(write.ref)))
    return this.attempt(fn, attempt + 1)
  }

  private snapshot(ref: RowRef): Write {
    const value = rowOf(this.cache.get(), ref, this)
    return { ref, value: value === undefined ? undefined : structuredClone(value), expected: this.versions.get(refID(ref)) ?? 0 }
  }

  /** Writes the rows in order; false at the first version conflict. Publishes what was written. */
  private async commit(writes: readonly Write[]): Promise<boolean> {
    const changed: [string, string, number][] = []
    let ok = true
    try {
      for (const { ref, value, expected } of writes) {
        const id = refID(ref)
        if (versioned(ref.collection)) {
          if (value === undefined) {
            if (expected === 0) continue
            const result = await this.store.delete(HUB_ROWS, ref.collection, ref.key, { ifVersion: expected })
            if (!result.ok) {
              ok = false
              break
            }
            this.versions.delete(id)
            applyRow(this.cache.get(), ref, undefined, this)
            changed.push([ref.collection, ref.key, 0])
          } else {
            const result = await this.store.put(HUB_ROWS, ref.collection, ref.key, value, { ifVersion: expected })
            if (!result.ok) {
              ok = false
              break
            }
            this.versions.set(id, result.version)
            // The cache holds what is now stored at that version (a refresh meanwhile may have replaced it).
            applyRow(this.cache.get(), ref, structuredClone(value), this)
            changed.push([ref.collection, ref.key, result.version])
          }
        } else if (value === undefined) {
          await this.store.delete(HUB_ROWS, ref.collection, ref.key)
          changed.push([ref.collection, ref.key, 0])
        } else {
          const result = await this.store.put(HUB_ROWS, ref.collection, ref.key, value, { ifVersion: 0 })
          if (!result.ok) {
            const current = await this.store.get(HUB_ROWS, ref.collection, ref.key)
            // The same row already there (written by an earlier attempt of this mutation) is fine.
            if (JSON.stringify(current?.value) === JSON.stringify(value)) continue
            ok = false
            break
          }
          changed.push([ref.collection, ref.key, result.version])
        }
      }
    } finally {
      if (changed.length) await this.publish(changed)
    }
    return ok
  }

  private async publish(rows: [string, string, number][]): Promise<void> {
    const message: ChangedMessage = { from: this.instanceID, rows }
    try {
      await this.bus.publish(STORE_CHANGED_TOPIC, message)
    } catch (error) {
      this.warn(`[hub] store.changed not published: ${(error as Error)?.message ?? error}`)
    }
  }

  private async onChanged(raw: unknown): Promise<void> {
    if (this.closed || !this.loading) return
    const message = raw as Partial<ChangedMessage> | null
    if (!message || typeof message !== "object" || message.from === this.instanceID || !Array.isArray(message.rows)) return
    const stale: RowRef[] = []
    for (const row of message.rows) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "string" || typeof row[2] !== "number") continue
      const ref = { collection: row[0] as Collection, key: row[1] }
      if (!isCollection(ref.collection)) continue
      if (versioned(ref.collection) && row[2] !== 0 && (this.versions.get(refID(ref)) ?? 0) >= row[2]) continue
      stale.push(ref)
    }
    await Promise.all(stale.map((ref) => this.refresh(ref)))
  }

  /** Re-reads one row into the cache (an index row also re-reads the record it points to). */
  async refresh(ref: RowRef): Promise<void> {
    const row = await this.store.get(HUB_ROWS, ref.collection, ref.key)
    const id = refID(ref)
    if (versioned(ref.collection)) {
      // Same version: the cache has it. Older: read before a newer write this pod already holds.
      if (row && (this.versions.get(id) ?? 0) >= row.version) return
      if (row) this.versions.set(id, row.version)
      else this.versions.delete(id)
    }
    applyRow(this.cache.get(), ref, row?.value, this)
    const target = row && indexTarget(ref.collection)
    if (target) {
      const pointed = (row.value as { id?: unknown }).id
      if (typeof pointed === "string") await this.refresh({ collection: target, key: pointed })
    }
  }

  /** The record id a token-hash index row points to (read from the database). */
  async indexed(collection: "machine-tokens" | "device-tokens", hash: string): Promise<string | undefined> {
    const row = await this.store.get<{ id?: unknown }>(HUB_ROWS, collection, hash)
    return typeof row?.value?.id === "string" ? row.value.id : undefined
  }
}

/**
 * The row key of an audit entry at `at` that sorts after `last` (the greatest key so far):
 * <time, 15 digits>-<sequence within that time, 6 digits>-<suffix: 8 hex>.
 */
export function nextAuditKey(last: string | undefined, at: number, suffix: string): string {
  const time0 = Math.max(0, Math.floor(at))
  const [lastAt, lastSeq] = last ? [Number(last.slice(0, 15)), Number(last.slice(16, 22))] : [-1, -1]
  const time = Math.max(time0, lastAt)
  const seq = time === lastAt ? lastSeq + 1 : 0
  return `${String(time).padStart(15, "0")}-${String(seq).padStart(6, "0")}-${suffix}`
}

export interface StateRow {
  readonly collection: Collection
  readonly key: string
  readonly value: unknown
}

/**
 * Every row a whole StateData is stored as (records, settings, audit with the given keys, then the index rows),
 * through the same mapping the shared Store writes with (`hub-server import`).
 */
export function stateRows(state: StateData, auditKey: (entry: AuditEntry) => string): StateRow[] {
  const refs: RowRef[] = [
    ...state.users.map((u) => ({ collection: "users" as const, key: u.id })),
    ...state.machines.map((m) => ({ collection: "machines" as const, key: m.id })),
    ...state.devices.map((d) => ({ collection: "devices" as const, key: d.id })),
    ...state.push.map((p) => ({ collection: "push" as const, key: pushKey(p.endpoint) })),
    ...SETTINGS.map((key) => ({ collection: "settings" as const, key })),
    ...state.audit.map((entry) => ({ collection: "audit" as const, key: auditKey(entry) })),
    ...state.machines.map((m) => ({ collection: "machine-tokens" as const, key: m.tokenHash })),
    ...state.devices.map((d) => ({ collection: "device-tokens" as const, key: d.tokenHash })),
    ...state.users.flatMap((u) => (u.email ? [{ collection: "user-emails" as const, key: u.email }] : [])),
  ]
  const rows: StateRow[] = []
  for (const ref of refs) {
    const value = rowOf(state, ref, { auditKey })
    if (value !== undefined) rows.push({ ...ref, value })
  }
  return rows
}

const isCollection = (value: string): value is Collection =>
  (["users", "machines", "devices", "push", "settings", "audit", "machine-tokens", "device-tokens", "user-emails"] as const).includes(value as Collection)

function indexTarget(collection: Collection): Collection | undefined {
  if (collection === "machine-tokens") return "machines"
  if (collection === "device-tokens") return "devices"
  if (collection === "user-emails") return "users"
  return undefined
}

function setSetting(state: StateData, key: string, value: unknown): void {
  if (key === "vapid") {
    if (value === undefined) delete state.vapid
    else state.vapid = value as NonNullable<StateData["vapid"]>
  } else if (key === "speech") {
    if (value === undefined) delete state.speech
    else state.speech = value as NonNullable<StateData["speech"]>
  } else if (key === "agentsActingPaused") {
    if (value === true) state.agentsActingPaused = true
    else delete state.agentsActingPaused
  }
}

/** The row value the cache holds for `ref` (undefined: the row should not exist). */
function rowOf(state: StateData, ref: RowRef, rows: Pick<SharedRows, "auditKey">): unknown {
  const { collection, key } = ref
  switch (collection) {
    case "users":
      return state.users.find((u) => u.id === key)
    case "machines":
      return state.machines.find((m) => m.id === key)
    case "devices":
      return state.devices.find((d) => d.id === key)
    case "push":
      return state.push.find((p) => pushKey(p.endpoint) === key)
    case "settings":
      return (SETTINGS as readonly string[]).includes(key) ? (state as unknown as Record<string, unknown>)[key] : undefined
    case "audit":
      return state.audit.find((entry) => rows.auditKey(entry) === key)
    case "machine-tokens": {
      const machine = state.machines.find((m) => m.tokenHash === key)
      return machine && { id: machine.id }
    }
    case "device-tokens": {
      const device = state.devices.find((d) => d.tokenHash === key)
      return device && { id: device.id }
    }
    case "user-emails": {
      const user = state.users.find((u) => u.email === key)
      return user && { id: user.id }
    }
  }
}

/** Puts a row's value (undefined: removed) into the cache. Index rows are derived: nothing to do. */
function applyRow(state: StateData, ref: RowRef, value: unknown, rows: SharedRows): void {
  const { collection, key } = ref
  const replace = <T>(list: T[], match: (item: T) => boolean, sort?: (a: T, b: T) => number): T[] => {
    const index = list.findIndex(match)
    if (value === undefined) {
      if (index >= 0) list.splice(index, 1)
    } else if (index >= 0) list[index] = value as T
    else {
      list.push(value as T)
      if (sort) list.sort(sort)
    }
    return list
  }
  switch (collection) {
    case "users":
      replace(state.users, (u) => u.id === key, byCreated)
      return
    case "machines":
      replace(state.machines, (m) => m.id === key, byCreated)
      return
    case "devices":
      replace(state.devices, (d) => d.id === key, byCreated)
      return
    case "push":
      replace(state.push, (p) => pushKey(p.endpoint) === key, (a, b) => a.created - b.created)
      return
    case "settings":
      setSetting(state, key, value)
      return
    case "audit": {
      const index = state.audit.findIndex((entry) => rows.auditKey(entry) === key)
      if (value === undefined) {
        if (index >= 0) state.audit.splice(index, 1)
        return
      }
      const entry = value as AuditEntry
      if (index >= 0) state.audit.splice(index, 1)
      // Keyed by time: insert in key order.
      rows.rememberAudit(entry, key)
      let at = state.audit.length
      while (at > 0 && (rows.auditKey(state.audit[at - 1]!) ?? "") > key) at--
      state.audit.splice(at, 0, entry)
      return
    }
    default:
      return
  }
}
