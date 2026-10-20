// Sessions this OpenCode process knows about, built from the events it sees, plus which of them
// are exposed to the central server (by mode). Pure: time is passed in.
import type { Mode } from "../config"
import { compactActivity, FORWARDED_EVENTS, type JobInfo, type SessionInfo, type TerminalInfo } from "../protocol"

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

/** Shells and terminals remembered (for the session of their exit). */
const JOBS_KNOWN = 1000

const RUN_END = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

export class SessionTracker {
  private readonly entries = new Map<string, Entry>()
  /** Sessions with a run in progress. */
  private readonly running = new Set<string>()
  /** Pending permission or form ID → its session. */
  private readonly waiting = new Map<string, string>()
  /** Sessions OpenCode reports busy or retrying (session.status). */
  private readonly busy = new Set<string>()
  /** Shell or terminal ID → its session, while known (running or exited, until deleted). */
  private readonly jobs = new Map<string, { sessionID: string; running: boolean }>()

  /** Applies an event seen in this process. Returns true when the snapshot may have changed. */
  observe(event: EventLike, now: number): boolean {
    this.trackActive(event)
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
        this.running.delete(id)
        this.busy.delete(id)
        for (const [jobID, job] of this.jobs) if (job.sessionID === id) this.jobs.delete(jobID)
        for (const [key, sessionID] of this.waiting) if (sessionID === id) this.waiting.delete(key)
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
  applyListing(sessions: ReadonlyArray<{ readonly id: string } & SessionDetails>, now: number, keep: ReadonlySet<string> = new Set()): boolean {
    let changed = false
    const ids = new Set(sessions.map((s) => s.id))
    for (const entry of [...this.entries.values()]) {
      if (!entry.listed || ids.has(entry.id) || keep.has(entry.id)) continue
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

  /**
   * Adds a session known only by ID (e.g. open in a terminal), not owned; its details (and last update)
   * are fetched later. `_now` is accepted for symmetry with observe.
   */
  ensure(id: string, _now: number): boolean {
    if (this.entries.has(id)) return false
    this.entry(id, 0)
    return true
  }

  /**
   * Root sessions with a run in progress, a busy or retrying status, a running shell or terminal, or a pending
   * permission or form somewhere in their tree.
   */
  active(): string[] {
    const roots = new Set<string>()
    const jobs = [...this.jobs.values()].filter((j) => j.running).map((j) => j.sessionID)
    for (const id of [...this.running, ...this.busy, ...jobs, ...this.waiting.values()]) roots.add(this.rootOf(id))
    return [...roots]
  }

  /** Sessions OpenCode reported busy or retrying, or with a running shell or terminal (not their roots). */
  working(): string[] {
    const jobs = [...this.jobs.values()].filter((j) => j.running).map((j) => j.sessionID)
    return [...new Set([...this.busy, ...jobs])]
  }

  /** Directories of known sessions (where to list shells), most recently updated first. */
  directories(max: number): string[] {
    const sorted = [...this.entries.values()].filter((e) => e.directory.startsWith("/")).sort((a, b) => b.updated - a.updated)
    return [...new Set(sorted.map((e) => e.directory))].slice(0, max)
  }

  /** The session a shell or terminal belongs to, while known. */
  jobSession(jobID: string): string | undefined {
    return this.jobs.get(jobID)?.sessionID
  }

  /** Replaces a session's status and running jobs with a snapshot (fetched at startup or after a reconnect). */
  seed(sessionID: string, snapshot: { readonly status: "idle" | "busy" | "retry"; readonly jobs: readonly JobInfo[] }): void {
    if (snapshot.status === "idle") this.busy.delete(sessionID)
    else this.busy.add(sessionID)
    for (const [jobID, job] of this.jobs) if (job.sessionID === sessionID && job.running) this.jobs.delete(jobID)
    for (const job of snapshot.jobs) this.setJob(job.id, sessionID, job.status === "running")
  }

  /** Session status and shells/terminals (compacted so the session of an exit is resolved). */
  private trackJobs(event: EventLike): void {
    if (event.type !== "session.status" && !event.type.startsWith("shell.") && !event.type.startsWith("pty.") && !event.type.startsWith("session.shell.")) return
    const compact = compactActivity({ type: event.type, data: record(event.data) }, (id) => this.jobSession(id))
    if (!compact) return
    const data = compact.data as Record<string, any>
    const sessionID = data.sessionID as string
    if (compact.type === "session.status") {
      if (data.status.type === "idle") this.busy.delete(sessionID)
      else this.busy.add(sessionID)
    } else if (compact.type.endsWith(".deleted")) this.jobs.delete(data.id)
    else if (typeof data.id === "string" && typeof data.status === "string") this.setJob(data.id, sessionID, data.status === "running")
  }

  /** Remembers a job, keeping at most JOBS_KNOWN (oldest dropped). */
  private setJob(id: string, sessionID: string, running: boolean): void {
    this.jobs.delete(id)
    this.jobs.set(id, { sessionID, running })
    if (this.jobs.size > JOBS_KNOWN) this.jobs.delete(this.jobs.keys().next().value!)
  }

  private trackActive(event: EventLike): void {
    this.trackJobs(event)
    const data = record(event.data)
    const sessionID = eventSessionID(event)
    if (event.type === "session.execution.started" && sessionID) this.running.add(sessionID)
    else if (RUN_END.has(event.type) && sessionID) {
      this.running.delete(sessionID)
      // OpenCode v2 sends no idle status: a run's end ends a busy status (seeded or reported) too.
      this.busy.delete(sessionID)
    }
    else if (event.type === "permission.asked" && sessionID && typeof data.id === "string") this.waiting.set(`per ${data.id}`, sessionID)
    else if (event.type === "permission.replied" && typeof data.requestID === "string") this.waiting.delete(`per ${data.requestID}`)
    else if (event.type === "form.created" && sessionID && typeof record(data.form).id === "string") this.waiting.set(`frm ${record(data.form).id}`, sessionID)
    else if ((event.type === "form.replied" || event.type === "form.cancelled") && typeof (record(data.form).id ?? data.formID ?? data.id) === "string") {
      this.waiting.delete(`frm ${record(data.form).id ?? data.formID ?? data.id}`)
    }
  }

  /** A form (question) this process saw asked and not yet replied or cancelled. */
  formPending(formID: string): boolean {
    return this.waiting.has(`frm ${formID}`)
  }

  /** Running sessions strictly below a root, deepest first. */
  runningBelow(root: string): string[] {
    return [...this.running]
      .filter((id) => id !== root && this.lineage(id).includes(root))
      .sort((a, b) => this.lineage(b).length - this.lineage(a).length)
  }

  needsInfo(): string[] {
    return [...this.entries.values()].filter((e) => !e.info).map((e) => e.id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  directoryOf(id: string): string | undefined {
    return this.entries.get(id)?.directory || undefined
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

/** Remote inspection and control: any session this process knows while connected (mode not "off"). Voice is separate. */
export function isReported(config: ExposureConfig, tracker: SessionTracker, sessionID: string): boolean {
  return config.mode !== "off" && (tracker.has(sessionID) || isExposed(config, tracker, sessionID))
}

export function shouldForward(config: ExposureConfig, tracker: SessionTracker, event: EventLike): boolean {
  if (!FORWARDED_EVENTS.has(event.type)) return false
  const sessionID = eventSessionID(event)
  return sessionID !== undefined && isReported(config, tracker, sessionID)
}

/** Most sessions in one snapshot frame, and its size budget (the protocol refuses frames over 1 MB). */
export const SNAPSHOT_MAX = 500
export const SNAPSHOT_MAX_BYTES = 900_000

/**
 * The snapshot for the session browser: every known session with its Voice exposure. Over the limits,
 * open, then exposed, then most recent sessions are kept.
 */
export function browserSessions(
  config: ExposureConfig,
  tracker: SessionTracker,
  now: number,
  limits: {
    readonly max?: number
    readonly maxBytes?: number
    /** Where a session is open right now (Herdr pane or TUI), if it is. */
    readonly terminal?: (sessionID: string) => TerminalInfo | undefined
  } = {},
): Array<SessionInfo & { exposed: boolean }> {
  if (config.mode === "off") return []
  const all = tracker
    .snapshot(now)
    .map((s) => {
      const terminal = limits.terminal?.(s.id)
      return { ...s, exposed: isExposed(config, tracker, s.id), ...(terminal ? { open: true, terminal } : {}) }
    })
  const max = limits.max ?? SNAPSHOT_MAX
  const maxBytes = limits.maxBytes ?? SNAPSHOT_MAX_BYTES
  if (all.length <= max && JSON.stringify(all).length <= maxBytes) return all
  const ranked = [...all].sort((a, b) => Number(b.open === true) - Number(a.open === true) || Number(b.exposed) - Number(a.exposed) || b.updated - a.updated)
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
