// StateStore in process memory (the single-process hub; a cluster uses Postgres). Values are copied in and out,
// like a database round trip, so callers never share mutable state with the store.
import type { Claim, ClaimResult, Clock, Data, Entry, StateStore, Versioned, WriteOptions, WriteResult } from "./types"

interface Stored {
  value: Data
  version: number
}

/** Map key for (a, b) pairs; NUL never occurs in ids or names. */
const pair = (a: string, b: string) => `${a}\u0000${b}`

export class MemoryStateStore implements StateStore {
  private readonly now: Clock
  /** pair(userID, collection) → key → entry. */
  private readonly collections = new Map<string, Map<string, Stored>>()
  /** pair(namespace, key) → claim. */
  private readonly claims = new Map<string, Claim>()

  constructor(options: { now?: Clock } = {}) {
    this.now = options.now ?? Date.now
  }

  async get<T = Data>(userID: string, collection: string, key: string): Promise<Versioned<T> | undefined> {
    const stored = this.collections.get(pair(userID, collection))?.get(key)
    return stored && { value: structuredClone(stored.value) as T, version: stored.version }
  }

  async put<T = Data>(userID: string, collection: string, key: string, value: T, options: WriteOptions = {}): Promise<WriteResult> {
    const id = pair(userID, collection)
    let entries = this.collections.get(id)
    const current = entries?.get(key)?.version ?? 0
    if (options.ifVersion !== undefined && options.ifVersion !== current) return { ok: false, version: current }
    if (!entries) this.collections.set(id, (entries = new Map()))
    const version = current + 1
    entries.set(key, { value: structuredClone(value), version })
    return { ok: true, version }
  }

  async delete(userID: string, collection: string, key: string, options: WriteOptions = {}): Promise<WriteResult> {
    const id = pair(userID, collection)
    const entries = this.collections.get(id)
    const current = entries?.get(key)?.version ?? 0
    if (options.ifVersion !== undefined && options.ifVersion !== current) return { ok: false, version: current }
    entries?.delete(key)
    if (entries?.size === 0) this.collections.delete(id)
    return { ok: true, version: 0 }
  }

  async list<T = Data>(userID: string, collection: string): Promise<Entry<T>[]> {
    const entries = this.collections.get(pair(userID, collection))
    if (!entries) return []
    return [...entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, stored]) => ({ key, value: structuredClone(stored.value) as T, version: stored.version }))
  }

  async claim(namespace: string, key: string, owner: string): Promise<ClaimResult> {
    const id = pair(namespace, key)
    const held = this.claims.get(id)
    if (held) return held.owner === owner ? { ok: true, claim: held } : { ok: false, conflict: held }
    const claim: Claim = { namespace, key, owner, at: this.now() }
    this.claims.set(id, claim)
    return { ok: true, claim }
  }

  async release(namespace: string, key: string, owner: string): Promise<boolean> {
    const id = pair(namespace, key)
    if (this.claims.get(id)?.owner !== owner) return false
    this.claims.delete(id)
    return true
  }

  async claimOf(namespace: string, key: string): Promise<Claim | undefined> {
    return this.claims.get(pair(namespace, key))
  }
}
