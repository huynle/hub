// GET /api/agent/events?cursor=&wait=&limit=&type=&session= (lifecycle design, frozen "Events route and tool"):
// the canonical journal (events.ts) read with an opaque cursor (event-cursor.ts).
//
// - No cursor: no events and a cursor at the latest record (a long poll then waits for what comes next).
// - wait: seconds 0–60 to hold the request while nothing matches (local appends wake it at once; appends on other
//   pods are rechecked every RECHECK_MS). limit: 1–200 (default 50). type and session may repeat (≤ 20 each);
//   a type ending in `.*` matches a family of types.
// - At most INSPECT_MAX records are inspected per request. Filters advance the cursor over every inspected record;
//   `more` means records remain unread, matching or not.
// - A cursor the journal no longer covers (expired, trimmed, another epoch after a restart) answers a typed reset
//   with a fresh cursor and the reads to refresh; a malformed, forged, future, unsupported-version or another
//   user's cursor answers 400 invalid_cursor.
//
// Who sees what: the user everything. App tokens need events:subscribe for the route and, per family, sessions:read
// (session), sessions:manage (manage), messages:read and being a party (message), sessions:launch and having started
// it (launch). Session tokens see session and manage events, messages they are a party to and launches they started.
// Reader-only fields (family, audience, position) never leave the hub.
import type { AgentActor } from "./actor"
import type { Directory } from "./directory"
import { decodeCursor, encodeCursor, parsePosition, type CursorKeys } from "./event-cursor"
import type { AgentEvent, AgentEvents, EventRecord } from "./events"
import { partyFromActor, partyKey } from "./envelope"
import { AgentError } from "./errors"
import { launchedBy } from "./launch-routes"
import { AGENT_PREFIX, type AgentRoute } from "./routes"

export const EVENTS_WAIT_MAX_S = 60
export const EVENTS_LIMIT_MAX = 200
export const EVENTS_LIMIT_DEFAULT = 50
export const INSPECT_MAX = 1000
export const RECHECK_MS = 1000
export const RESET_REFRESH = ["status", "sessions", "inbox", "decisions", "launches"] as const
const FILTER_MAX = 20
const TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/

const NO_STORE = { "cache-control": "no-store" }

export interface EventsRouteDeps {
  readonly events: Pick<AgentEvents, "latest" | "since" | "appended">
  readonly keys: CursorKeys
  readonly directory: Pick<Directory, "resolve">
}

export interface EventsPage {
  readonly events: AgentEvent[]
  readonly cursor: string
  readonly more: boolean
  readonly reset: boolean
  readonly refresh?: readonly string[]
}

const invalid = (message: string) => new AgentError("invalid", message)
const badCursor = () => new AgentError("invalid_cursor", "This cursor is not valid here: start again without one", { hint: `GET ${AGENT_PREFIX}/events without cursor` })

function intParam(url: URL, key: string, min: number, max: number, fallback: number): number {
  const raw = url.searchParams.get(key)
  if (raw === null || raw === "") return fallback
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw invalid(`${key} must be a whole number from ${min} to ${max}`)
  return Number(raw)
}

/** Whether an actor may read a record. */
export function visible(record: EventRecord, actor: AgentActor): boolean {
  if (actor.kind === "user") return true
  const party = partyKey(partyFromActor(actor))
  const has = (scope: string) => actor.kind === "session" || actor.scopes.includes(scope)
  switch (record.family) {
    case "session":
      return has("sessions:read")
    case "manage":
      return has("sessions:manage")
    case "message":
      return has("messages:read") && (record.audience?.parties ?? []).includes(party)
    case "launch":
      return has("sessions:launch") && record.audience?.by === launchedBy(actor)
  }
}

export function eventsRoutes(deps: EventsRouteDeps): AgentRoute[] {
  return [
    {
      method: "GET",
      path: `${AGENT_PREFIX}/events`,
      allow: { session: true, scope: "events:subscribe" },
      handle: async ({ user, url, actor, request }) => {
        const wait = intParam(url, "wait", 0, EVENTS_WAIT_MAX_S, 0)
        const limit = intParam(url, "limit", 1, EVENTS_LIMIT_MAX, EVENTS_LIMIT_DEFAULT)
        const types = url.searchParams.getAll("type").filter(Boolean)
        const addrs = url.searchParams.getAll("session").filter(Boolean)
        if (types.length > FILTER_MAX || addrs.length > FILTER_MAX) throw invalid(`At most ${FILTER_MAX} type and ${FILTER_MAX} session filters`)
        if (types.some((t) => t.length > 100 || !TYPE.test(t))) throw invalid("type must be an event type such as session.changed or launch.*")
        const sessions = addrs.length ? new Set(addrs.flatMap((addr) => deps.directory.resolve(user.id, addr).sessions.map((s) => s.sessionID))) : undefined
        const page = await read(deps, user.id, actor, { cursor: url.searchParams.get("cursor") ?? undefined, wait, limit, types, sessions }, request.signal)
        return Response.json(page, { headers: NO_STORE })
      },
    },
  ]
}

interface ReadOptions {
  readonly cursor?: string
  readonly wait: number
  readonly limit: number
  readonly types: readonly string[]
  readonly sessions?: ReadonlySet<string>
}

const typeMatches = (types: readonly string[], type: string) => types.length === 0 || types.some((t) => (t.endsWith(".*") ? type.startsWith(t.slice(0, -1)) : t === type))

const sessionMatches = (sessions: ReadonlySet<string> | undefined, event: AgentEvent) =>
  !sessions || [event.subject.sessionID, event.subject.rootID, event.subject.senderID].some((id) => id !== undefined && sessions.has(id))

export async function read(deps: EventsRouteDeps, userID: string, actor: AgentActor, options: ReadOptions, signal?: AbortSignal): Promise<EventsPage> {
  const { events, keys } = deps
  const page = (position: string, found: AgentEvent[], more: boolean): EventsPage => ({ events: found, cursor: encodeCursor(keys, userID, position), more, reset: false })
  let position: string
  if (options.cursor === undefined || options.cursor === "") {
    position = await events.latest(userID)
    if (options.wait === 0) return page(position, [], false)
  } else {
    const decoded = decodeCursor(keys, userID, options.cursor)
    const held = decoded ? parsePosition(decoded) : undefined
    if (!decoded || !held) throw badCursor()
    const latest = parsePosition(await events.latest(userID))
    if (latest && latest.epoch === held.epoch && held.n > latest.n) throw badCursor()
    position = decoded
  }
  const deadline = performance.now() + options.wait * 1000
  for (;;) {
    const result = await events.since(userID, position)
    if ("reset" in result) return { events: [], cursor: encodeCursor(keys, userID, await events.latest(userID)), more: false, reset: true, refresh: RESET_REFRESH }
    const found: AgentEvent[] = []
    let more = result.records.length > INSPECT_MAX
    for (const record of result.records.slice(0, INSPECT_MAX)) {
      if (visible(record, actor) && typeMatches(options.types, record.event.type) && sessionMatches(options.sessions, record.event)) {
        if (found.length === options.limit) {
          more = true
          break
        }
        found.push(record.event)
      }
      position = record.position
    }
    const left = deadline - performance.now()
    if (found.length > 0 || more || left <= 0 || signal?.aborted) return page(position, found, more)
    await events.appended(userID, Math.min(RECHECK_MS, left), signal)
  }
}
