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

describe("normalizeNodeConfig: the openshell section", () => {
  test("absent: no openshell config", () => {
    expect(normalizeNodeConfig({ workspaceRoots: ["/w"] }).config.openshell).toBeUndefined()
  })

  test("keeps enabled, gateway, image and normalizes profiles (the built-in default always there)", () => {
    const { config, problems } = normalizeNodeConfig({
      openshell: { enabled: true, gateway: "openshell", image: "ghcr.io/huynle/hub-sandbox:0.1", profiles: { web: { providers: ["anthropic"], endpoints: ["registry.npmjs.org:443"] } } },
    })
    expect(problems).toEqual([])
    expect(config.openshell?.enabled).toBe(true)
    expect(config.openshell?.gateway).toBe("openshell")
    expect(config.openshell?.image).toBe("ghcr.io/huynle/hub-sandbox:0.1")
    expect(Object.keys(config.openshell!.profiles.profiles).sort()).toEqual(["default", "web"])
    expect(config.openshell!.profiles.profiles.web!.providers).toEqual(["anthropic"])
  })

  test("enabled defaults to false; bad fields are dropped with a problem each, profile problems included", () => {
    const { config, problems } = normalizeNodeConfig({ openshell: { enabled: "yes", gateway: "-bad gw", image: "not an image!", profiles: { big: { cpu: 4 } } } })
    expect(config.openshell?.enabled).toBe(false)
    expect(config.openshell?.gateway).toBeUndefined()
    expect(config.openshell?.image).toBeUndefined()
    expect(config.openshell?.profiles.unsupported.big).toContain("cpu")
    const text = problems.join("\n")
    expect(problems.length).toBe(4)
    expect(text).toContain("openshell.enabled")
    expect(text).toContain("openshell.gateway")
    expect(text).toContain("openshell.image")
    expect(text).toContain("openshell.profiles.big")
  })

  test("a non-object openshell section is a problem and leaves openshell off", () => {
    const { config, problems } = normalizeNodeConfig({ openshell: true })
    expect(config.openshell).toBeUndefined()
    expect(problems).toEqual(["openshell must be an object"])
  })
})

describe("node.json harnesses", () => {
  test("a map of harness → on/off: true offers a harness detection missed, false withholds a detected one", () => {
    const { config, problems } = normalizeNodeConfig({ harnesses: { "claude-code": false, codex: true } })
    expect(problems).toEqual([])
    expect(config.harnesses).toEqual({ "claude-code": false, codex: true })
  })

  test("absent: no overrides (the field is left out)", () => {
    expect(normalizeNodeConfig({}).config.harnesses).toBeUndefined()
  })

  test("bad harness names and non-boolean values are dropped, each with a problem; a non-object is a problem", () => {
    const { config, problems } = normalizeNodeConfig({ harnesses: { "Bad Name": true, codex: "yes", "claude-code": true } })
    expect(config.harnesses).toEqual({ "claude-code": true })
    expect(problems.length).toBe(2)
    expect(problems.join("\n")).toContain("Bad Name")
    expect(problems.join("\n")).toContain("codex")
    const list = normalizeNodeConfig({ harnesses: ["claude-code"] })
    expect(list.config.harnesses).toBeUndefined()
    expect(list.problems).toEqual(["harnesses must be an object of harness names to true or false"])
  })
})
