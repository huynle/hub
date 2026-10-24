// The directory on /api/agent (design §2.2) and its wiring to the hub: the Registry is the SessionSource
// (sessions reported now, per tenant), the console's Archive (viewPrefs.hiddenSessions) the archive source,
// and every catalog change syncs the affected users (records, lastSeen, derived names).
//
// Routes (user actors always; session tokens may read, and write for their OWN session only):
//   GET  /api/agent/who?project=&role=
//   POST /api/agent/name           {name, session?}
//   POST /api/agent/roles/claim    {role, exclusive?, project?, session?}
//   POST /api/agent/roles/release  {role, project?, session?}
// `session` is an address (ses_…, ID prefix, @name, …) resolved for the caller; a session token defaults to
// its own session, a user must name one.
import path from "node:path"
import type { CatalogMachine, RegistryMessage } from "../registry"
import type { Store } from "../store"
import { Directory, type ReportedSession, type SessionSource } from "./directory"
import { AgentError } from "./errors"
import { slugify } from "./names"
import { AGENT_PREFIX, type AgentContext, type AgentRoute } from "./routes"

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
export function hubDirectory(options: { registry: DirectoryRegistry; store: Pick<Store, "viewPrefs" | "updateAgentData">; now?: () => number }): Directory {
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
      try {
        directory.sync(userID)
      } catch (cause) {
        if (!(cause instanceof AgentError)) console.error("[hub] directory sync failed:", cause)
      }
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

export function directoryRoutes(directory: Directory): AgentRoute[] {
  return [
    {
      method: "GET",
      path: `${AGENT_PREFIX}/who`,
      allow: { session: true },
      handle: ({ url, user }) => {
        const project = url.searchParams.get("project") || undefined
        const role = url.searchParams.get("role") || undefined
        return ok({ sessions: directory.who(user.id, { ...(project ? { project } : {}), ...(role ? { role } : {}) }) })
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/name`,
      allow: { session: true },
      handle: async (context) => {
        const body = await readBody(context.request)
        const name = text(body, "name", true)
        const sessionID = target(directory, context, text(body, "session"))
        return ok(directory.setName(context.user.id, sessionID, name))
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/roles/claim`,
      allow: { session: true },
      handle: async (context) => {
        const body = await readBody(context.request)
        const role = text(body, "role", true)
        const exclusive = flag(body, "exclusive")
        const project = text(body, "project")
        const sessionID = target(directory, context, text(body, "session"))
        const claim = directory.claimRole(context.user.id, sessionID, role, {
          ...(exclusive !== undefined ? { exclusive } : {}),
          ...(project !== undefined ? { project } : {}),
          byUser: context.actor.kind === "user",
        })
        return ok({ sessionID, ...claim })
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/roles/release`,
      allow: { session: true },
      handle: async (context) => {
        const body = await readBody(context.request)
        const role = text(body, "role", true)
        const project = text(body, "project")
        const sessionID = target(directory, context, text(body, "session"))
        return ok({ sessionID, ...directory.releaseRole(context.user.id, sessionID, role, project), released: true })
      },
    },
  ]
}
