// Pure logic for the 0.4.0 home screen (docs/session-view.md), no DOM: synced view prefs (hide/pin), migration
// of 0.3 local pins, the Open / Recent / Hidden split, Herdr-like grouping and ordering of open sessions, status
// dots and new-session targets. Imported by web/app.js and by bun tests.

import { UNTITLED, aggregateState, blockersOf, nowLabel, relativeDir, sessionState } from "./browser-core.js"

const RANK = { blocked: 0, working: 1, error: 2, idle: 3 }
const trimSlash = (dir) => String(dir ?? "").replace(/(.)[\\/]+$/, "$1")
const basename = (dir) => trimSlash(dir).split(/[\\/]/).pop() || String(dir ?? "")

// ---------- view prefs ----------

/** The synced lists (GET/PUT /api/prefs/view). */
export const PREF_LISTS = ["hiddenSessions", "hiddenWorkspaces", "pinnedSessions", "pinnedWorkspaces"]
const MAX_ENTRIES = 500
const MAX_KEY = 4096

const cleanList = (value) =>
  Array.isArray(value) ? [...new Set(value.filter((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_KEY))].slice(0, MAX_ENTRIES) : []

/** Prefs from the hub (a prefs object or {prefs}); every list present, unique strings, at most 500 each. */
export function normalizePrefs(raw) {
  const source = raw && typeof raw === "object" && raw.prefs && typeof raw.prefs === "object" ? raw.prefs : raw ?? {}
  return Object.fromEntries(PREF_LISTS.map((list) => [list, cleanList(source[list])]))
}

/** Adds (`on`) or removes `key` in one list. Returns the new prefs and the PUT patch (undefined: no change). */
export function setPref(prefs, list, key, on) {
  if (!PREF_LISTS.includes(list)) throw new Error(`unknown prefs list: ${list}`)
  const current = prefs[list] ?? []
  const has = current.includes(key)
  if (has === on) return { prefs, patch: undefined }
  const next = on ? [...current, key] : current.filter((x) => x !== key)
  return { prefs: { ...prefs, [list]: next }, patch: { [list]: next } }
}

const parseList = (raw) => {
  try {
    const value = JSON.parse(raw ?? "null")
    return Array.isArray(value) ? value.filter((x) => typeof x === "string") : []
  } catch {
    return []
  }
}

/**
 * 0.3 kept pins in localStorage (session IDs; workspace/worktree folders). Merges them into the synced prefs:
 * `patch` to PUT (undefined when prefs already have them), `clear` when local keys exist and should be removed.
 */
export function migratePins(rawSessions, rawWorkspaces, prefs) {
  const clear = rawSessions != null || rawWorkspaces != null
  const patch = {}
  for (const [list, raw] of [["pinnedSessions", rawSessions], ["pinnedWorkspaces", rawWorkspaces]]) {
    const current = prefs[list] ?? []
    const add = parseList(raw).filter((x) => !current.includes(x))
    if (add.length) patch[list] = cleanList([...current, ...add])
  }
  return { clear, patch: Object.keys(patch).length ? patch : undefined }
}

// ---------- sessions ----------

/** Herdr's agent status as a session state ("done"/"unknown" count as idle). */
const TERMINAL_STATE = { working: "working", blocked: "blocked" }

/** Status dot of a session: the worse of Herdr's agent status and the session's own state. */
export function dotState(s) {
  return aggregateState([sessionState(s), TERMINAL_STATE[s?.terminal?.status] ?? "idle"])
}

const isHerdr = (s) => !!s?.open && s.terminal?.source === "herdr" && !!s.terminal.workspaceID
/** Project folder of a session (the Recent tab's workspace key, and the Open tab's key outside Herdr). */
export const folderKey = (s) => trimSlash(s?.project || s?.directory)

/** Open-tab group key: `herdr:<workspaceID>` when open in Herdr, else the project folder. */
export function groupKey(s) {
  return isHerdr(s) ? `herdr:${s.terminal.workspaceID}` : folderKey(s)
}

/** Whether a hidden workspace key covers a session: its project folder, its own folder, or its Herdr workspace. */
const inWorkspace = (s, key) => folderKey(s) === key || trimSlash(s.directory) === key || (isHerdr(s) && groupKey(s) === key)

/** Hidden by its ID, or by a hidden workspace (project folder, nested folder such as a worktree, Herdr workspace). */
function isHidden(s, hidden) {
  if (hidden.sessions.has(s.id)) return true
  for (const key of hidden.workspaces) if (inWorkspace(s, key)) return true
  return false
}

/** Two reports of one session (several processes): the latest wins; live flags and terminal from any copy. */
function merge(a, b) {
  const base = (b.updated ?? 0) > (a.updated ?? 0) ? b : a
  const open = a.open ? a : b.open ? b : undefined
  return {
    ...base,
    conversation: !!(a.conversation || b.conversation),
    busy: !!(a.busy || b.busy),
    ...(open ? { open: true, terminal: open.terminal } : {}),
  }
}

/** Root sessions of a machine, one per ID. */
function roots(machine) {
  const processes = machine?.processes ?? []
  const all = new Set(processes.flatMap((p) => p.sessions.map((s) => s.id)))
  const merged = new Map()
  for (const p of processes) {
    for (const s of p.sessions) {
      if (s.parentID && all.has(s.parentID)) continue
      const seen = merged.get(s.id)
      merged.set(s.id, seen ? merge(seen, s) : s)
    }
  }
  return [...merged.values()]
}

const hiddenSets = (prefs) => ({ sessions: new Set(prefs?.hiddenSessions ?? []), workspaces: new Set(prefs?.hiddenWorkspaces ?? []) })
const herdrWorkspaces = (machine) => machine?.terminals?.herdr?.workspaces ?? []

/** Short folder line: project name, plus the path inside the project (worktree, subfolder). */
function whereOf(s) {
  const root = trimSlash(s.project || s.directory)
  const rel = s.project ? relativeDir(s.directory, root) : ""
  return `${s.projectName || basename(root)}${rel ? ` › ${rel}` : ""}`
}

function toRow(s, machine, pinned) {
  const ws = isHerdr(s) ? s.terminal.workspace || herdrWorkspaces(machine).find((w) => w.id === s.terminal.workspaceID)?.label || s.terminal.workspaceID : undefined
  return {
    ...s,
    title: s.title || s.terminal?.title || UNTITLED,
    updated: s.updated ?? 0,
    state: dotState(s),
    blockers: blockersOf(s),
    exposed: s.exposed !== false,
    pinned: pinned.has(s.id),
    nowText: nowLabel(s.now),
    where: whereOf(s),
    workspace: ws ?? (s.projectName || basename(folderKey(s))),
    machineID: machine?.id,
  }
}

const byPinStateRecent = (a, b) => Number(b.pinned) - Number(a.pinned) || RANK[a.state] - RANK[b.state] || b.updated - a.updated
const maxUpdated = (rows) => rows.reduce((m, r) => Math.max(m, r.updated), 0)

/** Open sessions grouped like Herdr's sidebar, plus sessions running outside a terminal ("background"). */
function openGroups(machine, open, pinnedWorkspaces) {
  const order = new Map(herdrWorkspaces(machine).map((w, i) => [w.id, i]))
  const groups = new Map()
  for (const r of open) {
    const key = groupKey(r)
    let g = groups.get(key)
    if (!g) {
      const herdr = isHerdr(r)
      const known = herdr ? herdrWorkspaces(machine).find((w) => w.id === r.terminal.workspaceID) : undefined
      g = {
        key,
        kind: herdr ? "herdr" : "folder",
        name: r.workspace,
        ...(herdr ? { workspaceID: r.terminal.workspaceID } : {}),
        directory: known?.directories?.[0] ?? (herdr ? undefined : key),
        order: herdr ? order.get(r.terminal.workspaceID) ?? Infinity : Infinity,
        rows: [],
      }
      groups.set(key, g)
    }
    g.rows.push(r)
  }
  return [...groups.values()]
    .map((g) => {
      g.rows.sort(byPinStateRecent)
      return {
        ...g,
        directory: g.directory ?? g.rows[0].directory,
        state: aggregateState(g.rows.map((r) => r.state)),
        updated: maxUpdated(g.rows),
        pinned: pinnedWorkspaces.has(g.key),
      }
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || b.updated - a.updated)
}

/**
 * Everything the home screen shows, from the catalog machines and the synced prefs:
 * `needs` (blocked, any machine, not hidden), per machine the Open tab (`open.groups`, `open.background`), and
 * tab counts (open sessions, other history, hidden entries as listed by hiddenView).
 */
export function homeView(machines, prefs, { now = Date.now() } = {}) {
  const hidden = hiddenSets(prefs)
  const pinned = new Set(prefs?.pinnedSessions ?? [])
  const pinnedWorkspaces = new Set(prefs?.pinnedWorkspaces ?? [])
  const counts = { open: 0, recent: 0, hidden: 0 }
  const needs = []
  const views = (machines ?? []).map((machine) => {
    const rows = roots(machine)
      .filter((s) => !isHidden(s, hidden))
      .map((s) => toRow(s, machine, pinned))
    const open = rows.filter((r) => r.open)
    const rest = rows.filter((r) => !r.open)
    counts.open += open.length
    counts.recent += rest.length
    needs.push(...rows.filter((r) => r.state === "blocked"))
    return {
      id: machine.id,
      name: machine.name,
      online: !!machine.online,
      lastSeen: machine.lastSeen,
      herdr: !!machine.terminals?.herdr,
      open: {
        groups: openGroups(machine, open, pinnedWorkspaces),
        background: rest.filter((r) => r.state === "working" || r.conversation).sort(byPinStateRecent),
      },
    }
  })
  const h = hiddenView(machines, prefs)
  counts.hidden = h.sessions.length + h.workspaces.length
  needs.sort((a, b) => b.updated - a.updated)
  return { now, needs, counts, machines: views }
}

/** A catalog machine reduced to the Recent tab: root sessions that are neither open nor hidden. */
export function recentMachine(machine, prefs) {
  const hidden = hiddenSets(prefs)
  const keep = new Set(roots(machine).filter((s) => !s.open && !isHidden(s, hidden)).map((s) => s.id))
  return {
    ...machine,
    processes: (machine?.processes ?? []).map((p) => ({ ...p, sessions: p.sessions.filter((s) => keep.has(s.id)) })),
  }
}

/** The Hidden tab: hidden workspaces (named, with how many sessions they hide) and hidden sessions, all machines. */
export function hiddenView(machines, prefs) {
  const all = (machines ?? []).flatMap((m) => roots(m).map((s) => ({ s, m })))
  const workspaces = (prefs?.hiddenWorkspaces ?? []).map((key) => {
    const inside = all.filter(({ s }) => inWorkspace(s, key))
    let name
    if (key.startsWith("herdr:")) {
      const id = key.slice(6)
      const known = (machines ?? []).flatMap(herdrWorkspaces).find((w) => w.id === id)
      name = known?.label || inside[0]?.s.terminal?.workspace || `Herdr workspace ${id}`
    } else {
      const s = inside.find(({ s }) => folderKey(s) === key || trimSlash(s.directory) === key)?.s
      name = !s ? basename(key) : folderKey(s) === key ? s.projectName || basename(key) : whereOf(s)
    }
    return { key, name, count: inside.length }
  })
  const ids = new Set(prefs?.hiddenSessions ?? [])
  const sessions = all.filter(({ s }) => ids.has(s.id)).map(({ s, m }) => toRow(s, m, new Set(prefs?.pinnedSessions ?? [])))
  sessions.sort((a, b) => b.updated - a.updated)
  return { workspaces, sessions, unknown: ids.size - new Set(sessions.map((r) => r.id)).size }
}

// ---------- new session ----------

const MAX_FOLDERS = 50
const TITLE_MAX = 200

/**
 * Where a new session can go on a machine: Herdr workspaces first (Herdr's order, with their pane folders),
 * then other known folders (session folders and project roots, not already under a Herdr workspace), most
 * recently active first. `herdr` says whether the machine reports Herdr ("Open in Herdr" toggle).
 */
export function newSessionTargets(machine) {
  const herdr = herdrWorkspaces(machine).map((w) => ({
    kind: "herdr",
    key: `herdr:${w.id}`,
    workspaceID: w.id,
    label: w.label || w.id,
    directories: [...(w.directories ?? [])],
  }))
  const taken = new Set(herdr.flatMap((t) => t.directories.map(trimSlash)))
  const sessions = roots(machine)
  const activity = new Map()
  const names = new Map()
  for (const s of sessions) {
    const dir = trimSlash(s.directory)
    if (!dir) continue
    activity.set(dir, Math.max(activity.get(dir) ?? 0, s.updated ?? 0))
    names.set(dir, whereOf(s))
  }
  for (const s of sessions) {
    const root = trimSlash(s.project)
    if (!root || names.has(root)) continue
    const latest = Math.max(...sessions.filter((x) => trimSlash(x.project) === root).map((x) => x.updated ?? 0))
    activity.set(root, latest)
    names.set(root, s.projectName || basename(root))
  }
  const folders = [...activity.entries()]
    .filter(([dir]) => !taken.has(dir))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FOLDERS)
    .map(([dir]) => ({ kind: "folder", key: dir, label: names.get(dir), directories: [dir] }))
  return { herdr: !!machine?.terminals?.herdr, targets: [...herdr, ...folders] }
}

/** Body of POST /api/machines/:id/sessions. */
export function createBody({ target, directory, title, openInHerdr }) {
  const body = { directory }
  const name = String(title ?? "").trim().slice(0, TITLE_MAX)
  if (name) body.title = name
  if (openInHerdr && target?.kind === "herdr" && target.workspaceID) body.herdrWorkspace = target.workspaceID
  return body
}
