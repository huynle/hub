// Reading on /api/agent (design §4): the snapshot and the flat session list, built only from the hub's catalog
// (Registry) and directory, never from a spoke.
//
// Routes (user actors always; session tokens and app tokens holding sessions:read):
//   GET /api/agent/status
//   GET /api/agent/sessions?project=&state=&machine=&label=k=v
import path from "node:path"
import type { CatalogMachine, CatalogSession, LiveStatus, NowActivity } from "../registry"
import type { Store } from "../store"
import type { Directory, DirectoryEntry, RoleView } from "./directory"
import type { AgentActor } from "./actor"
import { AGENT_PREFIX, type AgentRoute } from "./routes"

/** What the read routes need from the Registry. */
export interface ReadRegistry {
  catalog(): CatalogMachine[]
  sessionTenant(sessionID: string): string | undefined
}

export interface ReadDeps {
  readonly store: Pick<Store, "machines">
  readonly directory: Directory
  readonly registry: ReadRegistry
  readonly now?: () => number
}

/** One session in agent answers (status, sessions). */
export interface AgentSessionView {
  readonly id: string
  readonly name?: string
  readonly roles: string[]
  readonly title: string
  readonly state: string
  readonly harness: string
  readonly parentID?: string
  readonly busySince?: number
  readonly now?: string
  readonly blockers: { kind: string; id: string; summary: string; sessionID?: string }[]
  readonly children: number
  readonly labels: Record<string, string>
}

export interface AttentionItem {
  readonly kind: string
  readonly sessionID: string
  readonly name?: string
  readonly id?: string
  readonly summary: string
}

/** A session the user owns, where it is reported. */
interface Row {
  readonly machineID: string
  readonly harness: string
  readonly session: CatalogSession
}

const roleLabel = (r: RoleView) => (r.project !== undefined ? `${r.role}.${r.project}` : r.role)

/** "bash: bun test", from the session's latest running activity item. */
const nowText = (now: NowActivity) => [now.tool ?? (now.kind === "thinking" ? "thinking" : undefined), now.summary].filter(Boolean).join(": ") || now.kind

/** The user's sessions in the catalog, once each (the first process reporting one wins). */
function rows(registry: ReadRegistry, userID: string): Row[] {
  const out = new Map<string, Row>()
  for (const machine of registry.catalog()) {
    for (const process of machine.processes) {
      for (const session of process.sessions) {
        if (out.has(session.id) || registry.sessionTenant(session.id) !== userID) continue
        out.set(session.id, { machineID: machine.id, harness: process.harness, session })
      }
    }
  }
  return [...out.values()]
}

function view({ session: s, harness }: Row, entry: DirectoryEntry | undefined): AgentSessionView {
  const own = s.status.find((e) => e.id === s.id) as LiveStatus | undefined
  return {
    id: s.id,
    ...(entry?.name ? { name: `@${entry.name}` } : {}),
    roles: (entry?.roles ?? []).map(roleLabel),
    title: own?.title ?? s.title,
    state: s.state,
    harness,
    ...(s.parentID ? { parentID: s.parentID } : {}),
    ...(own?.since !== undefined ? { busySince: own.since } : {}),
    ...(s.now ? { now: nowText(s.now) } : {}),
    blockers: s.blockers.map((b) => ({ kind: b.kind, id: b.id, summary: b.summary, ...(b.sessionID !== s.id ? { sessionID: b.sessionID } : {}) })),
    children: s.status.filter((e) => e.parentID === s.id).length,
    labels: {},
  }
}

const projectOf = (s: CatalogSession) => {
  const root = s.project || s.directory
  return { root, name: s.projectName || path.basename(root) }
}

function directoryOf(directory: Directory, userID: string): Map<string, DirectoryEntry> {
  return new Map(directory.who(userID).map((e) => [e.sessionID, e]))
}

/** Blockers and errors across the user's sessions, oldest first (by the session's last update). */
function attention(list: readonly Row[], entries: Map<string, DirectoryEntry>): AttentionItem[] {
  const out: AttentionItem[] = []
  const seen = new Set<string>()
  const named = (sessionID: string) => {
    const name = entries.get(sessionID)?.name
    return name ? { name: `@${name}` } : {}
  }
  for (const { session: s } of [...list].sort((a, b) => a.session.updated - b.session.updated)) {
    for (const b of s.blockers) {
      if (seen.has(b.id)) continue
      seen.add(b.id)
      out.push({ kind: b.kind, sessionID: b.sessionID, ...named(b.sessionID), id: b.id, summary: b.summary })
    }
    if (s.state === "error" && !seen.has(`error:${s.id}`)) {
      seen.add(`error:${s.id}`)
      const own = s.status.find((e) => e.id === s.id)
      out.push({ kind: "error", sessionID: s.id, ...named(s.id), summary: own?.detail ?? "error" })
    }
  }
  return out
}

function you(actor: AgentActor, entries: Map<string, DirectoryEntry>) {
  if (actor.kind === "session") {
    const name = entries.get(actor.sessionID)?.name
    return { kind: "session", sessionID: actor.sessionID, ...(name ? { name: `@${name}` } : {}) }
  }
  if (actor.kind === "app") return { kind: "app", tokenID: actor.tokenID, ...(actor.label ? { label: actor.label } : {}) }
  return { kind: "user" }
}

/** The status snapshot of one user (design §4): machines → projects → sessions, and what needs attention. */
export function snapshot(deps: ReadDeps, userID: string, actor: AgentActor) {
  const list = rows(deps.registry, userID)
  const entries = directoryOf(deps.directory, userID)
  const online = new Map(deps.registry.catalog().map((m) => [m.id, m]))
  const machines = deps.store
    .machines()
    .filter((m) => !m.revoked && m.ownerID === userID)
    .map((m) => {
      const live = online.get(m.id)
      const projects = new Map<string, { root: string; name: string; sessions: AgentSessionView[] }>()
      for (const row of list) {
        if (row.machineID !== m.id) continue
        const project = projectOf(row.session)
        const group = projects.get(project.root) ?? { ...project, sessions: [] }
        projects.set(project.root, group)
        group.sessions.push(view(row, entries.get(row.session.id)))
      }
      return {
        id: m.id,
        name: m.name,
        online: live !== undefined,
        harnesses: [...new Set((live?.processes ?? []).map((p) => p.harness))],
        projects: [...projects.values()],
      }
    })
  return { at: (deps.now ?? Date.now)(), you: you(actor, entries), machines, attention: attention(list, entries) }
}

const NO_STORE = { "cache-control": "no-store" }
const ok = (body: unknown) => Response.json(body, { headers: NO_STORE })
const READ = { session: true, scope: "sessions:read" } as const

export function readRoutes(deps: ReadDeps): AgentRoute[] {
  return [
    {
      method: "GET",
      path: `${AGENT_PREFIX}/status`,
      allow: READ,
      handle: ({ user, actor }) => ok(snapshot(deps, user.id, actor)),
    },
    {
      method: "GET",
      path: `${AGENT_PREFIX}/sessions`,
      allow: READ,
      handle: ({ user }) => {
        const entries = directoryOf(deps.directory, user.id)
        return ok({ sessions: rows(deps.registry, user.id).map((row) => ({ ...view(row, entries.get(row.session.id)), machineID: row.machineID, project: projectOf(row.session).name })) })
      },
    },
  ]
}
