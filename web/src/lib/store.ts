// Shared hub state of the console and what each SSE message (/api/events) does to it. The reducers mutate a
// plain object (the Solid store applies them through `produce`), so they are tested without a DOM. Activity
// feeds (class instances, one per root session) live in LiveFeeds beside the store.
import { ActivityFeed, type ActivityItem, type StatusEntry } from "../core/feedback-core"
import { normalizePrefs, type ViewMachine, type ViewPrefs, type ViewProcess, type ViewSession } from "../core/view-core"

export type Connection = "connecting" | "live" | "down"

export interface HubState {
  machines: ViewMachine[] | undefined
  reads: Record<string, number>
  prefs: ViewPrefs
  /** "hub" once GET /api/prefs/view answered; "local" on hubs without it; "error" after a failed load. */
  prefsSource: "unknown" | "hub" | "local" | "error"
  prefsPending: number
  prefsStale: boolean
  connection: Connection
  enrollmentRev: number
  notice?: { kind: "handoff"; sessionID: string; at: number }
}

export const initialHub = (): HubState => ({
  machines: undefined,
  reads: {},
  prefs: normalizePrefs({}),
  prefsSource: "unknown",
  prefsPending: 0,
  prefsStale: false,
  connection: "connecting",
  enrollmentRev: 0,
})

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value)

type Mutable = { status?: unknown; conversation?: unknown }

function eachSession(machines: ViewMachine[] | undefined, id: string, fn: (s: Mutable) => void): void {
  for (const machine of machines ?? []) for (const p of machine.processes) for (const s of p.sessions) if (s.id === id) fn(s as unknown as Mutable)
}

/** Applies one SSE message to the state; returns whether anything changed. */
export function applyMessage(state: HubState, message: unknown): boolean {
  if (!isRecord(message) || typeof message.type !== "string") return false
  switch (message.type) {
    case "catalog":
      if (!Array.isArray(message.machines)) return false
      state.machines = message.machines as ViewMachine[]
      return true
    case "status": {
      if (typeof message.sessionID !== "string" || !Array.isArray(message.sessions)) return false
      let found = false
      eachSession(state.machines, message.sessionID, (s) => {
        s.status = message.sessions
        found = true
      })
      return found
    }
    case "conversation": {
      if (typeof message.sessionID !== "string" || typeof message.on !== "boolean") return false
      let found = false
      eachSession(state.machines, message.sessionID, (s) => {
        s.conversation = message.on
        found = true
      })
      return found
    }
    case "reads":
      if (!isRecord(message.reads)) return false
      state.reads = Object.fromEntries(Object.entries(message.reads).filter((e): e is [string, number] => typeof e[1] === "number"))
      return true
    case "prefs":
      if (state.prefsSource !== "hub") return false
      if (state.prefsPending) {
        state.prefsStale = true
        return true
      }
      state.prefs = normalizePrefs(message.prefs)
      return true
    case "enrollment":
      state.enrollmentRev++
      return true
    case "handoff":
      if (typeof message.sessionID !== "string") return false
      state.notice = { kind: "handoff", sessionID: message.sessionID, at: Date.now() }
      return true
    default:
      return false
  }
}

export interface Found {
  readonly session: ViewSession & { status?: readonly StatusEntry[] }
  readonly machine: ViewMachine
  readonly process: ViewProcess
}

/**
 * The most recently updated report of a session, with the machine and process that report it. A subagent
 * session no process lists is found through its root's status tree: then `session.rootID` is that root.
 */
export function findSession(machines: readonly ViewMachine[] | undefined, id: string): Found | undefined {
  let best: Found | undefined
  for (const machine of machines ?? []) {
    for (const process of machine.processes) {
      const session = process.sessions.find((x) => x.id === id)
      if (session && (!best || (session.updated ?? 0) > (best.session.updated ?? 0))) best = { session, machine, process }
    }
  }
  return best ?? findChild(machines, id)
}

type Node = { readonly id?: string; readonly parentID?: string; readonly title?: string; readonly state?: string; readonly blockers?: readonly unknown[] }

function findChild(machines: readonly ViewMachine[] | undefined, id: string): Found | undefined {
  for (const machine of machines ?? []) {
    for (const process of machine.processes) {
      for (const root of process.sessions) {
        const tree = (Array.isArray(root.status) ? root.status : []) as readonly Node[]
        const own = tree.find((n) => n.id === id)
        if (!own || root.id === id) continue
        const below = subtree(tree, id)
        const nodes = tree.filter((n) => n.id && below.has(n.id))
        const state = nodes.some((n) => n.state === "blocked") ? "blocked" : own.state === "error" ? "error" : nodes.some((n) => n.state === "working") ? "working" : "idle"
        const session = {
          ...root,
          id,
          title: own.title ?? "",
          ...(own.parentID ? { parentID: own.parentID } : {}),
          rootID: root.id,
          state,
          blockers: (own.blockers ?? []) as never,
          busy: false,
          conversation: false,
        } as Found["session"]
        return { session, machine, process }
      }
    }
  }
  return undefined
}

/** A session and every session below it in a status tree (parentID links). */
export function subtree(status: ReadonlyArray<{ readonly id?: string; readonly parentID?: string }> | undefined, id: string): Set<string> {
  const out = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const n of status ?? []) {
      if (n.id && n.parentID && out.has(n.parentID) && !out.has(n.id)) {
        out.add(n.id)
        grew = true
      }
    }
  }
  return out
}

/** A session updated after the user last read it (never-read sessions are not marked). */
export function isUnread(id: string, updated: number | undefined, reads: Readonly<Record<string, number>>): boolean {
  const read = reads[id]
  return read !== undefined && (updated ?? 0) > read
}

/** The tree works or waits for the user: typed input steers and Stop applies. */
export function treeRunning(status: readonly { readonly id?: string; readonly state: string }[] | undefined): boolean {
  return (status ?? []).some((s) => s.state === "working" || s.state === "blocked")
}

/** Activity feeds of root sessions (what each is doing now), fed by activity, delta, reasoning and status. */
export class LiveFeeds {
  private feeds = new Map<string, ActivityFeed>()
  constructor(private readonly max = 50) {}

  has(rootID: string): boolean {
    return this.feeds.has(rootID)
  }

  feed(rootID: string, seed?: readonly StatusEntry[]): ActivityFeed {
    let feed = this.feeds.get(rootID)
    if (!feed) {
      feed = new ActivityFeed(rootID)
      if (seed) feed.status(seed)
      this.feeds.set(rootID, feed)
      while (this.feeds.size > this.max) this.feeds.delete(this.feeds.keys().next().value as string)
    }
    return feed
  }

  /** Routes one SSE message; returns the root session it changed, if any. */
  apply(message: unknown): string | undefined {
    if (!isRecord(message)) return undefined
    const sessionID = typeof message.sessionID === "string" ? message.sessionID : undefined
    if (!sessionID) return undefined
    const rootID = typeof message.rootID === "string" ? message.rootID : sessionID
    const messageID = typeof message.messageID === "string" ? message.messageID : undefined
    switch (message.type) {
      case "activity":
        if (!isRecord(message.item)) return undefined
        this.feed(rootID).activity(sessionID, message.item as ActivityItem)
        return rootID
      case "delta":
        if (typeof message.text !== "string" || !message.text) return undefined
        this.feed(rootID).text(sessionID, messageID, message.text)
        return rootID
      case "reasoning":
        if (typeof message.delta !== "string" || !message.delta) return undefined
        this.feed(rootID).reasoning(sessionID, messageID ?? "unknown", message.delta)
        return rootID
      case "status":
        if (!Array.isArray(message.sessions)) return undefined
        this.feed(sessionID).status(message.sessions as StatusEntry[])
        return sessionID
      default:
        return undefined
    }
  }
}
