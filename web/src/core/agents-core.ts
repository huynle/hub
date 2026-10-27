// Settings → Agents (design §5, §7; P3-T12): pure state and labels for the user's grants (GET/POST/PUT/DELETE
// /api/agent/grants), the create/edit form and the hub's validation errors, the acting switches, the agent audit
// (GET /api/agent/audit, SSE 'agent' {entry}), "Answered by" notes, escalation Decisions and blocker recommendations.
import { askerLabel, countdown, type DecisionView } from "./decision-core"
import { partyAddress } from "./timeline-core"

// ---------- grants ----------

/** What a grant may let its holder do (src/central/agent/policy.ts GRANT_VERBS). */
export const GRANT_VERBS = ["approve", "deny", "answer", "prompt", "stop", "roles", "launch"] as const
export type GrantVerb = (typeof GRANT_VERBS)[number]
export type GrantState = "active" | "expired" | "revoked"

/** A grant as GET /api/agent/grants shows it (src/central/agent/grant-routes.ts grantView). */
export interface GrantView {
  readonly id: string
  /** As the user wrote it: `@@role`, `@name`, `ses_…` or `app:<token id>`. */
  readonly holder: string
  /** The session a `ses_…` or `@name` holder was pinned to at creation. */
  readonly holderSessionID?: string
  readonly scope: { readonly projects: readonly string[] }
  readonly allow: readonly string[]
  readonly permissions: { readonly allow: readonly string[]; readonly never: readonly string[] }
  readonly allowAlways: boolean
  readonly maxActionsPerHour: number
  readonly created: number
  readonly expiresAt: number
  readonly updated?: number
  readonly revokedAt?: number
  readonly state: GrantState
}

const STATES = new Set<string>(["active", "expired", "revoked"])
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string")

// ---------- app tokens ----------

export const APP_TOKEN_SCOPES = ["sessions:read", "sessions:manage", "messages:send", "messages:read", "sessions:act", "sessions:launch"] as const

export interface AppTokenView {
  readonly id: string
  readonly label?: string
  readonly scopes: readonly string[]
  readonly created?: number
}

export function parseAppToken(raw: unknown): AppTokenView | undefined {
  if (!isObject(raw) || typeof raw.id !== "string" || !/^[0-9a-f]{16}$/.test(raw.id) || !strings(raw.scopes)) return undefined
  return {
    id: raw.id,
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    scopes: raw.scopes.filter((scope) => APP_TOKEN_SCOPES.includes(scope as (typeof APP_TOKEN_SCOPES)[number])),
    ...(typeof raw.created === "number" ? { created: raw.created } : {}),
  }
}

export function parseAppTokens(raw: unknown): AppTokenView[] {
  const list = isObject(raw) && Array.isArray(raw.tokens) ? raw.tokens : []
  return list.map(parseAppToken).filter((token): token is AppTokenView => !!token)
}

export function appTokenBody(label: string, scopes: readonly string[]): { ok: true; body: { label: string; scopes: string[] } } | { ok: false; error: string } {
  const clean = label.trim()
  if (!clean) return { ok: false, error: "Give the token a label" }
  if (!scopes.length) return { ok: false, error: "Pick at least one scope" }
  const unknown = scopes.find((scope) => !APP_TOKEN_SCOPES.includes(scope as (typeof APP_TOKEN_SCOPES)[number]))
  if (unknown) return { ok: false, error: `Unknown scope: ${unknown}` }
  return { ok: true, body: { label: clean, scopes: [...new Set(scopes)] } }
}

/** A grant from the hub; undefined when it is not one. */
export function parseGrant(raw: unknown): GrantView | undefined {
  if (!isObject(raw)) return undefined
  const { id, holder, scope, allow, permissions, allowAlways, maxActionsPerHour, created, expiresAt, state } = raw
  if (typeof id !== "string" || typeof holder !== "string" || typeof state !== "string" || !STATES.has(state)) return undefined
  if (!isObject(scope) || !strings(scope.projects) || !strings(allow) || !isObject(permissions) || !strings(permissions.allow) || !strings(permissions.never)) return undefined
  if (typeof allowAlways !== "boolean" || typeof maxActionsPerHour !== "number" || typeof created !== "number" || typeof expiresAt !== "number") return undefined
  return raw as unknown as GrantView
}

/** The grants of GET /api/agent/grants ({grants}); malformed ones are dropped. */
export function parseGrants(raw: unknown): GrantView[] {
  const list = isObject(raw) && Array.isArray(raw.grants) ? raw.grants : []
  return list.map(parseGrant).filter((g): g is GrantView => !!g)
}

/** A grant's state now: the hub's at load, or expired once its countdown ran out since. */
export function grantStateAt(g: GrantView, now: number): GrantState {
  if (g.state === "revoked" || g.revokedAt !== undefined) return "revoked"
  return g.state === "expired" || now >= g.expiresAt ? "expired" : "active"
}

const STATE_LABEL: Record<GrantState, string> = { active: "Active", expired: "Expired", revoked: "Revoked" }

export interface GrantRow {
  readonly id: string
  readonly holder: string
  readonly state: GrantState
  readonly stateLabel: string
  readonly projects: string
  readonly verbs: string
  /** Permission patterns it allows ("" when none). */
  readonly permit: string
  /** Patterns it never allows ("" when none). */
  readonly never: string
  readonly limits: string
  readonly expiry: string
  /** Only active grants can be edited or revoked. */
  readonly editable: boolean
}

/** One line of the grants list. */
export function grantRow(g: GrantView, now: number): GrantRow {
  const state = grantStateAt(g, now)
  return {
    id: g.id,
    holder: g.holderSessionID ? `${g.holder} (${g.holderSessionID})` : g.holder,
    state,
    stateLabel: STATE_LABEL[state],
    projects: g.scope.projects.join(", "),
    verbs: g.allow.join(", "),
    permit: g.permissions.allow.join(", "),
    never: g.permissions.never.join(", "),
    limits: [g.allowAlways ? "may allow always" : "", `${g.maxActionsPerHour} actions an hour`].filter(Boolean).join(" · "),
    expiry: state === "active" ? `Expires in ${countdown(g.expiresAt, now)}` : STATE_LABEL[state],
    editable: state === "active",
  }
}

// ---------- the grant form ----------

/** The form's fields as typed (one project and one pattern per line). */
export interface GrantDraft {
  readonly holder: string
  readonly projects: string
  readonly allow: readonly string[]
  readonly permit: string
  readonly never: string
  readonly expires: string
  readonly maxActionsPerHour: string
  readonly allowAlways: boolean
}

export type GrantField = "holder" | "projects" | "allow" | "permit" | "never" | "expires" | "maxActionsPerHour" | "allowAlways"

/** The hub's defaults (8 hours, 60 actions an hour); an existing grant's fields (an edit restarts its expiry). */
export function draftOf(g?: GrantView): GrantDraft {
  return {
    holder: g?.holder ?? "",
    projects: g ? g.scope.projects.join("\n") : "",
    allow: g ? [...g.allow] : [],
    permit: g ? g.permissions.allow.join("\n") : "",
    never: g ? g.permissions.never.join("\n") : "",
    expires: "8h",
    maxActionsPerHour: String(g?.maxActionsPerHour ?? 60),
    allowAlways: g?.allowAlways ?? false,
  }
}

export interface GrantBody {
  readonly holder: string
  readonly scope: { readonly projects: string[] }
  readonly allow: string[]
  readonly permissions: { readonly allow: string[]; readonly never: string[] }
  readonly expires: string
  readonly maxActionsPerHour: number
  readonly allowAlways: boolean
}

export type GrantBodyResult = { readonly ok: true; readonly body: GrantBody } | { readonly ok: false; readonly errors: Partial<Record<GrantField, string>> }

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
const DURATION = /^\d+(s|m|h|d)?$/
const absolute = (p: string) => /^([A-Za-z]:)?[\\/]/.test(p)

/** The POST/PUT body of a draft, or what is wrong with each field (the hub checks it again). */
export function grantBody(draft: GrantDraft): GrantBodyResult {
  const errors: Partial<Record<GrantField, string>> = {}
  const holder = draft.holder.trim()
  if (!holder) errors.holder = "Who holds it: @@orchestrator, @name, ses_… or app:<token id>"
  const projects = lines(draft.projects)
  const relative = projects.find((p) => !absolute(p))
  if (!projects.length) errors.projects = "At least one project directory"
  else if (relative !== undefined) errors.projects = `${relative} is not an absolute directory`
  const allow = GRANT_VERBS.filter((v) => draft.allow.includes(v))
  if (!allow.length) errors.allow = "Pick at least one action"
  const expires = draft.expires.trim()
  if (!DURATION.test(expires)) errors.expires = "A duration: seconds, or 30m, 8h, 2d"
  const cap = draft.maxActionsPerHour.trim()
  const max = /^\d+$/.test(cap) ? Number(cap) : NaN
  if (!(max >= 1 && max <= 1000)) errors.maxActionsPerHour = "A whole number from 1 to 1000"
  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    body: {
      holder,
      scope: { projects },
      allow,
      permissions: { allow: lines(draft.permit), never: lines(draft.never) },
      expires,
      maxActionsPerHour: max,
      allowAlways: draft.allowAlways,
    },
  }
}

/** The form field a hub validation message (400 invalid, 404 for a holder) is about; undefined for the form as a whole. */
export function hubErrorField(message: string): GrantField | undefined {
  if (/^permissions\.never/.test(message)) return "never"
  if (/^permissions/.test(message)) return "permit"
  if (/^scope/.test(message)) return "projects"
  if (/^allow\b/.test(message)) return "allow"
  if (/^expires/.test(message)) return "expires"
  if (/^maxActionsPerHour/.test(message)) return "maxActionsPerHour"
  if (/^allowAlways/.test(message)) return "allowAlways"
  if (/holder|^No app token|^No session|^No such session/i.test(message)) return "holder"
  return undefined
}


// ---------- the agent audit ----------

export type AuditDecision = "allow" | "needs_user" | "forbidden" | "paused" | "rate_limited"
export type AuditOutcome = "ok" | "failed" | "gone" | "offline" | "unsupported" | "escalated" | "refused"

/** One entry of GET /api/agent/audit or an SSE 'agent' event (src/central/agent/audit.ts AgentAuditEntry). */
export interface AuditEntryView {
  readonly seq: number
  readonly at: number
  /** Who acted: a session, an app or the user (DecisionParty's shape). */
  readonly actor: { readonly kind: "session"; readonly sessionID: string; readonly name?: string } | { readonly kind: "user" } | { readonly kind: "app"; readonly tokenID: string; readonly label?: string }
  readonly verb: string
  readonly target: { readonly sessionID?: string; readonly requestID?: string; readonly formID?: string }
  readonly grant?: string
  readonly decision: string
  readonly reason?: string
  readonly outcome: string
}

/** An audit entry from the hub; undefined when it is not one. */
export function parseAuditEntry(raw: unknown): AuditEntryView | undefined {
  if (!isObject(raw)) return undefined
  const { seq, at, actor, verb, target, decision, outcome } = raw
  if (typeof seq !== "number" || typeof at !== "number" || !isObject(actor) || typeof actor.kind !== "string" || typeof verb !== "string") return undefined
  if (!isObject(target) || typeof decision !== "string" || typeof outcome !== "string") return undefined
  return raw as unknown as AuditEntryView
}

/** A page of GET /api/agent/audit ({entries, next?}: newest first; `next` is the `before` of the older page). */
export function parseAuditPage(raw: unknown): { entries: AuditEntryView[]; next?: number } {
  if (!isObject(raw)) return { entries: [] }
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).map(parseAuditEntry).filter((e): e is AuditEntryView => !!e)
  return typeof raw.next === "number" ? { entries, next: raw.next } : { entries }
}

const DECISION_LABEL: Record<string, string> = { allow: "allowed", needs_user: "needs you", forbidden: "refused", paused: "paused", rate_limited: "rate limited" }
const OUTCOME_LABEL: Record<string, string> = { ok: "done", failed: "failed", gone: "already answered", offline: "offline", unsupported: "unsupported", escalated: "sent to you", refused: "refused" }
const BAD_DECISIONS = new Set(["forbidden", "paused", "rate_limited"])
const BAD_OUTCOMES = new Set(["failed", "refused", "offline", "unsupported"])
const SWITCH_VERBS: Record<string, string> = { "acting.pause": "turned agent actions off", "acting.resume": "turned agent actions on" }

/** Who acted, as the console names it ("you" for the user). */
const actorLabel = (actor: AuditEntryView["actor"]) => (actor.kind === "user" ? "you" : partyAddress(actor))

export interface AuditLine {
  readonly seq: number
  readonly at: number
  readonly who: string
  readonly what: string
  readonly result: string
  readonly tone: "ok" | "warn" | "err"
  readonly grant: string
  readonly reason: string
}

/** One line of Settings → Agents → Activity. */
export function auditLine(e: AuditEntryView): AuditLine {
  const id = e.target.requestID ?? e.target.formID
  const where = e.target.sessionID ?? ""
  const what = SWITCH_VERBS[e.verb] ?? [e.verb, id, id && where ? `in ${where}` : where].filter(Boolean).join(" ")
  const decision = DECISION_LABEL[e.decision] ?? e.decision
  const outcome = OUTCOME_LABEL[e.outcome] ?? e.outcome
  const done = e.decision === "allow" && e.outcome === "ok"
  return {
    seq: e.seq,
    at: e.at,
    who: actorLabel(e.actor),
    what,
    result: done ? "done" : decision === outcome ? decision : `${decision} · ${outcome}`,
    tone: done ? "ok" : BAD_DECISIONS.has(e.decision) || BAD_OUTCOMES.has(e.outcome) ? "err" : "warn",
    grant: e.grant ? `grant ${e.grant}` : "",
    reason: e.reason ?? "",
  }
}

// ---------- "Answered by" (live 'agent' events) ----------

const ANSWER_VERBS: Record<string, string> = { approve: "Approved", deny: "Denied", answer: "Answered" }
/** Live entries kept for notes. */
export const AGENT_ENTRIES_KEPT = 100
/** How long a session shows who answered its requests. */
export const AGENT_NOTE_MS = 10 * 60_000
const AGENT_NOTES_MAX = 3

/** "Approved by @orchestrator · grant g_…" for an entry that answered a permission or form; undefined otherwise. */
export function answeredNote(e: AuditEntryView): string | undefined {
  const done = ANSWER_VERBS[e.verb]
  if (!done || e.decision !== "allow" || e.outcome !== "ok") return undefined
  return `${done} by ${actorLabel(e.actor)}${e.grant ? ` · grant ${e.grant}` : ""}`
}

/** The live entries after an SSE 'agent' event: newest first, once each, at most AGENT_ENTRIES_KEPT. */
export function applyAgentEntry(list: readonly AuditEntryView[], e: AuditEntryView): AuditEntryView[] {
  return [e, ...list.filter((x) => x.seq !== e.seq)].sort((a, b) => b.seq - a.seq).slice(0, AGENT_ENTRIES_KEPT)
}

/** Who answered this permission request or form (the newest entry that did). */
export function noteForBlocker(list: readonly AuditEntryView[], blockerID: string): string | undefined {
  for (const e of list) {
    if (e.target.requestID !== blockerID && e.target.formID !== blockerID) continue
    const note = answeredNote(e)
    if (note) return note
  }
  return undefined
}

/** The recent answers in a session's tree (its root and subagents), newest first, one per request. */
export function agentNotes(list: readonly AuditEntryView[], sessionIDs: ReadonlySet<string>, now: number): Array<{ key: string; text: string; at: number }> {
  const out: Array<{ key: string; text: string; at: number }> = []
  for (const e of [...list].sort((a, b) => b.at - a.at || b.seq - a.seq)) {
    if (out.length >= AGENT_NOTES_MAX) break
    if (!e.target.sessionID || !sessionIDs.has(e.target.sessionID) || now - e.at > AGENT_NOTE_MS) continue
    const text = answeredNote(e)
    const key = e.target.requestID ?? e.target.formID ?? `seq-${e.seq}`
    if (text && !out.some((n) => n.key === key)) out.push({ key, text, at: e.at })
  }
  return out
}

// ---------- acting switches ----------

/** GET /api/agent/acting {enabled, hubEnabled}: the user's switch, the admin's, and what they mean now. */
export function actingView(raw: { enabled?: unknown; hubEnabled?: unknown }): { on: boolean; hubOn: boolean; note: string } {
  const on = raw.enabled !== false
  const hubOn = raw.hubEnabled !== false
  const note = !hubOn
    ? "An admin turned agent actions off for the whole hub: no agent can approve, deny, answer, prompt, stop or launch until it is on again."
    : !on
      ? "Agents cannot act for you (approve, deny, answer, prompt, stop, launch). Reading and messaging still work."
      : ""
  return { on, hubOn, note }
}

// ---------- escalations and recommendations ----------

export interface EscalationDetails {
  /** Who asked to act (the Decision's asker). */
  readonly requester: string
  /** The permission's action (shell, edit, …) when the hub knew it. */
  readonly action?: string
  readonly resources: readonly string[]
  readonly always: boolean
  /** Why it is outside the grant. */
  readonly reason?: string
  readonly requestID?: string
}

const ESCALATION_QUESTION = /^(.*?) asks to approve( always(?: \(saves .*?\))?)? (.*?)\. Outside its grant: (.*)$/s
const UNKNOWN_REQUEST = "a permission request (details unknown)"

/** What an escalation Decision (one the hub opened for an agent's approval outside its grant) asks about. */
export function escalationOf(d: DecisionView): EscalationDetails | undefined {
  if (d.action?.kind !== "permission") return undefined
  const base = { requester: askerLabel(d), always: d.action.always === true, ...(d.action.requestID ? { requestID: d.action.requestID } : {}) }
  const match = ESCALATION_QUESTION.exec(d.question)
  if (!match) return { ...base, action: undefined, resources: [], reason: undefined }
  const what = match[3]!
  const colon = what.indexOf(": ")
  const known = what !== UNKNOWN_REQUEST
  return {
    ...base,
    always: base.always || !!match[2],
    action: known ? (colon < 0 ? what : what.slice(0, colon)) : undefined,
    resources: known && colon >= 0 ? what.slice(colon + 2).split(", ").filter(Boolean) : [],
    reason: match[4]!.trim() || undefined,
  }
}

/** "@orchestrator recommends Approve: only runs tests" for a permission blocker's recommendation; "" without one. */
export function recommendationText(raw: unknown): string {
  if (!isObject(raw) || typeof raw.by !== "string" || raw.recommends !== "approve") return ""
  return `${raw.by} recommends Approve${typeof raw.why === "string" && raw.why ? `: ${raw.why}` : ""}`
}
