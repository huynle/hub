// Catalog in Valkey (design §9): one hash per user, a field per (sessionID, connID) report, merged on read, so
// every pod writes only its own connections' reports and any pod reads them all.
//
// A field is the JSON array [sessionID, connID]; its value is `<seq> <json>`, seq a per-user counter that keeps
// report order (a new report moves to the end) when the clock ties. A set per (user, connection) indexes the
// connection's fields, so deleteConn (the connection went away) removes them without scanning. Valkey 8 has no
// hash-field TTL, so a report with a ttl carries expiresAt (the `now` clock) and reads skip it once passed; the
// reader then removes it (only if it is still the report it read, so a concurrent renewal stays). Reports of a
// pod that died without saying so go that way, or through deleteConn from a sweeper.
import { RedisClient } from "bun"
import { mergeNewestWins, type CatalogMerge } from "./memory-catalog"
import type { Catalog, CatalogEntry, CatalogSession, CatalogValue, Clock } from "./types"

export interface ValkeyCatalogOptions {
  readonly now?: Clock
  /** How a session's reports combine (default: the newest report wins per field). */
  readonly merge?: CatalogMerge
  /** Key prefix (default "hub:"). */
  readonly prefix?: string
}

/** Where a user's catalog lives. Every key shares the user's hash tag, so scripts may use them together. */
export function valkeyCatalogKeys(userID: string, prefix = "hub:"): { reports: string; seq: string; conn: (connID: string) => string } {
  const reports = `${prefix}cat:{${encodeURIComponent(userID)}}`
  return { reports, seq: `${reports}:seq`, conn: (connID) => `${reports}:conn:${connID}` }
}

// Shared by the scripts: KEYS[1] reports, KEYS[2] seq; drops the counter with the last report.
const TIDY = `
local function tidy()
  if redis.call('HLEN', KEYS[1]) == 0 then redis.call('DEL', KEYS[2]) end
end
local function connOf(field) return cjson.decode(field)[2] end
`

// KEYS[3] the connection's index; ARGV[1] field, ARGV[2] stored JSON.
const SET = `
local seq = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], ARGV[1], seq .. ' ' .. ARGV[2])
redis.call('SADD', KEYS[3], ARGV[1])
`

// KEYS[3] the connection's index; ARGV[1] field.
const DELETE_ONE = `${TIDY}
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('SREM', KEYS[3], ARGV[1])
tidy()
`

// ARGV[1] the session's field prefix, ARGV[2] the index key prefix.
const DELETE_SESSION = `${TIDY}
for _, field in ipairs(redis.call('HKEYS', KEYS[1])) do
  if string.sub(field, 1, #ARGV[1]) == ARGV[1] then
    redis.call('HDEL', KEYS[1], field)
    redis.call('SREM', ARGV[2] .. connOf(field), field)
  end
end
tidy()
`

// KEYS[3] the connection's index.
const DELETE_CONN = `${TIDY}
for _, field in ipairs(redis.call('SMEMBERS', KEYS[3])) do redis.call('HDEL', KEYS[1], field) end
redis.call('DEL', KEYS[3])
tidy()
`

// ARGV[1] the index key prefix, then field and value pairs: removes each field still holding that value.
const DROP_EXPIRED = `${TIDY}
for i = 2, #ARGV, 2 do
  if redis.call('HGET', KEYS[1], ARGV[i]) == ARGV[i + 1] then
    redis.call('HDEL', KEYS[1], ARGV[i])
    redis.call('SREM', ARGV[1] .. connOf(ARGV[i]), ARGV[i])
  end
end
tidy()
`

interface Stored {
  readonly v: CatalogValue
  readonly at: number
  readonly e?: number
}

interface Report extends CatalogEntry {
  readonly seq: number
}

const fieldOf = (sessionID: string, connID: string) => JSON.stringify([sessionID, connID])
/** The start of every field of a session. */
const sessionPrefix = (sessionID: string) => `${JSON.stringify([sessionID]).slice(0, -1)},`

export class ValkeyCatalog implements Catalog {
  private readonly client: RedisClient
  private readonly ownsClient: boolean
  private readonly now: Clock
  private readonly merge: CatalogMerge
  private readonly prefix: string

  /** On a url (its own connection, made on first use) or a client the caller owns. */
  constructor(valkey: string | RedisClient, options: ValkeyCatalogOptions = {}) {
    this.ownsClient = typeof valkey === "string"
    this.client = typeof valkey === "string" ? new RedisClient(valkey) : valkey
    this.now = options.now ?? Date.now
    this.merge = options.merge ?? mergeNewestWins
    this.prefix = options.prefix ?? "hub:"
  }

  async set(userID: string, sessionID: string, connID: string, value: CatalogValue, options: { readonly ttlMs?: number } = {}): Promise<void> {
    const at = this.now()
    const stored: Stored = { v: value, at, ...(options.ttlMs !== undefined ? { e: at + options.ttlMs } : {}) }
    await this.eval(SET, userID, connID, [fieldOf(sessionID, connID), JSON.stringify(stored)])
  }

  async delete(userID: string, sessionID: string, connID?: string): Promise<void> {
    if (connID !== undefined) await this.eval(DELETE_ONE, userID, connID, [fieldOf(sessionID, connID)])
    else await this.eval(DELETE_SESSION, userID, undefined, [sessionPrefix(sessionID), this.keys(userID).conn("")])
  }

  async deleteConn(userID: string, connID: string): Promise<void> {
    await this.eval(DELETE_CONN, userID, connID, [])
  }

  async get(userID: string, sessionID: string): Promise<CatalogSession | undefined> {
    const reports = (await this.live(userID)).filter((report) => report.sessionID === sessionID)
    return reports.length ? this.session(sessionID, reports) : undefined
  }

  async list(userID: string): Promise<CatalogSession[]> {
    const bySession = new Map<string, CatalogEntry[]>()
    for (const report of await this.live(userID)) {
      const reports = bySession.get(report.sessionID)
      if (reports) reports.push(report)
      else bySession.set(report.sessionID, [report])
    }
    return [...bySession.keys()].sort().map((sessionID) => this.session(sessionID, bySession.get(sessionID)!))
  }

  async entries(userID: string): Promise<CatalogEntry[]> {
    return (await this.live(userID)).map(({ sessionID, connID, value, at }) => ({ sessionID, connID, value, at }))
  }

  /** Closes the connection when the catalog made it. */
  close(): void {
    if (this.ownsClient) this.client.close()
  }

  /** The user's unexpired reports in report order; expired ones are removed from Valkey. */
  private async live(userID: string): Promise<Report[]> {
    const raw = await this.client.send("HGETALL", [this.keys(userID).reports])
    const pairs: [string, string][] = Array.isArray(raw)
      ? Array.from({ length: raw.length / 2 }, (_, i) => [String(raw[2 * i]), String(raw[2 * i + 1])])
      : Object.entries((raw ?? {}) as Record<string, string>)
    const t = this.now()
    const reports: Report[] = []
    const expired: string[] = []
    for (const [field, stored] of pairs) {
      const space = stored.indexOf(" ")
      const { v, at, e } = JSON.parse(stored.slice(space + 1)) as Stored
      if (e !== undefined && e <= t) {
        expired.push(field, stored)
        continue
      }
      const [sessionID, connID] = JSON.parse(field) as [string, string]
      reports.push({ sessionID, connID, value: v, at, seq: Number(stored.slice(0, space)) })
    }
    if (expired.length) await this.eval(DROP_EXPIRED, userID, undefined, [this.keys(userID).conn(""), ...expired])
    return reports.sort((a, b) => a.seq - b.seq)
  }

  private session(sessionID: string, reports: CatalogEntry[]): CatalogSession {
    return {
      sessionID,
      value: structuredClone(this.merge(reports)),
      connIDs: reports.map((report) => report.connID),
      at: Math.max(...reports.map((report) => report.at)),
    }
  }

  private keys(userID: string) {
    return valkeyCatalogKeys(userID, this.prefix)
  }

  /** Runs a script on the user's keys (the connection's index third, when the script uses one). */
  private eval(script: string, userID: string, connID: string | undefined, args: string[]): Promise<unknown> {
    const keys = this.keys(userID)
    const list = connID === undefined ? [keys.reports, keys.seq] : [keys.reports, keys.seq, keys.conn(connID)]
    return this.client.send("EVAL", [script, String(list.length), ...list, ...args])
  }
}
