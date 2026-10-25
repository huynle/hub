// The agent audit (design §5, §7, §11.4): every agent action, {seq, at, actor, verb, target, grant?, decision,
// reason?, outcome}, in a per-user ring (AGENT_AUDIT_LIMIT, oldest dropped first) in the StateStore. The acting
// code (approve, deny, answer, prompt, stop, launch, roles) records each attempt, allowed or not.
//
// - One key per entry (collection "agent-audit", keyed by the zero-padded sequence) and a per-user counter
//   ("agent-audit-seq"), so an append is a few small writes in every backend.
// - Text is sanitised: the reason (bounded), target ids and the grant id (dropped unless short and plain). The verb
//   is the caller's constant; a malformed one is a bug and throws.
// - Each new entry goes to `recorded` (the hub sends the owner an SSE 'agent' event); a throwing listener never
//   fails the record.
// - Admins see only a hub-wide summary in the Store's audit (who: the user ID; kind: agent.<verb> and the actor
//   kind; when), never targets, reasons or text (design §7).
import type { Clock, StateStore } from "../backend/types"
import type { AuditEntry } from "../store"
import { type Party, sanitizeText } from "./envelope"
import { updateVersioned } from "./versioned"

/** Entries each user keeps (the oldest are dropped first). */
export const AGENT_AUDIT_LIMIT = 2000
/** Characters of an entry's reason. */
export const AUDIT_REASON_MAX = 500
/** Entries a list returns by default, and at most. */
export const AUDIT_PAGE_DEFAULT = 100
export const AUDIT_PAGE_MAX = 500

/** The policy's decision: allowed, or why not. */
export type AuditDecision = "allow" | "needs_user" | "forbidden" | "paused" | "rate_limited"
/** What happened: done, failed, raced (gone), the spoke could not (offline, unsupported), escalated or refused. */
export type AuditOutcome = "ok" | "failed" | "gone" | "offline" | "unsupported" | "escalated" | "refused"

/** What the action was on: the session, and the permission request or form. */
export interface AuditTarget {
  readonly sessionID?: string
  readonly requestID?: string
  readonly formID?: string
}

export interface AuditInput {
  /** Who acted (from the authenticated actor). */
  readonly actor: Party
  /** approve, deny, answer, prompt, stop, launch, roles, grant.request, … */
  readonly verb: string
  readonly target: AuditTarget
  /** The grant it acted under. */
  readonly grant?: string
  readonly decision: AuditDecision
  /** The agent's reason (`--why`) or the policy's. */
  readonly reason?: string
  readonly outcome: AuditOutcome
}

export interface AgentAuditEntry extends AuditInput {
  /** Per user, from 1; newer entries have higher numbers (the list cursor). */
  readonly seq: number
  readonly at: number
}

export interface AuditPage {
  /** Newest first. */
  readonly entries: AgentAuditEntry[]
  /** `before` for the next (older) page; absent on the last one. */
  readonly next?: number
}

export interface AuditListOptions {
  readonly limit?: number
  /** Only entries older than this seq. */
  readonly before?: number
}

export interface AgentAuditDeps {
  readonly state: StateStore
  readonly now?: Clock
  /** The hub-wide admin audit (Store): gets the summary of every entry. */
  readonly admin?: { audit(entry: Omit<AuditEntry, "at">): void }
  /** A new entry, for its owner (the hub's SSE 'agent' event). */
  readonly recorded?: (userID: string, entry: AgentAuditEntry) => void
  /** Ring size (default AGENT_AUDIT_LIMIT). */
  readonly limit?: number
}

const ENTRIES = "agent-audit"
const SEQ = "agent-audit-seq"
const SEQ_KEY = "seq"
const VERB = /^[a-z][a-z0-9._-]{0,31}$/
const ID = /^[A-Za-z0-9_.:@-]{1,200}$/

const keyOf = (seq: number) => String(seq).padStart(12, "0")
const cleanID = (value: string | undefined) => (value !== undefined && ID.test(value) ? value : undefined)

function cleanReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const clean = Array.from(sanitizeText(reason).trim()).slice(0, AUDIT_REASON_MAX).join("").trimEnd()
  return clean || undefined
}

function cleanTarget(target: AuditTarget): AuditTarget {
  const out: { sessionID?: string; requestID?: string; formID?: string } = {}
  for (const key of ["sessionID", "requestID", "formID"] as const) {
    const id = cleanID(target[key])
    if (id) out[key] = id
  }
  return out
}

export class AgentAudit {
  private readonly now: Clock
  private readonly limit: number

  constructor(private readonly deps: AgentAuditDeps) {
    this.now = deps.now ?? Date.now
    this.limit = deps.limit ?? AGENT_AUDIT_LIMIT
  }

  /** Appends an entry to the user's log (dropping the oldest past the limit) and returns it. */
  async record(userID: string, input: AuditInput): Promise<AgentAuditEntry> {
    if (!VERB.test(input.verb)) throw new Error(`agent audit: bad verb ${JSON.stringify(input.verb)}`)
    const { state } = this.deps
    const seq = (await updateVersioned<number>(state, userID, SEQ, SEQ_KEY, (current) => (current ?? 0) + 1))!
    const grant = cleanID(input.grant)
    const reason = cleanReason(input.reason)
    const entry: AgentAuditEntry = {
      seq,
      at: this.now(),
      actor: input.actor,
      verb: input.verb,
      target: cleanTarget(input.target),
      ...(grant ? { grant } : {}),
      decision: input.decision,
      ...(reason ? { reason } : {}),
      outcome: input.outcome,
    }
    await state.put(userID, ENTRIES, keyOf(seq), entry)
    if (seq > this.limit) await state.delete(userID, ENTRIES, keyOf(seq - this.limit))
    this.deps.admin?.audit({ actor: userID, action: `agent.${entry.verb}`, detail: entry.actor.kind })
    try {
      this.deps.recorded?.(userID, entry)
    } catch (cause) {
      console.error(`[hub] agent audit listener failed: ${(cause as Error).message}`)
    }
    return entry
  }

  /** The user's entries, newest first, a page at a time. */
  async list(userID: string, options: AuditListOptions = {}): Promise<AuditPage> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? AUDIT_PAGE_DEFAULT), 1), AUDIT_PAGE_MAX)
    const all = (await this.deps.state.list<AgentAuditEntry>(userID, ENTRIES)).map((e) => e.value).sort((a, b) => b.seq - a.seq)
    // Entries an interrupted record left past the ring: dropped now.
    for (const stale of all.splice(this.limit)) await this.deps.state.delete(userID, ENTRIES, keyOf(stale.seq))
    const older = options.before === undefined ? all : all.filter((e) => e.seq < options.before!)
    const entries = older.slice(0, limit)
    return { entries, ...(older.length > limit ? { next: entries[entries.length - 1]!.seq } : {}) }
  }
}
