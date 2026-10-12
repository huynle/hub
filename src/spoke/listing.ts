// The background service's session listing for the phone's session browser: the most recent root
// sessions (no subagent children, nothing archived) within the history window, plus sessions that must
// always be listed (open in a terminal, running, ...), each with the workspace it belongs to.
import path from "node:path"

export interface RawSession {
  readonly id: string
  readonly title?: string
  readonly parentID?: string
  readonly projectID?: string
  /** Path of the session's directory inside its project, e.g. "packages/app". */
  readonly subpath?: string
  readonly location: { readonly directory: string }
  readonly time: { readonly updated: number; readonly archived?: number }
}

export interface RawProject {
  readonly id: string
  /** Project root; "/" for the global project of directories outside any repository. */
  readonly canonical: string
  readonly name?: string
}

/** The parts of the OpenCode client the listing uses. */
export interface ListingClient {
  readonly session: {
    list(input: { limit?: number; parentID?: null; cursor?: string }): Promise<{ data: readonly RawSession[]; cursor: { next?: string | null } }>
    /** One session by ID (for always-included sessions outside the window). */
    get?(input: { sessionID: string }): Promise<RawSession>
  }
  readonly project: { list(): Promise<readonly RawProject[]> }
}

export interface ListedSession {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly updated: number
  readonly project: string
  readonly projectName: string
}

export interface ListingOptions {
  /** Most sessions returned (default 500). */
  readonly max?: number
  readonly pageSize?: number
  /** Pages read at most, so a long run of filtered-out sessions cannot loop for long (default 20). */
  readonly maxPages?: number
  /** History window: only sessions updated in the last `days` days (default: no limit). */
  readonly days?: number
  readonly now?: number
  /** Session IDs listed even outside the window or over `max` (fetched one by one when missing). */
  readonly include?: readonly string[]
}

/** Most always-included sessions fetched one by one per listing. */
export const INCLUDE_FETCH_MAX = 50
const DAY_MS = 86_400_000

/** Workspace root and name of a session: its project, else its directory minus its subpath. */
export function workspaceOf(session: RawSession, projects: ReadonlyMap<string, RawProject>): { project: string; projectName: string } {
  const known = session.projectID ? projects.get(session.projectID) : undefined
  if (known && known.canonical && known.canonical !== "/") {
    return { project: known.canonical, projectName: known.name || path.basename(known.canonical) }
  }
  const directory = session.location.directory
  const subpath = session.subpath?.replace(/^\/+|\/+$/g, "")
  const root = subpath && directory.endsWith(`/${subpath}`) ? directory.slice(0, -subpath.length - 1) || "/" : directory
  return { project: root, projectName: path.basename(root) || root }
}

export async function listServiceSessions(client: ListingClient, options: ListingOptions = {}): Promise<ListedSession[]> {
  const max = options.max ?? 500
  const pageSize = options.pageSize ?? 100
  const maxPages = options.maxPages ?? 20
  const projects = new Map<string, RawProject>()
  try {
    for (const project of await client.project.list()) projects.set(project.id, project)
  } catch {
    // workspaces fall back to directories
  }
  const cutoff = options.days !== undefined ? (options.now ?? Date.now()) - options.days * DAY_MS : -Infinity
  const listed = (s: RawSession): ListedSession => ({ id: s.id, title: s.title ?? "", directory: s.location.directory, updated: s.time.updated, ...workspaceOf(s, projects) })
  const out: ListedSession[] = []
  let cursor: string | undefined
  // Sessions come newest first: the first one older than the window ends the listing.
  let ended = false
  for (let page = 0; page < maxPages && out.length < max && !ended; page++) {
    const result = await client.session.list({ limit: pageSize, parentID: null, ...(cursor ? { cursor } : {}) })
    for (const s of result.data) {
      if (s.parentID || s.time.archived || out.length >= max) continue
      if (s.time.updated < cutoff) {
        ended = true
        break
      }
      out.push(listed(s))
    }
    cursor = result.cursor.next ?? undefined
    if (!cursor || result.data.length === 0) break
  }
  const have = new Set(out.map((s) => s.id))
  const missing = [...new Set(options.include ?? [])].filter((id) => !have.has(id)).slice(0, INCLUDE_FETCH_MAX)
  if (missing.length && client.session.get) {
    const fetched = await Promise.all(missing.map((sessionID) => client.session.get!({ sessionID }).catch(() => undefined)))
    for (const s of fetched) if (s && s.id && !s.parentID && !s.time?.archived && s.location?.directory) out.push(listed(s))
  }
  return out
}
