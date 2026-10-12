// Session view (0.4.0, docs/session-view.md): open sessions first. Synced view prefs (hide/pin), migration of
// 0.3 local pins, Open / Recent / Hidden split, Herdr-like grouping and ordering, status dots, new-session targets.
import { describe, expect, test } from "bun:test"
import { dotState, groupKey, hiddenView, homeView as typedHomeView, migratePins, normalizePrefs, recentMachine, setPref } from "../web/view-core.js"

type S = any
const homeView = (...args: Parameters<typeof typedHomeView>): S => typedHomeView(...args)
const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime()
const MIN = 60_000
const P = "/home/user/projects"
let n = 0
const ses = (extra: S = {}): S => ({
  id: `ses_${++n}`,
  title: `Session ${n}`,
  directory: `${P}/general`,
  project: `${P}/general`,
  projectName: "general",
  updated: NOW - n * MIN,
  owned: false,
  exposed: true,
  busy: false,
  conversation: false,
  status: [],
  ...extra,
})
const herdr = (workspaceID: string, workspace: string, status = "idle", extra: S = {}) => ({ open: true, terminal: { source: "herdr", workspaceID, workspace, status, ...extra } })
const tui = { open: true, terminal: { source: "tui" } }
const withState = (s: S, state: string, blockers: S[] = []) => ({ ...s, status: [{ id: s.id, title: s.title, state, blockers }] })
const WORKSPACES = [
  { id: "w1", label: "general", directories: [`${P}/general`] },
  { id: "w2", label: "api-server", directories: [`${P}/api-server`, `${P}/api-server/.worktrees/feat-auth`] },
  { id: "w3", label: "research", directories: [] },
]
const machine = (sessions: S[], extra: S = {}): S => ({
  id: "mac_1",
  name: "laptop",
  online: true,
  processes: [{ id: "p1", kind: "service", directory: "/home/user", pid: 1, sessions }],
  terminals: { herdr: { workspaces: WORKSPACES } },
  ...extra,
})
const EMPTY = normalizePrefs({})

describe("view prefs", () => {
  test("normalizePrefs keeps the four lists as unique strings, accepts a {prefs} wrapper and drops junk", () => {
    expect(normalizePrefs(undefined)).toEqual({ hiddenSessions: [], hiddenWorkspaces: [], pinnedSessions: [], pinnedWorkspaces: [] })
    expect(normalizePrefs({ hiddenSessions: ["a", "a", 3, "b"], pinnedWorkspaces: "x", extra: [1] })).toEqual({
      hiddenSessions: ["a", "b"],
      hiddenWorkspaces: [],
      pinnedSessions: [],
      pinnedWorkspaces: [],
    })
    expect(normalizePrefs({ prefs: { pinnedSessions: ["s1"] } }).pinnedSessions).toEqual(["s1"])
    const many = Array.from({ length: 600 }, (_, i) => `s${i}`)
    expect(normalizePrefs({ hiddenSessions: [...many, "x".repeat(5000)] }).hiddenSessions).toHaveLength(500)
  })

  test("setPref adds or removes one key and returns the partial patch for PUT", () => {
    const prefs = normalizePrefs({ pinnedSessions: ["a"] })
    const on = setPref(prefs, "pinnedSessions", "b", true)
    expect(on.prefs.pinnedSessions).toEqual(["a", "b"])
    expect(on.patch).toEqual({ pinnedSessions: ["a", "b"] })
    expect(prefs.pinnedSessions).toEqual(["a"]) // not mutated
    const off = setPref(on.prefs, "pinnedSessions", "a", false)
    expect(off.prefs.pinnedSessions).toEqual(["b"])
    expect(setPref(prefs, "pinnedSessions", "a", true).patch).toBeUndefined() // no change, no PUT
    expect(() => setPref(prefs, "nope" as any, "a", true)).toThrow()
  })

  test("migratePins merges 0.3 local pins into prefs once and says to clear the local keys", () => {
    const prefs = normalizePrefs({ pinnedSessions: ["a"], pinnedWorkspaces: [] })
    const m = migratePins('["a","b"]', '["/home/user/projects/api-server"]', prefs)
    expect(m.clear).toBe(true)
    expect(m.patch).toEqual({ pinnedSessions: ["a", "b"], pinnedWorkspaces: ["/home/user/projects/api-server"] })
    // Already in prefs: nothing to PUT but still clear.
    expect(migratePins('["a"]', null, prefs)).toEqual({ clear: true, patch: undefined })
    // Nothing stored locally (or junk): nothing to do.
    expect(migratePins(null, null, prefs)).toEqual({ clear: false, patch: undefined })
    expect(migratePins("{bad", "[]", prefs)).toEqual({ clear: true, patch: undefined })
  })
})

describe("status dot", () => {
  test("combines Herdr's agent status with the session state: blocked > working > error > idle", () => {
    expect(dotState(ses())).toBe("idle")
    expect(dotState(ses(herdr("w1", "general", "working")))).toBe("working")
    expect(dotState(ses(herdr("w1", "general", "blocked")))).toBe("blocked")
    expect(dotState(ses(herdr("w1", "general", "done")))).toBe("idle")
    expect(dotState(withState(ses(herdr("w1", "general", "idle")), "working"))).toBe("working")
    expect(dotState(withState(ses(herdr("w1", "general", "working")), "blocked"))).toBe("blocked")
    expect(dotState(withState(ses(herdr("w1", "general", "unknown")), "error"))).toBe("error")
    expect(dotState(withState(ses(herdr("w1", "general", "working")), "error"))).toBe("working")
  })

  test("group key: Herdr workspace when open in Herdr, else the project folder", () => {
    expect(groupKey(ses(herdr("w2", "api-server")))).toBe("herdr:w2")
    expect(groupKey(ses({ ...tui, project: `${P}/api-server/`, directory: `${P}/api-server/src` }))).toBe(`${P}/api-server`)
    expect(groupKey(ses({ project: undefined, directory: "/tmp/scratch" }))).toBe("/tmp/scratch")
  })
})

describe("home view: Open", () => {
  test("splits open sessions from history and groups open ones by Herdr workspace in Herdr's order, then folders", () => {
    const a = ses({ ...herdr("w2", "api-server"), directory: `${P}/api-server`, project: `${P}/api-server`, projectName: "api-server" })
    const b = ses(herdr("w1", "general"))
    const c = ses({ ...tui, directory: "/tmp/scratch", project: undefined, projectName: undefined, updated: NOW })
    const old = ses({ updated: NOW - 40 * 86_400_000 })
    const v = homeView([machine([a, b, c, old])], EMPTY, { now: NOW })
    expect(v.counts).toEqual({ open: 3, recent: 1, hidden: 0 })
    const groups = v.machines[0].open.groups
    expect(groups.map((g: S) => [g.key, g.kind, g.name])).toEqual([
      ["herdr:w1", "herdr", "general"],
      ["herdr:w2", "herdr", "api-server"],
      ["/tmp/scratch", "folder", "scratch"],
    ])
    expect(groups[1].workspaceID).toBe("w2")
    expect(groups[1].directory).toBe(`${P}/api-server`) // Herdr's most used folder: default target for "+"
    expect(groups[2].directory).toBe("/tmp/scratch")
    expect(groups[0].rows.map((r: S) => r.id)).toEqual([b.id])
  })

  test("Herdr workspaces missing from the terminals list, and folder groups, order by latest activity", () => {
    const x = ses({ ...herdr("w9", "ops"), updated: NOW - 50 * MIN })
    const y = ses({ ...tui, directory: `${P}/blog`, project: `${P}/blog`, projectName: "blog", updated: NOW - 5 * MIN })
    const z = ses({ ...herdr("w3", "research"), updated: NOW - 90 * MIN })
    const v = homeView([machine([x, y, z])], EMPTY, { now: NOW })
    expect(v.machines[0].open.groups.map((g: S) => g.name)).toEqual(["research", "blog", "ops"])
  })

  test("rows: pinned first, then blocked, working, idle, then most recent; title falls back to the pane title", () => {
    const idleNew = ses({ ...herdr("w1", "general"), updated: NOW - 1 * MIN })
    const idleOld = ses({ ...herdr("w1", "general"), updated: NOW - 9 * MIN, title: "", terminal: { source: "herdr", workspaceID: "w1", workspace: "general", title: "Fix login", status: "idle" } })
    const work = ses({ ...herdr("w1", "general", "working"), updated: NOW - 30 * MIN, now: { kind: "tool", tool: "shell", summary: "bun test" } })
    const blocked = withState(ses({ ...herdr("w1", "general"), updated: NOW - 60 * MIN }), "blocked", [{ id: "p", kind: "permission", summary: "rm" }])
    const pinned = ses({ ...herdr("w1", "general"), updated: NOW - 99 * MIN })
    const prefs = normalizePrefs({ pinnedSessions: [pinned.id] })
    const rows = homeView([machine([idleOld, work, idleNew, blocked, pinned])], prefs, { now: NOW }).machines[0].open.groups[0].rows
    expect(rows.map((r: S) => r.id)).toEqual([pinned.id, blocked.id, work.id, idleNew.id, idleOld.id])
    expect(rows[0].pinned).toBe(true)
    expect(rows[1].state).toBe("blocked")
    expect(rows[1].blockers[0].summary).toBe("rm")
    expect(rows[2].nowText).toBe("shell · bun test")
    expect(rows[4].title).toBe("Fix login")
    expect(rows[3].where).toBe("general")
  })

  test("row folder line: project name plus the path inside it", () => {
    const s = ses({ ...herdr("w2", "api-server"), directory: `${P}/api-server/.worktrees/feat-auth`, project: `${P}/api-server`, projectName: "api-server" })
    const row = homeView([machine([s])], EMPTY, { now: NOW }).machines[0].open.groups[0].rows[0]
    expect(row.where).toBe("api-server › .worktrees/feat-auth")
    expect(row.workspace).toBe("api-server")
  })

  test("pinned workspaces float to the top; group state is the worst row", () => {
    const a = ses(herdr("w1", "general"))
    const b = withState(ses(herdr("w2", "api-server", "working")), "idle")
    const prefs = normalizePrefs({ pinnedWorkspaces: ["herdr:w2"] })
    const groups = homeView([machine([a, b])], prefs, { now: NOW }).machines[0].open.groups
    expect(groups.map((g: S) => [g.key, g.pinned, g.state])).toEqual([
      ["herdr:w2", true, "working"],
      ["herdr:w1", false, "idle"],
    ])
  })

  test("several processes reporting one session: one row, open from any copy", () => {
    const s = ses()
    const m = machine([s])
    m.processes.push({ id: "p2", kind: "standalone", directory: "/tmp", pid: 2, sessions: [{ ...s, ...herdr("w1", "general"), updated: s.updated - 1 }] })
    const v = homeView([m], EMPTY, { now: NOW })
    expect(v.counts).toEqual({ open: 1, recent: 0, hidden: 0 })
    expect(v.machines[0].open.groups[0].rows[0].terminal.source).toBe("herdr")
  })

  test("not open but working or in conversation mode: listed under 'background' on the Open tab", () => {
    const w = withState(ses(), "working")
    const c = ses({ conversation: true })
    const quiet = ses()
    const v = homeView([machine([w, c, quiet])], EMPTY, { now: NOW })
    expect(v.machines[0].open.background.map((r: S) => r.id)).toEqual([w.id, c.id])
    expect(v.counts.recent).toBe(3)
  })

  test("Needs you: blocked sessions from every machine, open or not, hidden ones excluded, newest first", () => {
    const b1 = withState(ses({ ...herdr("w1", "general"), updated: NOW - 5 * MIN }), "blocked")
    const b2 = withState(ses({ updated: NOW - 1 * MIN }), "blocked")
    const b3 = ses({ ...herdr("w2", "api-server", "blocked"), updated: NOW - 3 * MIN })
    const gone = withState(ses(), "blocked")
    const other = { ...machine([b2]), id: "mac_2", name: "desktop" }
    const v = homeView([machine([b1, b3, gone]), other], normalizePrefs({ hiddenSessions: [gone.id] }), { now: NOW })
    expect(v.needs.map((r: S) => [r.id, r.machineID])).toEqual([
      [b2.id, "mac_2"],
      [b3.id, "mac_1"],
      [b1.id, "mac_1"],
    ])
  })
})

describe("home view: hidden sessions and workspaces", () => {
  test("hidden by session ID, Herdr workspace key or folder key: out of Open and Recent, counted as hidden", () => {
    const a = ses(herdr("w1", "general"))
    const b = ses(herdr("w2", "api-server"))
    const c = ses({ directory: `${P}/blog`, project: `${P}/blog`, projectName: "blog" })
    const d = ses({ directory: `${P}/blog/sub`, project: `${P}/blog`, projectName: "blog" })
    const e = ses()
    const prefs = normalizePrefs({ hiddenSessions: [a.id], hiddenWorkspaces: ["herdr:w2", `${P}/blog`] })
    const v = homeView([machine([a, b, c, d, e])], prefs, { now: NOW })
    expect(v.machines[0].open.groups).toEqual([])
    expect(v.counts).toEqual({ open: 0, recent: 1, hidden: 3 })
    const recent = recentMachine(machine([a, b, c, d, e]), prefs)
    expect(recent.processes[0].sessions.map((s: S) => s.id)).toEqual([e.id])
  })

  test("recentMachine keeps root history only (no open, hidden or child sessions) and the machine fields", () => {
    const root = ses()
    const kid = ses({ parentID: root.id })
    const open = ses(herdr("w1", "general"))
    const m = recentMachine(machine([root, kid, open]), EMPTY)
    expect(m.id).toBe("mac_1")
    expect(m.processes[0].sessions.map((s: S) => s.id)).toEqual([root.id])
  })

  test("hiddenView lists hidden workspaces (named, with counts) and hidden sessions across machines", () => {
    const a = ses({ ...herdr("w2", "api-server"), title: "Rate limiter" })
    const b = ses({ directory: `${P}/blog`, project: `${P}/blog`, projectName: "blog" })
    const c = ses({ title: "Old spike" })
    const prefs = normalizePrefs({ hiddenSessions: [c.id, "ses_gone"], hiddenWorkspaces: ["herdr:w2", `${P}/blog`, "herdr:w7", "/srv/x/"] })
    const v = hiddenView([machine([a, b, c])], prefs)
    expect(v.workspaces.map((w: S) => [w.key, w.name, w.count])).toEqual([
      ["herdr:w2", "api-server", 1],
      [`${P}/blog`, "blog", 1],
      ["herdr:w7", "Herdr workspace w7", 0],
      ["/srv/x/", "x", 0],
    ])
    expect(v.sessions.map((r: S) => [r.id, r.title, r.machineID])).toEqual([[c.id, "Old spike", "mac_1"]])
    expect(v.unknown).toBe(1) // hidden IDs no machine reports right now
  })
})
