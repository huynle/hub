// The canonical agent event journal (lifecycle design: Events; decision xwzersmm). One bounded journal per user of
// compact events that GET /api/agent/events, MCP `events` and (later) /api/agent/watch read:
//
//   {id: "evt_…", at, type, subject: {sessionID?, rootID?, messageID?, senderID?, launchID?, machineID?}, data}
//
// Payloads are built from allowlists here and nowhere else: never prompts, message bodies, titles, blocker
// summaries, launch reasons or labels, credentials, or connection/pod/spoke IDs. Each record also keeps, for the
// reader only, its scope family (session, manage, message, launch) and its audience (the parties of a message, who
// started a launch), so an app or session token sees only what its scopes and identity allow.
//
// Storage is an EventLog (a Valkey stream per user in a cluster, process memory otherwise) bounded to
// AGENT_EVENTS_MAX events and AGENT_EVENTS_AGE_MS. An event id is assigned once, before any cross-pod fan-out;
// append claims it in the Kv first (SET NX), so appending the same id twice stores it once.
import { randomBytes } from "node:crypto"
import type { Clock, EventLog, Kv } from "../backend/types"
import type { LiveStatus } from "../registry"
import { partyKey } from "./envelope"
import type { Launch } from "./launch-store"
import { addressOf, type Message } from "./messages"

export const AGENT_EVENTS_MAX = 10_000
export const AGENT_EVENTS_AGE_MS = 86_400_000
/** Record format version (readers reject others rather than skip them). */
export const AGENT_EVENT_VERSION = 1

/** The scope family a reader needs: sessions:read, sessions:manage, messages:read, sessions:launch. */
export type EventFamily = "session" | "manage" | "message" | "launch"

export type EventSubject = Readonly<Record<string, string>>
export type EventData = Readonly<Record<string, string | number | boolean>>

/** An event as readers receive it. */
export interface AgentEvent {
  readonly id: string
  readonly at: number
  readonly type: string
  readonly subject: EventSubject
  readonly data: EventData
}

/** Who else may read an event beyond the user: the party keys of a message, who started a launch. */
export interface EventAudience {
  readonly parties?: readonly string[]
  readonly by?: string
}

/** What a writer appends. */
export interface EventInput {
  /** A stable id (assigned before fan-out); a new one when absent. */
  readonly id?: string
  readonly type: string
  readonly family: EventFamily
  readonly subject: EventSubject
  readonly data: EventData
  readonly audience?: EventAudience
}

/** A journal record: the event, its reader-only scope fields, and its position in the user's log. */
export interface EventRecord {
  readonly position: string
  readonly event: AgentEvent
  readonly family: EventFamily
  readonly audience?: EventAudience
}

/** Records after a position, or `reset` when the journal no longer covers it (expired, trimmed, restarted). */
export type EventsSince = { readonly records: EventRecord[] } | { readonly reset: true }

const FAMILIES: ReadonlySet<string> = new Set<EventFamily>(["session", "manage", "message", "launch"])
const EVENT_ID = /^evt_[0-9a-f]{20}$/

export const newEventID = (): string => `evt_${randomBytes(10).toString("hex")}`

export interface AgentEventsOptions {
  readonly log: EventLog
  readonly kv: Kv
  readonly now?: Clock
}

export class AgentEvents {
  private readonly log: EventLog
  private readonly kv: Kv
  private readonly now: Clock

  constructor(options: AgentEventsOptions) {
    this.log = options.log
    this.kv = options.kv
    this.now = options.now ?? Date.now
  }

  /** Stores an event once per id; returns its id. */
  async append(userID: string, input: EventInput): Promise<string> {
    const id = input.id ?? newEventID()
    if (!EVENT_ID.test(id)) throw new Error("Invalid event id")
    const claim = `aev:${userID}:${id}`
    if (!(await this.kv.set(claim, "1", { nx: true, px: AGENT_EVENTS_AGE_MS }))) return id
    const record = {
      type: input.type,
      v: AGENT_EVENT_VERSION,
      id,
      at: this.now(),
      family: input.family,
      subject: input.subject,
      data: input.data,
      ...(input.audience ? { audience: input.audience } : {}),
    }
    try {
      await this.log.append(userID, record)
    } catch (cause) {
      // Not stored: a retry with the same id must be able to store it.
      await this.kv.del(claim).catch(() => {})
      throw cause
    }
    return id
  }

  /** The position of the user's latest record; a reader holding it gets every later one. */
  latest(userID: string): Promise<string> {
    return this.log.latest(userID)
  }

  async since(userID: string, position: string): Promise<EventsSince> {
    const result = await this.log.since(userID, position)
    if ("resync" in result) return { reset: true }
    const records: EventRecord[] = []
    for (const logged of result.events) {
      const m = logged.message as Record<string, unknown>
      // A record this version cannot read is a reset, never a silent skip.
      if (m.v !== AGENT_EVENT_VERSION || typeof m.id !== "string" || typeof m.at !== "number" || !FAMILIES.has(m.family as string)) return { reset: true }
      records.push({
        position: logged.id,
        event: { id: m.id, at: m.at, type: String(m.type), subject: (m.subject ?? {}) as EventSubject, data: (m.data ?? {}) as EventData },
        family: m.family as EventFamily,
        ...(m.audience ? { audience: m.audience as EventAudience } : {}),
      })
    }
    return { records }
  }
}

// ---- Compact builders (allowlists) ------------------------------------------------------------------------

/** A stored agent message changed (sent, delivered, answered…): never its text. */
export function messageEvent(message: Message): EventInput {
  const { id, kind, state, from, recipient, replyTo, delivery } = message
  return {
    type: "message.changed",
    family: "message",
    subject: {
      messageID: id,
      ...(recipient.kind === "session" ? { sessionID: recipient.sessionID } : {}),
      ...(from.kind === "session" ? { senderID: from.sessionID } : {}),
    },
    data: { kind, state, from: addressOf(from), to: message.to, ...(replyTo ? { replyTo } : {}), ...(delivery ? { delivery } : {}) },
    audience: { parties: [partyKey(from), partyKey(recipient)] },
  }
}

/** A launch changed: never its prompt, reason or labels. */
export function launchEvent(launch: Launch): EventInput {
  return {
    type: "launch.changed",
    family: "launch",
    subject: { launchID: launch.id, ...(launch.sessionID !== undefined ? { sessionID: launch.sessionID } : {}) },
    data: { state: launch.state, ...(launch.outcome !== undefined ? { outcome: launch.outcome } : {}), ...(launch.name !== undefined ? { name: launch.name } : {}) },
    ...(launch.by !== undefined ? { audience: { by: launch.by } } : {}),
  }
}

/** A session's archive state changed. */
export const archiveEvent = (sessionID: string, archived: boolean): EventInput => ({ type: "session.archived", family: "manage", subject: { sessionID }, data: { archived } })

interface Known {
  state: string
  blockers: Set<string>
}

/**
 * State and blocker changes of status trees, against what was seen before (one per writer). Bounded by the live
 * trees: a tree's entry is replaced by each status of it and dropped by forget().
 */
export class StatusDiff {
  private readonly trees = new Map<string, Map<string, Known>>()

  events(rootID: string, sessions: readonly LiveStatus[]): EventInput[] {
    const before = this.trees.get(rootID) ?? new Map<string, Known>()
    const after = new Map<string, Known>()
    const out: EventInput[] = []
    for (const entry of sessions) {
      const known = before.get(entry.id)
      const subject = { sessionID: entry.id, rootID }
      const open = new Set(entry.blockers.map((b) => b.id))
      for (const b of entry.blockers) if (!known?.blockers.has(b.id)) out.push({ type: "blocker.opened", family: "session", subject, data: { blockerID: b.id, kind: b.kind } })
      for (const id of known?.blockers ?? []) if (!open.has(id)) out.push({ type: "blocker.closed", family: "session", subject, data: { blockerID: id } })
      if (known?.state !== entry.state) out.push({ type: "session.changed", family: "session", subject, data: { state: entry.state, ...(known ? { prev: known.state } : {}) } })
      after.set(entry.id, { state: entry.state, blockers: open })
    }
    this.trees.set(rootID, after)
    return out
  }

  /** Drops a tree that is gone. */
  forget(rootID: string): void {
    this.trees.delete(rootID)
  }

  roots(): string[] {
    return [...this.trees.keys()]
  }
}

/** Presence per user (sessions and machines) diffed against the previous view (the catalog writer's). */
export interface PresenceView {
  readonly sessions: ReadonlySet<string>
  /** Machine id → name, for the machines with a connected process. */
  readonly machines: ReadonlyMap<string, string>
}

export function presenceEvents(before: PresenceView, after: PresenceView): EventInput[] {
  const out: EventInput[] = []
  for (const id of after.sessions) if (!before.sessions.has(id)) out.push({ type: "session.added", family: "session", subject: { sessionID: id }, data: {} })
  for (const id of before.sessions) if (!after.sessions.has(id)) out.push({ type: "session.removed", family: "session", subject: { sessionID: id }, data: {} })
  for (const [id, name] of after.machines) if (!before.machines.has(id)) out.push({ type: "machine.changed", family: "session", subject: { machineID: id }, data: { name, online: true } })
  for (const [id, name] of before.machines) if (!after.machines.has(id)) out.push({ type: "machine.changed", family: "session", subject: { machineID: id }, data: { name, online: false } })
  return out
}
