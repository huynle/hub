// Locks in Valkey: a lease is one key "lock:<key>" set with PX (server-side expiry) holding
// "<fence> <expiresAt> <owner>"; a new holder takes the next value of the counter "fence:<key>", which never
// expires, so fences keep growing across expiries and releases. Taking (SET PX only when the key is absent or
// already the caller's), renewing and releasing compare the owner inside Lua scripts, so each is atomic.
//
// Expiry follows the server's clock; `expiresAt` in a Lease is stamped by the injected clock (`now`) and is
// informational. Fence counters stay after their lock goes away (one small key per lock name ever used).
import type { Clock, Lease, Locks } from "./types"
import { ValkeyConnection, type ValkeySource } from "./valkey-client"

/** KEYS: lock, fence. ARGV: owner, ttl, expiresAt, mode ("acquire" or "renew"). Returns the lease value or nil. */
const TAKE = `local cur = redis.call('GET', KEYS[1])
local fence
if cur then
  local f, _, owner = string.match(cur, '^(%d+) (%S+) (.*)$')
  if owner ~= ARGV[1] then return false end
  fence = f
elseif ARGV[4] == 'acquire' then
  fence = tostring(redis.call('INCR', KEYS[2]))
else
  return false
end
local value = fence .. ' ' .. ARGV[3] .. ' ' .. ARGV[1]
redis.call('SET', KEYS[1], value, 'PX', ARGV[2])
return value`

/** KEYS: lock. ARGV: owner. Deletes the lock when the owner holds it; returns 1 or 0. */
const RELEASE = `local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local _, _, owner = string.match(cur, '^(%d+) (%S+) (.*)$')
if owner ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1`

export interface ValkeyLocksOptions {
  /** Stamps Lease.expiresAt (default Date.now). Expiry itself is server-side. */
  readonly now?: Clock
  /** Prepended to the lock keys (default "lock:"); fence counters use `fencePrefix` (default "fence:"). */
  readonly prefix?: string
  readonly fencePrefix?: string
}

export class ValkeyLocks implements Locks {
  private readonly valkey: ValkeyConnection
  private readonly now: Clock
  private readonly prefix: string
  private readonly fencePrefix: string

  constructor(source: ValkeySource, options: ValkeyLocksOptions = {}) {
    this.valkey = new ValkeyConnection(source)
    this.now = options.now ?? Date.now
    this.prefix = options.prefix ?? "lock:"
    this.fencePrefix = options.fencePrefix ?? "fence:"
  }

  acquire(key: string, owner: string, ttlMs: number): Promise<Lease | undefined> {
    return this.take("acquire", key, owner, ttlMs)
  }

  renew(key: string, owner: string, ttlMs: number): Promise<Lease | undefined> {
    return this.take("renew", key, owner, ttlMs)
  }

  async release(key: string, owner: string): Promise<boolean> {
    return Number(await this.valkey.send("EVAL", [RELEASE, "1", this.prefix + key, owner])) === 1
  }

  async holder(key: string): Promise<Lease | undefined> {
    return parseLease(key, await this.valkey.send("GET", [this.prefix + key]))
  }

  /** Closes the connection when it was opened from a url. */
  async close(): Promise<void> {
    this.valkey.close()
  }

  private async take(mode: "acquire" | "renew", key: string, owner: string, ttlMs: number): Promise<Lease | undefined> {
    if (!(Number.isInteger(ttlMs) && ttlMs > 0)) throw new Error(`Locks.${mode}: ttl must be a positive whole number of milliseconds`)
    const expiresAt = this.now() + ttlMs
    const keys = [this.prefix + key, this.fencePrefix + key]
    return parseLease(key, await this.valkey.send("EVAL", [TAKE, "2", ...keys, owner, String(ttlMs), String(expiresAt), mode]))
  }
}

/** A lease from its stored "<fence> <expiresAt> <owner>" (the owner may hold any character). */
function parseLease(key: string, reply: unknown): Lease | undefined {
  if (reply === null || reply === undefined) return undefined
  const value = String(reply)
  const first = value.indexOf(" ")
  const second = value.indexOf(" ", first + 1)
  return { key, owner: value.slice(second + 1), fence: Number(value.slice(0, first)), expiresAt: Number(value.slice(first + 1, second)) }
}
