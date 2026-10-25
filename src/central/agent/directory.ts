// The agent directory (design §2, §7): who is who among one user's sessions. Persisted per user in
// UserRecord.agent (agent-data.ts): session records, @names (with rename aliases) and @@role holders.
//
// Every rule is evaluated lazily against the clock when the directory is used (no timers):
// - A session record is created when a spoke reports the session; lastSeen is saved at minute granularity
//   while it stays online (LAST_SEEN_STEP_MS), and exactly when it stops being reported.
// - Archive source: the console's Archive (viewPrefs.hiddenSessions). Spokes never report archived OpenCode
//   sessions (the listing drops them), so SessionInfo.archived never reaches the hub. archivedAt is the first
//   time the directory sees the session in that list; unarchiving clears it. deletedAt comes from markDeleted.
// - Names: derived once, from the first non-placeholder title, for root sessions only; a taken derived name
//   gets a suffix, an explicit taken one fails (name_taken). A name is released NAME_RELEASE_MS after its
//   session was archived or deleted; a rename keeps the old name as an alias for ALIAS_MS.
// - Roles: see claimRole. A holder offline (not reported) for ROLE_OFFLINE_MS loses the role, except during
//   the RECONNECT_WINDOW_MS after the hub started, while spokes reconnect.
// - At most SESSION_LIMIT records per user: archived/deleted ones are dropped first, then the least recently
//   seen, with their names and roles.
// - Primer (design §2.3): a session record remembers when the identity primer reached it (primed); explicit
//   names are announced to onNamed listeners (the delivery engine primes on them), derived names never are.
//
// Tenancy: everything is per user; another user's sessions, names and roles do not exist here (not_found),
// and ambiguity candidates only ever list the caller's own sessions.
// Uniqueness is enforced inside one synchronous store update (single writer per user in this process); a
// cluster backend would put names behind StateStore.claim instead.
import { roleKey, type AgentData, type AgentName, type AgentRole, type AgentSession } from "../agent-data"
import type { Store } from "../store"
import { AgentError } from "./errors"
import { isPlaceholderTitle, isReservedRole, parseAddress, slugify, validName, withSuffix, type Address } from "./names"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const SESSION_LIMIT = 2000
export const NAME_RELEASE_MS = 7 * DAY
export const ALIAS_MS = 24 * HOUR
export const ROLE_OFFLINE_MS = 30 * MINUTE
export const RECONNECT_WINDOW_MS = 2 * MINUTE
export const LAST_SEEN_STEP_MS = MINUTE
/** Most candidates listed in an ambiguous error. */
const CANDIDATES_MAX = 20

/** A session a spoke of the user reports now. */
export interface ReportedSession {
  readonly sessionID: string
  readonly title: string
  readonly machineID?: string
  readonly parentID?: string
  /** Project name, lowercased (the `.project` scope). */
  readonly project?: string
  readonly state?: string
}

/** What the directory needs to know about the user's live sessions. */
export interface SessionSource {
  /** The user's sessions reported now (roots and subagents), only ones the user owns. */
  reported(userID: string): readonly ReportedSession[]
  /** IDs of the sessions the user archived. */
  archived(userID: string): ReadonlySet<string>
}

export type DirectoryStore = Pick<Store, "updateAgentData">

export interface DirectoryOptions {
  readonly store: DirectoryStore
  readonly source: SessionSource
  readonly now?: () => number
}

export interface RoleView {
  readonly role: string
  readonly project?: string
  readonly generation: number
  readonly exclusive?: boolean
}

/** One session in directory answers. */
export interface DirectoryEntry {
  readonly sessionID: string
  readonly name?: string
  readonly aliases?: string[]
  readonly machineID?: string
  readonly parentID?: string
  readonly project?: string
  readonly title?: string
  readonly state?: string
  /** A spoke reports it now. */
  readonly online: boolean
  readonly lastSeen?: number
  readonly archived?: boolean
  readonly roles: RoleView[]
}

/** Hears an explicit name change (setName); derived names are never announced. */
export type NamedListener = (userID: string, sessionID: string, name: string) => void

export interface Resolved {
  readonly address: Address
  /** One session for an ID or @name; every live holder for a @@role. */
  readonly sessions: DirectoryEntry[]
}

/** The working copy of one user's data inside an update. */
interface Draft {
  readonly data: AgentData
  readonly sessions: AgentSession[]
  readonly byID: Map<string, AgentSession>
  readonly reported: Map<string, ReportedSession>
  names: AgentName[]
  roles: AgentRole[]
}

const ended = (s: AgentSession | undefined): number | undefined => {
  const times = [s?.archivedAt, s?.deletedAt].filter((t): t is number => typeof t === "number")
  return times.length ? Math.min(...times) : undefined
}

export class Directory {
  private readonly store: DirectoryStore
  private readonly source: SessionSource
  private readonly now: () => number
  private readonly startedAt: number
  /** Per user: the sessions reported at the last update (to stamp lastSeen when they go away). */
  private readonly online = new Map<string, Set<string>>()
  private readonly named = new Set<NamedListener>()

  constructor(options: DirectoryOptions) {
    this.store = options.store
    this.source = options.source
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
  }

  /** Applies what the spokes report and the clock to the user's records (saves only on change). */
  sync(userID: string): void {
    this.update(userID, () => undefined)
  }

  /** Records that a session was deleted (its name is released NAME_RELEASE_MS later). */
  markDeleted(userID: string, sessionID: string): void {
    this.update(userID, (draft) => {
      const record = draft.byID.get(sessionID)
      if (record && record.deletedAt === undefined) record.deletedAt = this.now()
    })
  }

  // ---------- primer ----------

  /** Whether the identity primer reached the session (false for an unknown one). */
  primed(userID: string, sessionID: string): boolean {
    return this.update(userID, (draft) => draft.byID.get(sessionID)?.primed !== undefined)
  }

  /** Records that the identity primer reached the session (an unknown session is ignored). */
  markPrimed(userID: string, sessionID: string): void {
    this.update(userID, (draft) => {
      const record = draft.byID.get(sessionID)
      if (record && record.primed === undefined) record.primed = this.now()
    })
  }

  /** Listens for explicit names (setName); returns the unsubscribe. */
  onNamed(listener: NamedListener): () => void {
    this.named.add(listener)
    return () => void this.named.delete(listener)
  }

  // ---------- names ----------

  /** Names a session (explicit: a taken name fails); the previous name stays an alias for ALIAS_MS. Tells onNamed listeners. */
  setName(userID: string, sessionID: string, requested: string): { sessionID: string; name: string; alias?: string } {
    const result = this.assignName(userID, sessionID, requested)
    for (const listener of this.named) {
      try {
        listener(userID, sessionID, result.name)
      } catch (cause) {
        console.error("[hub] name listener failed:", cause)
      }
    }
    return result
  }

  private assignName(userID: string, sessionID: string, requested: string): { sessionID: string; name: string; alias?: string } {
    const name = requested.replace(/^@/, "")
    if (!validName(name)) throw new AgentError("invalid", "A name is 2–40 characters: a-z, 0-9 and -")
    return this.update(userID, (draft) => {
      const record = this.known(draft, sessionID)
      const held = draft.names.find((n) => n.name === name)
      if (held && held.sessionID !== sessionID) throw new AgentError("name_taken", `@${name} is taken`)
      record.named = true
      const current = draft.names.find((n) => n.sessionID === sessionID && n.expiresAt === undefined)
      if (current?.name === name) return { sessionID, name }
      const t = this.now()
      if (held) draft.names = draft.names.filter((n) => n !== held)
      if (current) current.expiresAt = t + ALIAS_MS
      draft.names.push({ name, sessionID, created: t })
      return { sessionID, name, ...(current ? { alias: current.name } : {}) }
    })
  }

  // ---------- roles ----------

  /**
   * Claims `role` (or `role.project`) for a session. Each new holder gets the next holder generation of
   * (role, project). An exclusive claim fails (name_taken) while another live holder exists, and nobody else
   * can claim while an exclusive holder is live. Reserved roles (orchestrator…, concierge…) need `byUser`
   * (grants with `roles` come in phase 3). Exclusivity and generations are per (role, project scope).
   */
  claimRole(userID: string, sessionID: string, requested: string, options: { exclusive?: boolean; project?: string; byUser?: boolean } = {}): RoleView {
    const { role, project } = parseRole(requested, options.project)
    if (isReservedRole(role) && !options.byUser) throw new AgentError("forbidden", `@@${role} is reserved: only the user can assign it`)
    return this.update(userID, (draft) => {
      this.known(draft, sessionID)
      const same = draft.roles.filter((r) => r.role === role && r.project === project)
      const mine = same.find((r) => r.sessionID === sessionID)
      const others = same.filter((r) => r !== mine)
      if (others.some((r) => r.exclusive) || (options.exclusive && others.length)) {
        throw new AgentError("name_taken", `@@${scoped(role, project)} is held${others.some((r) => r.exclusive) ? " exclusively" : ""} by another session`)
      }
      if (mine) {
        if (options.exclusive) mine.exclusive = true
        return roleView(mine)
      }
      const key = roleKey(role, project)
      const generations = { ...(draft.data.generations ?? {}) }
      const generation = (generations[key] ?? 0) + 1
      generations[key] = generation
      draft.data.generations = generations
      const claim: AgentRole = { role, sessionID, ...(project !== undefined ? { project } : {}), generation, ...(options.exclusive ? { exclusive: true } : {}), claimedAt: this.now() }
      draft.roles.push(claim)
      return roleView(claim)
    })
  }

  /** Gives a role up; not_found when the session does not hold it. */
  releaseRole(userID: string, sessionID: string, requested: string, scope?: string): { role: string; project?: string } {
    const { role, project } = parseRole(requested, scope)
    return this.update(userID, (draft) => {
      const held = draft.roles.find((r) => r.sessionID === sessionID && r.role === role && r.project === project)
      if (!held) throw new AgentError("not_found", `Not holding @@${scoped(role, project)}`)
      draft.roles = draft.roles.filter((r) => r !== held)
      return project !== undefined ? { role, project } : { role }
    })
  }

  // ---------- directory ----------

  /** The user's named, role-holding or online sessions (not archived or deleted), by project and role. */
  who(userID: string, filter: { project?: string; role?: string } = {}): DirectoryEntry[] {
    const project = filter.project?.toLowerCase()
    const role = filter.role !== undefined ? parseRole(filter.role, project) : undefined
    return this.update(userID, (draft) =>
      draft.sessions
        .filter((s) => s.archivedAt === undefined && s.deletedAt === undefined)
        .map((s) => this.entry(draft, s.sessionID))
        .filter((e) => e.online || e.name !== undefined || e.roles.length > 0)
        .filter((e) => project === undefined || e.project === project || e.roles.some((r) => r.project === project))
        .filter((e) => !role || e.roles.some((r) => r.role === role.role && inScope(r.project, e.project, role.project))),
    )
  }

  // ---------- resolution ----------

  /**
   * The sessions an address names, for this user only: `ses_…` (an ID or a unique ID prefix), `@name[.project]`
   * or `@@role[.project]` (every live holder). Throws invalid (malformed), not_found or ambiguous {candidates}.
   */
  resolve(userID: string, addr: string): Resolved {
    const address = parseAddress(addr)
    if (!address) throw new AgentError("invalid", `Not an address: use ses_…, @name or @@role`)
    return this.update(userID, (draft) => ({ address, sessions: this.lookup(draft, address, addr) }))
  }

  /** Exactly one session; several (a role with several holders) is ambiguous. */
  resolveOne(userID: string, addr: string): DirectoryEntry {
    const { sessions } = this.resolve(userID, addr)
    if (sessions.length > 1) throw ambiguous(addr, sessions)
    return sessions[0]!
  }

  private lookup(draft: Draft, address: Address, addr: string): DirectoryEntry[] {
    const missing = () => new AgentError("not_found", `No session ${addr}`)
    if (address.kind === "id") {
      if (draft.byID.has(address.id)) return [this.entry(draft, address.id)]
      const matches = draft.sessions.filter((s) => s.sessionID.startsWith(address.id)).map((s) => this.entry(draft, s.sessionID))
      if (matches.length > 1) throw ambiguous(addr, matches)
      if (!matches.length) throw missing()
      return matches
    }
    if (address.kind === "name") {
      const held = draft.names.find((n) => n.name === address.name)
      const entry = held && this.entry(draft, held.sessionID)
      if (!entry || (address.project !== undefined && entry.project !== address.project)) throw missing()
      return [entry]
    }
    const holders = draft.roles.filter((r) => r.role === address.role && inScope(r.project, draft.byID.get(r.sessionID)?.project, address.project))
    const ids = [...new Set(holders.map((r) => r.sessionID))]
    if (!ids.length) throw missing()
    return ids.map((id) => this.entry(draft, id))
  }

  // ---------- internals ----------

  private known(draft: Draft, sessionID: string): AgentSession {
    const record = draft.byID.get(sessionID)
    if (!record) throw new AgentError("not_found", `No session ${sessionID}`)
    return record
  }

  private entry(draft: Draft, sessionID: string): DirectoryEntry {
    const record = draft.byID.get(sessionID)
    const live = draft.reported.get(sessionID)
    const own = draft.names.filter((n) => n.sessionID === sessionID)
    const name = own.find((n) => n.expiresAt === undefined)?.name
    const aliases = own.filter((n) => n.expiresAt !== undefined).map((n) => n.name)
    const roles = draft.roles.filter((r) => r.sessionID === sessionID).map(roleView)
    return {
      sessionID,
      ...(name ? { name } : {}),
      ...(aliases.length ? { aliases } : {}),
      ...(record?.machineID ? { machineID: record.machineID } : {}),
      ...(record?.parentID ? { parentID: record.parentID } : {}),
      ...(record?.project ? { project: record.project } : {}),
      ...(record?.title ? { title: record.title } : {}),
      ...(live?.state ? { state: live.state } : {}),
      online: live !== undefined,
      ...(record?.lastSeen !== undefined ? { lastSeen: record.lastSeen } : {}),
      ...(record?.archivedAt !== undefined ? { archived: true } : {}),
      roles,
    }
  }

  /** Runs `change` on the user's refreshed data in one store update; not_found for an unknown user. */
  private update<T>(userID: string, change: (draft: Draft) => T): T {
    const reported = new Map(this.source.reported(userID).map((s) => [s.sessionID, s]))
    const archived = this.source.archived(userID)
    let done = false
    let result: T | undefined
    this.store.updateAgentData(userID, (data) => {
      const draft = this.refresh(userID, data, reported, archived)
      result = change(draft)
      this.write(draft)
      done = true
    })
    if (!done) throw new AgentError("not_found", "No such user")
    this.online.set(userID, new Set(reported.keys()))
    return result as T
  }

  private write(draft: Draft): void {
    const { data } = draft
    if (draft.sessions.length || data.sessions) data.sessions = draft.sessions
    if (draft.names.length || data.names) data.names = draft.names
    if (draft.roles.length || data.roles) data.roles = draft.roles
  }

  /** Records, archive marks, releases, derivations and the cap, as of now. */
  private refresh(userID: string, data: AgentData, reported: Map<string, ReportedSession>, archived: ReadonlySet<string>): Draft {
    const t = this.now()
    const sessions = data.sessions ?? []
    const byID = new Map(sessions.map((s) => [s.sessionID, s]))
    for (const live of reported.values()) {
      let record = byID.get(live.sessionID)
      if (!record) {
        record = { sessionID: live.sessionID, firstSeen: t }
        sessions.push(record)
        byID.set(live.sessionID, record)
      }
      for (const field of ["machineID", "parentID", "project", "title"] as const) {
        const value = live[field]
        if (value !== undefined && value !== "" && record[field] !== value) record[field] = value
      }
      if (record.lastSeen === undefined || t - record.lastSeen >= LAST_SEEN_STEP_MS) record.lastSeen = t
      delete record.deletedAt
    }
    for (const id of this.online.get(userID) ?? []) {
      const record = byID.get(id)
      if (record && !reported.has(id)) record.lastSeen = t
    }
    for (const record of sessions) {
      if (archived.has(record.sessionID)) record.archivedAt ??= t
      else delete record.archivedAt
    }

    const draft: Draft = { data, sessions, byID, reported, names: data.names ?? [], roles: data.roles ?? [] }
    draft.names = draft.names.filter((n) => !this.nameReleased(n, byID, t))
    draft.roles = draft.roles.filter((r) => this.holding(draft, r.sessionID, t))
    this.derive(draft, t)
    this.cap(draft)
    return draft
  }

  private nameReleased(name: AgentName, byID: Map<string, AgentSession>, t: number): boolean {
    if (name.expiresAt !== undefined && t >= name.expiresAt) return true
    const end = ended(byID.get(name.sessionID))
    return end !== undefined && t - end >= NAME_RELEASE_MS
  }

  /** A holder keeps its roles while reported, or offline for less than ROLE_OFFLINE_MS, or (any) during the reconnect window; never once deleted. */
  private holding(draft: Draft, sessionID: string, t: number): boolean {
    const record = draft.byID.get(sessionID)
    if (record?.deletedAt !== undefined) return false
    if (draft.reported.has(sessionID) || t - this.startedAt < RECONNECT_WINDOW_MS) return true
    return record?.lastSeen !== undefined && t - record.lastSeen < ROLE_OFFLINE_MS
  }

  /** Names root sessions once, from their first non-placeholder title. */
  private derive(draft: Draft, t: number): void {
    for (const live of draft.reported.values()) {
      const record = draft.byID.get(live.sessionID)!
      if (live.parentID || record.named || isPlaceholderTitle(live.title)) continue
      record.named = true
      const slug = slugify(live.title)
      if (!slug || draft.names.some((n) => n.sessionID === live.sessionID && n.expiresAt === undefined)) continue
      const taken = new Set(draft.names.map((n) => n.name))
      draft.names.push({ name: withSuffix(slug, (n) => taken.has(n)), sessionID: live.sessionID, created: t })
    }
  }

  /** Drops records beyond SESSION_LIMIT (never a reported one), with their names and roles. */
  private cap(draft: Draft): void {
    const excess = draft.sessions.length - SESSION_LIMIT
    if (excess <= 0) return
    const seen = (s: AgentSession) => s.lastSeen ?? s.firstSeen ?? 0
    const victims = draft.sessions
      .filter((s) => !draft.reported.has(s.sessionID))
      .sort((a, b) => Number(ended(b) !== undefined) - Number(ended(a) !== undefined) || seen(a) - seen(b))
      .slice(0, excess)
    const gone = new Set(victims.map((s) => s.sessionID))
    const kept = draft.sessions.filter((s) => !gone.has(s.sessionID))
    draft.sessions.splice(0, draft.sessions.length, ...kept)
    for (const id of gone) draft.byID.delete(id)
    draft.names = draft.names.filter((n) => !gone.has(n.sessionID))
    draft.roles = draft.roles.filter((r) => !gone.has(r.sessionID))
  }
}

/** `role`, `@@role` or `role.project` (an explicit scope wins); invalid when malformed. */
function parseRole(requested: string, scope?: string): { role: string; project?: string } {
  const [role = "", inline, ...rest] = requested.replace(/^@@/, "").split(".")
  const project = (scope ?? inline)?.toLowerCase()
  if (!validName(role) || rest.length || (project !== undefined && !/^[^./\s]+$/.test(project))) {
    throw new AgentError("invalid", "A role is 2–40 characters: a-z, 0-9 and -, optionally .project")
  }
  return project !== undefined ? { role, project } : { role }
}

const scoped = (role: string, project?: string) => (project !== undefined ? `${role}.${project}` : role)

/** A claim scoped to `claimProject` (or unscoped, in a session of `sessionProject`) counts for `wanted`. */
const inScope = (claimProject: string | undefined, sessionProject: string | undefined, wanted: string | undefined) =>
  wanted === undefined || claimProject === wanted || (claimProject === undefined && sessionProject === wanted)

const roleView = (r: AgentRole): RoleView => ({ role: r.role, ...(r.project !== undefined ? { project: r.project } : {}), generation: r.generation ?? 0, ...(r.exclusive ? { exclusive: true } : {}) })

function ambiguous(addr: string, sessions: readonly DirectoryEntry[]): AgentError {
  const candidates = sessions.slice(0, CANDIDATES_MAX).map((s) => ({ sessionID: s.sessionID, ...(s.name ? { name: s.name } : {}), ...(s.project ? { project: s.project } : {}) }))
  return new AgentError("ambiguous", `${addr} matches ${sessions.length} sessions`, { extra: { candidates } })
}
