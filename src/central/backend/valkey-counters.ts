// Counters in Valkey: fixed windows as INCR + PEXPIRE NX in one Lua script, so the first increment of a window
// starts its expiry and later ones never extend it, atomically. Keys go under a prefix (default "ctr:").
// Expiry is server-side, so it follows the server's clock, not an injected one.
import type { Counters } from "./types"
import { ValkeyConnection, type ValkeySource } from "./valkey-client"

const INCR_WINDOW = `local n = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1], 'NX')
return n`

export interface ValkeyCountersOptions {
  /** Prepended to every key (default "ctr:"). */
  readonly prefix?: string
}

export class ValkeyCounters implements Counters {
  private readonly valkey: ValkeyConnection
  private readonly prefix: string

  constructor(source: ValkeySource, options: ValkeyCountersOptions = {}) {
    this.valkey = new ValkeyConnection(source)
    this.prefix = options.prefix ?? "ctr:"
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    if (!(Number.isInteger(ttlMs) && ttlMs > 0)) throw new Error("Counters.incr: ttl must be a positive whole number of milliseconds")
    return Number(await this.valkey.send("EVAL", [INCR_WINDOW, "1", this.prefix + key, String(ttlMs)]))
  }

  async get(key: string): Promise<number> {
    return Number((await this.valkey.send("GET", [this.prefix + key])) ?? 0)
  }

  /** Closes the connection when it was opened from a url. */
  async close(): Promise<void> {
    this.valkey.close()
  }
}
