// node.json (decision 6): the node's own settings, next to the spoke's config.json (which the node only reads, for
// the hub URL and the machine token; it never writes it).
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_SLOTS, nodeConfigPath, normalizeNodeConfig, readNodeConfig, readSpokeCredentials } from "../src/config.ts"

const dir = () => mkdtempSync(path.join(tmpdir(), "hub-node-config-"))

describe("nodeConfigPath", () => {
  test("is node.json in the spoke's config directory (~/.config/hub)", () => {
    expect(nodeConfigPath({}, "/home/u")).toBe("/home/u/.config/hub/node.json")
    expect(nodeConfigPath({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/x/hub/node.json")
  })

  test("follows HUB_SPOKE_CONFIG (and its legacy names) to the same directory", () => {
    expect(nodeConfigPath({ HUB_SPOKE_CONFIG: "/etc/hub/spoke.json" }, "/home/u")).toBe("/etc/hub/node.json")
    expect(nodeConfigPath({ OPENCODE_HUB_CONFIG: "/old/config.json" }, "/home/u")).toBe("/old/node.json")
  })
})

describe("normalizeNodeConfig", () => {
  test("keeps valid fields", () => {
    const { config, problems } = normalizeNodeConfig({ workspaceRoots: ["/Users/huy/projects", "/srv/work/"], labels: { gpu: "no" }, slots: 6, memoryMB: 49152 })
    expect(problems).toEqual([])
    expect(config).toEqual({ workspaceRoots: ["/Users/huy/projects", "/srv/work"], labels: { gpu: "no" }, slots: 6, memoryMB: 49152 })
  })

  test("defaults: no roots, no labels, DEFAULT_SLOTS, no memory", () => {
    expect(normalizeNodeConfig(undefined)).toEqual({ config: { workspaceRoots: [], labels: {}, slots: DEFAULT_SLOTS }, problems: [] })
    expect(normalizeNodeConfig({})).toEqual({ config: { workspaceRoots: [], labels: {}, slots: DEFAULT_SLOTS }, problems: [] })
  })

  test("drops invalid fields, each with a problem", () => {
    const { config, problems } = normalizeNodeConfig({ workspaceRoots: ["relative", "/a/../b", "/ok", "/ok", 5, "/"], labels: { "bad key": "x" }, slots: 0, memoryMB: -1 })
    expect(config).toEqual({ workspaceRoots: ["/ok"], labels: {}, slots: DEFAULT_SLOTS })
    expect(problems.length).toBe(7)
    expect(problems.join("\n")).toContain("relative")
    expect(problems.join("\n")).toContain("slots")
    expect(problems.join("\n")).toContain("memoryMB")
    expect(problems.join("\n")).toContain("labels")
  })

  test("a root of / is refused (it would put the whole machine in reach)", () => {
    expect(normalizeNodeConfig({ workspaceRoots: ["/"] }).config.workspaceRoots).toEqual([])
  })

  test("a non-object or non-array value is a problem", () => {
    expect(normalizeNodeConfig([]).problems.length).toBe(1)
    expect(normalizeNodeConfig({ workspaceRoots: "/a" }).problems.length).toBe(1)
  })
})

describe("readNodeConfig", () => {
  test("a missing file is the defaults without problems", () => {
    expect(readNodeConfig(path.join(dir(), "node.json"))).toEqual({ config: { workspaceRoots: [], labels: {}, slots: DEFAULT_SLOTS }, problems: [] })
  })

  test("bad JSON is the defaults with a problem", () => {
    const file = path.join(dir(), "node.json")
    writeFileSync(file, "{nope")
    const { config, problems } = readNodeConfig(file)
    expect(config.workspaceRoots).toEqual([])
    expect(problems[0]).toContain("node.json")
  })

  test("reads the file", () => {
    const file = path.join(dir(), "node.json")
    writeFileSync(file, JSON.stringify({ workspaceRoots: ["/w"], slots: 2 }))
    expect(readNodeConfig(file).config).toEqual({ workspaceRoots: ["/w"], labels: {}, slots: 2 })
  })
})

describe("readSpokeCredentials", () => {
  test("reads server, token and machine ID from config.json without touching it", () => {
    const d = dir()
    const file = path.join(d, "config.json")
    const text = JSON.stringify({ server: "https://hub.example.com/", token: "mt_secret", machineID: "m1", extra: "kept" })
    writeFileSync(file, text)
    chmodSync(file, 0o600)
    const before = statSync(file).mtimeMs
    expect(readSpokeCredentials({ HUB_SPOKE_CONFIG: file }, "/nowhere")).toEqual({ server: "https://hub.example.com", token: "mt_secret", machineID: "m1" })
    expect(readFileSync(file, "utf8")).toBe(text)
    expect(statSync(file).mtimeMs).toBe(before)
  })

  test("undefined when the machine is not enrolled (no token) or there is no config", () => {
    const d = dir()
    const file = path.join(d, "config.json")
    expect(readSpokeCredentials({ HUB_SPOKE_CONFIG: file }, "/nowhere")).toBeUndefined()
    writeFileSync(file, JSON.stringify({ server: "https://hub.example.com" }))
    expect(readSpokeCredentials({ HUB_SPOKE_CONFIG: file }, "/nowhere")).toBeUndefined()
  })
})
