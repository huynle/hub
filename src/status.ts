// Live status of a voice session and the subagent sessions it spawns, built from OpenCode events.

export type SessionState = "idle" | "working" | "blocked" | "error"

export interface Blocker {
  readonly kind: "permission" | "form"
  readonly id: string
  readonly summary: string
}

export interface SessionStatus {
  readonly id: string
  readonly parentID?: string
  readonly title: string
  readonly state: SessionState
  readonly detail?: string
  readonly blockers: ReadonlyArray<Blocker>
}

interface Entry {
  id: string
  parentID?: string
  title: string
  running: boolean
  error?: string
  blockers: Blocker[]
}

interface EventLike {
  readonly type: string
  readonly data?: unknown
}

export class StatusBoard {
  private readonly sessions = new Map<string, Entry>()

  constructor(rootID: string, title: string) {
    this.sessions.set(rootID, { id: rootID, title, running: false, blockers: [] })
  }

  /** Applies an event. Returns true when the visible status changed. */
  observe(event: EventLike): boolean {
    const data = (event.data ?? {}) as Record<string, any>
    switch (event.type) {
      case "session.created": {
        if (typeof data.parentID !== "string" || !this.sessions.has(data.parentID)) return false
        this.sessions.set(data.sessionID, {
          id: data.sessionID,
          parentID: data.parentID,
          title: data.title ?? data.agent ?? data.slug ?? "subagent",
          running: false,
          blockers: [],
        })
        return true
      }
      case "session.renamed":
        return this.update(data.sessionID, (entry) => (entry.title = data.title))
      case "session.deleted":
        return this.sessions.delete(data.sessionID)
      case "session.execution.started":
        return this.update(data.sessionID, (entry) => {
          entry.running = true
          entry.error = undefined
        })
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        return this.update(data.sessionID, (entry) => (entry.running = false))
      case "session.execution.failed":
        return this.update(data.sessionID, (entry) => {
          entry.running = false
          entry.error = String(data.error?.message ?? "failed")
        })
      case "permission.asked":
        return this.update(data.sessionID, (entry) =>
          entry.blockers.push({
            kind: "permission",
            id: data.id,
            summary: [data.action, (data.resources ?? []).join(", ")].filter(Boolean).join(": "),
          }),
        )
      case "permission.replied":
        return this.unblock(data.sessionID, data.requestID)
      case "form.created":
        return this.update(data.form?.sessionID, (entry) =>
          entry.blockers.push({ kind: "form", id: data.form.id, summary: data.form.title ?? "question" }),
        )
      case "form.replied":
      case "form.cancelled":
        return this.unblock(data.sessionID, data.id)
      default:
        return false
    }
  }

  get(id: string): SessionStatus | undefined {
    const entry = this.sessions.get(id)
    return entry && view(entry)
  }

  ids(): string[] {
    return [...this.sessions.keys()]
  }

  snapshot(): { sessions: SessionStatus[] } {
    return { sessions: [...this.sessions.values()].map(view) }
  }

  private update(id: unknown, change: (entry: Entry) => void): boolean {
    const entry = typeof id === "string" ? this.sessions.get(id) : undefined
    if (!entry) return false
    change(entry)
    return true
  }

  private unblock(sessionID: unknown, blockerID: unknown): boolean {
    return this.update(sessionID, (entry) => {
      entry.blockers = entry.blockers.filter((blocker) => blocker.id !== blockerID)
    })
  }
}

function view(entry: Entry): SessionStatus {
  const state: SessionState =
    entry.blockers.length > 0 ? "blocked" : entry.error ? "error" : entry.running ? "working" : "idle"
  return {
    id: entry.id,
    ...(entry.parentID ? { parentID: entry.parentID } : {}),
    title: entry.title,
    state,
    ...(entry.error && state === "error" ? { detail: entry.error } : {}),
    blockers: entry.blockers.map((blocker) => ({ ...blocker })),
  }
}
