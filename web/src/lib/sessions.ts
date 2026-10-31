// Session rows of the console: one row per root session across machines (with machine, open source, unread
// and archived/hidden flags), the home table (search, filter chips, sort, persisted in localStorage), the sidebar
// sections (Needs you, Running, Pinned, open-session groups, Recents) and the inactive sessions to archive.
//
// Archive is the hub's own (OpenCode has no archive API yet): archived session IDs are the user's synced
// `hiddenSessions` view pref (the list's name from when Archive was called Hide). Archived sessions show only under
// the Archived chip, except one that needs you, which also shows under Needs you so a question is never missed.
import { RANK, fold, matches, type SessionState } from "../core/browser-core"
import { groupKey, hiddenBy, roots, toRow, type ViewMachine, type ViewPrefs, type ViewRow } from "../core/view-core"
import { retryText, runningJobs } from "../core/jobs-core"
import { treeError } from "../core/error-core"

export type Source = "herdr" | "tui" | "background"

export interface SessionRow extends ViewRow {
  readonly machineName: string
  readonly machineOnline: boolean
  readonly source: Source
  /** The tree works or waits for the user (Steer/Stop apply). */
  readonly running: boolean
  /** Left out of the default views: archived, or in a hidden workspace. */
  readonly hidden: boolean
  /** Archived by ID (Archive / Unarchive). */
  readonly archived: boolean
  readonly unread: boolean
  /** Sidebar/open-group key (`herdr:<id>` or the project folder). */
  readonly group: string
  /** Running shells and terminals in the tree (background jobs). */
  readonly jobs: number
  /** The tree is retrying a model request ("Retrying (attempt 2): Rate limited"). */
  readonly retry?: string
  /** The session failed (state "error"): "Quota exceeded (HTTP 429): <message>", else the message. */
  readonly error?: string
}

/** Every root session of every machine, newest first. */
export function sessionRows(machines: readonly ViewMachine[] | undefined, prefs: ViewPrefs, reads: Readonly<Record<string, number>>): SessionRow[] {
  const pinned = new Set(prefs.pinnedSessions)
  const archived = new Set(prefs.hiddenSessions)
  const hidden = hiddenBy(prefs)
  const out: SessionRow[] = []
  for (const machine of machines ?? []) {
    for (const s of roots(machine)) {
      const row = toRow(s, machine, pinned)
      const source: Source = row.open ? (row.terminal?.source === "herdr" ? "herdr" : "tui") : "background"
      const read = reads[row.id]
      // No countdown here: rows are not re-rendered every second (and stableRows compares them as JSON).
      const retry = row.state === "working" ? retryText(s.status, undefined, Number.POSITIVE_INFINITY) : undefined
      const error = row.state === "error" ? (treeError(s.status, row.id)?.text ?? "Error") : undefined
      out.push({
        ...row,
        machineName: machine.name,
        machineOnline: !!machine.online,
        source,
        running: row.state === "working" || row.state === "blocked",
        hidden: hidden(s),
        archived: archived.has(row.id),
        unread: read !== undefined && row.updated > read,
        group: groupKey(s),
        jobs: runningJobs(s.status),
        ...(retry ? { retry } : {}),
        ...(error ? { error } : {}),
      })
    }
  }
  return out.sort((a, b) => b.updated - a.updated)
}

/**
 * The new rows, reusing the previous object of every row whose content did not change. Lists render rows by
 * object identity, so an unchanged row keeps its DOM (an open ⋯ menu or rename field) when the catalog updates.
 */
export function stableRows(previous: readonly SessionRow[] | undefined, next: SessionRow[]): SessionRow[] {
  if (!previous?.length) return next
  const before = new Map(previous.map((r) => [r.id, r]))
  return next.map((r) => {
    const old = before.get(r.id)
    return old && JSON.stringify(old) === JSON.stringify(r) ? old : r
  })
}

// ---------- home table ----------

export type SortKey = "status" | "title" | "project" | "server" | "source" | "activity"
export type SortDir = "asc" | "desc"

export interface TableFilters {
  status: "all" | "needs" | "running" | "idle"
  source: "all" | "open" | "background"
  /** Machine ID, "" for all. */
  machine: string
  /** Show archived (and hidden) sessions only. */
  archived: boolean
}

export interface TableState {
  query: string
  filters: TableFilters
  sort: { key: SortKey; dir: SortDir }
}

export const DEFAULT_TABLE: TableState = Object.freeze({
  query: "",
  filters: Object.freeze({ status: "all", source: "all", machine: "", archived: false }),
  sort: Object.freeze({ key: "activity", dir: "desc" }),
}) as TableState

const SORT_KEYS: readonly SortKey[] = ["status", "title", "project", "server", "source", "activity"]
const STATUS = ["all", "needs", "running", "idle"] as const
const SOURCE = ["all", "open", "background"] as const

const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" })
const recent = (a: SessionRow, b: SessionRow) => b.updated - a.updated

/** Ascending comparators; "activity" ascending means newest first (the natural reading). */
const COMPARE: Record<SortKey, (a: SessionRow, b: SessionRow) => number> = {
  status: (a, b) => RANK[a.state] - RANK[b.state] || recent(a, b),
  title: (a, b) => text(a.title, b.title) || recent(a, b),
  project: (a, b) => text(a.workspace, b.workspace) || recent(a, b),
  server: (a, b) => text(a.machineName, b.machineName) || recent(a, b),
  source: (a, b) => text(a.source, b.source) || recent(a, b),
  activity: (a, b) => a.updated - b.updated,
}

function passes(r: SessionRow, f: TableFilters): boolean {
  // An archived session that waits for an answer also shows under Needs you (a failed one does not: archiving clears it).
  const needsYou = f.status === "needs" && r.state === "blocked"
  if (f.archived ? !r.hidden : r.hidden && !needsYou) return false
  if (f.status === "needs" && !needsYouNow(r)) return false
  if (f.status === "running" && !r.running) return false
  if (f.status === "idle" && r.running) return false
  if (f.source === "open" && r.source === "background") return false
  if (f.source === "background" && r.source !== "background") return false
  if (f.machine && r.machineID !== f.machine) return false
  return true
}

/** Search (title, project, directory, machine) words must all match somewhere. */
function searched(r: SessionRow, query: string): boolean {
  if (!query.trim()) return true
  if (matches(r, query)) return true
  const words = fold(query).split(/\s+/).filter(Boolean)
  const fields = [r.title, r.workspace, r.where, r.directory, r.machineName].map(fold)
  return words.every((w) => fields.some((f) => f.includes(w)))
}

export function tableRows(rows: readonly SessionRow[], state: TableState): SessionRow[] {
  const compare = COMPARE[state.sort.key]
  const sign = state.sort.key === "activity" ? (state.sort.dir === "desc" ? -1 : 1) : state.sort.dir === "asc" ? 1 : -1
  return rows.filter((r) => passes(r, state.filters) && searched(r, state.query)).sort((a, b) => sign * compare(a, b))
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)

/** Table filters and sort from localStorage (the search box is not kept; unknown keys, e.g. the old voice filter, are dropped). */
export function parseTable(raw: string | null | undefined): TableState {
  let value: Record<string, any>
  try {
    value = JSON.parse(raw ?? "null") ?? {}
    if (typeof value !== "object" || Array.isArray(value)) return DEFAULT_TABLE
  } catch {
    return DEFAULT_TABLE
  }
  const f = (value.filters ?? {}) as Record<string, unknown>
  const s = (value.sort ?? {}) as Record<string, unknown>
  const d = DEFAULT_TABLE
  // An unknown sort key (e.g. the removed "voice" column) resets the whole sort, direction included.
  const key = pick(s.key, SORT_KEYS, d.sort.key)
  const dir = key === s.key ? pick(s.dir, ["asc", "desc"] as const, d.sort.dir) : d.sort.dir
  const sort = key === d.sort.key && dir === d.sort.dir ? d.sort : { key, dir }
  const filters: TableFilters = {
    status: pick(f.status, STATUS, d.filters.status),
    source: pick(f.source, SOURCE, d.filters.source),
    machine: typeof f.machine === "string" && f.machine.length <= 200 ? f.machine : "",
    // `hidden` is the saved Hidden chip from before Archive.
    archived: f.archived === true || f.hidden === true,
  }
  const same = (Object.keys(filters) as Array<keyof TableFilters>).every((k) => filters[k] === d.filters[k])
  if (same && sort === d.sort) return DEFAULT_TABLE
  return { query: "", filters: same ? d.filters : filters, sort }
}

export function serializeTable(state: TableState): string {
  return JSON.stringify({ filters: state.filters, sort: state.sort })
}

// ---------- sidebar ----------

export type GroupBy = "project" | "machine"
export type SidebarSort = "recent" | "title"

export interface SidebarSection {
  readonly id: string
  readonly title: string
  readonly kind: "results" | "needs" | "running" | "pinned" | "group" | "recents"
  /** Groups: the open-group key (`herdr:<id>`, folder) or machine ID. */
  readonly key?: string
  readonly machineID?: string
  /** Groups: default folder for New session here (+). */
  readonly directory?: string
  readonly state?: SessionState
  readonly rows: SessionRow[]
}

/** Waits for an answer (even archived), or failed (a quota or auth error to fix) until it runs again or is archived. */
const needsYouNow = (r: SessionRow): boolean => r.state === "blocked" || (r.state === "error" && !r.hidden)

/**
 * The sidebar: Needs you, Running, Pinned, then sessions open in a terminal grouped by workspace (or server),
 * then the most recent others. Each session appears once; hidden sessions do not appear; a search shows one
 * flat result list.
 */
export function sidebarSections(
  rows: readonly SessionRow[],
  { query, groupBy, sortBy, recentLimit = 20 }: { query: string; groupBy: GroupBy; sortBy: SidebarSort; recentLimit?: number },
): SidebarSection[] {
  const visible = rows.filter((r) => !r.hidden)
  const needsYou = rows.filter(needsYouNow)
  const order = sortBy === "title" ? (a: SessionRow, b: SessionRow) => text(a.title, b.title) || recent(a, b) : recent
  if (query.trim()) return [{ id: "results", title: "Results", kind: "results", rows: visible.filter((r) => searched(r, query)).sort(recent) }]
  const used = new Set<string>()
  const take = (list: SessionRow[]) => {
    for (const r of list) used.add(r.id)
    return list
  }
  const sections: SidebarSection[] = []
  const add = (section: SidebarSection) => section.rows.length && sections.push(section)
  add({ id: "needs", title: "Needs you", kind: "needs", rows: take(needsYou.sort(recent)) })
  add({ id: "running", title: "Running", kind: "running", rows: take(visible.filter((r) => !used.has(r.id) && r.running).sort(recent)) })
  add({ id: "pinned", title: "Pinned", kind: "pinned", rows: take(visible.filter((r) => !used.has(r.id) && r.pinned).sort(order)) })
  const groups = new Map<string, { title: string; key: string; machineID: string; directory: string; rows: SessionRow[] }>()
  for (const r of visible) {
    if (used.has(r.id) || !r.open) continue
    const key = groupBy === "machine" ? r.machineID : `${r.machineID}\u0000${r.group}`
    let g = groups.get(key)
    if (!g) {
      g = {
        title: groupBy === "machine" ? r.machineName : r.workspace,
        key: groupBy === "machine" ? r.machineID : r.group,
        machineID: r.machineID,
        directory: r.directory,
        rows: [],
      }
      groups.set(key, g)
    }
    g.rows.push(r)
  }
  const latest = (list: SessionRow[]) => Math.max(...list.map((r) => r.updated))
  const groupList = [...groups.values()].sort((a, b) =>
    sortBy === "title" ? text(a.title, b.title) || latest(b.rows) - latest(a.rows) : latest(b.rows) - latest(a.rows),
  )
  for (const g of groupList) {
    g.rows.sort(order)
    take(g.rows)
    const byRecency = [...g.rows].sort(recent)
    add({ id: `group:${g.machineID}:${g.key}`, title: g.title, kind: "group", key: g.key, machineID: g.machineID, directory: byRecency[0]!.directory, rows: g.rows })
  }
  add({ id: "recents", title: "Recents", kind: "recents", rows: visible.filter((r) => !used.has(r.id)).sort(recent).slice(0, recentLimit) })
  return sections
}

// ---------- archive inactive sessions ----------

const DAY_MS = 24 * 60 * 60_000

/**
 * Sessions "Archive inactive" archives: not archived or hidden yet, idle, not pinned, not open in a terminal, and
 * without activity for more than `days` (a whole number, at least 1) days.
 */
export function inactiveRows(rows: readonly SessionRow[], days: number, now: number): SessionRow[] {
  if (!Number.isInteger(days) || days < 1) return []
  const before = now - days * DAY_MS
  return rows.filter((r) => !r.hidden && !r.running && !r.pinned && !r.open && r.updated < before)
}

// ---------- live Voice ----------

/**
 * The session is live in Voice: in Voice mode in this browser (`voice` is the app-level controller state), or in
 * a conversation per the catalog. Merely allowing Voice (`exposed`) is not live.
 */
export function voiceLive(row: SessionRow, voice: { readonly phase: string; readonly sessionID?: string }): boolean {
  return (voice.phase !== "off" && voice.sessionID === row.id) || row.conversation === true
}
