// Decisions (design §12.1; exploration iw6kfmxg Security): what an ask to the user (`@me`) opens. No routes: the
// agent message routes (ask @me) and the console routes (/api/decisions) call it.
//
// - Stored form: {id, messageID, from, about, sessionID?, question, options, recommendation?, urgency, tier,
//   deadline?, onTimeout?, state, at, expiresAt, escalatedAt?, answer?}, per user in the StateStore. The ask
//   message (stored by the delivery engine, recipient the user) carries it: it closes when the Decision is
//   answered, and the Decision expires with it.
// - Only the user answers (never a session or app, never the asker); `tap` Decisions only from a signed-in
//   console (the device cookie, not a device token). The first answer wins (a version-checked write); later
//   ones get `gone`. The answer goes back to the asker as the user's reply to the ask.
// - Deadlines: at the deadline, `onTimeout` (only an option marked safe) answers it, recorded answeredBy
//   "timeout"; without one the Decision stays open and escalates once (notified again). The loop (start/tick)
//   looks at every user's open Decisions, so deadlines survive restarts.
// - Text is sanitised (question by the message store; labels, ids and reasons here). Notifications carry only
//   the Decision (the push layer sends a generic body).
// - close(): a Decision whose subject went away (a permission answered elsewhere) is closed, not answered; the asker
//   hears why.
// - Every open and change (answer, timeout, escalation, expiry, close) goes to `changed` (the console's 'decision' event).
import type { Clock, StateStore, Timers } from "../backend/types"
import type { AgentActor, UserActor } from "./actor"
import type { Delivery } from "./delivery"
import { type Party, partyKey, sanitizeLabel, sanitizeText } from "./envelope"
import { AgentError } from "./errors"
import { ASK_EXPIRES_MAX_MS, ASK_EXPIRES_MIN_MS, ASK_EXPIRES_MS, type Message, newMessageID } from "./messages"
import { updateVersioned } from "./versioned"

export type Urgency = "low" | "normal" | "high"
/** confirm: any of the user's signed-in devices; tap: only a signed-in console (cookie). */
export type Tier = "confirm" | "tap"
/** closed: ended without an answer because what it asked about went away (answered elsewhere, ended). */
export type DecisionState = "open" | "answered" | "expired" | "closed"

export const URGENCIES: readonly Urgency[] = ["low", "normal", "high"]
export const TIERS: readonly Tier[] = ["confirm", "tap"]
export const DECISION_STATES: readonly DecisionState[] = ["open", "answered", "expired", "closed"]

/** Options a Decision offers. */
export const OPTIONS_MAX = 8
/** Characters of an option label. */
export const OPTION_LABEL_MAX = 80
/** Characters of a recommendation's reason. */
export const WHY_MAX = 1_000
/** Characters of the user's answer text (a note with an option, or the free-text answer). */
export const ANSWER_MAX = 4_000
/** Decisions each user keeps (the oldest closed ones go first). */
export const DECISIONS_MAX = 500
/** How often the loop looks for deadlines. */
export const DECISION_TICK_MS = 30_000

const OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

export interface DecisionOption {
  readonly id: string
  readonly label: string
  /** onTimeout may pick only a safe option. */
  readonly safe?: true
}

export interface DecisionAnswer {
  readonly option?: string
  readonly text?: string
  readonly answeredBy: "user" | "timeout"
  readonly at: number
  /** The device the user answered from. */
  readonly deviceID?: string
}

export interface Decision {
  readonly id: string
  /** The ask (to @me) that carries it. */
  readonly messageID: string
  /** The asker (a session or an app). */
  readonly from: Party
  /** Session IDs it concerns (default: the asking session). */
  readonly about: readonly string[]
  /** The session a notification opens (about[0]). */
  readonly sessionID?: string
  readonly question: string
  readonly options: readonly DecisionOption[]
  readonly recommendation?: { readonly option: string; readonly why?: string }
  readonly urgency: Urgency
  readonly tier: Tier
  readonly deadline?: number
  readonly onTimeout?: string
  readonly state: DecisionState
  readonly at: number
  /** When its ask expires (the Decision with it). */
  readonly expiresAt: number
  /** When it passed its deadline without a safe onTimeout (notified again). */
  readonly escalatedAt?: number
  readonly answer?: DecisionAnswer
  /** Why it closed without an answer (state closed). */
  readonly closed?: { readonly at: number; readonly reason: string }
}

export interface AskInput {
  readonly question: string
  readonly options?: readonly { readonly id: string; readonly label: string; readonly safe?: boolean }[]
  readonly recommendation?: { readonly option: string; readonly why?: string }
  readonly urgency?: Urgency
  readonly tier?: Tier
  /** From now. */
  readonly deadlineMs?: number
  readonly onTimeout?: string
  /** Session IDs (resolved by the caller, the user's own). */
  readonly about?: readonly string[]
  /** The ask's lifetime (default: a day, or the deadline plus a day; at most ASK_EXPIRES_MAX_MS). */
  readonly expiresInMs?: number
}

export interface AnswerInput {
  readonly option?: string
  readonly text?: string
}

export type NotifyReason = "opened" | "escalated"

export interface DecisionsDeps {
  readonly state: StateStore
  readonly delivery: Pick<Delivery, "send" | "reply">
  readonly now?: Clock
  readonly timers?: Timers
  readonly newID?: () => string
  /** The users whose Decisions the deadline loop looks at. */
  readonly users?: () => Iterable<string>
  /** A Decision the user should see (opened, or past its deadline without a safe onTimeout). */
  readonly notify?: (userID: string, decision: Decision, reason: NotifyReason) => void
  /** A Decision opened or changed (answered, timed out, escalated, expired): the console's live event. Never throws through. */
  readonly changed?: (userID: string, decision: Decision) => void
}

const DECISIONS = "decisions"
const BY_MESSAGE = "decision-by-message"

const defaultTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** `dec_` + 22 base62 characters from the CSPRNG. */
export const newDecisionID = (): string => `dec_${newMessageID().slice(4)}`

const invalid = (message: string) => new AgentError("invalid", message)
const gone = () => new AgentError("gone", "The decision is already answered or expired")
const notFound = () => new AgentError("not_found", "No such decision")

function cleanLabel(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || value.length > max * 4) throw invalid(`${what} must be a string of at most ${max} characters`)
  const clean = sanitizeLabel(value, max)
  if (!clean) throw invalid(`${what} is empty`)
  return clean
}

function cleanText(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || value.length > max) throw invalid(`${what} must be a string of at most ${max} characters`)
  const clean = sanitizeText(value).trim()
  if (!clean) throw invalid(`${what} is empty`)
  return clean
}

/** The validated, sanitised parts of a Decision (everything but what the ask message gives). */
function validate(input: AskInput) {
  const raw = input.options ?? []
  if (!Array.isArray(raw) || raw.length > OPTIONS_MAX) throw invalid(`A decision offers at most ${OPTIONS_MAX} options`)
  const options: DecisionOption[] = []
  for (const option of raw) {
    if (typeof option?.id !== "string" || !OPTION_ID.test(option.id)) throw invalid("Option ids are 1–32 lowercase letters, digits, - or _")
    if (options.some((o) => o.id === option.id)) throw invalid(`Option ${option.id} is given twice`)
    options.push({ id: option.id, label: cleanLabel(option.label, OPTION_LABEL_MAX, "An option label"), ...(option.safe === true ? { safe: true as const } : {}) })
  }
  const has = (id: string) => options.some((o) => o.id === id)
  let recommendation: Decision["recommendation"]
  if (input.recommendation !== undefined) {
    const { option, why } = input.recommendation
    if (typeof option !== "string" || !has(option)) throw invalid("The recommendation must name one of the options")
    recommendation = { option, ...(why === undefined ? {} : { why: cleanLabel(why, WHY_MAX, "The recommendation's reason") }) }
  }
  const urgency = input.urgency ?? "normal"
  if (!URGENCIES.includes(urgency)) throw invalid(`urgency is one of ${URGENCIES.join(", ")}`)
  const tier = input.tier ?? "confirm"
  if (!TIERS.includes(tier)) throw invalid(`tier is one of ${TIERS.join(", ")}`)
  const { deadlineMs, onTimeout } = input
  if (deadlineMs !== undefined && !(Number.isFinite(deadlineMs) && deadlineMs >= ASK_EXPIRES_MIN_MS && deadlineMs <= ASK_EXPIRES_MAX_MS)) {
    throw invalid(`A deadline is 1 minute to ${ASK_EXPIRES_MAX_MS / 86_400_000} days away`)
  }
  if (onTimeout !== undefined) {
    if (deadlineMs === undefined) throw invalid("onTimeout needs a deadline")
    if (!options.some((o) => o.id === onTimeout && o.safe)) throw invalid("onTimeout may pick only an option marked safe")
  }
  const expiresInMs = input.expiresInMs ?? Math.min(ASK_EXPIRES_MAX_MS, Math.max(ASK_EXPIRES_MS, (deadlineMs ?? 0) + ASK_EXPIRES_MS))
  if (deadlineMs !== undefined && deadlineMs > expiresInMs) throw invalid("The deadline is after the ask expires")
  return { options, recommendation, urgency, tier, deadlineMs, onTimeout, expiresInMs }
}

export class Decisions {
  private readonly deps: DecisionsDeps
  private readonly now: Clock
  private readonly timers: Timers
  private readonly newID: () => string
  private timer: unknown
  private running = false

  constructor(deps: DecisionsDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? defaultTimers
    this.newID = deps.newID ?? newDecisionID
  }

  /**
   * Opens a Decision: stores the ask to @me (through the delivery engine: rate limits, sanitising) and the
   * Decision, then notifies. Throws invalid (input; the user as asker), rate_limited, forbidden.
   */
  async ask(userID: string, actor: AgentActor, input: AskInput): Promise<{ message: Message; decision: Decision }> {
    if (actor.kind === "user") throw invalid("You are @me: the user cannot ask themselves")
    if (typeof input.question !== "string") throw invalid("question must be a string")
    const v = validate(input)
    const about = [...new Set(input.about ?? (actor.kind === "session" ? [actor.sessionID] : []))]
    const { message } = await this.deps.delivery.send(userID, actor, "@me", "ask", input.question, { expiresInMs: v.expiresInMs })
    const decision: Decision = {
      id: this.newID(),
      messageID: message.id,
      from: message.from,
      about,
      ...(about[0] ? { sessionID: about[0] } : {}),
      question: message.text,
      options: v.options,
      ...(v.recommendation ? { recommendation: v.recommendation } : {}),
      urgency: v.urgency,
      tier: v.tier,
      ...(v.deadlineMs === undefined ? {} : { deadline: message.at + v.deadlineMs }),
      ...(v.onTimeout === undefined ? {} : { onTimeout: v.onTimeout }),
      state: "open",
      at: message.at,
      expiresAt: message.expiresAt ?? message.at + v.expiresInMs,
    }
    const written = await this.deps.state.put(userID, DECISIONS, decision.id, decision, { ifVersion: 0 })
    if (!written.ok) throw new Error("decision id collision")
    await this.deps.state.put(userID, BY_MESSAGE, message.id, decision.id)
    await this.trim(userID)
    this.deps.notify?.(userID, decision, "opened")
    this.emit(userID, decision)
    return { message, decision }
  }

  async get(userID: string, id: string): Promise<Decision | undefined> {
    const stored = await this.deps.state.get<Decision>(userID, DECISIONS, id)
    return stored && this.view(stored.value)
  }

  /** The Decision an ask to @me carries. */
  async byMessage(userID: string, messageID: string): Promise<Decision | undefined> {
    const id = (await this.deps.state.get<string>(userID, BY_MESSAGE, messageID))?.value
    return id === undefined ? undefined : this.get(userID, id)
  }

  /** The user's Decisions, newest first; `from`: only those this party asked. */
  async list(userID: string, filter: { readonly state?: DecisionState; readonly from?: Party } = {}): Promise<Decision[]> {
    const from = filter.from && partyKey(filter.from)
    return (await this.deps.state.list<Decision>(userID, DECISIONS))
      .map((entry) => this.view(entry.value))
      .filter((d) => (filter.state === undefined || d.state === filter.state) && (from === undefined || partyKey(d.from) === from))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
  }

  /**
   * The user answers: an option (with an optional note), or text for a Decision without options. The first
   * answer wins; then the asker gets the user's reply. Throws not_found, gone, forbidden (tap without the
   * console cookie) or invalid.
   */
  async answer(userID: string, id: string, input: AnswerInput, by: UserActor): Promise<{ decision: Decision; reply?: Message }> {
    const current = await this.get(userID, id)
    if (!current || by.userID !== userID) throw notFound()
    if (current.state !== "open") throw gone()
    if (current.tier === "tap" && by.via !== "cookie") throw new AgentError("forbidden", "This decision needs a tap in the signed-in console", { hint: "Answer it in the console" })
    const choice = this.choice(current, input)
    const at = this.now()
    const answer: DecisionAnswer = { ...choice, answeredBy: "user", at, deviceID: by.deviceID }
    const decision = await this.settle(userID, id, answer)
    if (!decision) throw gone()
    this.emit(userID, decision)
    const option = decision.options.find((o) => o.id === choice.option)
    const text = option ? `Decision ${id}: ${option.label} [${option.id}]${choice.text ? `\n${choice.text}` : ""}` : `Decision ${id}: ${choice.text}`
    return { decision, ...(await this.replyTo(userID, decision, text, by)) }
  }

  /**
   * Closes an open Decision without an answer (what it asked about went away: answered elsewhere, ended) and tells
   * the asker why. Undefined (no change) when it is not open, unknown or another user's.
   */
  async close(userID: string, id: string, reason: string): Promise<Decision | undefined> {
    const why = sanitizeLabel(reason, WHY_MAX) || "Closed"
    const closed = await updateVersioned<Decision>(this.deps.state, userID, DECISIONS, id, (current) =>
      current && this.view(current).state === "open" ? { ...current, state: "closed", closed: { at: this.now(), reason: why } } : undefined,
    )
    if (!closed) return undefined
    this.emit(userID, closed)
    const hub: UserActor = { kind: "user", userID, deviceID: "hub", via: "cookie" }
    await this.replyTo(userID, closed, `Decision ${id} closed: ${why}`, hub)
    return closed
  }

  /** Starts the deadline loop (every DECISION_TICK_MS). */
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

  /** One pass of the deadline loop over every user (the loop calls it; tests may too). */
  async tick(): Promise<void> {
    for (const userID of this.deps.users?.() ?? []) {
      try {
        await this.due(userID)
      } catch (cause) {
        console.error(`[hub] decision deadlines failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
  }

  // ---- internals ----------------------------------------------------------------------------------------

  /** Tells the changed listener (its failure never fails the caller). */
  private emit(userID: string, decision: Decision): void {
    try {
      this.deps.changed?.(userID, decision)
    } catch (cause) {
      console.error(`[hub] decision ${decision.id}: change listener failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  private schedule(): void {
    this.timer = this.timers.set(() => {
      this.timer = undefined
      void this.tick().finally(() => {
        if (this.running && this.timer === undefined) this.schedule()
      })
    }, DECISION_TICK_MS)
  }

  /** The Decision as of now (an open one past its ask's expiry reads expired). */
  private view(decision: Decision): Decision {
    return decision.state === "open" && this.now() >= decision.expiresAt ? { ...decision, state: "expired" } : decision
  }

  private choice(decision: Decision, input: AnswerInput): { option?: string; text?: string } {
    const text = input.text === undefined ? undefined : cleanText(input.text, ANSWER_MAX, "The answer text")
    if (!decision.options.length) {
      if (input.option !== undefined) throw invalid("This decision has no options: answer with text")
      if (text === undefined) throw invalid("This decision needs an answer text")
      return { text }
    }
    if (typeof input.option !== "string" || !decision.options.some((o) => o.id === input.option)) {
      throw invalid(`Pick one of the options: ${decision.options.map((o) => o.id).join(", ")}`)
    }
    return { option: input.option, ...(text === undefined ? {} : { text }) }
  }

  /** Answers the Decision if it is still open (version-checked); undefined when it is not. */
  private settle(userID: string, id: string, answer: DecisionAnswer): Promise<Decision | undefined> {
    return updateVersioned<Decision>(this.deps.state, userID, DECISIONS, id, (current) =>
      current && this.view(current).state === "open" ? { ...current, state: "answered", answer } : undefined,
    )
  }

  /** The user's reply to the ask (the asker's answer); a failure is logged, the Decision stays answered. */
  private async replyTo(userID: string, decision: Decision, text: string, by: UserActor): Promise<{ reply?: Message }> {
    try {
      return { reply: (await this.deps.delivery.reply(userID, by, decision.messageID, text)).message }
    } catch (cause) {
      console.error(`[hub] decision ${decision.id}: reply to the asker failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      return {}
    }
  }

  /** Expires, times out or escalates the user's open Decisions that are due. */
  private async due(userID: string): Promise<void> {
    const t = this.now()
    for (const { value } of await this.deps.state.list<Decision>(userID, DECISIONS)) {
      if (value.state !== "open") continue
      if (t >= value.expiresAt) {
        const expired = await updateVersioned<Decision>(this.deps.state, userID, DECISIONS, value.id, (current) => (current?.state === "open" ? { ...current, state: "expired" } : undefined))
        if (expired) this.emit(userID, expired)
        continue
      }
      if (value.deadline === undefined || t < value.deadline) continue
      const option = value.onTimeout === undefined ? undefined : value.options.find((o) => o.id === value.onTimeout && o.safe)
      if (option) {
        const decision = await this.settle(userID, value.id, { option: option.id, answeredBy: "timeout", at: t })
        if (decision) {
          this.emit(userID, decision)
          const hub: UserActor = { kind: "user", userID, deviceID: "hub", via: "cookie" }
          await this.replyTo(userID, decision, `Decision ${decision.id}: no answer by the deadline; took the safe option ${option.label} [${option.id}]`, hub)
        }
        continue
      }
      if (value.escalatedAt !== undefined) continue
      const escalated = await updateVersioned<Decision>(this.deps.state, userID, DECISIONS, value.id, (current) =>
        current?.state === "open" && current.escalatedAt === undefined ? { ...current, escalatedAt: t } : undefined,
      )
      if (escalated) {
        this.deps.notify?.(userID, escalated, "escalated")
        this.emit(userID, escalated)
      }
    }
  }

  /** Drops the oldest closed Decisions over DECISIONS_MAX. */
  private async trim(userID: string): Promise<void> {
    const all = await this.deps.state.list<Decision>(userID, DECISIONS)
    const excess = all.length - DECISIONS_MAX
    if (excess <= 0) return
    const closed = all.filter((e) => this.view(e.value).state !== "open").sort((a, b) => a.value.at - b.value.at)
    for (const entry of closed.slice(0, excess)) {
      await this.deps.state.delete(userID, DECISIONS, entry.key, { ifVersion: entry.version })
      await this.deps.state.delete(userID, BY_MESSAGE, entry.value.messageID)
    }
  }
}
