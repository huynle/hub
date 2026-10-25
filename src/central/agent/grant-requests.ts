// Grant requests (design §5, §7; P3-T9): an agent asks the user for a grant. Grants are created only by users
// (grant-routes.ts); a session (any token) or an app token (scope messages:send) may only request one, and the
// user's tap in the console creates it.
//
// - The body is {grant, why}: the grant as POST /api/agent/grants takes it, validated the same way (validateGrant)
//   when requested and again, as the user's, when approved (Grants.create). The holder defaults to the requester
//   (`ses_…`, `app:<token id>`); it may name only the requester itself (`ses_…`, its `@name`: stored as the session
//   id, so a name moving on never moves the grant) or a reserved `@@role` the requesting session holds now.
//   Another session or app is forbidden; a session that is not the user's is not_found.
// - It opens a Decision to @me (tap tier, high urgency; options approve / deny, deny safe) whose question
//   summarises holder, projects, verbs, permissions allow/never, always, the hourly cap, expiry and the why
//   (sanitised); its action (kind "grant", the canonical grant body) is the hub's, never the asker's.
// - Approve: the grant is created AS THE USER (owner the user); the requester's reply carries the grant id. The
//   holder gone by then (not_found) closes the Decision instead. Deny: nothing is created; the reply says so.
//   No editing on approval (yet): the user may create an edited grant directly and deny the request.
// - Limits: one open request per requester (another is rate_limited with the open Decision's id; a version-checked
//   reservation settles races) and GRANT_REQUESTS_PER_HOUR per requester an hour (Counters). Asks to @me also
//   count against the message limits.
// - Audit: the request (grant.request, needs_user, escalated) and its outcome (grant.approve ok / grant.deny
//   refused, as the user).
import type { Counters, StateStore } from "../backend/types"
import type { AgentActor, AppActor, SessionActor, UserActor } from "./actor"
import type { AgentAudit } from "./audit"
import { type ActOutcome, type Decision, type Decisions, WHY_MAX } from "./decisions"
import type { Directory } from "./directory"
import { type Party, partyFromActor, partyKey, partyLabel, sanitizeLabel } from "./envelope"
import { AgentError } from "./errors"
import type { Grants } from "./grants"
import type { Message } from "./messages"
import { parseAddress } from "./names"
import { type GrantSpec, validateGrant } from "./policy"

/** Grant requests each requester opens an hour. */
export const GRANT_REQUESTS_PER_HOUR = 5
/** Characters of the question (lists are cut to fit). */
const QUESTION_MAX = 4_000
/** A reservation older than this (its opener crashed) no longer blocks a new request. */
const RESERVATION_MS = 60_000
const HOUR_MS = 3_600_000
const COLLECTION = "grant-requests"
const BODY_FIELDS = ["grant", "why"]

/** requester → its latest request's Decision (without decisionID while it is being opened). */
interface RequestRecord {
  readonly at: number
  readonly decisionID?: string
}

export interface GrantRequestsDeps {
  readonly state: StateStore
  readonly counters: Counters
  readonly decisions: Pick<Decisions, "ask" | "get">
  readonly grants: Pick<Grants, "create">
  readonly directory: Pick<Directory, "resolve">
  readonly audit?: Pick<AgentAudit, "record">
  /** The requester as envelopes name it; default: from the actor alone. */
  readonly describe?: (userID: string, actor: AgentActor) => Party
  /** The Decision's ask was stored (the console's message feed). */
  readonly published?: (userID: string, message: Message) => void
  readonly now?: () => number
}

const invalid = (message: string) => new AgentError("invalid", message)
const forbidden = (message: string) => new AgentError("forbidden", message, { hint: "Request a grant held by yourself (the default), or by a reserved role you hold" })
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export class GrantRequests {
  private readonly now: () => number

  constructor(private readonly deps: GrantRequestsDeps) {
    this.now = deps.now ?? Date.now
    this.act = this.act.bind(this)
  }

  /** Opens the Decision for the agent's request. Throws invalid, forbidden, not_found or rate_limited. */
  async request(userID: string, actor: AgentActor, body: unknown): Promise<{ decision: Decision; message: Message }> {
    if (actor.kind === "user") throw invalid("You are the user: create the grant directly (POST /api/agent/grants)")
    if (!isObject(body)) throw invalid("A grant request is {grant, why}")
    for (const key of Object.keys(body)) if (!BODY_FIELDS.includes(key)) throw invalid(`Unknown grant request field ${key}`)
    if (!isObject(body.grant)) throw invalid("grant is the grant to request (as POST /api/agent/grants takes it)")
    const why = typeof body.why === "string" && body.why.length <= WHY_MAX * 4 ? sanitizeLabel(body.why, WHY_MAX) : ""
    if (!why) throw invalid(`why is the reason the user reads (1–${WHY_MAX} characters)`)
    const own = ownHolder(actor)
    const spec = validateGrant({ ...body.grant, holder: body.grant.holder ?? own })
    const holder = this.holder(userID, actor, spec.holder, own)
    const grant = canonical({ ...spec, holder })

    const requester = this.describe(userID, actor)
    const key = partyKey(requester)
    const { state, counters, decisions } = this.deps
    const existing = await state.get<RequestRecord>(userID, COLLECTION, key)
    if (existing?.value.decisionID) {
      const open = await decisions.get(userID, existing.value.decisionID)
      if (open?.state === "open") {
        throw new AgentError("rate_limited", `Your grant request ${open.id} still waits for the user`, { extra: { retryAfter: 60, decisionID: open.id } })
      }
    } else if (existing && this.now() - existing.value.at < RESERVATION_MS) {
      throw new AgentError("rate_limited", "Your grant request is being opened", { extra: { retryAfter: 1 } })
    }
    const at = this.now()
    const count = await counters.incr(`grant-requests:${userID}:${key}`, HOUR_MS)
    if (count > GRANT_REQUESTS_PER_HOUR) {
      throw new AgentError("rate_limited", `At most ${GRANT_REQUESTS_PER_HOUR} grant requests an hour`, { extra: { retryAfter: HOUR_MS / 1000 } })
    }
    const reserved = await state.put(userID, COLLECTION, key, { at } satisfies RequestRecord, { ifVersion: existing?.version ?? 0 })
    if (!reserved.ok) throw new AgentError("rate_limited", "Your grant request is being opened", { extra: { retryAfter: 1 } })
    let opened: { decision: Decision; message: Message }
    try {
      opened = await decisions.ask(
        userID,
        actor,
        {
          question: question(partyLabel(requester), spec, holder, why),
          options: [
            { id: "approve", label: "Approve grant" },
            { id: "deny", label: "Deny", safe: true },
          ],
          urgency: "high",
          tier: "tap",
        },
        { action: { kind: "grant", requester: key, grant } },
      )
    } catch (cause) {
      await state.delete(userID, COLLECTION, key, { ifVersion: reserved.version })
      throw cause
    }
    await state.put(userID, COLLECTION, key, { at, decisionID: opened.decision.id } satisfies RequestRecord, { ifVersion: reserved.version })
    this.deps.published?.(userID, opened.message)
    await this.deps.audit?.record(userID, { actor: requester, verb: "grant.request", target: target(actor), decision: "needs_user", reason: why, outcome: "escalated" })
    return opened
  }

  /** Decisions' action runner: approve creates the grant as the answering user; deny creates nothing. */
  async act(userID: string, decision: Decision, choice: { readonly option?: string }, by: UserActor): Promise<ActOutcome> {
    const action = decision.action
    if (!action || action.kind !== "grant" || by.userID !== userID) return "gone"
    const about = decision.from.kind === "session" ? { sessionID: decision.from.sessionID } : {}
    const reason = `Decision ${decision.id}`
    if (choice.option !== "approve") {
      await this.deps.audit?.record(userID, { actor: { kind: "user" }, verb: "grant.deny", target: about, decision: "allow", reason, outcome: "refused" })
      return "done"
    }
    let created
    try {
      created = await this.deps.grants.create(userID, action.grant)
    } catch (cause) {
      if (!(cause instanceof AgentError) || cause.code !== "not_found") throw cause
      await this.deps.audit?.record(userID, { actor: { kind: "user" }, verb: "grant.approve", target: about, decision: "allow", reason, outcome: "gone" })
      return { outcome: "gone", reason: "The requested holder is gone" }
    }
    await this.deps.audit?.record(userID, { actor: { kind: "user" }, verb: "grant.approve", target: about, grant: created.id, decision: "allow", reason, outcome: "ok" })
    return { outcome: "done", note: `Grant ${created.id} created (holder ${created.holder}, until ${new Date(created.expiresAt).toISOString()})` }
  }

  // ---- internals ----------------------------------------------------------------------------------------

  private describe(userID: string, actor: AgentActor): Party {
    return this.deps.describe?.(userID, actor) ?? partyFromActor(actor)
  }

  /** The holder the request may name (see the header), as stored. */
  private holder(userID: string, actor: SessionActor | AppActor, holder: string, own: string): string {
    if (holder === own) return own
    if (holder.startsWith("app:") || actor.kind === "app") throw forbidden("A grant request may name only the requester as its holder")
    const holds = (sessions: readonly { readonly sessionID: string }[]) => sessions.some((s) => s.sessionID === actor.sessionID)
    if (parseAddress(holder)?.kind === "role") {
      let held = false
      try {
        held = holds(this.deps.directory.resolve(userID, holder).sessions)
      } catch {
        held = false
      }
      if (!held) throw forbidden(`You do not hold ${holder}`)
      return holder
    }
    // A session or name that is not the user's is not_found (the resolver's tenancy).
    const { sessions } = this.deps.directory.resolve(userID, holder)
    if (sessions.length !== 1 || !holds(sessions)) throw forbidden("A grant request may name only the requester as its holder")
    return actor.sessionID
  }
}

/** The holder a request defaults to: the session's id, or `app:<token id>`. */
const ownHolder = (actor: SessionActor | AppActor): string => (actor.kind === "session" ? actor.sessionID : `app:${actor.tokenID}`)

const target = (actor: SessionActor | AppActor) => (actor.kind === "session" ? { sessionID: actor.sessionID } : {})

/** The spec as the body Grants.create takes (expires in seconds). */
const canonical = (spec: GrantSpec): Record<string, unknown> => ({
  holder: spec.holder,
  scope: { projects: [...spec.scope.projects] },
  allow: [...spec.allow],
  permissions: { allow: [...spec.permissions.allow], never: [...spec.permissions.never] },
  allowAlways: spec.allowAlways,
  maxActionsPerHour: spec.maxActionsPerHour,
  expires: Math.round(spec.expiresInMs / 1000),
})

/** `90m`, `8h`, `2d`; seconds otherwise. */
function duration(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) if (ms % size === 0) return `${ms / size}${unit}`
  return `${Math.round(ms / 1000)}s`
}

/** "@orchestrator requests a grant: holder ses_o; projects /p; verbs approve, deny; …. Why: …" (bounded). */
function question(by: string, spec: GrantSpec, holder: string, why: string): string {
  const list = (values: readonly string[]) => (values.length ? values.join(", ") : "none")
  const text = [
    `${by} requests a grant: holder ${holder}`,
    `projects ${list(spec.scope.projects)}`,
    `verbs ${list(spec.allow)}`,
    `permissions allow ${list(spec.permissions.allow)}`,
    `never ${list(spec.permissions.never)}`,
    `always ${spec.allowAlways ? "yes" : "no"}`,
    `up to ${spec.maxActionsPerHour} actions an hour`,
    `expires ${duration(spec.expiresInMs)} after approval`,
  ].join("; ")
  const tail = `. Why: ${why}`
  const head = text.length + tail.length > QUESTION_MAX ? `${text.slice(0, Math.max(0, QUESTION_MAX - tail.length - 1))}…` : text
  return `${head}${tail}`
}
