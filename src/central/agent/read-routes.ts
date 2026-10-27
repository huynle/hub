// Reading on /api/agent (design §4): the snapshot and the flat session list, built only from the hub's catalog
// (Registry) and directory, never from a spoke.
//
// Routes (user actors always; session tokens and app tokens holding sessions:read):
//   GET /api/agent/status
//   GET /api/agent/sessions?project=&state=&machine=&label=k=v
//   GET /api/agent/sessions/:addr          show: the catalog view plus the spoke's summary (when it serves one)
//   GET /api/agent/sessions/:addr/log?n=20 the newest timeline rows (spoke feature "timeline")
//   GET /api/agent/watch?blocked=1&session=<addr>  SSE of compact events (watch.ts)
// show and log call spokes; a spoke without the feature answers unsupported {feature, harness}.
// A session a launch started carries that launch's labels (the latest launch's, when several did); others have none.
import path from "node:path"
import { featureForOp, type ServerRequest, type SpokeFeature } from "../../protocol"
import type { CatalogMachine, CatalogSession, LiveStatus, NowActivity, RegistryMessage, SessionView } from "../registry"
import { unsupportedMessage } from "../actions"
import { SpokeError } from "../spoke-ws"
import type { Store } from "../store"
import type { Directory, DirectoryEntry, RoleView } from "./directory"
import type { AgentActor } from "./actor"
import { AgentError } from "./errors"
import { AGENT_PREFIX, type AgentRoute } from "./routes"
import { watchStream } from "./watch"
import type { EventsRouteDeps } from "./events-routes"

/** Labels per session ID. */
export type SessionLabels = ReadonlyMap<string, Readonly<Record<string, string>>>

/** What the read routes need from the Registry. */
export interface ReadRegistry {
  catalog(): CatalogMachine[]
  sessionTenant(sessionID: string): string | undefined
  session(sessionID: string): SessionView | undefined
  owner(sessionID: string): string | undefined
  supports(connID: string, feature: SpokeFeature): boolean
  subscribe(listener: (message: RegistryMessage, tenant?: string) => void): () => void
}

/** Hub → spoke requests (SpokeHub). */
export interface SpokeRequester {
  request(connID: string, req: ServerRequest): Promise<unknown>
}

export interface ReadDeps {
  readonly store: Pick<Store, "machines">
  readonly directory: Directory
  readonly registry: ReadRegistry
  readonly spokes?: SpokeRequester
  /** The labels of the user's launched sessions (none without it). */
  readonly labels?: (userID: string) => Promise<SessionLabels>
  /** The journal GET /api/agent/watch streams (no watch route without it). */
  readonly events?: EventsRouteDeps
  /** Watch stream heartbeat (default WATCH_HEARTBEAT_MS). */
  readonly heartbeatMs?: number
  /** Aborted when the hub drains: watch streams end with a `retry:` hint. */
  readonly draining?: AbortSignal
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

const NO_LABELS: SessionLabels = new Map()

function view({ session: s, harness }: Row, entry: DirectoryEntry | undefined, labels: SessionLabels): AgentSessionView {
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
    labels: { ...labels.get(s.id) },
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
export function snapshot(deps: ReadDeps, userID: string, actor: AgentActor, labels: SessionLabels = NO_LABELS) {
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
        group.sessions.push(view(row, entries.get(row.session.id), labels))
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

/** The session an address names for the user, if the user's spokes report it now (else offline). */
function located(deps: ReadDeps, userID: string, addr: string) {
  const entry = deps.directory.resolveOne(userID, addr)
  const live = deps.registry.sessionTenant(entry.sessionID) === userID ? deps.registry.session(entry.sessionID) : undefined
  const list = rows(deps.registry, userID)
  const row = list.find((r) => r.session.id === entry.sessionID) ?? (live && list.find((r) => r.session.id === live.status[0]?.id))
  return { entry, live, row }
}

/** The connection to ask for `op` about a session: unsupported when it lacks the op's feature, offline when none. */
function spokeFor(deps: ReadDeps, sessionID: string, op: ServerRequest["op"], harness: string): string {
  const connID = deps.registry.owner(sessionID)
  if (!connID || !deps.spokes) throw new AgentError("offline", "No spoke reports this session now")
  const feature = featureForOp(op)
  if (feature && !deps.registry.supports(connID, feature)) {
    throw new AgentError("unsupported", unsupportedMessage({ feature, harness }), { extra: { feature, harness } })
  }
  return connID
}

async function ask(deps: ReadDeps, connID: string, req: ServerRequest): Promise<unknown> {
  try {
    return await deps.spokes!.request(connID, req)
  } catch (cause) {
    if (cause instanceof SpokeError && cause.message.includes("disconnected")) throw new AgentError("offline", "The session's spoke disconnected")
    throw cause
  }
}

/** GET /sessions/:addr: the session's catalog view with full blockers, and its summary from the spoke. */
async function show(deps: ReadDeps, userID: string, addr: string) {
  const { entry, live, row } = located(deps, userID, addr)
  const labels = { ...(await labelsOf(deps, userID)).get(entry.sessionID) }
  const name = entry.name ? { name: `@${entry.name}` } : {}
  const roles = entry.roles.map(roleLabel)
  if (!live) {
    return {
      id: entry.sessionID,
      ...name,
      roles,
      ...(entry.title ? { title: entry.title } : {}),
      state: "offline",
      online: false,
      ...(entry.parentID ? { parentID: entry.parentID } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      ...(entry.machineID ? { machineID: entry.machineID } : {}),
      ...(entry.lastSeen !== undefined ? { lastSeen: entry.lastSeen } : {}),
      blockers: [],
      labels,
    }
  }
  const harness = row?.harness ?? "unknown"
  const own = live.status.find((e) => e.id === live.id) as LiveStatus | undefined
  const base = {
    id: live.id,
    ...name,
    roles,
    title: live.title,
    state: live.state,
    harness,
    online: true,
    ...(row ? { machineID: row.machineID } : {}),
    project: live.projectName || path.basename(live.project || live.directory),
    directory: live.directory,
    ...(live.parentID ? { parentID: live.parentID } : {}),
    ...(own?.since !== undefined ? { busySince: own.since } : {}),
    ...(live.now ? { now: nowText(live.now), activity: live.now } : {}),
    blockers: live.blockers.map(({ sessionTitle: _, ...b }) => b),
    children: live.status.filter((e) => e.parentID === live.id).length,
    labels,
  }
  try {
    const connID = spokeFor(deps, live.id, "summary", harness)
    return { ...base, summary: await ask(deps, connID, { op: "summary", sessionID: live.id }) }
  } catch (cause) {
    if (cause instanceof AgentError && cause.code === "unsupported") return { ...base, unsupported: [cause.options.extra] }
    if (cause instanceof AgentError && cause.code === "offline") return base
    console.error("[hub] agent show: summary failed:", cause)
    return { ...base, failed: [{ feature: "summary" }] }
  }
}

/** GET /sessions/:addr/log: the newest `n` timeline rows, newest first. */
async function log(deps: ReadDeps, userID: string, addr: string, raw: string | null) {
  const n = raw === null ? 20 : Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new AgentError("invalid", "n must be 1–200")
  const { entry, live, row } = located(deps, userID, addr)
  if (!live) throw new AgentError("offline", "No spoke reports this session now")
  const connID = spokeFor(deps, entry.sessionID, "timeline", row?.harness ?? "unknown")
  const page = (await ask(deps, connID, { op: "timeline", sessionID: entry.sessionID, limit: n, order: "desc" })) as { items?: unknown[]; older?: string }
  return { sessionID: entry.sessionID, rows: page.items ?? [], ...(page.older ? { older: page.older } : {}) }
}

const labelsOf = (deps: ReadDeps, userID: string): Promise<SessionLabels> => deps.labels?.(userID) ?? Promise.resolve(NO_LABELS)

const STATES = new Set(["idle", "working", "blocked", "error"])

/** The /sessions filters: project (name or root), state (comma list), machine (ID or name), label k=v. */
function sessionFilter(deps: ReadDeps, userID: string, params: URLSearchParams): (row: Row, view: AgentSessionView) => boolean {
  const project = params.get("project") || undefined
  const states = params.get("state")?.split(",").filter(Boolean)
  if (states?.some((state) => !STATES.has(state))) throw new AgentError("invalid", "state must be idle, working, blocked or error (comma-separated)")
  const machine = params.get("machine") || undefined
  const machineIDs = machine && new Set(deps.store.machines().filter((m) => m.ownerID === userID && (m.id === machine || m.name === machine)).map((m) => m.id))
  const labels = params.getAll("label").map((label) => {
    const at = label.indexOf("=")
    if (at < 1) throw new AgentError("invalid", "label must be key=value")
    return [label.slice(0, at), label.slice(at + 1)] as const
  })
  return (row, view) => {
    const { root, name } = projectOf(row.session)
    if (project !== undefined && root !== project && name.toLowerCase() !== project.toLowerCase()) return false
    if (states?.length && !states.includes(view.state)) return false
    if (machineIDs && !machineIDs.has(row.machineID)) return false
    return labels.every(([key, value]) => view.labels[key] === value)
  }
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
      handle: async ({ user, actor }) => ok(snapshot(deps, user.id, actor, await labelsOf(deps, user.id))),
    },
    {
      method: "GET",
      path: `${AGENT_PREFIX}/sessions`,
      allow: READ,
      handle: async ({ user, url }) => {
        const keep = sessionFilter(deps, user.id, url.searchParams)
        const entries = directoryOf(deps.directory, user.id)
        const labels = await labelsOf(deps, user.id)
        const sessions = rows(deps.registry, user.id)
          .map((row) => ({ row, view: view(row, entries.get(row.session.id), labels) }))
          .filter(({ row, view }) => keep(row, view))
          .map(({ row, view }) => ({ ...view, machineID: row.machineID, project: projectOf(row.session).name }))
        return ok({ sessions })
      },
    },
    {
      method: "GET",
      path: `${AGENT_PREFIX}/sessions/:addr`,
      allow: READ,
      handle: async ({ user, params }) => ok(await show(deps, user.id, params.addr!)),
    },
    {
      method: "GET",
      path: `${AGENT_PREFIX}/sessions/:addr/log`,
      allow: READ,
      handle: async ({ user, params, url }) => ok(await log(deps, user.id, params.addr!, url.searchParams.get("n"))),
    },
    ...(deps.events ? [watchRoute(deps, deps.events)] : []),
  ]
}

/** GET /api/agent/watch: the journal's events live (watch.ts), with the events route's visibility and filters. */
function watchRoute(deps: ReadDeps, events: EventsRouteDeps): AgentRoute {
  return {
    method: "GET",
    path: `${AGENT_PREFIX}/watch`,
    allow: READ,
    handle: ({ user, url, request, actor }) => {
      const addr = url.searchParams.get("session") || undefined
      const sessions = addr ? new Set(deps.directory.resolve(user.id, addr).sessions.map((s) => s.sessionID)) : undefined
      const blocked = ["1", "true"].includes(url.searchParams.get("blocked") ?? "")
      const cursor = url.searchParams.get("cursor") || request.headers.get("last-event-id") || undefined
      return watchStream({
        events,
        userID: user.id,
        actor,
        signal: request.signal,
        ...(blocked ? { types: ["blocker.*"] } : {}),
        ...(sessions ? { sessions } : {}),
        ...(cursor ? { cursor } : {}),
        ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.draining ? { draining: deps.draining } : {}),
      })
    },
  }
}
