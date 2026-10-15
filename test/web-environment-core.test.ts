// /new environments (machines), the remembered environment + folder, folder search, and the session rail's
// collapsible cards (web/src/core/environment-core.ts).
import { describe, expect, test } from "bun:test"
import {
  NEW_SESSION_KEY,
  RAIL_COLLAPSED_KEY,
  environments,
  filterTargets,
  loadCollapsed,
  loadNewSessionChoice,
  pickEnvironment,
  pickTarget,
  saveNewSessionChoice,
  toggleCollapsed,
  type EnvMachine,
} from "../web/src/core/environment-core"
import type { NewSessionTarget } from "../web/src/core/view-core"

function memory(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

const machine = (id: string, name: string, over: Partial<EnvMachine> = {}): EnvMachine => ({
  id,
  name,
  online: true,
  processes: [{ id: `p_${id}`, kind: "service", directory: "/", pid: 1, sessions: [], opencodeVersion: "2.0.26" }],
  ...over,
})

describe("environments", () => {
  test("online first (by name), offline last and disabled; detail says the process kind and OpenCode version", () => {
    const list = environments([
      machine("m3", "zeta"),
      machine("m1", "desktop", { online: false, processes: [] }),
      machine("m2", "alpha", { processes: [{ id: "p", kind: "standalone", directory: "/", pid: 1, sessions: [], opencodeVersion: "2.0.25" }] }),
      machine("m4", "beta", { terminals: { herdr: { workspaces: [] } } }),
    ])
    expect(list.map((e) => [e.id, e.online, e.disabled])).toEqual([
      ["m2", true, false],
      ["m4", true, false],
      ["m3", true, false],
      ["m1", false, true],
    ])
    expect(list[0]!.detail).toBe("standalone · OpenCode 2.0.25")
    expect(list[1]!.detail).toBe("background service · OpenCode 2.0.26")
    expect(list[1]!.herdr).toBe(true)
    expect(list[3]!.detail).toBe("offline")
    // Sessions can only be created by a background service.
    expect(list[0]!.canCreate).toBe(false)
    expect(list[1]!.canCreate).toBe(true)
  })
})

describe("pickEnvironment", () => {
  const list = environments([machine("m1", "alpha"), machine("m2", "beta"), machine("m3", "gamma", { online: false, processes: [] })])
  test("the link's machine, else the remembered one, else the first online", () => {
    expect(pickEnvironment(list, "m2", "m1")).toBe("m2")
    expect(pickEnvironment(list, undefined, "m2")).toBe("m2")
    expect(pickEnvironment(list, "m3", "m2")).toBe("m2") // offline link target → remembered
    expect(pickEnvironment(list, undefined, "gone")).toBe("m1")
    expect(pickEnvironment([], undefined, undefined)).toBeUndefined()
  })
  test("prefers a machine that can create sessions", () => {
    const mixed = environments([machine("m1", "alpha", { processes: [{ id: "p", kind: "standalone", directory: "/", pid: 1, sessions: [] }] }), machine("m2", "beta")])
    expect(pickEnvironment(mixed, undefined, undefined)).toBe("m2")
  })
})

const targets: NewSessionTarget[] = [
  { kind: "herdr", key: "herdr:w1", workspaceID: "w1", label: "general", directories: ["/home/u/general", "/home/u/api"] },
  { kind: "folder", key: "/home/u/shop", label: "shop", directories: ["/home/u/shop"] },
  { kind: "folder", key: "/home/u/notes", label: "Notes app", directories: ["/home/u/notes"] },
]

describe("folders", () => {
  test("pickTarget: the link's key, else the remembered folder on that machine, else the first", () => {
    expect(pickTarget(targets, { key: "/home/u/shop" }, undefined)).toEqual({ key: "/home/u/shop", dir: "/home/u/shop" })
    expect(pickTarget(targets, {}, { machine: "m1", key: "herdr:w1", dir: "/home/u/api" })).toEqual({ key: "herdr:w1", dir: "/home/u/api" })
    // A remembered folder that is gone falls back to the first target.
    expect(pickTarget(targets, {}, { machine: "m1", key: "/gone", dir: "/gone" })).toEqual({ key: "herdr:w1", dir: "/home/u/general" })
    expect(pickTarget([], {}, undefined)).toBeUndefined()
  })
  test("filterTargets: every word must match the label or a folder, case- and accent-insensitive", () => {
    expect(filterTargets(targets, "").map((t) => t.key)).toEqual(targets.map((t) => t.key))
    expect(filterTargets(targets, "NOTES").map((t) => t.key)).toEqual(["/home/u/notes"])
    expect(filterTargets(targets, "api").map((t) => t.key)).toEqual(["herdr:w1"])
    expect(filterTargets(targets, "home shop").map((t) => t.key)).toEqual(["/home/u/shop"])
    expect(filterTargets(targets, "nötes").map((t) => t.key)).toEqual(["/home/u/notes"])
  })
})

describe("remembered choice", () => {
  test("saved and loaded; garbage is ignored", () => {
    const storage = memory()
    expect(loadNewSessionChoice(storage)).toBeUndefined()
    saveNewSessionChoice(storage, { machine: "m2", key: "herdr:w1", dir: "/home/u/api" })
    expect(loadNewSessionChoice(storage)).toEqual({ machine: "m2", key: "herdr:w1", dir: "/home/u/api" })
    storage.setItem(NEW_SESSION_KEY, "{not json")
    expect(loadNewSessionChoice(storage)).toBeUndefined()
    storage.setItem(NEW_SESSION_KEY, JSON.stringify({ machine: 5 }))
    expect(loadNewSessionChoice(storage)).toBeUndefined()
  })
})

describe("rail cards", () => {
  test("collapsed cards persist per device", () => {
    const storage = memory()
    expect(loadCollapsed(storage)).toEqual(new Set())
    expect(toggleCollapsed(storage, "environment")).toEqual(new Set(["environment"]))
    expect(toggleCollapsed(storage, "mcp")).toEqual(new Set(["environment", "mcp"]))
    expect(loadCollapsed(storage)).toEqual(new Set(["environment", "mcp"]))
    expect(toggleCollapsed(storage, "environment")).toEqual(new Set(["mcp"]))
    storage.setItem(RAIL_COLLAPSED_KEY, "42")
    expect(loadCollapsed(storage)).toEqual(new Set())
  })
})
