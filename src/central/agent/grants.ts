// Grants (design §5, §7; decision wvqeuis0; exploration hcw63slg): what lets a session or app token act for its
// user. Storage, holder/tenancy checks and the hourly cap; the policy is policy.ts, the check order acting.ts.
//
// - Stored per owner in the StateStore (collection "grants", keyed by id `g_<16 hex>`). Only the user creates,
//   edits or revokes one (grant-routes.ts admits user actors only).
// - Holders: `ses_…` and `@name` are pinned to the session they name at creation (a grant never follows a later
//   holder of the name); a reserved `@@role` follows the role (whoever holds it when the grant is used); an
//   `app:<id>` holder must be one of the owner's app tokens. All must belong to the owner, at creation and on use.
// - `expires` becomes an absolute expiresAt; revoke ends a grant (kept, for the audit's "grant g_12"). Ended
//   grants beyond GRANTS_KEPT are dropped, oldest first.
// - The admin audit gets only {actor: owner, action: grant.*, target: id}, never holder, scope or permissions.
import { randomBytes } from "node:crypto"
import type { Counters, StateStore } from "../backend/types"
import type { AuditEntry, Store } from "../store"
import type { Directory } from "./directory"
import { AgentError } from "./errors"
import { type GrantSpec, type GrantVerb, validateGrant } from "./policy"

/** Active (unexpired, unrevoked) grants per user. */
export const GRANTS_ACTIVE_MAX = 50
/** Ended (expired or revoked) grants each user keeps for the audit trail. */
export const GRANTS_KEPT = 200

const COLLECTION = "grants"
const ID = /^g_[0-9a-f]{16}$/

export type GrantState = "active" | "expired" | "revoked"

export interface Grant {
  readonly id: string
  readonly owner: string
  /** As the user wrote it: `@@role`, `@name`, `ses_…` or `app:<token id>`. */
  readonly holder: string
  /** The session a `ses_…` or `@name` holder was pinned to at creation. */
  readonly holderSessionID?: string
  readonly scope: { readonly projects: readonly string[] }
  readonly allow: readonly GrantVerb[]
  readonly permissions: { readonly allow: readonly string[]; readonly never: readonly string[] }
  readonly allowAlways: boolean
  readonly maxActionsPerHour: number
  readonly created: number
  readonly expiresAt: number
  readonly updated?: number
  readonly revokedAt?: number
}

export interface GrantsDeps {
  readonly state: StateStore
  /** The hourly action counts (consume). */
  readonly counters?: Counters
  readonly directory: Pick<Directory, "resolve">
  readonly store: Pick<Store, "user" | "agentData">
  /** The hub-wide admin audit (Store): summaries only. */
  readonly admin?: { audit(entry: Omit<AuditEntry, "at">): void }
  readonly now?: () => number
}

const notFound = () => new AgentError("not_found", "No such grant")

export class Grants {
  private readonly now: () => number

  constructor(private readonly deps: GrantsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Validates and stores a new grant of the owner (the holder resolved and pinned for the owner). */
  async create(owner: string, input: unknown): Promise<Grant> {
    this.owner(owner)
    const spec = validateGrant(input)
    const holderSessionID = this.pin(owner, spec.holder)
    const all = await this.all(owner)
    const at = this.now()
    if (all.filter((g) => grantState(g, at) === "active").length >= GRANTS_ACTIVE_MAX) {
      throw new AgentError("rate_limited", `At most ${GRANTS_ACTIVE_MAX} active grants per user`, { hint: "Revoke unused grants" })
    }
    const grant: Grant = { id: `g_${randomBytes(8).toString("hex")}`, owner, ...fields(spec, at), ...(holderSessionID ? { holderSessionID } : {}), created: at }
    await this.deps.state.put(owner, COLLECTION, grant.id, grant)
    await this.prune(owner, all, at)
    this.deps.admin?.audit({ actor: owner, action: "grant.create", target: grant.id })
    return grant
  }

  /** One of the owner's grants (any state); not_found otherwise. */
  async get(owner: string, id: string): Promise<Grant> {
    if (!ID.test(id)) throw notFound()
    const found = await this.deps.state.get<Grant>(owner, COLLECTION, id)
    if (!found) throw notFound()
    return found.value
  }

  private owner(owner: string): void {
    const user = this.deps.store.user(owner)
    if (!user || user.disabled) throw new AgentError("not_found", "No such user")
  }

  /** The session a ses_/@name holder names for the owner (not_found when it is not theirs); undefined for roles and apps. */
  private pin(owner: string, holder: string): string | undefined {
    if (holder.startsWith("app:")) {
      const id = holder.slice(4)
      if (!(this.deps.store.agentData(owner).appTokens ?? []).some((t) => t.id === id)) throw new AgentError("not_found", `No app token ${id}`)
      return undefined
    }
    if (holder.startsWith("@@")) return undefined
    const { sessions } = this.deps.directory.resolve(owner, holder)
    return sessions[0]!.sessionID
  }

  private async all(owner: string): Promise<Grant[]> {
    return (await this.deps.state.list<Grant>(owner, COLLECTION)).map((e) => e.value)
  }

  /** Drops the oldest ended grants past GRANTS_KEPT. */
  private async prune(owner: string, before: readonly Grant[], at: number): Promise<void> {
    const ended = before.filter((g) => grantState(g, at) !== "active").sort((a, b) => endOf(a) - endOf(b))
    for (const grant of ended.slice(0, Math.max(0, ended.length - GRANTS_KEPT))) await this.deps.state.delete(owner, COLLECTION, grant.id)
  }
}

/** A grant's state at a time. */
export function grantState(grant: Grant, at: number): GrantState {
  if (grant.revokedAt !== undefined) return "revoked"
  return at >= grant.expiresAt ? "expired" : "active"
}

const endOf = (grant: Grant): number => grant.revokedAt ?? grant.expiresAt

const fields = (spec: GrantSpec, at: number) => ({
  holder: spec.holder,
  scope: { projects: [...spec.scope.projects] },
  allow: [...spec.allow],
  permissions: { allow: [...spec.permissions.allow], never: [...spec.permissions.never] },
  allowAlways: spec.allowAlways,
  maxActionsPerHour: spec.maxActionsPerHour,
  expiresAt: at + spec.expiresInMs,
})
