// Pure logic for the session browser on the home screen (no DOM): session state, search with highlights,
// filter chips, pins, and the per-machine view (Needs you, Active now, Workspaces with nested worktrees,
// Standalone processes). Imported by web/app.js and by bun tests.

export const UNTITLED = "Untitled"

/** Filter chips: [id, label]. */
export const FILTERS = [
  ["all", "All"],
  ["active", "Active"],
  ["needs", "Needs you"],
  ["today", "Today"],
  ["voice", "Voice on"],
  ["enabled", "Enabled"],
]

const RANK = { blocked: 0, working: 1, error: 2, idle: 3 }

const trimSlash = (dir) => String(dir ?? "").replace(/(.)[\\/]+$/, "$1")
const basename = (dir) => trimSlash(dir).split(/[\\/]/).pop() || String(dir ?? "")

// ---------- session state ----------

/** Overall state of a session: from its status tree (root first), else its own `state`/`blockers`. */
export function sessionState(s) {
  const status = Array.isArray(s?.status) ? s.status : []
  if (status.length) {
    if (status.some((x) => x.state === "blocked")) return "blocked"
    if (status[0].state === "error") return "error"
    if (status.some((x) => x.state === "working")) return "working"
    return "idle"
  }
  if (s?.blockers?.length) return "blocked"
  return s?.state in RANK ? s.state : "idle"
}

/** Blockers of the whole tree, each with the session it was asked in. */
export function blockersOf(s) {
  const status = Array.isArray(s?.status) ? s.status : []
  const tree = status.length ? status : [{ id: s?.id, title: s?.title, blockers: s?.blockers }]
  return tree.flatMap((x) => (x.blockers ?? []).map((b) => ({ ...b, sessionID: x.id, sessionTitle: x.title })))
}

/** Workspace badge: blocked > working > error > idle. */
export function aggregateState(states) {
  let best = "idle"
  for (const state of states) if ((RANK[state] ?? 3) < RANK[best]) best = state
  return best
}

/** The `now` field of a catalog session ({kind, tool?, summary?}) as one line. */
export function nowLabel(now) {
  if (!now) return undefined
  if (now.kind === "thinking") return "Thinking…"
  const name = now.tool || "tool"
  return now.summary ? `${name} · ${now.summary}` : name
}

// ---------- search ----------

/** Lowercase without diacritics ("Crème" → "creme"). */
export function fold(text) {
  return String(text ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

const words = (query) => fold(query).split(/\s+/).filter(Boolean)

/** Every word of the query appears in the title, project name or directory (case/diacritic-insensitive). */
export function matches(s, query) {
  const tokens = words(query)
  if (!tokens.length) return true
  const fields = [s.title || UNTITLED, s.projectName, s.project, s.directory].filter(Boolean).map(fold)
  return tokens.every((t) => fields.some((f) => f.includes(t)))
}

/** Splits `text` into [{text, hit}] segments, marking where query words match (folded) on the original text. */
export function highlight(text, query) {
  const source = String(text ?? "")
  const tokens = words(query)
  if (!tokens.length || !source) return source ? [{ text: source, hit: false }] : []
  // Folded string, with each folded char mapped back to its original [start, end).
  let folded = ""
  const spans = []
  for (let i = 0; i < source.length; ) {
    const cp = source.codePointAt(i)
    const len = cp > 0xffff ? 2 : 1
    const f = fold(source.slice(i, i + len))
    for (let k = 0; k < f.length; k++) spans.push([i, i + len])
    folded += f
    i += len
  }
  const hit = new Uint8Array(source.length)
  for (const t of tokens) {
    for (let at = folded.indexOf(t); at >= 0; at = folded.indexOf(t, at + 1)) {
      for (let k = spans[at][0]; k < spans[at + t.length - 1][1]; k++) hit[k] = 1
    }
  }
  const out = []
  for (let i = 0; i < source.length; ) {
    let j = i
    while (j < source.length && hit[j] === hit[i]) j++
    out.push({ text: source.slice(i, j), hit: hit[i] === 1 })
    i = j
  }
  return out
}

// ---------- filters ----------

function startOfDay(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function passesFilter(s, filter, now = Date.now()) {
  switch (filter) {
    case "active": {
      const state = sessionState(s)
      return state === "working" || state === "blocked" || !!s.busy
    }
    case "needs":
      return sessionState(s) === "blocked"
    case "today":
      return (s.updated ?? 0) >= startOfDay(now)
    case "voice":
      return !!s.conversation
    case "enabled":
      return s.exposed !== false
    default:
      return true
  }
}

// ---------- pins / stored sets ----------

/** A Set of strings from a stored JSON array; anything else is an empty set. */
export function parseSet(raw) {
  try {
    const value = JSON.parse(raw ?? "null")
    return new Set(Array.isArray(value) ? value.filter((x) => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

/** A copy of `set` with `id` added or removed. */
export function toggleIn(set, id) {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** `dir` relative to `root` ("" for the root itself); the full directory when it is outside. */
export function relativeDir(dir, root) {
  const d = trimSlash(dir)
  const r = trimSlash(root)
  if (d === r) return ""
  return d.startsWith(`${r}/`) ? d.slice(r.length + 1) : d
}

// ---------- machine view ----------

const byPinStateRecent = (a, b) => Number(b.pinned) - Number(a.pinned) || RANK[a.state] - RANK[b.state] || b.updated - a.updated
const byPinRecent = (a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated
const byStateRecent = (a, b) => RANK[a.state] - RANK[b.state] || b.updated - a.updated
const maxUpdated = (rows) => rows.reduce((m, r) => Math.max(m, r.updated ?? 0), 0)

/** Two reports of one session (several processes): the latest wins, live flags from any copy. */
function merge(a, b) {
  const base = (b.updated ?? 0) > (a.updated ?? 0) ? b : a
  return { ...base, conversation: !!(a.conversation || b.conversation), busy: !!(a.busy || b.busy) }
}

/**
 * One machine of the catalog as the home screen shows it. `query`/`filter` narrow every section; `pins` is
 * {sessions: Set, workspaces: Set}. Workspaces come from service processes, grouped by project root
 * (project ?? directory) with other directories (worktrees, subfolders) nested under it.
 */
export function machineView(machine, { query = "", filter = "all", pins, now = Date.now() } = {}) {
  const pinnedSessions = pins?.sessions ?? new Set()
  const pinnedWorkspaces = pins?.workspaces ?? new Set()
  const processes = machine?.processes ?? []
  const all = new Set(processes.flatMap((p) => p.sessions.map((s) => s.id)))
  const isRoot = (s) => !s.parentID || !all.has(s.parentID)

  const merged = new Map()
  for (const p of processes) {
    for (const s of p.sessions) {
      if (!isRoot(s)) continue
      const seen = merged.get(s.id)
      merged.set(s.id, seen ? merge(seen, s) : s)
    }
  }
  const rows = new Map()
  for (const [id, s] of merged) {
    rows.set(id, {
      ...s,
      title: s.title || UNTITLED,
      updated: s.updated ?? 0,
      state: sessionState(s),
      blockers: blockersOf(s),
      exposed: s.exposed !== false,
      pinned: pinnedSessions.has(id),
      nowText: nowLabel(s.now),
    })
  }
  const visible = [...rows.values()].filter((r) => passesFilter(r, filter, now) && matches(r, query))
  const shown = new Set(visible.map((r) => r.id))

  // Workspaces (service processes).
  const service = processes.filter((p) => p.kind === "service")
  const serviceIDs = new Set(service.flatMap((p) => p.sessions.map((s) => s.id)))
  const groups = new Map()
  for (const r of visible) {
    if (!serviceIDs.has(r.id)) continue
    const root = trimSlash(r.project || r.directory)
    let g = groups.get(root)
    if (!g) {
      g = { key: root, root, name: r.projectName || basename(root), rows: [], dirs: new Map() }
      groups.set(root, g)
    }
    const dir = trimSlash(r.directory)
    if (dir === root || !dir) g.rows.push(r)
    else {
      const list = g.dirs.get(dir) ?? []
      list.push(r)
      g.dirs.set(dir, list)
    }
  }
  const workspaces = [...groups.values()]
    .map((g) => {
      const nested = [...g.dirs.entries()]
        .map(([dir, list]) => ({
          key: dir,
          dir,
          rel: relativeDir(dir, g.root),
          rows: list.sort(byPinStateRecent),
          count: list.length,
          state: aggregateState(list.map((r) => r.state)),
          updated: maxUpdated(list),
          pinned: pinnedWorkspaces.has(dir),
        }))
        .sort(byPinRecent)
      const everything = [...g.rows, ...nested.flatMap((x) => x.rows)]
      return {
        key: g.key,
        root: g.root,
        name: g.name,
        rows: g.rows.sort(byPinStateRecent),
        nested,
        count: everything.length,
        state: aggregateState(everything.map((r) => r.state)),
        updated: maxUpdated(everything),
        pinned: pinnedWorkspaces.has(g.key),
      }
    })
    .sort(byPinRecent)

  const standalone = processes
    .filter((p) => p.kind !== "service")
    .map((p) => ({
      id: p.id,
      pid: p.pid,
      directory: p.directory,
      rows: [...new Set(p.sessions.filter((s) => shown.has(s.id)).map((s) => s.id))].map((id) => rows.get(id)).sort(byPinStateRecent),
    }))

  return {
    id: machine?.id,
    name: machine?.name,
    online: !!machine?.online,
    lastSeen: machine?.lastSeen,
    hasService: service.length > 0,
    total: rows.size,
    shown: visible.length,
    pinned: visible.filter((r) => r.pinned).sort(byStateRecent),
    needs: visible.filter((r) => r.state === "blocked").sort(byPinRecent),
    active: visible.filter((r) => r.state === "working").sort(byPinRecent),
    workspaces,
    standalone,
  }
}

/** The first `limit` rows and how many more there are. */
export function page(rows, limit) {
  return { rows: rows.slice(0, limit), more: Math.max(0, rows.length - limit) }
}
/** Stored open/closed choices ({key: boolean} JSON) as a Map; anything else is empty. */
export function parseChoices(raw) {
  try {
    const value = JSON.parse(raw ?? "null")
    if (!value || typeof value !== "object" || Array.isArray(value)) return new Map()
    return new Map(Object.entries(value).filter(([, v]) => typeof v === "boolean"))
  } catch {
    return new Map()
  }
}

const RECENT_MS = 24 * 60 * 60 * 1000

/**
 * Whether a workspace (or nested) group shows its rows. A search opens every group; otherwise the user's
 * stored choice wins; by default groups that are pinned, need attention, are working or changed within a day
 * are open.
 */
export function groupOpen(group, choices, { query = "", now = Date.now() } = {}) {
  if (query.trim()) return true
  const choice = choices?.get(group.key)
  if (choice !== undefined) return choice
  return !!group.pinned || group.state === "blocked" || group.state === "working" || now - (group.updated ?? 0) < RECENT_MS
}
