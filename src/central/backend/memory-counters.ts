// Counters and Locks in process memory (a cluster uses Redis INCR + PEXPIRE NX and SET NX PX). Expiry is
// evaluated lazily against the clock: no timers. Expired keys are dropped when touched and in periodic sweeps,
// so keys that are never read again do not pile up.
import type { Clock, Counters, Lease, Locks } from "./types"

/** Writes between sweeps of expired keys. */
const SWEEP_EVERY = 1000

/** A map whose entries expire at `expiresAt`; reads drop expired entries. */
class ExpiringMap<V extends { readonly expiresAt: number }> {
  private readonly entries = new Map<string, V>()
  private writes = 0

  constructor(private readonly now: Clock) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  set(key: string, value: V): void {
    this.entries.set(key, value)
    if (++this.writes % SWEEP_EVERY === 0) this.sweep()
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  private sweep(): void {
    const t = this.now()
    for (const [key, entry] of this.entries) if (entry.expiresAt <= t) this.entries.delete(key)
  }
}

export class MemoryCounters implements Counters {
  private readonly now: Clock
  private readonly counts: ExpiringMap<{ count: number; expiresAt: number }>

  constructor(options: { now?: Clock } = {}) {
    this.now = options.now ?? Date.now
    this.counts = new ExpiringMap(this.now)
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    const current = this.counts.get(key)
    const count = (current?.count ?? 0) + 1
    this.counts.set(key, { count, expiresAt: current?.expiresAt ?? this.now() + ttlMs })
    return count
  }

  async get(key: string): Promise<number> {
    return this.counts.get(key)?.count ?? 0
  }
}

export class MemoryLocks implements Locks {
  private readonly now: Clock
  private readonly leases: ExpiringMap<Lease>
  /** Last fence handed out per key (kept after release so fences only grow). */
  private readonly fences = new Map<string, number>()

  constructor(options: { now?: Clock } = {}) {
    this.now = options.now ?? Date.now
    this.leases = new ExpiringMap(this.now)
  }

  async acquire(key: string, owner: string, ttlMs: number): Promise<Lease | undefined> {
    const held = this.leases.get(key)
    if (held) return held.owner === owner ? this.extend(held, ttlMs) : undefined
    const fence = (this.fences.get(key) ?? 0) + 1
    this.fences.set(key, fence)
    const lease: Lease = { key, owner, fence, expiresAt: this.now() + ttlMs }
    this.leases.set(key, lease)
    return lease
  }

  async renew(key: string, owner: string, ttlMs: number): Promise<Lease | undefined> {
    const held = this.leases.get(key)
    return held?.owner === owner ? this.extend(held, ttlMs) : undefined
  }

  async release(key: string, owner: string): Promise<boolean> {
    if (this.leases.get(key)?.owner !== owner) return false
    this.leases.delete(key)
    return true
  }

  async holder(key: string): Promise<Lease | undefined> {
    return this.leases.get(key)
  }

  private extend(lease: Lease, ttlMs: number): Lease {
    const renewed = { ...lease, expiresAt: this.now() + ttlMs }
    this.leases.set(lease.key, renewed)
    return renewed
  }
}
