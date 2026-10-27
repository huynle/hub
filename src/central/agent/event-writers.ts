// Writers of the canonical agent event journal (events.ts; lifecycle design, Event rollout stage 1). Each change
// is appended exactly once across a cluster, by the one place that sees it first:
//
// - state and blockers: the pod holding the spoke (the registry's status messages are local to it), diffed per tree;
// - session and machine presence: the "agent-events" leader, diffing the cluster-wide catalog per user against a
//   snapshot it keeps in the Kv, so a new leader continues where the last one stopped (none: everything present
//   is new);
// - messages and launches: the pod that published them (Feed origin listeners);
// - archive changes: the route that made them (directory-routes).
//
// Appends of one writer are serialized, so a user's events keep their order. Failures are reported, never thrown.
import type { Kv } from "../backend/types"
import type { CatalogMachine, RegistryMessage } from "../registry"
import { AGENT_EVENTS_AGE_MS, type AgentEvents, type EventInput, launchEvent, messageEvent, presenceEvents, type PresenceView, StatusDiff } from "./events"
import type { Launch } from "./launch-store"
import type { Message } from "./messages"

interface Subscribable<T> {
  subscribe(listener: (userID: string, item: T) => void, options?: { readonly origin?: boolean }): () => void
}

export interface EventWriterRegistry {
  subscribe(listener: (message: RegistryMessage, tenant?: string) => void): () => void
  catalog(): CatalogMachine[]
  sessionTenant(sessionID: string): string | undefined
}

export interface PresenceLeader {
  isLeader(): boolean
}

export interface EventWritersOptions {
  readonly events: AgentEvents
  readonly kv: Kv
  readonly registry: EventWriterRegistry
  /** The owner of a stored machine (undefined: not stored, e.g. the local machine). */
  readonly machineOwner: (machineID: string) => string | undefined
  /** Every stored user (a new leader loads their presence snapshots). */
  readonly users: () => Promise<string[]>
  readonly messages?: Subscribable<Message>
  readonly launches?: Subscribable<Launch>
  readonly report?: (cause: unknown) => void
}

const snapshotKey = (userID: string) => `aev:presence:${userID}`

const EMPTY: PresenceView = { sessions: new Set(), machines: new Map() }

/** Presence of every user in a catalog. */
export function presenceOf(machines: readonly CatalogMachine[], tenant: (sessionID: string) => string | undefined, owner: (machineID: string) => string | undefined): Map<string, PresenceView> {
  const out = new Map<string, { sessions: Set<string>; machines: Map<string, string> }>()
  const view = (userID: string) => {
    let v = out.get(userID)
    if (!v) out.set(userID, (v = { sessions: new Set(), machines: new Map() }))
    return v
  }
  for (const machine of machines) {
    const users = new Set<string>()
    const stored = owner(machine.id)
    if (stored !== undefined) users.add(stored)
    for (const process of machine.processes) {
      for (const s of process.sessions) {
        const userID = tenant(s.id)
        if (userID === undefined) continue
        view(userID).sessions.add(s.id)
        if (stored === undefined) users.add(userID)
      }
    }
    if (machine.processes.length > 0) for (const userID of users) view(userID).machines.set(machine.id, machine.name)
  }
  return out
}

export class EventWriters {
  private readonly options: EventWritersOptions
  private readonly diff = new StatusDiff()
  private readonly report: (cause: unknown) => void
  private queue: Promise<void> = Promise.resolve()
  /** Presence as last journaled, per user (leader only; undefined when not leading). */
  private presence: Map<string, PresenceView> | undefined
  private readonly offs: (() => void)[] = []

  constructor(options: EventWritersOptions) {
    this.options = options
    this.report = options.report ?? ((cause) => console.error(`[hub] agent event write failed: ${cause instanceof Error ? cause.message : String(cause)}`))
  }

  start(): void {
    const { registry, messages, launches } = this.options
    this.offs.push(
      registry.subscribe((message, tenant) => {
        if (message.type === "status" && tenant !== undefined) this.write(tenant, this.diff.events(message.sessionID, message.sessions))
        else if (message.type === "catalog") {
          this.forgetGone()
          if (this.presence) this.enqueue(() => this.presenceChanged())
        }
      }),
    )
    if (messages) this.offs.push(messages.subscribe((userID, message) => this.write(userID, [messageEvent(message)]), { origin: true }))
    if (launches) this.offs.push(launches.subscribe((userID, launch) => this.write(userID, [launchEvent(launch)]), { origin: true }))
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off()
    this.presence = undefined
  }

  /** Became the presence leader: load the last leader's snapshots, then journal what changed since. */
  elected(): void {
    this.enqueue(async () => {
      const presence = new Map<string, PresenceView>()
      for (const userID of await this.options.users()) {
        const raw = await this.options.kv.get(snapshotKey(userID))
        if (raw) presence.set(userID, parseSnapshot(raw))
      }
      this.presence = presence
      await this.presenceChanged()
    })
  }

  deposed(): void {
    this.enqueue(async () => {
      this.presence = undefined
    })
  }

  /** Resolves once every queued append is done (tests, drain). */
  settled(): Promise<void> {
    return this.queue
  }

  private write(userID: string, events: readonly EventInput[]): void {
    if (events.length === 0) return
    this.enqueue(async () => {
      for (const event of events) await this.options.events.append(userID, event)
    })
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch(this.report)
  }

  private async presenceChanged(): Promise<void> {
    const before = this.presence
    if (!before) return
    const { registry, machineOwner, events, kv } = this.options
    const after = presenceOf(registry.catalog(), (id) => registry.sessionTenant(id), machineOwner)
    for (const userID of new Set([...before.keys(), ...after.keys()])) {
      const prev = before.get(userID) ?? EMPTY
      const next = after.get(userID) ?? EMPTY
      const changes = presenceEvents(prev, next)
      if (changes.length === 0) continue
      for (const event of changes) await events.append(userID, event)
      if (next.sessions.size === 0 && next.machines.size === 0) {
        before.delete(userID)
        await kv.del(snapshotKey(userID))
      } else {
        before.set(userID, next)
        await kv.set(snapshotKey(userID), JSON.stringify({ sessions: [...next.sessions], machines: [...next.machines] }), { px: AGENT_EVENTS_AGE_MS })
      }
    }
  }

  /** Drops the status diffs of trees no longer in the catalog. */
  private forgetGone(): void {
    const present = new Set<string>()
    for (const machine of this.options.registry.catalog()) for (const process of machine.processes) for (const s of process.sessions) present.add(s.id)
    for (const rootID of this.diff.roots()) if (!present.has(rootID)) this.diff.forget(rootID)
  }
}

function parseSnapshot(raw: string): PresenceView {
  try {
    const value = JSON.parse(raw) as { sessions?: unknown; machines?: unknown }
    const sessions = Array.isArray(value.sessions) ? value.sessions.filter((id): id is string => typeof id === "string") : []
    const machines = Array.isArray(value.machines) ? value.machines.filter((m): m is [string, string] => Array.isArray(m) && typeof m[0] === "string" && typeof m[1] === "string") : []
    return { sessions: new Set(sessions), machines: new Map(machines) }
  } catch {
    return EMPTY
  }
}
