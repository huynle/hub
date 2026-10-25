// The delivery engine (design §3.3, §3.4; decisions jswt9p22, 52aqsopo): stores agent messages (./messages) and
// delivers them to their recipient sessions through the spokes. No routes: the message routes (P2-T6) call it.
//
// - Owner selection: the user's connections that report the session (Registry.sessionTargets, owner first) and
//   announce "deliver"; one that fails or answers malformed is skipped for the next (same messageID: OpenCode
//   dedupes it, even across restarts). Only spokes without "deliver" report the session: unsupported
//   {feature: "deliver"} and nothing is stored. No fallback through steer/turn.
// - Modes: plain msg → delivery "queue" (after the running turn), ask/reply/decline/urgent → "steer"; wake
//   unless wake:false, a subagent recipient, the hop cap (alerted once when crossed) or a spent wake budget.
// - Roles: one holder, the idle one (by real evidence) else the most recently active, else (all offline) the
//   one seen last; the message records the holder generation. sendAll: every holder, a message each. A session
//   never messages itself: it is left out of a role it holds, and an address naming only it is invalid.
// - Pending: no deliver-capable connection reports the recipient (offline) or every one failed → kept for
//   PENDING_MS in the StateStore and delivered oldest first on the user's next sessions frame (onSessions).
//   OpenCode holds admitted messages itself across forms, interrupts and restarts (P2-T0), so there is no
//   "retained" retry loop on the hub.
// - Re-wake: an open ask to an idle recipient (Registry.idle: native or hooks evidence) is woken again after
//   each REWAKE_BACKOFF_MS delay with a short reminder (its own id), then the user is alerted once. Busy,
//   offline or pending recipients push the wait back. State lives in the StateStore (survives restarts); the
//   loop looks at users seen since start (a send or a sessions frame of theirs).
// - Primer (design §2.3, decision jswt9p22 #7): once per session, a short identity note (renderPrimer) is
//   admitted without waking (wake:false, steer, meta.kind "primer") just before the first message the session
//   gets, or when it is explicitly named (Directory.onNamed; derived names never prime). Only through
//   deliver-capable spokes: an offline session is primed when its pending message is flushed. The directory
//   persists the primed flag on the session record; a primer no spoke takes is tried again with the next
//   message and never holds the message back.
// - @me (design §12.1): the user's address, never a session (even one named "me"). A msg or ask to @me is stored
//   for the user (their stored-only inbox; nothing goes to a spoke); a msg alerts the user ("user"), an ask is a
//   Decision's carrier (./decisions pushes it). The user cannot message @me; `@me.project` is malformed.
// - Loop protection (./message-limits): pair/user rate limits before storing, hop per message, human turns
//   (console, voice, typed in the harness) reset a session's chain (humanTurn).
import type { DeliverRequest, DeliverResult, DeliveryMode, MessageKind as WireKind } from "../../protocol"
import { isDeliverResult } from "../../protocol"
import type { Clock, Counters, StateStore, Timers } from "../backend/types"
import type { AgentActor } from "./actor"
import type { DirectoryEntry, NamedListener, Resolved } from "./directory"
import { type Party, type PartyInfo, partyFromActor, partyKey, partyLabel, renderEnvelope, renderPrimer } from "./envelope"
import { AgentError } from "./errors"
import { HOP_CAP, HopTracker, MessageLimiter, type MessageLimits, overHopCap } from "./message-limits"
import { parseAddress } from "./names"
import { type Delivery as DeliveryState, type Message, Messages, newMessageID } from "./messages"

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

/** Address resolution (Directory.resolve) and the primer flag (without primed/markPrimed: no primer). */
export interface DeliveryDirectory {
  resolve(userID: string, addr: string): Resolved
  primed?(userID: string, sessionID: string): boolean
  markPrimed?(userID: string, sessionID: string): void
  /** Explicit names (Directory.onNamed): an unprimed session is primed then. */
  onNamed?(listener: NamedListener): () => void
}

/** Hub → spoke deliver request (SpokeHub.request). */
export type DeliverSend = (connID: string, req: DeliverRequest) => Promise<DeliverResult>

/**
 * Something the user should know: a reply chain crossed the hop cap (its messages no longer wake anyone), or an
 * ask stayed unanswered by an idle recipient after every re-wake.
 */
export interface DeliveryAlert {
  /** user: a session or app sent the user (@me) a message. */
  readonly kind: "hopCap" | "unanswered" | "user"
  /** The recipient session (user: the sending session, "" for an app). */
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

const defaultTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The user's own address (design §12.1). */
export const USER_ADDRESS = "@me"

/** True for `@me` (and the malformed `@me.project`, which send refuses). */
const isUserAddress = (addr: string): boolean => addr === USER_ADDRESS || addr.startsWith(`${USER_ADDRESS}.`)

/** How long an offline recipient's message waits for its session to come back. */
export const PENDING_MS = 24 * 60 * 60_000

/** Delays before each re-wake of an idle recipient with an open ask; one more after the last, then the user is told. */
export const REWAKE_BACKOFF_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 45 * 60_000]
/** How often the re-wake loop looks for due asks. */
export const REWAKE_TICK_MS = 30_000

/** StateStore collection: messageID → Pending. */
const PENDING = "message-pending"

/** StateStore collection: ask id → Rewake. */
const REWAKE = "message-rewake"

/** An open ask whose idle recipient the loop wakes again. */
interface Rewake {
  readonly messageID: string
  readonly sessionID: string
  /** Re-wakes sent so far. */
  readonly reminders: number
  readonly nextAt: number
}

/** The wait after `reminders` re-wakes (the last delay repeats). */
const backoff = (reminders: number) => REWAKE_BACKOFF_MS[Math.min(reminders, REWAKE_BACKOFF_MS.length - 1)]!

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
  private readonly timers: Timers
  private readonly newID: () => string
  /** Per user: the flush in progress (flushes run one at a time). */
  private readonly flushing = new Map<string, Promise<void>>()
  /** Per user and session: the primer in flight (one at a time). */
  private readonly priming = new Map<string, Promise<void>>()
  /** Users seen since start (sent a message, or one of their spokes reported sessions): the loop looks at these. */
  private readonly users = new Set<string>()
  private timer: unknown
  private running = false

  constructor(deps: DeliveryDeps) {
    this.deps = deps
    const now = (this.now = deps.now ?? Date.now)
    this.timers = deps.timers ?? defaultTimers
    this.newID = deps.newID ?? newMessageID
    this.messages = new Messages({ state: deps.state, now, newID: this.newID })
    this.hops = new HopTracker({ state: deps.state, now })
    this.limiter = new MessageLimiter({ counters: deps.counters, now, ...(deps.limits ? { limits: deps.limits } : {}) })
    // An explicit (re)name primes again, so the session learns its new address.
    deps.directory.onNamed?.((userID, sessionID) => void this.prime(userID, sessionID, { again: true }))
  }

  /**
   * Primes the session once (see the header; `again`: an explicit rename primes once more): no-op when it is primed, unknown, or no deliver-capable spoke of
   * the user reports it. Never throws.
   */
  prime(userID: string, sessionID: string, options: { again?: boolean } = {}): Promise<void> {
    const key = `${userID}\u0000${sessionID}`
    const running = this.priming.get(key)
    if (running) return running
    const run = this.primeNow(userID, sessionID, options.again === true)
      .catch((cause) => console.error(`[hub] primer failed: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => this.priming.delete(key))
    this.priming.set(key, run)
    return run
  }

  /**
   * Stores a msg or ask from the actor to the session `addr` names and delivers it. A role goes to one holder:
   * an idle one, else the most recently active, else (all offline) the one seen last; never the sending session
   * itself (only itself: invalid). Throws invalid, not_found,
   * ambiguous, unsupported {feature: "deliver"}, rate_limited or forbidden (muted) before anything is stored.
   */
  async send(userID: string, actor: AgentActor, addr: string, kind: "msg" | "ask", text: string, options: SendOptions = {}): Promise<Sent> {
    if (isUserAddress(addr)) return this.sendToUser(userID, actor, addr, kind, text, options)
    const from = this.party(userID, actor)
    const resolved = this.others(actor, this.deps.directory.resolve(userID, addr))
    return this.sendTo(userID, from, addr, resolved, this.pick(resolved), kind, text, options)
  }

  /** Like send, to every session the address names (each role holder gets its own message). */
  async sendAll(userID: string, actor: AgentActor, addr: string, kind: "msg" | "ask", text: string, options: SendOptions = {}): Promise<Sent[]> {
    if (isUserAddress(addr)) return [await this.sendToUser(userID, actor, addr, kind, text, options)]
    const from = this.party(userID, actor)
    const resolved = this.others(actor, this.deps.directory.resolve(userID, addr))
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
    if (userID === undefined) return
    this.users.add(userID)
    await this.flush(userID)
  }

  /** Starts the re-wake loop (every REWAKE_TICK_MS). */
  start(): void {
    if (this.running) return
    this.running = true
    this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
  }

  /** One pass of the re-wake loop over every known user (the loop calls it; tests may too). */
  async tick(): Promise<void> {
    for (const userID of [...this.users]) {
      try {
        await this.rewake(userID)
      } catch (cause) {
        console.error(`[hub] re-wake failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
  }

  // ---- internals ----------------------------------------------------------------------------------------

  private async primeNow(userID: string, sessionID: string, again: boolean): Promise<void> {
    const { directory } = this.deps
    if (!directory.primed || !directory.markPrimed || (!again && directory.primed(userID, sessionID))) return
    if (!this.targets(userID, sessionID).length) return
    const entry = directory.resolve(userID, sessionID).sessions[0]
    if (!entry) return
    const roles = entry.roles.map((r) => (r.project === undefined ? r.role : `${r.role}.${r.project}`))
    const req: DeliverRequest = {
      op: "deliver",
      sessionID,
      messageID: this.newID(),
      text: renderPrimer({ ...(entry.name ? { name: entry.name } : {}), sessionID, roles }),
      wake: false,
      meta: { kind: "primer", from: "hub", to: entry.name ? `@${entry.name}` : sessionID, delivery: "steer" },
    }
    if (await this.request(userID, sessionID, req)) directory.markPrimed(userID, sessionID)
  }

  /** A msg or ask to the user (@me): stored only; a msg alerts the user. */
  private async sendToUser(userID: string, actor: AgentActor, addr: string, kind: "msg" | "ask", text: string, options: SendOptions): Promise<Sent> {
    if (addr !== USER_ADDRESS) throw new AgentError("invalid", "@me takes no project scope")
    if (actor.kind === "user") throw new AgentError("invalid", "You are @me: the user cannot message themselves")
    const from = this.party(userID, actor)
    const recipient: Party = { kind: "user" }
    await this.limiter.admit(userID, from, recipient)
    const hop = await this.hops.next(userID, from)
    const message = await this.messages.send(userID, {
      from,
      to: USER_ADDRESS,
      recipient,
      kind,
      text,
      hop,
      ...(options.expiresInMs === undefined ? {} : { expiresInMs: options.expiresInMs }),
    })
    this.users.add(userID)
    if (kind === "msg") {
      this.deps.alert?.(userID, { kind: "user", sessionID: from.kind === "session" ? from.sessionID : "", messageID: message.id, text: `${partyLabel(from)} sent you a message` })
    }
    return { message }
  }

  private async sendTo(userID: string, from: Party, addr: string, resolved: Resolved, entry: DirectoryEntry, kind: "msg" | "ask", text: string, options: SendOptions): Promise<Sent> {
    const sessionID = entry.sessionID
    const recipient: Party = { kind: "session", sessionID, ...(entry.name ? { name: entry.name } : {}) }
    this.gate(userID, sessionID)
    await this.limiter.admit(userID, from, recipient)
    const hop = await this.hops.next(userID, from)
    const generation = resolved.address.kind === "role" ? roleGeneration(entry, resolved.address) : undefined
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
    this.users.add(userID)
    const wanted = options.wake !== false && entry.parentID === undefined
    const wake = await this.wakeFor(userID, message, wanted)
    if (kind === "ask" && wanted && !overHopCap(hop)) {
      const rewake: Rewake = { messageID: message.id, sessionID, reminders: 0, nextAt: message.at + backoff(0) }
      await this.deps.state.put(userID, REWAKE, message.id, rewake)
    }
    return this.deliver(userID, message, sessionID, wake, options.urgent === true)
  }

  private schedule(): void {
    this.timer = this.timers.set(() => {
      this.timer = undefined
      void this.tick().finally(() => {
        if (this.running && this.timer === undefined) this.schedule()
      })
    }, REWAKE_TICK_MS)
  }

  /** Re-wakes the user's idle recipients of due open asks; after the last re-wake, tells the user. */
  private async rewake(userID: string): Promise<void> {
    const { registry } = this.deps
    for (const { key, value } of await this.deps.state.list<Rewake>(userID, REWAKE)) {
      const t = this.now()
      if (value.nextAt > t) continue
      const ask = await this.messages.get(userID, value.messageID)
      if (!ask || ask.state !== "open") {
        await this.deps.state.delete(userID, REWAKE, key)
        continue
      }
      const postpone = () => this.deps.state.put(userID, REWAKE, key, { ...value, nextAt: t + backoff(value.reminders) })
      const reachable = ask.delivery !== undefined && ask.delivery !== "pending" && this.targets(userID, value.sessionID).length > 0
      if (!reachable || !registry.idle(value.sessionID)) {
        await postpone()
        continue
      }
      if (value.reminders >= REWAKE_BACKOFF_MS.length) {
        await this.deps.state.delete(userID, REWAKE, key)
        this.deps.alert?.(userID, {
          kind: "unanswered",
          sessionID: value.sessionID,
          messageID: ask.id,
          text: `${partyLabel(ask.recipient)} has not answered ${partyLabel(ask.from)}'s ask after ${value.reminders} reminders`,
        })
        continue
      }
      if (!(await this.limiter.wake(userID, ask.recipient)) || !(await this.remind(userID, ask, value.sessionID))) {
        await postpone()
        continue
      }
      const reminders = value.reminders + 1
      await this.deps.state.put(userID, REWAKE, key, { ...value, reminders, nextAt: t + backoff(reminders) })
    }
  }

  /** Sends a short wake-up about an open ask (its own id: the ask itself was already admitted). */
  private async remind(userID: string, ask: Message, sessionID: string): Promise<boolean> {
    const id = this.newID()
    const hint = `↩ hub reply ${ask.id} "…" · hub decline ${ask.id} --why "…"`
    const req: DeliverRequest = {
      op: "deliver",
      sessionID,
      messageID: id,
      text: `[hub] reminder · ask ${ask.id} from ${partyLabel(ask.from)} is still open · ${id}\n${hint}`,
      wake: true,
      meta: { kind: "ask", from: wireAddress(ask.from), to: ask.to, delivery: "steer" },
    }
    return (await this.request(userID, sessionID, req)) !== undefined
  }

  /** The resolved sessions without the sending session itself; invalid when only it is left (no self-messages). */
  private others(actor: AgentActor, resolved: Resolved): Resolved {
    if (actor.kind !== "session") return resolved
    const sessions = resolved.sessions.filter((s) => s.sessionID !== actor.sessionID)
    if (!sessions.length) throw new AgentError("invalid", "A session cannot message itself")
    return { ...resolved, sessions }
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
    this.users.add(userID)
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
      return entry && roleGeneration(entry, address)
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
    await this.prime(userID, sessionID)
    const result = await this.request(userID, sessionID, this.deliverRequest(message, sessionID, wake, urgent))
    if (!result) return undefined
    const updated = (await this.messages.setDelivery(userID, message.id, result.delivered)) ?? message
    return { message: updated, delivery: result.delivered }
  }

  /** Sends the request to each of the user's deliver-capable connections for the session until one takes it. */
  private async request(userID: string, sessionID: string, req: DeliverRequest): Promise<DeliverResult | undefined> {
    for (const connID of this.targets(userID, sessionID)) {
      let result: unknown
      try {
        result = await this.deps.send(connID, req)
      } catch {
        continue
      }
      if (isDeliverResult(result)) return result
    }
    return undefined
  }

  private async flushNow(userID: string): Promise<void> {
    const entries = (await this.deps.state.list<Pending>(userID, PENDING)).sort((a, b) => a.value.at - b.value.at || (a.key < b.key ? -1 : 1))
    for (const { key, value, version } of entries) {
      const message = value.expiresAt > this.now() ? await this.messages.get(userID, value.messageID) : undefined
      // Gone, or an ask that closed (expired) while it waited: nothing to deliver.
      if (!message || (message.kind === "ask" && message.state !== "open")) {
        await this.deps.state.delete(userID, PENDING, key, { ifVersion: version })
        continue
      }
      if (!this.targets(userID, value.sessionID).length) continue
      if (await this.attempt(userID, message, value.sessionID, value.wake, value.urgent)) await this.deps.state.delete(userID, PENDING, key)
    }
  }

  private deliverRequest(message: Message, sessionID: string, wake: boolean, urgent: boolean): DeliverRequest {
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

/** The session's holder generation of the role (and project scope) an address names; undefined: not held. */
function roleGeneration(entry: DirectoryEntry, address: { readonly role: string; readonly project?: string }): number | undefined {
  return entry.roles.find((r) => r.role === address.role && (address.project === undefined || r.project === undefined || r.project === address.project))?.generation
}

/** The entry with the highest score (the first on ties). */
function latest<T>(list: readonly T[], score: (item: T) => number): T {
  return list.reduce((best, item) => (score(item) > score(best) ? item : best))
}
