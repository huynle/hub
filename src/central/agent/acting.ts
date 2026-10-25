// The acting engine (design §5, §7, §11.4; decision wvqeuis0; exploration hcw63slg): approve, deny, answer, prompt
// and stop a session for its user. acting-routes.ts maps HTTP onto it; actions.ts runs the spoke side.
//
// Who may act:
// - Users (cookie, device token) always may, on their own sessions: tenancy only, no grant, no kill switch.
// - Sessions (through their act token only, never a shell token) and app tokens (scope sessions:act) act under a
//   grant (grants.ts) of their user, in this order:
//   tenancy → kill switch → grant → self-tree → hub never → grant never → allow (else needs_user) → hourly cap →
//   kill switch again → spoke.
//   · tenancy: the address resolves among the user's sessions; a request or form must be pending in that tree
//     (otherwise not_found, like another user's).
//   · self-tree: a session never answers a permission request or form in its own session tree (forbidden).
//   · never (hub-wide agents.never, then every usable grant's never): beats any allow; tried on the request as
//     asked and on its normalised shell form (normaliseShell), a hit on either is forbidden.
//   · allow: the first usable grant whose policy covers the request; none → needs_user (403) with the evaluation
//     {verdict, reason, tier, grants}. The `escalate` hook (P3-T8 turns it into a Decision) gets the escalation
//     first; a request without parsed details, or truncated, is always needs_user (tap).
//   · deny, answer, prompt and stop need only the grant's verb (a reject is always safe).
// - Every outcome after the address resolves is in the agent audit: decision (allow, needs_user, forbidden,
//   paused, rate_limited) and outcome (ok, gone, offline, unsupported, escalated, refused, failed).
// - Races: the request answered elsewhere first is gone (410).
import {
  DELIVER_TEXT_MAX,
  type Delivered,
  type DeliveryMode,
  type FormAnswer,
  isDeliverResult,
  PERMISSION_MESSAGE_MAX,
  type PermissionDecision,
  type PromptImage,
  promptImagesProblem,
  type ResultFor,
  type ServerRequest,
} from "../../protocol"
import type { Actions } from "../actions"
import { BusyError, type Registry } from "../registry"
import { SpokeError } from "../spoke-ws"
import type { PermissionRequest } from "../../status"
import type { ActingSwitch } from "./acting-switch"
import type { AgentActor } from "./actor"
import type { AgentAudit, AuditDecision, AuditOutcome, AuditTarget } from "./audit"
import type { Tier } from "./decisions"
import type { Directory } from "./directory"
import { type Party, partyFromActor, partyLabel, sanitizeText } from "./envelope"
import { AgentError } from "./errors"
import type { Grant, Grants } from "./grants"
import { newMessageID } from "./messages"
import { evaluatePermission, formatPattern, type GrantVerb, parsePattern, type Pattern, riskTier } from "./policy"

/** What the engine reads from the Registry. */
export type ActingRegistry = Pick<
  Registry,
  "sessionTenant" | "session" | "rootOf" | "permissionRequest" | "permissionTargets" | "formTargets" | "owner" | "supports"
>

/** Why a request needs the user, as the policy saw it. */
export interface Evaluation {
  readonly verdict: "outside"
  readonly reason: string
  /** Set by the hub (decision wvqeuis0 §7), never by the agent. */
  readonly tier: Tier
  /** The usable grants it was evaluated against. */
  readonly grants: readonly string[]
}

/** An agent's approval outside its grant: what the user is asked to decide (P3-T8 opens a Decision). */
export interface Escalation {
  readonly userID: string
  readonly actor: AgentActor
  readonly verb: "approve"
  /** The addressed session. */
  readonly target: string
  /** The session that asked, and its tree. */
  readonly sessionID: string
  readonly rootID: string
  readonly requestID: string
  readonly request?: PermissionRequest
  readonly always: boolean
  readonly evaluation: Evaluation
  /** The agent's reason (`--why`): its recommendation to approve. */
  readonly why?: string
}

/** The escalation hook: answers the Decision it opened (or nothing); a throw only loses the Decision. */
export type Escalate = (escalation: Escalation) => Promise<{ readonly decisionID?: string } | void>

export interface ActingDeps {
  readonly registry: ActingRegistry
  readonly directory: Pick<Directory, "resolveOne">
  readonly actions: Actions
  readonly spokes: { request(connID: string, req: ServerRequest): Promise<unknown> }
  readonly grants: Pick<Grants, "usable" | "consume">
  readonly acting: Pick<ActingSwitch, "ensureActing" | "hubNever">
  readonly audit: Pick<AgentAudit, "record">
  /** needs_user escalations (P3-T8); without it needs_user is answered and audited as refused. */
  readonly escalate?: Escalate
  readonly newMessageID?: () => string
  /** Longest prompt a user sends (the console's limit); agents' prompts are at most DELIVER_TEXT_MAX. */
  readonly maxPromptChars?: number
}

/** Who acts, for which user. */
export interface Caller {
  readonly actor: AgentActor
  readonly userID: string
}

export interface ApproveInput {
  readonly requestID: string
  readonly always?: boolean
  readonly why?: string
}

export interface Approved {
  readonly sessionID: string
  readonly requestID: string
  readonly decision: PermissionDecision
  readonly grant?: string
}

export interface DenyInput {
  readonly requestID: string
  /** Why: passed to the harness (prefixed with who denied it) by spokes announcing "permissionMessage". */
  readonly why?: string
}

export interface Denied {
  readonly sessionID: string
  readonly requestID: string
  readonly grant?: string
  /** With a reason: whether the harness got it (older spokes take the reject without it). */
  readonly reasonSent?: boolean
}

export type AnswerInput =
  | { readonly formID: string; readonly answer: FormAnswer; readonly cancel?: undefined; readonly why?: string }
  | { readonly formID: string; readonly cancel: true; readonly answer?: undefined; readonly why?: string }

export interface Answered {
  readonly sessionID: string
  readonly formID: string
  readonly grant?: string
}

export interface StopInput {
  readonly why?: string
}

export interface StoppedSession {
  readonly sessionID: string
  readonly grant?: string
  /** The spoke's answer. */
  readonly result: ResultFor["stop"]
}

export interface PromptInput {
  readonly text: string
  /** Users only. */
  readonly images?: readonly PromptImage[]
  /** How an agent's prompt enters a busy session (the spoke picks when absent). */
  readonly delivery?: DeliveryMode
  /** Agents' prompts always wake the session: false is refused. */
  readonly wake?: boolean
  readonly why?: string
}

/** An agent's prompt, admitted by the spoke under its provenance header. */
export interface AgentPrompted {
  readonly sessionID: string
  readonly messageID: string
  readonly delivered: Delivered
  readonly inboxID?: string
  readonly grant: string
}

/** The user's prompt: steered into the running tree, or a new turn (its reply streams to the console). */
export type UserPrompted = { readonly sessionID: string; readonly mode: "steer"; readonly inboxID: string } | { readonly sessionID: string; readonly mode: "turn" }

/** The console's prompt limit (http.ts MAX_PROMPT_CHARS; Central passes it). */
const DEFAULT_MAX_PROMPT_CHARS = 100_000

/** The addressed session, live in the user's catalog. */
interface Located {
  readonly sessionID: string
  readonly directory: string
  readonly rootID: string
  readonly parentID?: string
}

// ---------- shell normalisation (never rules) ----------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Wrappers that run the rest of the line, and their options that take a value. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"])],
  ["env", new Set(["-u", "-C", "-S"])],
  ["time", new Set(["-f", "-o"])],
  ["command", new Set<string>()],
  ["builtin", new Set<string>()],
  ["exec", new Set(["-a"])],
  ["nohup", new Set<string>()],
])

/**
 * A shell command as a never rule also sees it: whitespace collapsed, leading variable assignments and wrappers
 * (env, command, builtin, exec, nohup, sudo, time, with their options) stripped.
 */
export function normaliseShell(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean)
  for (;;) {
    const word = words[0]
    if (word === undefined) break
    if (ASSIGNMENT.test(word)) {
      words.shift()
      continue
    }
    const valued = WRAPPERS.get(word)
    if (!valued) break
    words.shift()
    while (words[0]?.startsWith("-")) {
      const option = words.shift()!
      if (valued.has(option)) words.shift()
    }
  }
  return words.join(" ")
}

const isShell = (action: string) => action === "shell" || action === "bash"

/** The request as asked and (for shell) normalised, for never matching. */
function neverForms(request: PermissionRequest): PermissionRequest[] {
  if (!isShell(request.action)) return [request]
  const normalised = {
    action: request.action,
    resources: request.resources.map(normaliseShell),
    ...(request.save ? { save: request.save.map(normaliseShell) } : {}),
  }
  return [request, normalised]
}

const patterns = (texts: readonly string[]): Pattern[] => texts.flatMap((t) => parsePattern(t) ?? [])

const invalid = (message: string) => new AgentError("invalid", message)
const forbidden = (message: string) => new AgentError("forbidden", message)
const offline = () => new AgentError("offline", "No spoke reports this session now")

/** Thrown by a policy: the request needs the user. */
class NeedsUser {
  constructor(readonly evaluation: Evaluation) {}
}

export class Acting {
  constructor(private readonly deps: ActingDeps) {}

  /** Approves a pending permission request in the addressed session's tree (once, or always). */
  async approve(caller: Caller, addr: string, input: ApproveInput): Promise<Approved> {
    const target = this.locate(caller.userID, addr)
    const origin = this.pendingPermission(target, input.requestID)
    const always = input.always === true
    const decision: PermissionDecision = always ? "always" : "once"
    return this.act(caller, "approve", target, { requestID: input.requestID }, input.why, {
      selfTree: true,
      choose: (usable) => this.choosePermission(usable, origin.request, always),
      escalation: (evaluation) => ({
        verb: "approve",
        target: target.sessionID,
        sessionID: origin.sessionID,
        rootID: target.rootID,
        requestID: input.requestID,
        ...(origin.request ? { request: origin.request } : {}),
        always,
        evaluation,
        ...(input.why ? { why: input.why } : {}),
      }),
      run: async (grant) => {
        const answered = await this.deps.actions.answerPermission({ rootID: target.rootID, requestID: input.requestID, decision })
        if (answered.outcome === "gone") throw gone()
        return { sessionID: target.sessionID, requestID: input.requestID, decision, ...(grant ? { grant: grant.id } : {}) }
      },
    })
  }

  /** Rejects a pending permission request (any request: a reject is always safe), with an optional reason. */
  async deny(caller: Caller, addr: string, input: DenyInput): Promise<Denied> {
    const target = this.locate(caller.userID, addr)
    this.pendingPermission(target, input.requestID)
    return this.act(caller, "deny", target, { requestID: input.requestID }, input.why, {
      selfTree: true,
      run: async (grant) => {
        const { registry } = this.deps
        const why = input.why === undefined ? "" : sanitizeText(input.why).trim()
        const reasonSent = why !== "" && registry.permissionTargets(target.rootID, input.requestID).every((t) => registry.supports(t.connID, "permissionMessage"))
        const message = reasonSent ? bounded(`Denied by ${partyLabel(this.party(caller))}${grant ? ` (grant ${grant.id})` : ""}: ${why}`, PERMISSION_MESSAGE_MAX) : undefined
        const answered = await this.deps.actions.answerPermission({ rootID: target.rootID, requestID: input.requestID, decision: "reject", ...(message ? { message } : {}) })
        if (answered.outcome === "gone") throw gone()
        return { sessionID: target.sessionID, requestID: input.requestID, ...(grant ? { grant: grant.id } : {}), ...(why ? { reasonSent } : {}) }
      },
    })
  }

  /** Answers (or cancels) a form pending in the addressed session's tree. */
  async answer(caller: Caller, addr: string, input: AnswerInput): Promise<Answered> {
    const target = this.locate(caller.userID, addr)
    if (!this.deps.registry.formTargets(target.rootID, input.formID).length) throw new AgentError("not_found", `No pending form ${input.formID} in this session's tree`)
    return this.act(caller, "answer", target, { formID: input.formID }, input.why, {
      selfTree: true,
      run: async (grant) => {
        const form = input.cancel
          ? { rootID: target.rootID, formID: input.formID, cancel: true as const }
          : { rootID: target.rootID, formID: input.formID, answer: input.answer }
        const answered = await this.deps.actions.answerForm(form)
        if (answered.outcome === "gone") throw gone()
        return { sessionID: target.sessionID, formID: input.formID, ...(grant ? { grant: grant.id } : {}) }
      },
    })
  }

  /** Stops the addressed session's tree. */
  async stop(caller: Caller, addr: string, input: StopInput): Promise<StoppedSession> {
    const target = this.locate(caller.userID, addr)
    return this.act(caller, "stop", target, {}, input.why, {
      run: async (grant) => {
        const stopped = await this.deps.actions.stop(target.sessionID)
        if (stopped.outcome === "offline") throw offline()
        return { sessionID: target.sessionID, ...(grant ? { grant: grant.id } : {}), result: stopped.result }
      },
    })
  }

  /**
   * Prompts the addressed session. An agent's prompt is a deliver of kind "prompt" naming the sender and grant
   * (feature hubPrompt; the spoke renders the provenance header), never a human turn: hop chains are kept.
   * Refused (invalid): subagent sessions, the session itself, wake:false, images. The user's prompt is a human turn.
   */
  async prompt(caller: Caller, addr: string, input: PromptInput): Promise<AgentPrompted | UserPrompted> {
    const { actor, userID } = caller
    const text = input.text.trim()
    const images = input.images?.length ? input.images : undefined
    if (actor.kind === "user") {
      if (images) {
        const problem = promptImagesProblem(images)
        if (problem) throw invalid(problem)
      }
      if (!text && !images) throw invalid("Empty prompt")
      const max = this.deps.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS
      if (text.length > max) throw invalid(`Prompt longer than ${max} characters`)
    } else {
      if (images) throw invalid("An agent's prompt is text only")
      if (input.wake === false) throw invalid("An agent's prompt always wakes the session (send a message for wake: false)")
      if (!text) throw invalid("Empty prompt")
      if (text.length > DELIVER_TEXT_MAX) throw invalid(`Prompt longer than ${DELIVER_TEXT_MAX} characters`)
    }
    const target = this.locate(userID, addr)
    if (actor.kind !== "user") {
      if (target.parentID) throw invalid("Prompts go to root sessions, not subagent sessions")
      if (actor.kind === "session" && actor.sessionID === target.sessionID) throw invalid("A session never prompts itself")
    }
    return this.act(caller, "prompt", target, {}, input.why, {
      run: async (grant) => {
        if (!grant) return this.userPrompt(target.sessionID, text, images)
        return this.agentPrompt(caller, addr, target.sessionID, text, grant, input.delivery)
      },
    })
  }

  private async userPrompt(sessionID: string, text: string, images: readonly PromptImage[] | undefined): Promise<UserPrompted> {
    let started
    try {
      started = await this.deps.actions.prompt({ sessionID, text, ...(images ? { images } : {}), resetHops: true })
    } catch (cause) {
      if (cause instanceof BusyError) throw new AgentError("rate_limited", "Another turn is starting in this session", { hint: "Try again", extra: { retryAfter: 1 } })
      throw cause
    }
    if (started.outcome === "offline") throw offline()
    if (started.mode === "steer") return { sessionID, mode: "steer", inboxID: started.inboxID }
    // Nobody waits for the turn here: its reply streams to the console.
    void started.result.catch(() => {})
    return { sessionID, mode: "turn" }
  }

  private async agentPrompt(caller: Caller, addr: string, sessionID: string, text: string, grant: Grant, delivery: DeliveryMode | undefined): Promise<AgentPrompted> {
    const { registry, spokes } = this.deps
    const connID = registry.owner(sessionID)
    if (!connID) throw offline()
    for (const feature of ["deliver", "hubPrompt"] as const) {
      if (!registry.supports(connID, feature)) throw new AgentError("unsupported", `The session's spoke does not support ${feature}`, { extra: { feature } })
    }
    const messageID = (this.deps.newMessageID ?? newMessageID)()
    const from = this.address(caller)
    let result: unknown
    try {
      result = await spokes.request(connID, {
        op: "deliver",
        sessionID,
        messageID,
        text,
        wake: true,
        meta: { kind: "prompt", from, to: addr, grant: grant.id, ...(delivery ? { delivery } : {}) },
      })
    } catch (cause) {
      if (cause instanceof SpokeError && /disconnected/i.test(cause.message)) throw new AgentError("offline", "The session's spoke disconnected")
      throw cause
    }
    if (!isDeliverResult(result)) throw new Error("The spoke answered a deliver malformed")
    return { sessionID, messageID, delivered: result.delivered, ...(result.inboxID ? { inboxID: result.inboxID } : {}), grant: grant.id }
  }

  // ---------- the check order ----------

  private async act<T>(
    caller: Caller,
    verb: GrantVerb,
    target: Located,
    ids: Omit<AuditTarget, "sessionID">,
    why: string | undefined,
    plan: {
      /** A session never acts in its own tree (permissions and forms). */
      readonly selfTree?: boolean
      /** The grant to act under (default: the newest usable); throws NeedsUser or forbidden. */
      readonly choose?: (usable: Grant[]) => Grant
      readonly escalation?: (evaluation: Evaluation) => Omit<Escalation, "userID" | "actor">
      readonly run: (grant: Grant | undefined) => Promise<T>
    },
  ): Promise<T> {
    const { actor, userID } = caller
    const { acting, grants } = this.deps
    let grant: Grant | undefined
    const record = (decision: AuditDecision, outcome: AuditOutcome, reason?: string) =>
      this.deps.audit.record(userID, {
        actor: this.party(caller),
        verb,
        target: { sessionID: target.sessionID, ...ids },
        ...(grant ? { grant: grant.id } : {}),
        decision,
        ...(reason ? { reason } : {}),
        outcome,
      })
    try {
      if (actor.kind !== "user") {
        acting.ensureActing(userID)
        const usable = await grants.usable(actor, verb, { directory: target.directory })
        if (!usable.length) throw forbidden(`No grant lets this ${actor.kind} ${verb} in this session`)
        if (plan.selfTree && actor.kind === "session" && (this.deps.registry.rootOf(actor.sessionID) ?? actor.sessionID) === target.rootID) {
          throw forbidden("A session never answers requests in its own session tree")
        }
        grant = plan.choose ? plan.choose(usable) : usable[0]!
        await grants.consume(grant)
        acting.ensureActing(userID)
      }
      const result = await plan.run(grant)
      await record("allow", "ok", why)
      return result
    } catch (cause) {
      if (cause instanceof NeedsUser) {
        const escalated = await this.escalate(caller, plan.escalation?.(cause.evaluation))
        const decisionID = escalated?.decisionID
        await record("needs_user", escalated ? "escalated" : "refused", cause.evaluation.reason)
        throw new AgentError("needs_user", `Needs the user: ${cause.evaluation.reason}`, {
          hint: "The user decides in the console",
          extra: { evaluation: cause.evaluation, ...(decisionID !== undefined ? { decisionID } : {}) },
        })
      }
      const [decision, outcome] = auditOf(cause)
      await record(decision, outcome, cause instanceof Error ? cause.message : undefined)
      throw cause
    }
  }

  /** Hands the escalation to the hook: undefined when there is none or it failed. */
  private async escalate(caller: Caller, escalation: Omit<Escalation, "userID" | "actor"> | undefined): Promise<{ decisionID?: string } | undefined> {
    if (!this.deps.escalate || !escalation) return undefined
    try {
      return (await this.deps.escalate({ userID: caller.userID, actor: caller.actor, ...escalation })) ?? {}
    } catch (cause) {
      console.error(`[hub] escalation failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      return undefined
    }
  }

  /** The grant that covers the request, after every never rule; NeedsUser when none does. */
  private choosePermission(usable: Grant[], request: PermissionRequest | undefined, always: boolean): Grant {
    const hubNever = this.deps.acting.hubNever()
    const ids = usable.map((g) => g.id)
    if (!request) throw new NeedsUser({ verdict: "outside", reason: "The request's details are unknown", tier: "tap", grants: ids })
    const rules = usable.map((g) => ({ grant: g, allow: patterns(g.permissions.allow), never: patterns(g.permissions.never) }))
    for (const form of neverForms(request)) {
      for (const { grant, allow, never } of rules) {
        const verdict = evaluatePermission(form, { grant: { allow, never }, hubNever, always, allowAlways: grant.allowAlways })
        if (verdict.verdict === "never") {
          throw forbidden(`never: ${verdict.by === "hub" ? "the hub's" : `grant ${grant.id}'s`} rule ${formatPattern(verdict.pattern)} matches ${verdict.subject}`)
        }
      }
    }
    const allNever = [...hubNever, ...rules.flatMap((r) => r.never)]
    if (request.truncated) throw new NeedsUser({ verdict: "outside", reason: "The request was too large to check in full", tier: "tap", grants: ids })
    let reason: string | undefined
    for (const { grant, allow, never } of rules) {
      const verdict = evaluatePermission(request, { grant: { allow, never }, hubNever, always, allowAlways: grant.allowAlways })
      if (verdict.verdict === "allow") return grant
      if (verdict.verdict === "outside") reason ??= verdict.reason
    }
    throw new NeedsUser({ verdict: "outside", reason: reason ?? "Outside the grant", tier: riskTier(request, allNever), grants: ids })
  }

  // ---------- targets ----------

  /** The addressed session among the user's (not_found otherwise), live now (else offline). */
  private locate(userID: string, addr: string): Located {
    const entry = this.deps.directory.resolveOne(userID, addr)
    const { registry } = this.deps
    if (registry.sessionTenant(entry.sessionID) !== userID) throw offline()
    const live = registry.session(entry.sessionID)
    if (!live) throw offline()
    const parentID = live.parentID ?? entry.parentID
    return { sessionID: entry.sessionID, directory: live.directory, rootID: registry.rootOf(entry.sessionID) ?? entry.sessionID, ...(parentID ? { parentID } : {}) }
  }

  /** A permission request pending in the target's tree; not_found otherwise (unknown, elsewhere, another user's). */
  private pendingPermission(target: Located, requestID: string): { sessionID: string; request?: PermissionRequest } {
    const { registry } = this.deps
    const origin = registry.permissionRequest(requestID)
    if (!origin || (registry.rootOf(origin.sessionID) ?? origin.sessionID) !== target.rootID || !registry.permissionTargets(target.rootID, requestID).length) {
      throw new AgentError("not_found", `No pending request ${requestID} in this session's tree`)
    }
    return origin
  }

  /** The caller's address as a deliver's meta.from: `@name` or the session ID, `app:<token id>`. */
  private address(caller: Caller): string {
    const party = this.party(caller)
    switch (party.kind) {
      case "session":
        return party.name ? `@${party.name}` : party.sessionID
      case "app":
        return `app:${party.tokenID}`
      case "user":
        return "@me"
    }
  }

  /** The caller as the audit and envelopes name it (a session by its directory name). */
  private party(caller: Caller): Party {
    const { actor } = caller
    if (actor.kind !== "session") return partyFromActor(actor)
    let name: string | undefined
    try {
      name = this.deps.directory.resolveOne(caller.userID, actor.sessionID).name
    } catch {}
    return partyFromActor(actor, name ? { name } : {})
  }
}

/** At most `max` UTF-16 units, cut on a character boundary. */
function bounded(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ""
  for (const char of text) {
    if (out.length + char.length > max) break
    out += char
  }
  return out
}

const gone = () => new AgentError("gone", "Already answered, expired or ended")

/** An error's audit decision and outcome (shared with the launch routes). */
export function auditOf(cause: unknown): [AuditDecision, AuditOutcome] {
  if (!(cause instanceof AgentError)) return ["allow", "failed"]
  switch (cause.code) {
    case "paused":
      return ["paused", "refused"]
    case "forbidden":
    case "invalid":
    case "not_found":
      return ["forbidden", "refused"]
    case "rate_limited":
      return ["rate_limited", "refused"]
    case "needs_user":
      return ["needs_user", "refused"]
    case "gone":
      return ["allow", "gone"]
    case "offline":
      return ["allow", "offline"]
    case "unsupported":
      return ["allow", "unsupported"]
    default:
      return ["allow", "failed"]
  }
}
