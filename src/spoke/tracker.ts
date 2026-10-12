// Sessions this OpenCode process knows about, built from the events it sees, plus which of them
// are exposed to the central server (by mode). Pure: time is passed in.
import type { Mode } from "../config"
import { FORWARDED_EVENTS, type SessionInfo } from "../protocol"

/** A session is "owned" by this process while it viewed or ran it within this window. */
export const OWNED_WINDOW_MS = 30 * 60 * 1000

export interface EventLike {
  readonly type: string
  readonly data?: unknown
  readonly created?: number
}

export interface SessionDetails {
  readonly title: string
  readonly directory: string
  readonly parentID?: string
  readonly updated: number
  /** Workspace root and name (from the service's listing). */
  readonly project?: string
  readonly projectName?: string
}

interface Entry {
  id: string
  title: string
  directory: string
  parentID?: string
  updated: number
  lastActivity?: number
  /** Title/directory are known (from session.created, a lookup, or the listing). */
  info: boolean
  project?: string
  projectName?: string
  /** Came from the service's listing of recent sessions (dropped when it leaves the listing). */
  listed?: boolean
}

const ACTIVITY = new Set([
  "session.viewed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.delivered",
  "permission.asked",
])

const record = (v: unknown): Record<string, any> => (typeof v === "object" && v !== null ? (v as Record<string, any>) : {})

/** The session an event belongs to, if any. */
export function eventSessionID(event: EventLike): string | undefined {
  const data = record(event.data)
  if (typeof data.sessionID === "string" && data.sessionID) return data.sessionID
  const form = record(data.form)
  if (typeof form.sessionID === "string" && form.sessionID) return form.sessionID
  return undefined
}

export class SessionTracker {
  private readonly entries = new Map<string, Entry>()

  /** Applies an event seen in this process. Returns true when the snapshot may have changed. */
  observe(event: EventLike, now: number): boolean {
    const data = record(event.data)
    const id = typeof data.sessionID === "string" && data.sessionID ? data.sessionID : undefined
    if (!id) return false
    const at = typeof event.created === "number" ? event.created : now

    switch (event.type) {
      case "session.created": {
        const entry = this.entry(id, at)
        entry.title = typeof data.title === "string" ? data.title : entry.title
        entry.directory = typeof data.location?.directory === "string" ? data.location.directory : entry.directory
        if (typeof data.parentID === "string" && data.parentID) entry.parentID = data.parentID
        entry.info = true
        entry.lastActivity = now
        return true
      }
      case "session.renamed": {
        const entry = this.entries.get(id)
        if (!entry || typeof data.title !== "string") return false
        entry.title = data.title
        entry.updated = Math.max(entry.updated, at)
        return true
      }
      case "session.deleted":
        return this.entries.delete(id)
      default: {
        if (!ACTIVITY.has(event.type)) return false
        const entry = this.entry(id, at)
        entry.updated = Math.max(entry.updated, at)
        entry.lastActivity = now
        return true
      }
    }
  }

  /**
   * Applies a full listing of the service's recent root sessions. Sessions known only from listings
   * follow it (renames, removal); live sessions keep their live details and only gain the workspace.
   * Returns true when the snapshot may have changed.
   */
  applyListing(sessions: ReadonlyArray<{ readonly id: string } & SessionDetails>, now: number): boolean {
    let changed = false
    const ids = new Set(sessions.map((s) => s.id))
    for (const entry of [...this.entries.values()]) {
      if (!entry.listed || ids.has(entry.id)) continue
      if (entry.lastActivity !== undefined && now - entry.lastActivity <= OWNED_WINDOW_MS) {
        entry.listed = false
        continue
      }
      this.entries.delete(entry.id)
      changed = true
    }
    for (const s of sessions) {
      const existing = this.entries.get(s.id)
      if (!existing) {
        this.entries.set(s.id, {
          id: s.id,
          title: s.title,
          directory: s.directory,
          ...(s.parentID ? { parentID: s.parentID } : {}),
          updated: s.updated,
          info: true,
          listed: true,
          ...workspace(s),
        })
        changed = true
        continue
      }
      const listingOnly = existing.info && existing.lastActivity === undefined
      const next = listingOnly
        ? { title: s.title, directory: s.directory, updated: s.updated }
        : { updated: Math.max(existing.updated, s.updated) }
      const update = { ...next, ...workspace(s), listed: true }
      for (const [key, value] of Object.entries(update) as Array<[keyof Entry, never]>) {
        if (existing[key] === value) continue
        existing[key] = value
        changed = true
      }
    }
    return changed
  }

  /** Fills in details fetched for a session that was first seen through an activity event. */
  setInfo(id: string, details: SessionDetails): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    entry.title = details.title
    entry.directory = details.directory
    if (details.parentID) entry.parentID = details.parentID
    else delete entry.parentID
    if (details.project) entry.project = details.project
    if (details.projectName) entry.projectName = details.projectName
    entry.updated = Math.max(entry.updated, details.updated)
    entry.info = true
    return true
  }

  needsInfo(): string[] {
    return [...this.entries.values()].filter((e) => !e.info).map((e) => e.id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  parentOf(id: string): string | undefined {
    return this.entries.get(id)?.parentID
  }

  /** The top-most known ancestor of a session (itself when it has no known parent). */
  rootOf(id: string): string {
    let current = id
    const seen = new Set<string>([id])
    for (;;) {
      const parent = this.parentOf(current)
      if (!parent || seen.has(parent)) return current
      seen.add(parent)
      current = parent
    }
  }

  /** Lineage from the session up to its root, cycle-safe. */
  lineage(id: string): string[] {
    const out = [id]
    let current = id
    for (;;) {
      const parent = this.parentOf(current)
      if (!parent || out.includes(parent)) return out
      out.push(parent)
      current = parent
    }
  }

  snapshot(now: number): SessionInfo[] {
    return [...this.entries.values()]
      .filter((e) => e.info)
      .map((e) => ({
        id: e.id,
        title: e.title,
        directory: e.directory,
        ...(e.parentID ? { parentID: e.parentID } : {}),
        updated: e.updated,
        owned: e.lastActivity !== undefined && now - e.lastActivity <= OWNED_WINDOW_MS,
        ...(e.project ? { project: e.project } : {}),
        ...(e.projectName ? { projectName: e.projectName } : {}),
      }))
  }

  private entry(id: string, at: number): Entry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { id, title: "", directory: "", updated: at, info: false }
      this.entries.set(id, entry)
    }
    return entry
  }
}

const workspace = (s: SessionDetails) => ({
  ...(s.project ? { project: s.project } : {}),
  ...(s.projectName ? { projectName: s.projectName } : {}),
})

export interface ExposureConfig {
  readonly mode: Mode
  readonly sessions: readonly string[]
}

/** off: nothing; always: everything; session: listed sessions and their descendants. */
export function isExposed(config: ExposureConfig, tracker: SessionTracker, sessionID: string): boolean {
  if (config.mode === "always") return true
  if (config.mode !== "session") return false
  return tracker.lineage(sessionID).some((id) => config.sessions.includes(id))
}

export function shouldForward(config: ExposureConfig, tracker: SessionTracker, event: EventLike): boolean {
  if (!FORWARDED_EVENTS.has(event.type)) return false
  const sessionID = eventSessionID(event)
  return sessionID !== undefined && isExposed(config, tracker, sessionID)
}

/** Most sessions in one snapshot frame, and its size budget (the protocol refuses frames over 1 MB). */
export const SNAPSHOT_MAX = 500
export const SNAPSHOT_MAX_BYTES = 900_000

/**
 * The snapshot for the session browser: every known session with its exposure, except subagent
 * children of unexposed sessions. Over the limits, exposed then most recent sessions are kept.
 */
export function browserSessions(
  config: ExposureConfig,
  tracker: SessionTracker,
  now: number,
  limits: { readonly max?: number; readonly maxBytes?: number } = {},
): Array<SessionInfo & { exposed: boolean }> {
  if (config.mode === "off") return []
  const all = tracker
    .snapshot(now)
    .map((s) => ({ ...s, exposed: isExposed(config, tracker, s.id) }))
    .filter((s) => s.exposed || !s.parentID)
  const max = limits.max ?? SNAPSHOT_MAX
  const maxBytes = limits.maxBytes ?? SNAPSHOT_MAX_BYTES
  if (all.length <= max && JSON.stringify(all).length <= maxBytes) return all
  const ranked = [...all].sort((a, b) => Number(b.exposed) - Number(a.exposed) || b.updated - a.updated)
  const keep = new Set<string>()
  let bytes = 2
  for (const s of ranked) {
    const size = JSON.stringify(s).length + 1
    if (keep.size >= max || bytes + size > maxBytes) break
    bytes += size
    keep.add(s.id)
  }
  return all.filter((s) => keep.has(s.id))
}
