// Home table rows (sort, search, filter chips) and sidebar sections of the console (web/src/lib/sessions.ts).
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TABLE,
  inactiveRows,
  parseTable,
  serializeTable,
  sessionRows,
  sidebarSections,
  stableRows,
  tableRows,
  voiceLive,
  type SessionRow,
} from "../web/src/lib/sessions"
import { normalizePrefs, type ViewMachine, type ViewSession } from "../web/src/core/view-core"

const NOW = 1_800_000_000_000
const min = (n: number) => NOW - n * 60_000

function session(id: string, extra: Partial<ViewSession> = {}): ViewSession {
  return { id, title: id, directory: "/p/app", project: "/p/app", projectName: "app", updated: min(10), exposed: true, ...extra }
}

function machine(id: string, sessions: ViewSession[], extra: Partial<ViewMachine> = {}): ViewMachine {
  return { id, name: id === "m1" ? "laptop" : "desktop", online: true, processes: [{ id: `${id}-p`, kind: "service", directory: "/", pid: 1, sessions }], ...extra }
}

const working = (id: string) => ({ status: [{ id, state: "working" }] })
const blocked = (id: string) => ({ status: [{ id, state: "blocked", blockers: [{ id: "per", kind: "permission", summary: "shell: ls" }] }] })

describe("sessionRows", () => {
  test("one row per root session with machine, source, running, unread and hidden flags", () => {
    const machines = [
      machine("m1", [
        session("a", { ...working("a"), open: true, terminal: { source: "herdr", workspaceID: "w1", workspace: "general" } }),
        session("b", { updated: min(5), open: true, terminal: { source: "tui" } }),
        session("c", { exposed: false, updated: min(60) }),
        session("kid", { parentID: "a" }),
      ]),
    ]
    const prefs = normalizePrefs({ hiddenSessions: ["c"], pinnedSessions: ["b"] })
    const rows = sessionRows(machines, prefs, { b: min(20), a: min(1) })
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "c"])
    expect(by.a).toMatchObject({ machineName: "laptop", source: "herdr", running: true, state: "working", unread: false, workspace: "general" })
    expect(by.b).toMatchObject({ source: "tui", pinned: true, unread: true, running: false })
    expect(by.c).toMatchObject({ source: "background", hidden: true, archived: true, exposed: false, unread: false })
    expect(by.a!.archived).toBe(false)
  })

  test("archived means archived by ID; a hidden workspace hides without archiving", () => {
    const rows = sessionRows([machine("m1", [session("x"), session("y", { directory: "/p/gone", project: "/p/gone" })])], normalizePrefs({ hiddenSessions: ["x"], hiddenWorkspaces: ["/p/gone"] }), {})
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(by.x).toMatchObject({ hidden: true, archived: true })
    expect(by.y).toMatchObject({ hidden: true, archived: false })
  })

  test("a session never read is not unread; blocked counts as running", () => {
    const rows = sessionRows([machine("m1", [session("x", blocked("x"))])], normalizePrefs({}), {})
    expect(rows[0]).toMatchObject({ unread: false, running: true, state: "blocked" })
  })
})

describe("tableRows", () => {
  const machines = [
    machine("m1", [
      session("idle-old", { title: "Zeta", updated: min(300) }),
      session("work", { ...working("work"), title: "Alpha", updated: min(30), open: true, terminal: { source: "tui" } }),
      session("need", { ...blocked("need"), title: "Mid", updated: min(90) }),
      session("off", { title: "Beta", exposed: false, updated: min(5), projectName: "other", project: "/p/other", directory: "/p/other" }),
      session("hid", { title: "Hidden one", updated: min(1) }),
    ]),
    machine("m2", [session("far", { title: "Remote", updated: min(2), conversation: true })]),
  ]
  const rows = sessionRows(machines, normalizePrefs({ hiddenSessions: ["hid"] }), {})
  const ids = (list: SessionRow[]) => list.map((r) => r.id)

  test("default: hidden excluded, sorted by last activity", () => {
    expect(ids(tableRows(rows, DEFAULT_TABLE))).toEqual(["far", "off", "work", "need", "idle-old"])
  })

  test("status sort puts needs-you, then running, then idle (recent first within each)", () => {
    expect(ids(tableRows(rows, { ...DEFAULT_TABLE, sort: { key: "status", dir: "asc" } }))).toEqual(["need", "work", "far", "off", "idle-old"])
  })

  test("title sort ascending and descending", () => {
    expect(ids(tableRows(rows, { ...DEFAULT_TABLE, sort: { key: "title", dir: "asc" } }))).toEqual(["work", "off", "need", "far", "idle-old"])
    expect(ids(tableRows(rows, { ...DEFAULT_TABLE, sort: { key: "title", dir: "desc" } }))).toEqual(["idle-old", "far", "need", "off", "work"])
  })

  test("server sort groups by machine name", () => {
    expect(ids(tableRows(rows, { ...DEFAULT_TABLE, sort: { key: "server", dir: "asc" } }))[0]).toBe("far")
  })

  test("search covers title, project, directory and machine", () => {
    expect(ids(tableRows(rows, { ...DEFAULT_TABLE, query: "alp" }))).toEqual(["work"])
    expect(ids(tableRows(rows, { ...DEFAULT_TABLE, query: "other" }))).toEqual(["off"])
    expect(ids(tableRows(rows, { ...DEFAULT_TABLE, query: "desktop" }))).toEqual(["far"])
  })

  test("filter chips: status, source, machine; hidden shows only hidden", () => {
    const f = (filters: Partial<typeof DEFAULT_TABLE.filters>) => ids(tableRows(rows, { ...DEFAULT_TABLE, filters: { ...DEFAULT_TABLE.filters, ...filters } }))
    expect(f({ status: "needs" })).toEqual(["need"])
    expect(f({ status: "running" })).toEqual(["work", "need"])
    expect(f({ status: "idle" })).toEqual(["far", "off", "idle-old"])
    expect(f({ source: "open" })).toEqual(["work"])
    expect(f({ source: "background" })).toEqual(["far", "off", "need", "idle-old"])
    expect(f({ machine: "m2" })).toEqual(["far"])
    expect(f({ archived: true })).toEqual(["hid"])
  })

  test("archived sessions leave every view but Archived, except Needs you when they need you", () => {
    const list = sessionRows(
      [machine("m1", [session("arch-need", { ...blocked("arch-need"), updated: min(3) }), session("arch-run", { ...working("arch-run"), updated: min(4) }), session("plain", { updated: min(5) })])],
      normalizePrefs({ hiddenSessions: ["arch-need", "arch-run"] }),
      {},
    )
    const f = (filters: Partial<typeof DEFAULT_TABLE.filters>) => ids(tableRows(list, { ...DEFAULT_TABLE, filters: { ...DEFAULT_TABLE.filters, ...filters } }))
    expect(f({})).toEqual(["plain"])
    expect(f({ status: "running" })).toEqual([])
    expect(f({ status: "needs" })).toEqual(["arch-need"])
    expect(f({ archived: true })).toEqual(["arch-need", "arch-run"])
    expect(f({ archived: true, status: "running" })).toEqual(["arch-need", "arch-run"])
  })

  test("the old saved Hidden chip opens Archived", () => {
    expect(parseTable(JSON.stringify({ filters: { hidden: true } })).filters.archived).toBe(true)
    const state = { ...DEFAULT_TABLE, filters: { ...DEFAULT_TABLE.filters, archived: true } }
    expect(JSON.parse(serializeTable(state)).filters).toEqual({ ...DEFAULT_TABLE.filters, archived: true })
    expect(parseTable(serializeTable(state)).filters.archived).toBe(true)
    expect(Object.keys(DEFAULT_TABLE.filters)).not.toContain("hidden")
  })

  test("table state round-trips through storage and junk falls back to the default", () => {
    const state = { ...DEFAULT_TABLE, query: "x", sort: { key: "title" as const, dir: "desc" as const }, filters: { ...DEFAULT_TABLE.filters, status: "needs" as const } }
    const back = parseTable(serializeTable(state))
    expect(back.sort).toEqual(state.sort)
    expect(back.filters.status).toBe("needs")
    expect(back.query).toBe("") // the search box is not persisted
    expect(parseTable("{nope")).toEqual(DEFAULT_TABLE)
    expect(parseTable(JSON.stringify({ sort: { key: "bogus", dir: "up" }, filters: { status: "weird" } }))).toEqual(DEFAULT_TABLE)
  })

  test("there is no Voice filter or sort: stale saved voice values are ignored", () => {
    expect(Object.keys(DEFAULT_TABLE.filters)).not.toContain("voice")
    expect(parseTable(JSON.stringify({ sort: { key: "voice", dir: "asc" }, filters: { voice: "on" } }))).toEqual(DEFAULT_TABLE)
    const kept = parseTable(JSON.stringify({ sort: { key: "voice", dir: "asc" }, filters: { voice: "off", status: "needs" } }))
    expect(kept.sort).toEqual(DEFAULT_TABLE.sort)
    expect(kept.filters).toEqual({ ...DEFAULT_TABLE.filters, status: "needs" })
    expect(ids(tableRows(rows, kept))).toEqual(["need"])
  })
})

describe("inactiveRows", () => {
  const DAY = 24 * 60 * 60_000
  const rows = sessionRows(
    [
      machine("m1", [
        session("old", { updated: NOW - 40 * DAY }),
        session("older", { updated: NOW - 90 * DAY }),
        session("recent", { updated: NOW - 5 * DAY }),
        session("edge", { updated: NOW - 30 * DAY }),
        session("old-running", { ...working("old-running"), updated: NOW - 40 * DAY }),
        session("old-blocked", { ...blocked("old-blocked"), updated: NOW - 40 * DAY }),
        session("old-pinned", { updated: NOW - 40 * DAY }),
        session("old-open", { updated: NOW - 40 * DAY, open: true, terminal: { source: "tui" } }),
        session("old-archived", { updated: NOW - 40 * DAY }),
      ]),
    ],
    normalizePrefs({ pinnedSessions: ["old-pinned"], hiddenSessions: ["old-archived"] }),
    {},
  )
  test("idle, unpinned, not open, not yet archived, and inactive for more than N days", () => {
    expect(inactiveRows(rows, 30, NOW).map((r) => r.id).sort()).toEqual(["old", "older"])
    expect(inactiveRows(rows, 60, NOW).map((r) => r.id)).toEqual(["older"])
    expect(inactiveRows(rows, 1, NOW).map((r) => r.id).sort()).toEqual(["edge", "old", "older", "recent"])
  })
  test("N must be a whole number of days, at least 1", () => {
    expect(inactiveRows(rows, 0, NOW)).toEqual([])
    expect(inactiveRows(rows, Number.NaN, NOW)).toEqual([])
    expect(inactiveRows(rows, 1.5, NOW)).toEqual([])
  })
})

describe("stableRows", () => {
  test("unchanged rows keep their object (open ⋯ menus survive a catalog update); changed and new rows are fresh", () => {
    const prefs = normalizePrefs({})
    const first = sessionRows([machine("m1", [session("a"), session("b"), session("c")])], prefs, {})
    const second = sessionRows([machine("m1", [session("a"), session("b", { title: "B2" }), session("d")])], prefs, {})
    const stable = stableRows(first, second)
    const by = (list: SessionRow[], id: string) => list.find((r) => r.id === id)
    expect(stable.map((r) => r.id)).toEqual(second.map((r) => r.id))
    expect(by(stable, "a")).toBe(by(first, "a")!)
    expect(by(stable, "b")).toBe(by(second, "b")!)
    expect(by(stable, "b")!.title).toBe("B2")
    expect(by(stable, "d")).toBe(by(second, "d")!)
    expect(stableRows(undefined, second)).toBe(second)
  })
})

describe("voiceLive", () => {
  const rows = sessionRows(
    [machine("m1", [session("talk", { conversation: true }), session("here"), session("exposed"), session("off", { exposed: false })])],
    normalizePrefs({}),
    {},
  )
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  test("live only for the session in Voice mode here, or one the catalog reports in conversation", () => {
    const state = { phase: "listening", sessionID: "here" }
    expect(voiceLive(by.here!, state)).toBe(true)
    expect(voiceLive(by.talk!, state)).toBe(true)
    expect(voiceLive(by.exposed!, state)).toBe(false)
    expect(voiceLive(by.off!, state)).toBe(false)
  })
  test("starting counts as live; off does not, even for the remembered session", () => {
    expect(voiceLive(by.here!, { phase: "starting", sessionID: "here" })).toBe(true)
    expect(voiceLive(by.here!, { phase: "off", sessionID: "here" })).toBe(false)
    expect(voiceLive(by.exposed!, { phase: "off" })).toBe(false)
  })
})

describe("sidebarSections", () => {
  const machines = [
    machine("m1", [
      session("need", { ...blocked("need"), updated: min(50) }),
      session("run", { ...working("run"), updated: min(40) }),
      session("open1", { updated: min(30), open: true, terminal: { source: "herdr", workspaceID: "w1", workspace: "general" } }),
      session("open2", { updated: min(20), title: "B open", open: true, terminal: { source: "herdr", workspaceID: "w1", workspace: "general" } }),
      session("open3", { updated: min(25), open: true, terminal: { source: "tui" }, projectName: "api", project: "/p/api", directory: "/p/api" }),
      session("pin", { updated: min(500) }),
      session("old", { updated: min(600) }),
      session("older", { updated: min(700) }),
      session("hid", { updated: min(1), open: true, terminal: { source: "tui" } }),
    ]),
  ]
  const rows = sessionRows(machines, normalizePrefs({ hiddenSessions: ["hid"], pinnedSessions: ["pin"] }), {})
  const shape = (sections: ReturnType<typeof sidebarSections>) => sections.map((s) => [s.title, s.rows.map((r) => r.id)])

  test("an archived session that needs you shows under Needs you; archived running ones stay out", () => {
    const list = sessionRows(
      [machine("m1", [session("arch-need", blocked("arch-need")), session("arch-run", working("arch-run")), session("plain")])],
      normalizePrefs({ hiddenSessions: ["arch-need", "arch-run"] }),
      {},
    )
    expect(shape(sidebarSections(list, { query: "", groupBy: "project", sortBy: "recent" }))).toEqual([
      ["Needs you", ["arch-need"]],
      ["Recents", ["plain"]],
    ])
    // A search finds only what is not archived.
    expect(shape(sidebarSections(list, { query: "arch", groupBy: "project", sortBy: "recent" }))).toEqual([["Results", []]])
  })

  test("Needs you, Running, Pinned, open-session groups, then Recents; each session once, hidden ones left out", () => {
    expect(shape(sidebarSections(rows, { query: "", groupBy: "project", sortBy: "recent" }))).toEqual([
      ["Needs you", ["need"]],
      ["Running", ["run"]],
      ["Pinned", ["pin"]],
      ["general", ["open2", "open1"]],
      ["api", ["open3"]],
      ["Recents", ["old", "older"]],
    ])
  })

  test("groups carry their key and a folder for New session (+)", () => {
    const general = sidebarSections(rows, { query: "", groupBy: "project", sortBy: "recent" }).find((s) => s.title === "general")!
    expect(general).toMatchObject({ kind: "group", key: "herdr:w1", machineID: "m1", directory: "/p/app" })
  })

  test("sort by title inside groups; group by server", () => {
    const byTitle = sidebarSections(rows, { query: "", groupBy: "project", sortBy: "title" }).find((s) => s.title === "general")!
    expect(byTitle.rows.map((r) => r.id)).toEqual(["open2", "open1"])
    const byServer = shape(sidebarSections(rows, { query: "", groupBy: "machine", sortBy: "recent" }))
    expect(byServer).toContainEqual(["laptop", ["open2", "open3", "open1"]])
  })

  test("Recents is capped; a search shows one flat result list", () => {
    expect(sidebarSections(rows, { query: "", groupBy: "project", sortBy: "recent", recentLimit: 1 }).at(-1)!.rows.map((r) => r.id)).toEqual(["old"])
    expect(shape(sidebarSections(rows, { query: "B open", groupBy: "project", sortBy: "recent" }))).toEqual([["Results", ["open2"]]])
  })
})

describe("sessionRows: background jobs and retries", () => {
  test("rows count running jobs of the tree and carry the retry reason while working", () => {
    const status = [
      { id: "a", state: "working", retry: { attempt: 1, message: "Overloaded" }, jobs: [{ id: "sh_1", kind: "shell", command: "sleep 60", status: "running" }] },
      { id: "kid", parentID: "a", state: "idle", jobs: [{ id: "sh_2", kind: "shell", status: "running" }, { id: "sh_3", kind: "shell", status: "exited", exit: 0 }] },
    ]
    const rows = sessionRows([machine("m1", [session("a", { status } as any), session("b")])], normalizePrefs({}), {})
    const a = rows.find((r) => r.id === "a")!
    expect(a.jobs).toBe(2)
    expect(a.retry).toBe("Retrying (attempt 1): Overloaded")
    expect(a.running).toBe(true)
    const b = rows.find((r) => r.id === "b")!
    expect(b.jobs).toBe(0)
    expect(b.retry).toBeUndefined()
  })
})
