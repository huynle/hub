// EventLog on Valkey Streams (design §9): one stream per user, so Last-Event-ID resumes on any pod.
//
// Ids are `<epoch>.<n>` like the in-memory log's: n counts per user from 1 and is the entry's stream id (`n-0`,
// given explicitly rather than by the server clock), so a gap is exact: the entry after the client's id must
// still be there. The epoch lives in its own key next to the stream and is made the first time a user's log is
// touched; it goes when the log expires (both keys carry a ttl, renewed on every append and latest), so an id
// from an earlier log is never mistaken for a current one. Making an epoch deletes any stream left behind, so
// the stream always outlives its epoch (its ttl is a little longer) and never replays old entries.
//
// Bounds: XADD MAXLEN ~ max (approximate: Valkey trims whole nodes, so a log keeps at least `max` events) and,
// on read, `maxAgeMs` against the `now` clock. since() replays the entries after an id (XRANGE, exclusive) and
// asks for a resync when it cannot cover the gap: an unknown, another or an expired epoch, an id it never gave
// out, or the next entry trimmed or older than maxAgeMs.
import { RedisClient } from "bun"
import { EVENT_LOG_AGE_MS, EVENT_LOG_MAX } from "../events-log"
import type { Clock, EventLog, EventMessage, LogEvent, SinceResult } from "./types"

export interface ValkeyEventLogOptions {
  readonly now?: Clock
  /** Events kept per user, at least (default EVENT_LOG_MAX). */
  readonly max?: number
  /** Events older than this are not replayed (default EVENT_LOG_AGE_MS). */
  readonly maxAgeMs?: number
  /** Key prefix (default "hub:"). */
  readonly prefix?: string
  /** How long an idle user's log is kept in Valkey, server time (default maxAgeMs + 60 s). */
  readonly ttlMs?: number
}

/** Where a user's log lives. Both keys share a hash tag, so a script may use them together in a Valkey cluster. */
export function valkeyEventKeys(userID: string, prefix = "hub:"): { stream: string; epoch: string } {
  const base = `${prefix}ev:{${encodeURIComponent(userID)}}`
  return { stream: base, epoch: `${base}:epoch` }
}

/** The stream outlives its epoch by this much (see above). */
const STREAM_TTL_MARGIN_MS = 1000

// KEYS[1] stream, KEYS[2] epoch; ARGV[1] a new epoch (used when there is none), ARGV[2] ttl ms.
const OPEN = `
local epoch = redis.call('GET', KEYS[2])
if not epoch then
  epoch = ARGV[1]
  redis.call('DEL', KEYS[1])
end
redis.call('SET', KEYS[2], epoch, 'PX', ARGV[2])
local function renew()
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) + ${STREAM_TTL_MARGIN_MS})
end
`

// The n of the user's last entry (0: none yet); trimming keeps the stream's last id.
const LAST = `
local function lastN(key)
  if redis.call('EXISTS', key) == 0 then return 0 end
  local r = redis.call('XINFO', 'STREAM', key)
  for i = 1, #r, 2 do
    if r[i] == 'last-generated-id' then return tonumber(string.match(r[i + 1], '^(%d+)')) end
  end
  return 0
end
`

// ARGV[3] max, ARGV[4] message JSON, ARGV[5] at, ARGV[6] exceptDevice ('' for none).
const APPEND = `${OPEN}${LAST}
local n = string.format('%d', lastN(KEYS[1]) + 1)
if ARGV[6] ~= '' then
  redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[3], n .. '-0', 'm', ARGV[4], 'at', ARGV[5], 'x', ARGV[6])
else
  redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[3], n .. '-0', 'm', ARGV[4], 'at', ARGV[5])
end
renew()
return {epoch, n}
`

const LATEST = `${OPEN}${LAST}
if redis.call('EXISTS', KEYS[1]) == 1 then renew() end
return {epoch, string.format('%d', lastN(KEYS[1]))}
`

// ARGV[1] the n the client holds. Returns {} when the user has no log.
const SINCE = `${LAST}
local epoch = redis.call('GET', KEYS[2])
if not epoch then return {} end
return {epoch, string.format('%d', lastN(KEYS[1])), redis.call('XRANGE', KEYS[1], '(' .. ARGV[1] .. '-0', '+')}
`

const ID = /^([a-z0-9]+)\.(\d+)$/

const newEpoch = () => `${Date.now().toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`

type RawEntry = [string, string[]]

export class ValkeyEventLog implements EventLog {
  private readonly client: RedisClient
  private readonly ownsClient: boolean
  private readonly now: Clock
  private readonly max: number
  private readonly maxAgeMs: number
  private readonly prefix: string
  private readonly ttlMs: number

  /** On a url (its own connection, made on first use) or a client the caller owns. */
  constructor(valkey: string | RedisClient, options: ValkeyEventLogOptions = {}) {
    this.ownsClient = typeof valkey === "string"
    this.client = typeof valkey === "string" ? new RedisClient(valkey) : valkey
    this.now = options.now ?? Date.now
    this.max = options.max ?? EVENT_LOG_MAX
    this.maxAgeMs = options.maxAgeMs ?? EVENT_LOG_AGE_MS
    this.prefix = options.prefix ?? "hub:"
    this.ttlMs = options.ttlMs ?? this.maxAgeMs + 60_000
  }

  async append(userID: string, message: EventMessage, options: { readonly exceptDevice?: string } = {}): Promise<string> {
    const [epoch, n] = (await this.eval(APPEND, userID, [
      newEpoch(),
      String(this.ttlMs),
      String(this.max),
      JSON.stringify(message),
      String(this.now()),
      options.exceptDevice ?? "",
    ])) as [string, string]
    return `${epoch}.${n}`
  }

  async latest(userID: string): Promise<string> {
    const [epoch, n] = (await this.eval(LATEST, userID, [newEpoch(), String(this.ttlMs)])) as [string, string]
    return `${epoch}.${n}`
  }

  async since(userID: string, lastID: string): Promise<SinceResult> {
    const resync = { resync: true } as const
    const match = ID.exec(lastID)
    const held = Number(match?.[2])
    if (!match || !Number.isSafeInteger(held)) return resync
    const reply = (await this.eval(SINCE, userID, [String(held)])) as [] | [string, string, RawEntry[]]
    if (reply.length === 0) return resync
    const [epoch, last, entries] = reply
    if (epoch !== match[1] || held > Number(last)) return resync
    const events = entries.map(([id, fields]) => this.event(epoch, id, fields))
    if (held === Number(last)) return { events: [] }
    // The next event the client needs (held + 1) must still be there, and not too old.
    const next = events[0]
    if (!next || next.id !== `${epoch}.${held + 1}` || next.at < this.now() - this.maxAgeMs) return resync
    return { events }
  }

  /** Closes the connection when the log made it. */
  close(): void {
    if (this.ownsClient) this.client.close()
  }

  private eval(script: string, userID: string, args: string[]): Promise<unknown> {
    const keys = valkeyEventKeys(userID, this.prefix)
    return this.client.send("EVAL", [script, "2", keys.stream, keys.epoch, ...args])
  }

  private event(epoch: string, id: string, fields: string[]): LogEvent {
    const values: Record<string, string> = {}
    for (let i = 0; i + 1 < fields.length; i += 2) values[fields[i]!] = fields[i + 1]!
    return {
      id: `${epoch}.${id.slice(0, id.indexOf("-"))}`,
      message: JSON.parse(values.m ?? "{}") as EventMessage,
      at: Number(values.at),
      ...(values.x ? { exceptDevice: values.x } : {}),
    }
  }
}
