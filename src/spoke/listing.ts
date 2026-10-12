// The background service's session listing for the phone's session browser: the most recent root
// sessions (no subagent children, nothing archived), each with the workspace it belongs to.
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
}

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
  const out: ListedSession[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages && out.length < max; page++) {
    const result = await client.session.list({ limit: pageSize, parentID: null, ...(cursor ? { cursor } : {}) })
    for (const s of result.data) {
      if (s.parentID || s.time.archived || out.length >= max) continue
      out.push({ id: s.id, title: s.title ?? "", directory: s.location.directory, updated: s.time.updated, ...workspaceOf(s, projects) })
    }
    cursor = result.cursor.next ?? undefined
    if (!cursor || result.data.length === 0) break
  }
  return out
}
