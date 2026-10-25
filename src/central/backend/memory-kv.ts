// Kv in process memory (a cluster uses Valkey SET [PX] [NX], GET, GETDEL, DEL). Expiry is evaluated lazily
// against the clock, like the counters: no timers; expired keys are dropped when touched and in periodic sweeps.
import { ExpiringMap } from "./memory-counters"
import type { Clock, Kv, KvSetOptions } from "./types"

export class MemoryKv implements Kv {
  private readonly now: Clock
  private readonly values: ExpiringMap<{ value: string; expiresAt: number }>

  constructor(options: { now?: Clock } = {}) {
    this.now = options.now ?? Date.now
    this.values = new ExpiringMap(this.now)
  }

  async set(key: string, value: string, options: KvSetOptions = {}): Promise<boolean> {
    const { px, nx } = options
    if (px !== undefined && !(Number.isInteger(px) && px > 0)) throw new Error("Kv.set: px must be a positive whole number of milliseconds")
    if (nx && this.values.get(key)) return false
    this.values.set(key, { value, expiresAt: px === undefined ? Infinity : this.now() + px })
    return true
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)?.value
  }

  async getdel(key: string): Promise<string | undefined> {
    const entry = this.values.get(key)
    if (entry) this.values.delete(key)
    return entry?.value
  }

  async del(key: string): Promise<boolean> {
    const existed = this.values.get(key) !== undefined
    this.values.delete(key)
    return existed
  }
}
