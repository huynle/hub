// The delivery engine (design §3.3, §3.4; decisions jswt9p22, 52aqsopo).
import type { DeliverRequest, DeliverResult, DeliveryMode, MessageKind as WireKind } from "../../protocol"
import { isDeliverResult } from "../../protocol"
import type { Clock, Counters, StateStore, Timers } from "../backend/types"
import type { AgentActor } from "./actor"
import type { DirectoryEntry, Resolved } from "./directory"
import { type Party, type PartyInfo, partyFromActor, renderEnvelope } from "./envelope"
import { AgentError } from "./errors"
import { HopTracker, MessageLimiter } from "./message-limits"
import { type Delivery as DeliveryState, type Message, Messages } from "./messages"

/** What the engine reads from the Registry. */
export interface DeliveryRegistry {
  /** Connections that report the session, the owner first (Registry.sessionTargets). */
  sessionTargets(sessionID: string): string[]
  supports(connID: string, feature: "deliver"): boolean
  connTenant(connID: string): string | undefined
  /** Idle by real evidence (Registry.idle). */
  idle(sessionID: string): boolean
  /** Higher: more recent activity. */
  recency(sessionID: string): number
}

/** Address resolution (Directory.resolve). */
export interface DeliveryDirectory {
  resolve(userID: string, addr: string): Resolved
}

/** Hub → spoke deliver request (SpokeHub.request). */
export type DeliverSend = (connID: string, req: DeliverRequest) => Promise<DeliverResult>

export interface DeliveryAlert {
  readonly kind: string
}

export interface DeliveryDeps {
  readonly state: StateStore
  readonly counters: Counters
  readonly registry: DeliveryRegistry
  readonly directory: DeliveryDirectory
  readonly send: DeliverSend
  readonly now?: Clock
  readonly timers?: Timers
  readonly newID?: () => string
  /** Labels of a session sender (default: its @name from the directory). */
  readonly describe?: (userID: string, sessionID: string) => PartyInfo
  readonly alert?: (userID: string, alert: DeliveryAlert) => void
}

export interface SendOptions {
  /** false: admit without starting a turn (reported queued). */
  readonly wake?: boolean
  /** Steer into a running turn, like an ask. */
  readonly urgent?: boolean
  /** Asks only. */
  readonly expiresInMs?: number
}

export interface Sent {
  readonly message: Message
  /** How it reached the recipient; undefined when the recipient is not a session (stored only). */
  readonly delivery?: DeliveryState
}

/** How long an offline recipient's message waits for its session to come back. */
export const PENDING_MS = 24 * 60 * 60_000

/** StateStore collection: messageID → Pending. */
const PENDING = "message-pending"

/** A message waiting for its (offline) recipient session. */
interface Pending {
  readonly messageID: string
  readonly sessionID: string
  readonly wake: boolean
  readonly urgent: boolean
  readonly at: number
  readonly expiresAt: number
}

/** How a party appears in deliver meta: `@name`, `ses_…`, `@me`, `app:<tokenID>`. */
function wireAddress(party: Party): string {
  switch (party.kind) {
    case "session":
      return party.name ? `@${party.name}` : party.sessionID
    case "user":
      return "@me"
    case "app":
      return `app:${party.tokenID}`
  }
}

export class Delivery {
  readonly messages: Messages
  readonly hops: HopTracker
  readonly limiter: MessageLimiter
  private readonly deps: DeliveryDeps
  private readonly now: Clock
  /** Per user: the flush in progress (flushes run one at a time). */
  private readonly flushing = new Map<string, Promise<void>>()

  constructor(deps: DeliveryDeps) {
    this.deps = deps
    const now = (this.now = deps.now ?? Date.now)
    this.messages = new Messages({ state: deps.state, now, ...(deps.newID ? { newID: deps.newID } : {}) })
    this.hops = new HopTracker({ state: deps.state, now })
    this.limiter = new MessageLimiter({ counters: deps.counters, now })
  }

  /** Stores a msg or ask from the actor to the session `addr` names and delivers it. */
  async send(userID: string, actor: AgentActor, addr: string, kind: "msg" | "ask", text: string, options: SendOptions = {}): Promise<Sent> {
    const from = this.party(userID, actor)
    const entry = this.deps.directory.resolve(userID, addr).sessions[0]!
    const recipient: Party = { kind: "session", sessionID: entry.sessionID, ...(entry.name ? { name: entry.name } : {}) }
    this.gate(userID, entry.sessionID)
    const message = await this.messages.send(userID, { from, to: addr, recipient, kind, text, ...(options.expiresInMs === undefined ? {} : { expiresInMs: options.expiresInMs }) })
    const wake = options.wake !== false && entry.parentID === undefined
    return this.deliver(userID, message, entry.sessionID, wake, options.urgent === true)
  }

  /** Delivers the user's pending messages whose sessions a deliver-capable spoke reports now, oldest first. */
  flush(userID: string): Promise<void> {
    const previous = this.flushing.get(userID) ?? Promise.resolve()
    const run = previous.then(() => this.flushNow(userID))
    const tracked = run.finally(() => {
      if (this.flushing.get(userID) === tracked) this.flushing.delete(userID)
    })
    this.flushing.set(userID, tracked)
    return run
  }

  /** Registry.onSessions: a spoke reported its sessions (connected, reconnected, or its periodic snapshot). */
  async onSessions(connID: string): Promise<void> {
    const userID = this.deps.registry.connTenant(connID)
    if (userID !== undefined) await this.flush(userID)
  }

  // ---- internals ----------------------------------------------------------------------------------------

  /** Refuses (unsupported) a session that only spokes without deliver report; an offline one is fine (pending). */
  private gate(userID: string, sessionID: string): void {
    const targets = this.deps.registry.sessionTargets(sessionID).filter((connID) => this.deps.registry.connTenant(connID) === userID)
    if (targets.length && !targets.some((connID) => this.deps.registry.supports(connID, "deliver"))) {
      throw new AgentError("unsupported", "The recipient's spoke cannot receive messages: update the hub plugin", { extra: { feature: "deliver" } })
    }
  }

  /** The user's deliver-capable connections for the session, the owner first. */
  private targets(userID: string, sessionID: string): string[] {
    const { registry } = this.deps
    return registry.sessionTargets(sessionID).filter((connID) => registry.connTenant(connID) === userID && registry.supports(connID, "deliver"))
  }

  /** Delivers now, or queues the message as pending when no spoke takes it. */
  private async deliver(userID: string, message: Message, sessionID: string, wake: boolean, urgent: boolean): Promise<Sent> {
    const delivered = await this.attempt(userID, message, sessionID, wake, urgent)
    if (delivered) return delivered
    const at = this.now()
    const pending: Pending = { messageID: message.id, sessionID, wake, urgent, at, expiresAt: at + PENDING_MS }
    await this.deps.state.put(userID, PENDING, message.id, pending)
    return { message: (await this.messages.setDelivery(userID, message.id, "pending")) ?? message, delivery: "pending" }
  }

  /** Tries each deliver-capable connection in turn (same message id: the harness dedupes it). */
  private async attempt(userID: string, message: Message, sessionID: string, wake: boolean, urgent: boolean): Promise<Sent | undefined> {
    const req = this.request(message, sessionID, wake, urgent)
    for (const connID of this.targets(userID, sessionID)) {
      let result: unknown
      try {
        result = await this.deps.send(connID, req)
      } catch {
        continue
      }
      if (!isDeliverResult(result)) continue
      const updated = (await this.messages.setDelivery(userID, message.id, result.delivered)) ?? message
      return { message: updated, delivery: result.delivered }
    }
    return undefined
  }

  private async flushNow(userID: string): Promise<void> {
    const entries = (await this.deps.state.list<Pending>(userID, PENDING)).sort((a, b) => a.value.at - b.value.at || (a.key < b.key ? -1 : 1))
    for (const { key, value, version } of entries) {
      const message = value.expiresAt > this.now() ? await this.messages.get(userID, value.messageID) : undefined
      if (!message) {
        await this.deps.state.delete(userID, PENDING, key, { ifVersion: version })
        continue
      }
      if (!this.targets(userID, value.sessionID).length) continue
      if (await this.attempt(userID, message, value.sessionID, value.wake, value.urgent)) await this.deps.state.delete(userID, PENDING, key)
    }
  }

  private request(message: Message, sessionID: string, wake: boolean, urgent: boolean): DeliverRequest {
    const delivery: DeliveryMode = message.kind === "msg" && !urgent ? "queue" : "steer"
    return {
      op: "deliver",
      sessionID,
      messageID: message.id,
      text: renderEnvelope({ id: message.id, kind: message.kind, from: message.from, to: message.to, at: message.at, text: message.text, ...(message.replyTo ? { replyTo: message.replyTo } : {}), ...(message.expiresAt === undefined ? {} : { expiresAt: message.expiresAt }) }),
      wake,
      meta: { kind: message.kind as WireKind, from: wireAddress(message.from), to: message.to, ...(message.replyTo ? { replyTo: message.replyTo } : {}), delivery },
    }
  }

  /** The sender, from the authenticated actor only. */
  private party(userID: string, actor: AgentActor): Party {
    if (actor.kind !== "session") return partyFromActor(actor)
    return partyFromActor(actor, this.deps.describe?.(userID, actor.sessionID) ?? this.directoryInfo(userID, actor.sessionID))
  }

  private directoryInfo(userID: string, sessionID: string): PartyInfo {
    try {
      const name = this.deps.directory.resolve(userID, sessionID).sessions[0]?.name
      return name ? { name } : {}
    } catch {
      return {}
    }
  }
}
