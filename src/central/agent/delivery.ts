// The delivery engine (design §3.3, §3.4; decisions jswt9p22, 52aqsopo).
import type { DeliverRequest, DeliverResult, DeliveryMode, MessageKind as WireKind } from "../../protocol"
import { isDeliverResult } from "../../protocol"
import type { Clock, Counters, StateStore, Timers } from "../backend/types"
import type { AgentActor } from "./actor"
import type { DirectoryEntry, Resolved } from "./directory"
import { type Party, type PartyInfo, partyFromActor, partyKey, renderEnvelope } from "./envelope"
import { AgentError } from "./errors"
import { HOP_CAP, HopTracker, MessageLimiter, type MessageLimits, overHopCap } from "./message-limits"
import { parseAddress } from "./names"
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

/**
 * Something the user should know: a reply chain crossed the hop cap (its messages no longer wake anyone), or an
 * ask stayed unanswered by an idle recipient after every re-wake.
 */
export interface DeliveryAlert {
  readonly kind: "hopCap" | "unanswered"
  /** The recipient session. */
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
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
  /** Limiter caps (default PAIR_LIMIT, USER_LIMIT, WAKE_BUDGET). */
  readonly limits?: Partial<MessageLimits>
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

/** A reply or decline as sent, with the message it answered. */
export interface Replied extends Sent {
  readonly original: Message
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
    this.limiter = new MessageLimiter({ counters: deps.counters, now, ...(deps.limits ? { limits: deps.limits } : {}) })
  }

  /**
   * Stores a msg or ask from the actor to the session `addr` names and delivers it. A role goes to one holder:
   * an idle one, else the most recently active, else (all offline) the one seen last. Throws invalid, not_found,
   * ambiguous, unsupported {feature: "deliver"}, rate_limited or forbidden (muted) before anything is stored.
   */
  async send(userID: string, actor: AgentActor, addr: string, kind: "msg" | "ask", text: string, options: SendOptions = {}): Promise<Sent> {
    const from = this.party(userID, actor)
    const resolved = this.deps.directory.resolve(userID, addr)
    return this.sendTo(userID, from, addr, resolved, this.pick(resolved), kind, text, options)
  }

  /** Like send, to every session the address names (each role holder gets its own message). */
  async sendAll(userID: string, actor: AgentActor, addr: string, kind: "msg" | "ask", text: string, options: SendOptions = {}): Promise<Sent[]> {
    const from = this.party(userID, actor)
    const resolved = this.deps.directory.resolve(userID, addr)
    const sent: Sent[] = []
    for (const entry of resolved.sessions) sent.push(await this.sendTo(userID, from, addr, resolved, entry, kind, text, options))
    return sent
  }

  /** Replies to a message, from its recipient to its real sender (never via a role), and delivers the reply. */
  reply(userID: string, actor: AgentActor, replyTo: string, text: string, options: SendOptions = {}): Promise<Replied> {
    return this.answer(userID, actor, replyTo, options, (input) => this.messages.reply(userID, { ...input, text }))
  }

  /** Declines an ask, with a reason, and delivers the decline to the asker. */
  decline(userID: string, actor: AgentActor, replyTo: string, why: string, options: SendOptions = {}): Promise<Replied> {
    return this.answer(userID, actor, replyTo, options, (input) => this.messages.decline(userID, { ...input, why }))
  }

  /** A human turn in the session (console prompt or utterance, or typed in the harness): its hop chain starts over. */
  humanTurn(userID: string, sessionID: string): Promise<void> {
    return this.hops.humanTurn(userID, sessionID)
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

  private async sendTo(userID: string, from: Party, addr: string, resolved: Resolved, entry: DirectoryEntry, kind: "msg" | "ask", text: string, options: SendOptions): Promise<Sent> {
    const sessionID = entry.sessionID
    const recipient: Party = { kind: "session", sessionID, ...(entry.name ? { name: entry.name } : {}) }
    this.gate(userID, sessionID)
    await this.limiter.admit(userID, from, recipient)
    const hop = await this.hops.next(userID, from)
    const generation = generationOf(resolved, entry)
    const message = await this.messages.send(userID, {
      from,
      to: addr,
      recipient,
      kind,
      text,
      hop,
      ...(generation === undefined ? {} : { generation }),
      ...(options.expiresInMs === undefined ? {} : { expiresInMs: options.expiresInMs }),
    })
    await this.hops.received(userID, recipient, hop)
    const wake = await this.wakeFor(userID, message, options.wake !== false && entry.parentID === undefined)
    return this.deliver(userID, message, sessionID, wake, options.urgent === true)
  }

  /** One session of a resolved address (see send). */
  private pick(resolved: Resolved): DirectoryEntry {
    const { sessions } = resolved
    if (sessions.length === 1 || resolved.address.kind !== "role") return sessions[0]!
    const { registry } = this.deps
    const online = sessions.filter((s) => s.online)
    if (!online.length) return latest(sessions, (s) => s.lastSeen ?? 0)
    const idle = online.filter((s) => registry.idle(s.sessionID))
    return latest(idle.length ? idle : online, (s) => registry.recency(s.sessionID))
  }

  private async answer(
    userID: string,
    actor: AgentActor,
    replyTo: string,
    options: SendOptions,
    store: (input: { from: Party; replyTo: string; hop: number; generation?: number }) => Promise<{ message: Message; original: Message }>,
  ): Promise<Replied> {
    const from = this.party(userID, actor)
    const original = await this.messages.get(userID, replyTo)
    const to = original && partyKey(original.recipient) === partyKey(from) ? original.from : undefined
    if (to?.kind === "session") this.gate(userID, to.sessionID)
    if (to) await this.limiter.admit(userID, from, to)
    const hop = await this.hops.next(userID, from)
    const generation = original && actor.kind === "session" ? this.holderGeneration(userID, actor.sessionID, original) : undefined
    const answered = await store({ from, replyTo, hop, ...(generation === undefined ? {} : { generation }) })
    const { message } = answered
    await this.hops.received(userID, message.recipient, hop)
    if (message.recipient.kind !== "session") return answered
    const sessionID = message.recipient.sessionID
    const wake = await this.wakeFor(userID, message, options.wake !== false && !this.isSubagent(userID, sessionID))
    return { ...(await this.deliver(userID, message, sessionID, wake, true)), original: answered.original }
  }

  /** Whether the message may start a turn: wanted, under the hop cap (alerting once at the cap), wake budget left. */
  private async wakeFor(userID: string, message: Message, wanted: boolean): Promise<boolean> {
    if (!wanted || message.recipient.kind !== "session") return false
    if (overHopCap(message.hop)) {
      if (message.hop === HOP_CAP + 1) {
        this.deps.alert?.(userID, {
          kind: "hopCap",
          sessionID: message.recipient.sessionID,
          messageID: message.id,
          text: `Sessions messaged each other ${HOP_CAP} times without you; further messages no longer wake them`,
        })
      }
      return false
    }
    return this.limiter.wake(userID, message.recipient)
  }

  /** The replier's generation of the role the original reached (undefined: not a role, or not held now). */
  private holderGeneration(userID: string, sessionID: string, original: Message): number | undefined {
    const address = parseAddress(original.to)
    if (original.generation === undefined || address?.kind !== "role") return undefined
    try {
      const entry = this.deps.directory.resolve(userID, sessionID).sessions[0]
      return entry?.roles.find((r) => r.role === address.role && (address.project === undefined || r.project === undefined || r.project === address.project))?.generation
    } catch {
      return undefined
    }
  }

  private isSubagent(userID: string, sessionID: string): boolean {
    try {
      return this.deps.directory.resolve(userID, sessionID).sessions[0]?.parentID !== undefined
    } catch {
      return false
    }
  }

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

/** The holder generation a role address reached (undefined for names and IDs). */
function generationOf(resolved: Resolved, entry: DirectoryEntry): number | undefined {
  const address = resolved.address
  if (address.kind !== "role") return undefined
  return entry.roles.find((r) => r.role === address.role && (address.project === undefined || r.project === undefined || r.project === address.project))?.generation
}

/** The entry with the highest score (the first on ties). */
function latest<T>(list: readonly T[], score: (item: T) => number): T {
  return list.reduce((best, item) => (score(item) > score(best) ? item : best))
}
