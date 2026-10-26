// Escalations (design §5, §12.1; decision wvqeuis0 §7; exploration hcw63slg Security): what the acting engine's
// needs_user becomes. An agent asked to approve a permission request outside its grant; the user decides.
//
// - ONE Decision per (holder, request): the first escalation opens it (options approve [always] / deny (safe), the
//   agent's recommendation, the tier the hub set on the evaluation, about the asking session); escalating the same
//   request again updates the open Decision's reason instead (no new push). Concurrent escalations race on a
//   version-checked reservation: one opens the Decision, the other is rate_limited (retry).
// - The recommendation also shows on the request's blocker (registry.recommend: catalog, status, the push's
//   service worker reads it there).
// - Answering (decisions.ts runs `act` after the answer wins) replies to the permission AS THE USER through the
//   shared executor: no grant, no kill switch (those bind agents, not the user); tenancy of the tree is checked
//   again; the reply is in the agent audit as the user's. The request gone → the Decision closes (gone); its spoke
//   not serving permission → it closes with the unsupported reason (audited unsupported).
// - The request answered elsewhere, or ended (registry.onPermissionClosed → closed()): every Decision escalating
//   it closes.
// - Spam limits: ESCALATIONS_PER_HOLDER_HOUR new Decisions per holder an hour, ESCALATIONS_OPEN_MAX open ones per
//   user (both rate_limited: the needs_user still stands, without a Decision), and pushes coalesce: a Decision
//   opened within ESCALATION_PUSH_COALESCE_MS of the user's last escalation push opens quietly (still listed and
//   live in the console).
import { type Actions, unsupportedMessage } from "../actions"
import type { Counters, StateStore } from "../backend/types"
import type { Registry } from "../registry"
import type { PermissionDecision } from "../../protocol"
import type { BlockerRecommendation } from "../../status"
import type { Escalation } from "./acting"
import type { AgentActor, UserActor } from "./actor"
import type { AgentAudit } from "./audit"
import { type ActOutcome, type Decision, type DecisionActor, type Decisions, WHY_MAX } from "./decisions"
import { type Party, partyFromActor, partyKey, partyLabel } from "./envelope"
import { AgentError } from "./errors"
import type { Message } from "./messages"

/** New escalation Decisions a holder opens an hour (their asks to @me also count in its message pair limit). */
export const ESCALATIONS_PER_HOLDER_HOUR = 20
/** Open escalation Decisions per user. */
export const ESCALATIONS_OPEN_MAX = 20
/** Escalations opened this soon after the user's last escalation push do not push again. */
export const ESCALATION_PUSH_COALESCE_MS = 60_000
/** A reservation older than this (its opener crashed) no longer blocks a new escalation. */
const RESERVATION_MS = 60_000
const HOUR_MS = 3_600_000
/** Characters of the question (the request's resources are listed up to it). */
const QUESTION_MAX = 2_000
const CLOSED_REASON = "The request was answered elsewhere or ended"

const COLLECTION = "escalations"

/** (holder, request) → its Decision; without decisionID while it is being opened. */
interface EscalationRecord {
  readonly holder: string
  readonly requestID: string
  readonly at: number
  readonly decisionID?: string
}

export interface EscalationsDeps {
  readonly state: StateStore
  readonly counters: Counters
  readonly decisions: Pick<Decisions, "ask" | "get" | "list" | "close" | "revise">
  readonly registry: Pick<Registry, "recommend" | "sessionTenant">
  readonly actions: Pick<Actions, "answerPermission">
  readonly audit?: Pick<AgentAudit, "record">
  /** The holder as envelopes name it (a session by its directory name); default: from the actor alone. */
  readonly describe?: (userID: string, actor: AgentActor) => Party
  /** The Decision's ask was stored (the console's message feed). */
  readonly published?: (userID: string, message: Message) => void
  readonly now?: () => number
}

const rateLimited = (message: string, retryAfter: number) => new AgentError("rate_limited", message, { extra: { retryAfter } })

export class Escalations {
  private readonly now: () => number

  constructor(private readonly deps: EscalationsDeps) {
    this.now = deps.now ?? Date.now
    this.act = this.act.bind(this)
  }

  /** The acting engine's escalate hook: opens or updates the holder's Decision about the request. */
  async escalate(escalation: Escalation): Promise<{ decisionID?: string }> {
    const { userID } = escalation
    const holder = this.describe(userID, escalation.actor)
    const key = `${partyKey(holder)} ${escalation.requestID}`
    const { state } = this.deps
    const existing = await state.get<EscalationRecord>(userID, COLLECTION, key)
    if (existing?.value.decisionID) {
      const decision = await this.deps.decisions.get(userID, existing.value.decisionID)
      if (decision?.state === "open") return this.update(escalation, holder, decision)
    } else if (existing && this.now() - existing.value.at < RESERVATION_MS) {
      throw rateLimited("An escalation of this request is being opened", 1)
    }
    const record: EscalationRecord = { holder: partyKey(holder), requestID: escalation.requestID, at: this.now() }
    const reserved = await state.put(userID, COLLECTION, key, record, { ifVersion: existing?.version ?? 0 })
    if (!reserved.ok) throw rateLimited("An escalation of this request is being opened", 1)
    try {
      const decision = await this.open(escalation, holder)
      await state.put(userID, COLLECTION, key, { ...record, decisionID: decision.id }, { ifVersion: reserved.version })
      return { decisionID: decision.id }
    } catch (cause) {
      await state.delete(userID, COLLECTION, key, { ifVersion: reserved.version })
      throw cause
    }
  }

  /** Decisions' action runner: replies to the escalated permission as the answering user. */
  async act(userID: string, decision: Decision, choice: { readonly option?: string }, by: UserActor): Promise<ActOutcome> {
    const action = decision.action
    if (!action || action.kind !== "permission") return "gone"
    const reply: PermissionDecision = choice.option === "always" ? "always" : choice.option === "approve" ? "once" : "reject"
    const verb = reply === "reject" ? "deny" : "approve"
    const owned = this.deps.registry.sessionTenant(action.rootID) === by.userID && by.userID === userID
    const answered = owned ? await this.deps.actions.answerPermission({ rootID: action.rootID, requestID: action.requestID, decision: reply }) : { outcome: "gone" as const }
    await this.deps.audit?.record(userID, {
      actor: { kind: "user" },
      verb,
      target: { sessionID: action.sessionID, requestID: action.requestID },
      decision: "allow",
      reason: `Decision ${decision.id}`,
      outcome: answered.outcome === "done" ? "ok" : answered.outcome,
    })
    await this.forget(userID, action.requestID)
    // The spoke holding the request cannot answer permissions: the Decision closes saying so (not "answered elsewhere").
    if (answered.outcome === "unsupported") return { outcome: "gone", reason: unsupportedMessage(answered) }
    return answered.outcome === "done" ? "done" : "gone"
  }

  /** The request went away (answered elsewhere, ended): closes every Decision escalating it. */
  async closed(userID: string | undefined, requestID: string): Promise<void> {
    if (userID === undefined) return
    for (const { key, value } of await this.deps.state.list<EscalationRecord>(userID, COLLECTION)) {
      if (value.requestID !== requestID) continue
      if (value.decisionID) await this.deps.decisions.close(userID, value.decisionID, CLOSED_REASON)
      await this.deps.state.delete(userID, COLLECTION, key)
    }
  }

  // ---- internals ----------------------------------------------------------------------------------------

  private describe(userID: string, actor: AgentActor): Party {
    return this.deps.describe?.(userID, actor) ?? partyFromActor(actor)
  }

  /** A new Decision, within the spam limits. */
  private async open(escalation: Escalation, holder: Party): Promise<Decision> {
    const { userID } = escalation
    const { decisions, counters } = this.deps
    const open = (await decisions.list(userID, { state: "open" })).filter((d) => d.action?.kind === "permission").length
    if (open >= ESCALATIONS_OPEN_MAX) throw rateLimited(`At most ${ESCALATIONS_OPEN_MAX} escalations wait for the user at once`, 60)
    const opened = await counters.incr(`escalations:${userID}:${partyKey(holder)}`, HOUR_MS)
    if (opened > ESCALATIONS_PER_HOLDER_HOUR) throw rateLimited(`At most ${ESCALATIONS_PER_HOLDER_HOUR} escalations an hour`, 3600)
    const pushes = await counters.incr(`escalation-push:${userID}`, ESCALATION_PUSH_COALESCE_MS)
    const recommend = escalation.always ? "always" : "approve"
    const why = boundedWhy(escalation.why)
    const { message, decision } = await decisions.ask(
      userID,
      escalation.actor,
      {
        question: question(escalation, partyLabel(holder)),
        options: [
          ...(escalation.always ? [{ id: "always", label: "Approve always" }] : []),
          { id: "approve", label: "Approve once" },
          { id: "deny", label: "Deny", safe: true },
        ],
        recommendation: { option: recommend, ...(why ? { why } : {}) },
        urgency: "high",
        tier: escalation.evaluation.tier,
        about: [escalation.sessionID],
      },
      {
        action: { kind: "permission", requestID: escalation.requestID, rootID: escalation.rootID, sessionID: escalation.sessionID, always: escalation.always },
        quiet: pushes > 1,
      },
    )
    this.deps.published?.(userID, message)
    this.showOnBlocker(escalation.requestID, holder, decision)
    return decision
  }

  /** The same holder escalated the request again: a new reason replaces the recommendation's. */
  private async update(escalation: Escalation, holder: Party, decision: Decision): Promise<{ decisionID: string }> {
    const why = boundedWhy(escalation.why)
    let current = decision
    if (why && why !== decision.recommendation?.why) {
      const option = decision.recommendation?.option ?? (escalation.always ? "always" : "approve")
      current = (await this.deps.decisions.revise(escalation.userID, decision.id, { recommendation: { option, why } })) ?? decision
    }
    this.showOnBlocker(escalation.requestID, holder, current)
    return { decisionID: decision.id }
  }

  private showOnBlocker(requestID: string, holder: Party, decision: Decision): void {
    const why = decision.recommendation?.why
    const recommendation: BlockerRecommendation = { by: partyLabel(holder), recommends: "approve", ...(why ? { why } : {}), decisionID: decision.id }
    this.deps.registry.recommend(requestID, recommendation)
  }

  /** Drops the (holder, request) records of an answered request. */
  private async forget(userID: string, requestID: string): Promise<void> {
    for (const { key, value } of await this.deps.state.list<EscalationRecord>(userID, COLLECTION)) {
      if (value.requestID === requestID) await this.deps.state.delete(userID, COLLECTION, key)
    }
  }
}

/** The agent's reason, cut to what a Decision keeps. */
function boundedWhy(why: string | undefined): string | undefined {
  const trimmed = why?.trim()
  return trimmed ? Array.from(trimmed).slice(0, WHY_MAX).join("") : undefined
}

/** "@orchestrator asks to approve shell: bun test, bun run lint. Outside its grant: …" (bounded). */
function question(escalation: Escalation, by: string): string {
  const { request, evaluation } = escalation
  const what = request ? `${request.action}${request.resources.length ? `: ${request.resources.join(", ")}` : ""}` : "a permission request (details unknown)"
  const always = escalation.always && request?.save?.length ? ` always (saves ${request.save.join(", ")})` : escalation.always ? " always" : ""
  const text = `${by} asks to approve${always} ${what}. Outside its grant: ${evaluation.reason}`
  return text.length > QUESTION_MAX ? `${text.slice(0, QUESTION_MAX - 1)}…` : text
}
