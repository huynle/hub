// The directory on /api/agent (design §2.2) and its wiring to the hub: the Registry is the SessionSource
// (sessions reported now, per tenant), the console's Archive (viewPrefs.hiddenSessions) the archive source,
// and every catalog change syncs the affected users (records, lastSeen, derived names).
//
// Routes (user actors always; session tokens may read, and write for their OWN session only):
//   GET  /api/agent/who?project=&role=
//   POST /api/agent/name           {name, session?}
//   POST /api/agent/roles/claim    {role, exclusive?, project?, session?}
//   POST /api/agent/roles/release  {role, project?, session?}
//   PUT  /api/agent/sessions/:addr/archive {archived}
// `session` is an address (ses_…, ID prefix, @name, …) resolved for the caller; a session token defaults to
// its own session, a user or app must name one. Foreign and unknown sessions are both not_found.
//
// App tokens (lifecycle design, decision xwzersmm): naming and archiving need sessions:manage; a role claim or
// release also needs a grant allowing `roles` whose projects cover the (live) session's directory, in the acting
// order (kill switch → grant → hourly cap → kill switch), with every outcome in the agent audit (verb roles or
// roles.release). Reserved roles stay the user's to assign. Each change is in the admin audit and the event
// journal once (session.named, role.claimed, role.released, session.archived); a no-op is neither.
import type { ActingSwitch } from "./acting-switch"
import { auditOf } from "./acting"
import type { AgentAudit, AuditDecision, AuditOutcome } from "./audit"
import { partyFromActor } from "./envelope"
import { type AgentEvents, archiveEvent, type EventInput, namedEvent, pinnedEvent, roleEvent } from "./events"
import type { Grant, Grants } from "./grants"
import path from "node:path"
import type { CatalogMachine, Registry, RegistryMessage } from "../registry"
import type { Store } from "../store"
import { Directory, type ReportedSession, type SessionSource } from "./directory"
import { AgentError } from "./errors"
import { ArchiveInactive, parseInactiveFor } from "./archive-inactive"
import { slugify } from "./names"
import { AGENT_PREFIX, type AgentContext, type AgentRoute } from "./routes"
import type { CursorKeys } from "./event-cursor"

/** What the directory reads from the Registry. */
export interface DirectoryRegistry {
  catalog(): CatalogMachine[]
  sessionTenant(sessionID: string): string | undefined
  subscribe(listener: (message: RegistryMessage, tenant?: string) => void): () => void
}

type CatalogSession = CatalogMachine["processes"][number]["sessions"][number]

/** The `.project` scope of a session: its project name (else folder name), as a slug. */
function projectOf(s: Pick<CatalogSession, "projectName" | "project" | "directory">): string | undefined {
  const name = s.projectName || path.basename(s.project || s.directory || "")
  return name ? (slugify(name) ?? name.toLowerCase()) : undefined
}

/** Sessions the Registry reports for a user (subagents from the status trees too), and their Archive. */
export function registrySource(registry: Pick<DirectoryRegistry, "catalog" | "sessionTenant">, store: Pick<Store, "viewPrefs">): SessionSource {
  return {
    reported(userID) {
      const out = new Map<string, ReportedSession>()
      for (const machine of registry.catalog()) {
        for (const process of machine.processes) {
          for (const s of process.sessions) {
            if (out.has(s.id) || registry.sessionTenant(s.id) !== userID) continue
            const project = projectOf(s)
            const scope = project ? { project } : {}
            out.set(s.id, { sessionID: s.id, title: s.title, machineID: s.machineID, ...(s.parentID ? { parentID: s.parentID } : {}), ...scope, state: s.state })
            for (const child of s.status) {
              if (child.id === s.id || out.has(child.id)) continue
              out.set(child.id, { sessionID: child.id, title: child.title, machineID: s.machineID, parentID: child.parentID ?? s.id, ...scope, state: child.state })
            }
          }
        }
      }
      return [...out.values()]
    },
    archived: (userID) => new Set(store.viewPrefs(userID).hiddenSessions),
  }
}

/** The hub's directory: fed by the Registry, synced for the affected users on every catalog change. */
export function hubDirectory(options: { registry: DirectoryRegistry; store: Pick<Store, "viewPrefs" | "updateAgentData" | "agentData" | "user">; now?: () => number }): Directory {
  const { registry, store } = options
  const directory = new Directory({ store, source: registrySource(registry, store), ...(options.now ? { now: options.now } : {}) })
  /** Users with reported sessions at the last catalog change (they need a sync when theirs go away). */
  let online = new Set<string>()
  registry.subscribe((message) => {
    if (message.type !== "catalog") return
    const now = new Set<string>()
    for (const machine of registry.catalog()) {
      for (const process of machine.processes) {
        for (const s of process.sessions) {
          const tenant = registry.sessionTenant(s.id)
          if (tenant !== undefined) now.add(tenant)
        }
      }
    }
    for (const userID of new Set([...online, ...now])) {
      directory.sync(userID).catch((cause: unknown) => {
        if (!(cause instanceof AgentError)) console.error("[hub] directory sync failed:", cause)
      })
    }
    online = now
  })
  return directory
}

// ---------- routes ----------

type Body = Record<string, unknown>

async function readBody(request: Request): Promise<Body> {
  const body = await request.json()
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AgentError("invalid", "Expected a JSON object")
  return body as Body
}

function text(body: Body, field: string, required: true): string
function text(body: Body, field: string, required?: false): string | undefined
function text(body: Body, field: string, required = false): string | undefined {
  const value = body[field]
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || !value || value.length > 300) throw new AgentError("invalid", `${field} must be a string`)
  return value
}

function flag(body: Body, field: string): boolean | undefined {
  const value = body[field]
  if (value !== undefined && typeof value !== "boolean") throw new AgentError("invalid", `${field} must be true or false`)
  return value
}

/**
 * The session a write targets: a session token acts on its own session only (forbidden otherwise); a user
 * names any of their sessions by address.
 */
function target(directory: Directory, { actor, user }: AgentContext, addr: string | undefined): string {
  if (actor.kind === "session") {
    if (addr === undefined) return actor.sessionID
    const sessionID = directory.resolveOne(user.id, addr).sessionID
    if (sessionID !== actor.sessionID) throw new AgentError("forbidden", "A session token can only act for its own session")
    return sessionID
  }
  if (addr === undefined) throw new AgentError("invalid", "session is required (ses_…, @name)")
  return directory.resolveOne(user.id, addr).sessionID
}

const NO_STORE = { "cache-control": "no-store" }
const ok = (body: unknown) => Response.json(body, { headers: NO_STORE })

export interface DirectoryRoutesDeps {
  readonly directory: Directory
  readonly store: Pick<Store, "setSessionArchived" | "setSessionPinned" | "archiveSessionIfUnpinned" | "viewPrefs" | "agentData" | "audit">
  readonly events?: Pick<AgentEvents, "append">
  /** App role writes: the live session (its directory, for the grant's projects). */
  readonly registry?: Pick<Registry, "sessionTenant" | "session">
  readonly grants?: Pick<Grants, "usable" | "consume">
  readonly acting?: Pick<ActingSwitch, "ensureActing">
  readonly audit?: Pick<AgentAudit, "record">
  readonly previewKeys?: CursorKeys
}

const MANAGE = { session: true, scope: "sessions:manage" } as const

export function directoryRoutes(deps: DirectoryRoutesDeps): AgentRoute[] {
  const { directory, store, events } = deps

  /** The admin audit and the journal, once per change. */
  async function changed(context: AgentContext, action: string, sessionID: string, event: EventInput): Promise<void> {
    await store.audit({ actor: context.user.id, action, target: sessionID, detail: context.actor.kind })
    await events?.append(context.user.id, event).catch((cause) => console.error(`[hub] ${event.type} event failed: ${(cause as Error).message}`))
  }

  /** A role write: users and sessions as before; an app under a `roles` grant on the session's project, audited. */
  async function roleWrite<T>(context: AgentContext, verb: "roles" | "roles.release", sessionID: string, run: () => Promise<T>): Promise<T> {
    const { actor, user } = context
    if (actor.kind !== "app") return run()
    const { registry, grants, acting, audit } = deps
    if (!registry || !grants || !acting || !audit) throw new AgentError("forbidden", "This hub does not let app tokens change roles")
    let grant: Grant | undefined
    const record = (decision: AuditDecision, outcome: AuditOutcome, reason?: string) =>
      audit.record(user.id, { actor: partyFromActor(actor), verb, target: { sessionID }, ...(grant ? { grant: grant.id } : {}), decision, ...(reason ? { reason } : {}), outcome })
    try {
      acting.ensureActing(user.id)
      const live = registry.sessionTenant(sessionID) === user.id ? registry.session(sessionID) : undefined
      if (!live) throw new AgentError("offline", "No spoke reports this session now, so its project cannot be checked against a grant")
      const usable = await grants.usable(actor, "roles", { directory: live.directory })
      if (!usable.length) throw new AgentError("forbidden", "No grant lets this app change roles in this session's project")
      grant = usable[0]!
      await grants.consume(grant)
      acting.ensureActing(user.id)
      const result = await run()
      await record("allow", "ok")
      return result
    } catch (cause) {
      const [decision, outcome] = auditOf(cause)
      await record(decision, outcome, cause instanceof Error ? cause.message : undefined)
      throw cause
    }
  }

  return [
    ...(deps.previewKeys ? [{
      method: "POST" as const,
      path: `${AGENT_PREFIX}/sessions/archive-inactive`,
      allow: { scope: "sessions:manage" },
      async handle(context: AgentContext) {
        const inactive = new ArchiveInactive({ secret: deps.previewKeys!.active().secret })
        const body = await readBody(context.request)
        const prefs = store.viewPrefs(context.user.id)
        const entries = (store.agentData(context.user.id).sessions ?? []).map((s) => ({ sessionID: s.sessionID, online: !!deps.registry?.session(s.sessionID), ...(s.lastSeen !== undefined ? { lastSeen: s.lastSeen } : {}), roles: [] }))
        if (body.preview === true) {
          const limit = body.limit
          if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new AgentError("invalid", "limit must be a whole number from 1 to 200")
          return ok(inactive.preview(context.user.id, entries, { pinned: new Set(prefs.pinnedSessions), archived: new Set(prefs.hiddenSessions), inactiveForMs: parseInactiveFor(body.inactiveFor), limit: Number(limit) }))
        }
        if (body.confirm !== true || typeof body.previewToken !== "string") throw new AgentError("invalid", "Use preview:true first, then confirm:true with its previewToken")
        const open = new Set(entries.filter((s) => deps.registry?.session(s.sessionID)?.open).map((s) => s.sessionID))
        const active = new Set(entries.filter((s) => { const v = deps.registry?.session(s.sessionID); return !!v && (v.busy || v.status.some((x) => x.state === "working" || x.state === "blocked")) }).map((s) => s.sessionID))
        const checked = inactive.revalidate(context.user.id, body.previewToken, entries, { pinned: new Set(prefs.pinnedSessions), archived: new Set(prefs.hiddenSessions), open, active })
        const changedIDs: string[] = []
        const skipped = [...checked.skipped]
        for (const sessionID of checked.candidates) {
          const result = await store.archiveSessionIfUnpinned(context.user.id, sessionID)
          if (result === "changed") { changedIDs.push(sessionID); await changed(context, "session.archive", sessionID, archiveEvent(sessionID, true)) }
          else skipped.push({ sessionID, reason: result === "pinned" ? "pinned" : result === "not_found" ? "not_found" : "archived" })
        }
        if (changedIDs.length) await directory.sync(context.user.id)
        return ok({ changed: changedIDs, skipped })
      },
    }] : []),
    {
      method: "PUT",
      path: `${AGENT_PREFIX}/sessions/:addr/pin`,
      allow: { scope: "sessions:manage" },
      async handle(context) {
        const body = await readBody(context.request)
        if (flag(body, "pinned") === undefined) throw new AgentError("invalid", "pinned must be true or false")
        const sessionID = target(directory, context, context.params.addr)
        const pinned = body.pinned === true
        const result = await store.setSessionPinned(context.user.id, sessionID, pinned)
        if (!result) throw new AgentError("not_found", `No session ${context.params.addr}`)
        if (result.changed) await changed(context, pinned ? "session.pin" : "session.unpin", sessionID, pinnedEvent(sessionID, pinned))
        return ok({ sessionID, pinned, changed: result.changed })
      },
    },
    {
      method: "PUT",
      path: `${AGENT_PREFIX}/sessions/:addr/archive`,
      allow: { scope: "sessions:manage" },
      async handle(context) {
        const body = await readBody(context.request)
        if (flag(body, "archived") === undefined) throw new AgentError("invalid", "archived must be true or false")
        const sessionID = target(directory, context, context.params.addr)
        const archived = body.archived === true
        const result = await store.setSessionArchived(context.user.id, sessionID, archived)
        if (!result) throw new AgentError("invalid", "The archive is full; unarchive a session first")
        if (result.changed) {
          await directory.sync(context.user.id)
          await changed(context, archived ? "session.archive" : "session.unarchive", sessionID, archiveEvent(sessionID, archived))
        }
        return ok({ sessionID, archived, changed: result.changed })
      },
    },
    {
      method: "GET",
      path: `${AGENT_PREFIX}/who`,
      // Reading the directory: sessions, and app tokens holding sessions:read; writes stay users and sessions.
      allow: { session: true, scope: "sessions:read" },
      handle: ({ url, user }) => {
        const project = url.searchParams.get("project") || undefined
        const role = url.searchParams.get("role") || undefined
        return ok({ sessions: directory.who(user.id, { ...(project ? { project } : {}), ...(role ? { role } : {}) }) })
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/name`,
      allow: MANAGE,
      handle: async (context) => {
        const body = await readBody(context.request)
        const name = text(body, "name", true)
        const sessionID = target(directory, context, text(body, "session"))
        const before = directory.resolveOne(context.user.id, sessionID).name
        const named = await directory.setName(context.user.id, sessionID, name)
        if (named.name !== before) await changed(context, "session.name", sessionID, namedEvent(sessionID, named.name))
        return ok(named)
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/roles/claim`,
      allow: MANAGE,
      handle: async (context) => {
        const body = await readBody(context.request)
        const role = text(body, "role", true)
        const exclusive = flag(body, "exclusive")
        const project = text(body, "project")
        const sessionID = target(directory, context, text(body, "session"))
        const claim = await roleWrite(context, "roles", sessionID, async () => {
          const before = directory.resolveOne(context.user.id, sessionID).roles
          const claim = await directory.claimRole(context.user.id, sessionID, role, {
            ...(exclusive !== undefined ? { exclusive } : {}),
            ...(project !== undefined ? { project } : {}),
            byUser: context.actor.kind === "user",
          })
          const prev = before.find((r) => r.role === claim.role && r.project === claim.project)
          if (!prev || prev.generation !== claim.generation || !!prev.exclusive !== !!claim.exclusive) {
            await changed(context, "role.claim", sessionID, roleEvent(sessionID, true, claim))
          }
          return claim
        })
        return ok({ sessionID, ...claim })
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/roles/release`,
      allow: MANAGE,
      handle: async (context) => {
        const body = await readBody(context.request)
        const role = text(body, "role", true)
        const project = text(body, "project")
        const sessionID = target(directory, context, text(body, "session"))
        const released = await roleWrite(context, "roles.release", sessionID, async () => {
          const released = await directory.releaseRole(context.user.id, sessionID, role, project)
          await changed(context, "role.release", sessionID, roleEvent(sessionID, false, released))
          return released
        })
        return ok({ sessionID, ...released, released: true })
      },
    },
  ]
}
