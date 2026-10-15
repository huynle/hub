// Session browser (home screen): grouping by workspace with nested worktrees, aggregate state, sorting,
// filters, diacritic-insensitive search with highlights, pins, paging.
import { describe, expect, test } from "bun:test"
import {
  FILTERS,
  aggregateState,
  blockersOf,
  fold,
  groupOpen,
  highlight,
  machineView as typedMachineView,
  matches,
  nowLabel,
  page,
  parseChoices,
  parseSet,
  passesFilter,
  relativeDir,
  sessionState,
  toggleIn,
} from "../web/src/core/browser-core"

const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime()
const MIN = 60_000
const REPO = "/home/user/projects/opencode-voice"
const SHOP = "/home/user/projects/webshop"

type S = any
// Loosely typed so tests can index groups and rows directly (noUncheckedIndexedAccess).
const machineView = (...args: Parameters<typeof typedMachineView>): S => typedMachineView(...args)
let n = 0
const ses = (extra: S = {}): S => ({
  id: `ses_${++n}`,
  title: `Session ${n}`,
  directory: REPO,
  project: REPO,
  projectName: "opencode-voice",
  updated: NOW - n * MIN,
  owned: false,
  exposed: true,
  busy: false,
  conversation: false,
  status: [],
  ...extra,
})
const st = (id: string, state: string, blockers: S[] = []) => [{ id, title: "t", state, blockers }]
const blocked = (extra: S = {}) => {
  const s = ses(extra)
  s.status = st(s.id, "blocked", [{ id: "per_1", kind: "permission", summary: "shell: rm -rf build" }])
  return s
}
const working = (extra: S = {}) => {
  const s = ses(extra)
  s.status = st(s.id, "working")
  return s
}
const machine = (service: S[], standalone: Array<{ pid: number; directory: string; sessions: S[] }> = []) => ({
  id: "mac_1",
  name: "laptop",
  online: true,
  lastSeen: NOW,
  processes: [
    { id: "proc_svc", kind: "service", directory: "/home/user", pid: 100, sessions: service },
    ...standalone.map((p, i) => ({ id: `proc_${i}`, kind: "standalone", ...p })),
  ],
})
const pins = (sessions: string[] = [], workspaces: string[] = []) => ({ sessions: new Set(sessions), workspaces: new Set(workspaces) })
const ids = (rows: S[]) => rows.map((r) => r.id)

describe("session state", () => {
  test("from the status tree: blocked anywhere > root error > working anywhere > idle", () => {
    expect(sessionState(ses())).toBe("idle")
    expect(sessionState(ses({ status: [{ id: "a", state: "idle", blockers: [] }, { id: "b", state: "working", blockers: [] }] }))).toBe("working")
    expect(sessionState(ses({ status: [{ id: "a", state: "working", blockers: [] }, { id: "b", state: "blocked", blockers: [] }] }))).toBe("blocked")
    expect(sessionState(ses({ status: [{ id: "a", state: "error", blockers: [] }] }))).toBe("error")
  })

  test("falls back to the session's own state and blockers when there is no status tree", () => {
    expect(sessionState(ses({ state: "working" }))).toBe("working")
    const s = ses({ state: "blocked", blockers: [{ id: "q1", kind: "question", summary: "Which branch?" }] })
    expect(sessionState(s)).toBe("blocked")
    expect(blockersOf(s)).toEqual([{ id: "q1", kind: "question", summary: "Which branch?", sessionID: s.id, sessionTitle: s.title }])
  })

  test("blockers of subagents carry the subagent title", () => {
    const s = ses({ status: [{ id: "r", title: "Root", state: "working", blockers: [] }, { id: "c", title: "Child", state: "blocked", blockers: [{ id: "p", kind: "permission", summary: "edit a.ts" }] }] })
    expect(blockersOf(s)).toEqual([{ id: "p", kind: "permission", summary: "edit a.ts", sessionID: "c", sessionTitle: "Child" }])
  })

  test("aggregate state: blocked > working > error > idle", () => {
    expect(aggregateState([])).toBe("idle")
    expect(aggregateState(["idle", "working", "idle"])).toBe("working")
    expect(aggregateState(["working", "blocked"])).toBe("blocked")
    expect(aggregateState(["idle", "error"])).toBe("error")
  })

  test("now line: tool with summary, bare tool, thinking", () => {
    expect(nowLabel({ kind: "tool", tool: "shell", summary: "bun test" })).toBe("shell · bun test")
    expect(nowLabel({ kind: "tool", tool: "read" })).toBe("read")
    expect(nowLabel({ kind: "thinking" })).toBe("Thinking…")
    expect(nowLabel(undefined)).toBeUndefined()
  })
})

describe("search", () => {
  test("fold drops case and diacritics", () => {
    expect(fold("Crème BRÛLÉE Ñandú")).toBe("creme brulee nandu")
  })

  test("matches title, project name or directory; every word must match somewhere", () => {
    const s = ses({ title: "Fix café login", directory: `${REPO}/.worktrees/feat-auth`, projectName: "opencode-voice" })
    expect(matches(s, "")).toBe(true)
    expect(matches(s, "CAFE")).toBe(true)
    expect(matches(s, "voice")).toBe(true)
    expect(matches(s, "feat-auth")).toBe(true)
    expect(matches(s, "login voice")).toBe(true)
    expect(matches(s, "login webshop")).toBe(false)
  })

  test("an untitled session is found as 'untitled'", () => {
    expect(matches(ses({ title: "" }), "untitled")).toBe(true)
  })

  test("highlight marks folded matches on the original text", () => {
    expect(highlight("Crème brûlée", "BRULE")).toEqual([{ text: "Crème ", hit: false }, { text: "brûlé", hit: true }, { text: "e", hit: false }])
    expect(highlight("abc", "")).toEqual([{ text: "abc", hit: false }])
    expect(highlight("one two one", "one")).toEqual([
      { text: "one", hit: true },
      { text: " two ", hit: false },
      { text: "one", hit: true },
    ])
  })

  test("highlight merges overlapping word matches", () => {
    expect(highlight("session", "sess ion sio")).toEqual([{ text: "session", hit: true }])
  })
})

describe("filters", () => {
  test("chips in order", () => {
    expect(FILTERS.map((f: [string, string]) => f[1])).toEqual(["All", "Active", "Needs you", "Today", "Voice on", "Enabled"])
  })

  test("active, needs you, voice on, enabled", () => {
    const w = working()
    const b = blocked()
    const idle = ses({ conversation: true, exposed: false })
    expect([w, b, idle].map((s) => passesFilter(s, "all", NOW))).toEqual([true, true, true])
    expect([w, b, idle].map((s) => passesFilter(s, "active", NOW))).toEqual([true, true, false])
    expect([w, b, idle].map((s) => passesFilter(s, "needs", NOW))).toEqual([false, true, false])
    expect([w, b, idle].map((s) => passesFilter(s, "voice", NOW))).toEqual([false, false, true])
    expect([w, b, idle].map((s) => passesFilter(s, "enabled", NOW))).toEqual([true, true, false])
  })

  test("a session without `exposed` (older hub) counts as enabled", () => {
    const s = ses()
    delete s.exposed
    expect(passesFilter(s, "enabled", NOW)).toBe(true)
  })

  test("today: updated since local midnight", () => {
    const midnight = new Date(2026, 9, 12).getTime()
    expect(passesFilter(ses({ updated: midnight + 1 }), "today", NOW)).toBe(true)
    expect(passesFilter(ses({ updated: midnight - 1 }), "today", NOW)).toBe(false)
  })
})

describe("pins and stored sets", () => {
  test("parseSet tolerates junk", () => {
    expect([...parseSet('["a","b",3]')]).toEqual(["a", "b"])
    expect([...parseSet("not json")]).toEqual([])
    expect([...parseSet(null)]).toEqual([])
    expect([...parseSet('{"a":1}')]).toEqual([])
  })

  test("toggleIn returns a new set with the id flipped", () => {
    const a = new Set(["x"])
    const b = toggleIn(a, "y")
    expect([...b]).toEqual(["x", "y"])
    expect([...a]).toEqual(["x"])
    expect([...toggleIn(b, "x")]).toEqual(["y"])
  })
})

describe("relativeDir", () => {
  test("inside the root: the relative path; outside: the full directory", () => {
    expect(relativeDir(`${REPO}/.worktrees/feat-x`, REPO)).toBe(".worktrees/feat-x")
    expect(relativeDir(`${REPO}/`, REPO)).toBe("")
    expect(relativeDir("/tmp/wt/feat-y", REPO)).toBe("/tmp/wt/feat-y")
    expect(relativeDir(`${REPO}-other`, REPO)).toBe(`${REPO}-other`)
  })
})

describe("machineView", () => {
  test("groups by project root, nests worktrees and subfolders with their relative path", () => {
    const a = ses({ title: "root work" })
    const b = ses({ directory: `${REPO}/.worktrees/feat-x` })
    const c = ses({ directory: `${REPO}/.worktrees/feat-x` })
    const d = ses({ directory: `${REPO}/web` })
    const e = ses({ directory: SHOP, project: SHOP, projectName: "webshop" })
    const v = machineView(machine([a, b, c, d, e]), { pins: pins(), now: NOW })
    expect(v.workspaces.map((g: S) => [g.key, g.name, g.count])).toEqual([
      [REPO, "opencode-voice", 4],
      [SHOP, "webshop", 1],
    ])
    const repo = v.workspaces[0]
    expect(ids(repo.rows)).toEqual([a.id])
    expect(repo.nested.map((x: S) => [x.dir, x.rel, ids(x.rows)])).toEqual([
      [`${REPO}/.worktrees/feat-x`, ".worktrees/feat-x", [b.id, c.id]],
      [`${REPO}/web`, "web", [d.id]],
    ])
  })

  test("without a project the directory is the workspace, named by its basename", () => {
    const s = ses({ directory: "/srv/app", project: undefined, projectName: undefined })
    const v = machineView(machine([s]), { pins: pins(), now: NOW })
    expect(v.workspaces.map((g: S) => [g.key, g.name, g.nested.length])).toEqual([["/srv/app", "app", 0]])
  })

  test("group aggregate state and last activity include nested sessions", () => {
    const a = ses({ updated: NOW - 50 * MIN })
    const b = working({ directory: `${REPO}/.worktrees/x`, updated: NOW - 2 * MIN })
    const v = machineView(machine([a, b]), { pins: pins(), now: NOW })
    expect(v.workspaces[0]).toMatchObject({ state: "working", updated: NOW - 2 * MIN })
    expect(v.workspaces[0].nested[0]).toMatchObject({ state: "working", updated: NOW - 2 * MIN, count: 1 })
  })

  test("groups sorted by last activity, pinned workspaces first", () => {
    const old = ses({ directory: SHOP, project: SHOP, projectName: "webshop", updated: NOW - 300 * MIN })
    const fresh = ses({ updated: NOW - MIN })
    expect(machineView(machine([old, fresh]), { pins: pins(), now: NOW }).workspaces.map((g: S) => g.key)).toEqual([REPO, SHOP])
    const v = machineView(machine([old, fresh]), { pins: pins([], [SHOP]), now: NOW })
    expect(v.workspaces.map((g: S) => [g.key, g.pinned])).toEqual([[SHOP, true], [REPO, false]])
  })

  test("within a group: pinned, then state (blocked, working, error, idle), then most recent", () => {
    const idleNew = ses({ updated: NOW - MIN })
    const idleOld = ses({ updated: NOW - 90 * MIN })
    const w = working({ updated: NOW - 60 * MIN })
    const b = blocked({ updated: NOW - 80 * MIN })
    const pinnedIdle = ses({ updated: NOW - 200 * MIN })
    const v = machineView(machine([idleOld, w, idleNew, b, pinnedIdle]), { pins: pins([pinnedIdle.id]), now: NOW })
    expect(ids(v.workspaces[0].rows)).toEqual([pinnedIdle.id, b.id, w.id, idleNew.id, idleOld.id])
    expect(v.workspaces[0].rows[0].pinned).toBe(true)
  })

  test("Needs you and Active now span all workspaces and standalone processes, deduped", () => {
    const b1 = blocked({ updated: NOW - 5 * MIN })
    const b2 = blocked({ directory: SHOP, project: SHOP, projectName: "webshop", updated: NOW - MIN })
    const w = working({ now: { kind: "tool", tool: "shell", summary: "bun test" } })
    const idle = ses()
    const v = machineView(machine([b1, b2, w, idle], [{ pid: 7, directory: REPO, sessions: [{ ...w }] }]), { pins: pins(), now: NOW })
    expect(ids(v.needs)).toEqual([b2.id, b1.id])
    expect(v.needs[0].blockers[0]).toMatchObject({ kind: "permission", summary: "shell: rm -rf build" })
    expect(ids(v.active)).toEqual([w.id])
    expect(v.active[0].nowText).toBe("shell · bun test")
  })

  test("rows: title fallback, exposed default, unexposed flag", () => {
    const untitled = ses({ title: "" })
    const hidden = ses({ exposed: false })
    const legacy = ses()
    delete legacy.exposed
    const v = machineView(machine([untitled, hidden, legacy]), { pins: pins(), now: NOW })
    const rows = Object.fromEntries(v.workspaces[0].rows.map((r: S) => [r.id, r]))
    expect(rows[untitled.id].title).toBe("Untitled")
    expect(rows[hidden.id].exposed).toBe(false)
    expect(rows[legacy.id].exposed).toBe(true)
  })

  test("subagent sessions reported next to their root are not listed as rows", () => {
    const root = ses()
    const child = ses({ parentID: root.id })
    const v = machineView(machine([root, child]), { pins: pins(), now: NOW })
    expect(v.total).toBe(1)
    expect(ids(v.workspaces[0].rows)).toEqual([root.id])
  })

  test("standalone processes list their own sessions (even when the service also reports them)", () => {
    const shared = ses()
    const own = ses({ directory: "/tmp/scratch", project: undefined, projectName: undefined })
    const v = machineView(machine([shared], [{ pid: 7, directory: "/tmp/scratch", sessions: [own, { ...shared }] }]), { pins: pins(), now: NOW })
    expect(v.hasService).toBe(true)
    expect(v.standalone.map((p: S) => [p.pid, p.directory, ids(p.rows)])).toEqual([[7, "/tmp/scratch", [shared.id, own.id]]])
    expect(v.workspaces.map((g: S) => g.key)).toEqual([REPO])
    expect(v.total).toBe(2)
  })

  test("a session reported twice is merged: latest update, conversation from any copy", () => {
    const a = ses({ updated: NOW - 10 * MIN })
    const v = machineView(machine([a], [{ pid: 7, directory: REPO, sessions: [{ ...a, updated: NOW - MIN, conversation: true }] }]), { pins: pins(), now: NOW })
    expect(v.workspaces[0].rows[0]).toMatchObject({ id: a.id, updated: NOW - MIN, conversation: true })
  })

  test("search and filter narrow every section; empty groups disappear; counts follow", () => {
    const b = blocked({ title: "Deploy café" })
    const w = working({ title: "Refactor", directory: SHOP, project: SHOP, projectName: "webshop" })
    const i = ses({ title: "Notes", directory: `${REPO}/.worktrees/docs` })
    const m = machine([b, w, i])
    const q = machineView(m, { query: "CAFE", pins: pins(), now: NOW })
    expect(ids(q.needs)).toEqual([b.id])
    expect(q.workspaces.map((g: S) => [g.key, g.count])).toEqual([[REPO, 1]])
    expect(q.workspaces[0].nested).toEqual([])
    expect(q.shown).toBe(1)
    expect(q.total).toBe(3)
    const f = machineView(m, { filter: "active", pins: pins(), now: NOW })
    expect(f.workspaces.map((g: S) => g.key).sort()).toEqual([SHOP, REPO].sort())
    expect(ids(f.active)).toEqual([w.id])
    const project = machineView(m, { query: "webshop", pins: pins(), now: NOW })
    expect(ids(project.workspaces.flatMap((g: S) => g.rows))).toEqual([w.id])
  })

  test("pinned strip lists pinned sessions that pass the filter", () => {
    const a = ses()
    const b = working()
    const v = machineView(machine([a, b]), { pins: pins([a.id, b.id]), now: NOW })
    expect(ids(v.pinned)).toEqual([b.id, a.id])
    expect(ids(machineView(machine([a, b]), { filter: "active", pins: pins([a.id, b.id]), now: NOW }).pinned)).toEqual([b.id])
  })

  test("an offline machine with no processes has empty sections", () => {
    const v = machineView({ id: "m", name: "x", online: false, lastSeen: 1, processes: [] }, { pins: pins(), now: NOW })
    expect(v).toMatchObject({ total: 0, shown: 0, hasService: false, needs: [], active: [], workspaces: [], standalone: [], pinned: [] })
  })
})

describe("page", () => {
  test("caps rows and reports how many are hidden", () => {
    const rows = Array.from({ length: 120 }, (_, i) => i)
    expect(page(rows, 50)).toEqual({ rows: rows.slice(0, 50), more: 70 })
    expect(page(rows.slice(0, 3), 50)).toEqual({ rows: [0, 1, 2], more: 0 })
  })
})

describe("group open state", () => {
  const DAY = 24 * 60 * MIN
  const g = (extra: S = {}): S => ({ key: REPO, state: "idle", updated: NOW - 2 * DAY, pinned: false, ...extra })

  test("parseChoices keeps only boolean entries", () => {
    expect([...parseChoices('{"a":true,"b":false,"c":1}')]).toEqual([["a", true], ["b", false]])
    expect([...parseChoices("[1]")]).toEqual([])
    expect([...parseChoices("nope")]).toEqual([])
    expect([...parseChoices(null)]).toEqual([])
  })

  test("by default: open when active, blocked, pinned or updated within a day; closed otherwise", () => {
    const none = new Map<string, boolean>()
    expect(groupOpen(g(), none, { now: NOW })).toBe(false)
    expect(groupOpen(g({ updated: NOW - DAY + MIN }), none, { now: NOW })).toBe(true)
    expect(groupOpen(g({ state: "working" }), none, { now: NOW })).toBe(true)
    expect(groupOpen(g({ state: "blocked" }), none, { now: NOW })).toBe(true)
    expect(groupOpen(g({ pinned: true }), none, { now: NOW })).toBe(true)
  })

  test("the user's choice wins, except that a search opens every group", () => {
    expect(groupOpen(g({ state: "working" }), new Map([[REPO, false]]), { now: NOW })).toBe(false)
    expect(groupOpen(g(), new Map([[REPO, true]]), { now: NOW })).toBe(true)
    expect(groupOpen(g(), new Map([[REPO, false]]), { now: NOW, query: "  x " })).toBe(true)
    expect(groupOpen(g(), new Map([[REPO, false]]), { now: NOW, query: "   " })).toBe(false)
  })
})
