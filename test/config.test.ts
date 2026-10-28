import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { configPath, isExposed, prepareConfigPath, normalize, readConfig, readRawConfig, setSession, updateRawConfig, withServer, writeConfig } from "../src/config"

describe("config", () => {
  test("defaults to off with the local server", () => {
    expect(normalize(undefined, "mac")).toEqual({
      server: "http://127.0.0.1:4097",
      mode: "off",
      sessions: [],
      machineName: "mac",
      subagent: "general",
      autoStartLocalHub: true,
      herdr: true,
      list: { days: 30, max: 100 },
    })
  })

  test("normalizes untrusted values field by field", () => {
    const c = normalize({ server: "https://voice.example.com/", mode: "bogus", sessions: ["ses_a", "x", "ses_a", 3], token: "t" }, "mac")
    expect(c).toEqual({
      server: "https://voice.example.com",
      mode: "off",
      sessions: ["ses_a"],
      machineName: "mac",
      subagent: "general",
      autoStartLocalHub: true,
      herdr: true,
      list: { days: 30, max: 100 },
      token: "t",
    })
    expect(normalize({ server: "javascript:alert(1)" }, "mac").server).toBe("http://127.0.0.1:4097")
  })

  test("subagent defaults to general and accepts only plain agent IDs", () => {
    expect(normalize({ subagent: "tdd-dev" }, "mac").subagent).toBe("tdd-dev")
    expect(normalize({ subagent: "my_agent.v2" }, "mac").subagent).toBe("my_agent.v2")
    for (const bad of ["", "two words", "a/b", "x\"y", 3, null, "a\nb"]) expect(normalize({ subagent: bad }, "mac").subagent).toBe("general")
    expect(normalize({ subagent: "a".repeat(65) }, "mac").subagent).toBe("general")
  })

  test("autoStartLocalHub defaults to true; only a boolean false turns it off", () => {
    expect(normalize({ autoStartLocalHub: false }, "mac").autoStartLocalHub).toBe(false)
    expect(normalize({ autoStartLocalHub: true }, "mac").autoStartLocalHub).toBe(true)
    for (const v of ["false", 0, null, "no"]) expect(normalize({ autoStartLocalHub: v }, "mac").autoStartLocalHub).toBe(true)
  })

  test("herdr defaults to true; only a boolean false turns it off", () => {
    expect(normalize({ herdr: false }, "mac").herdr).toBe(false)
    expect(normalize({ herdr: true }, "mac").herdr).toBe(true)
    for (const v of ["false", 0, null]) expect(normalize({ herdr: v }, "mac").herdr).toBe(true)
  })

  test("list window: days 1-365 and max 1-500 (integers), each falling back to its default", () => {
    expect(normalize({ list: { days: 7, max: 50 } }, "mac").list).toEqual({ days: 7, max: 50 })
    expect(normalize({ list: { days: 1, max: 1 } }, "mac").list).toEqual({ days: 1, max: 1 })
    expect(normalize({ list: { days: 365, max: 500 } }, "mac").list).toEqual({ days: 365, max: 500 })
    expect(normalize({ list: { days: 0, max: 501 } }, "mac").list).toEqual({ days: 30, max: 100 })
    expect(normalize({ list: { days: 366, max: 0 } }, "mac").list).toEqual({ days: 30, max: 100 })
    expect(normalize({ list: { days: 2.5, max: "50" } }, "mac").list).toEqual({ days: 30, max: 100 })
    expect(normalize({ list: { days: 10 } }, "mac").list).toEqual({ days: 10, max: 100 })
    for (const bad of [null, "x", [1, 2], 5]) expect(normalize({ list: bad }, "mac").list).toEqual({ days: 30, max: 100 })
  })

  test("writes atomically with 0600 and reads back", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "vcfg-")), "sub", "config.json")
    writeConfig(file, { ...normalize({}, "mac"), mode: "always", token: "secret" })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readConfig(file, "mac")).toMatchObject({ mode: "always", token: "secret" })
    expect(readConfig(path.join(file, "missing"), "mac").mode).toBe("off")
  })

  test("changing server drops credentials; same server keeps them", () => {
    const c = { ...normalize({}, "mac"), machineID: "m1", token: "t" }
    expect(withServer(c, "http://127.0.0.1:4097/")).toMatchObject({ machineID: "m1", token: "t" })
    const moved = withServer(c, "https://voice.example.com")
    expect(moved.server).toBe("https://voice.example.com")
    expect(moved.token).toBeUndefined()
    expect(moved.machineID).toBeUndefined()
  })

  test("exposure follows the mode", () => {
    const c = setSession(normalize({}, "mac"), "ses_a", true)
    expect(isExposed(c, "ses_a")).toBe(false)
    expect(isExposed({ ...c, mode: "session" }, "ses_a")).toBe(true)
    expect(isExposed({ ...c, mode: "session" }, "ses_b")).toBe(false)
    expect(isExposed({ ...c, mode: "always" }, "ses_b")).toBe(true)
    expect(setSession(c, "ses_a", false).sessions).toEqual([])
  })

  test("config path honors overrides", () => {
    expect(configPath({ HUB_SPOKE_CONFIG: "/x/c.json" })).toBe("/x/c.json")
    expect(configPath({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/hub/config.json")
    expect(configPath({}, "/home/me")).toBe("/home/me/.config/hub/config.json")
  })

  test("the legacy OPENCODE_VOICE_CONFIG is a fallback; the new name wins", () => {
    expect(configPath({ OPENCODE_VOICE_CONFIG: "/old/c.json" })).toBe("/old/c.json")
    expect(configPath({ OPENCODE_HUB_CONFIG: "/hub/c.json" })).toBe("/hub/c.json")
    expect(configPath({ OPENCODE_VOICE_CONFIG: "/old/c.json", OPENCODE_HUB_CONFIG: "/hub/c.json", HUB_SPOKE_CONFIG: "/new/c.json" })).toBe("/new/c.json")
  })
})

describe("config migration from opencode-hub and opencode-voice", () => {
  const legacyHome = (dir = "opencode-voice") => {
    const home = mkdtempSync(path.join(tmpdir(), "hub-home-"))
    const legacy = path.join(home, ".config", dir, "config.json")
    mkdirSync(path.dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ server: "https://hub.example.com", mode: "always", token: "t" }))
    chmodSync(legacy, 0o600)
    return { home, legacy }
  }

  test("copies the legacy config (mode 0600) on first start and keeps the old file", () => {
    const { home, legacy } = legacyHome()
    const lines: string[] = []
    const file = prepareConfigPath({}, home, (m) => lines.push(m))
    expect(file).toBe(path.join(home, ".config", "hub", "config.json"))
    expect(readConfig(file, "mac")).toMatchObject({ server: "https://hub.example.com", mode: "always", token: "t" })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSync(legacy)).toBe(true)
    expect(lines).toHaveLength(1)
    // second start: already migrated, nothing logged
    prepareConfigPath({}, home, (m) => lines.push(m))
    expect(lines).toHaveLength(1)
  })

  test("copies the opencode-hub config first when both legacy copies exist", () => {
    const { home, legacy } = legacyHome("opencode-hub")
    const voice = path.join(home, ".config", "opencode-voice", "config.json")
    mkdirSync(path.dirname(voice), { recursive: true })
    writeFileSync(voice, JSON.stringify({ server: "https://old.example.com", mode: "off" }))
    const file = prepareConfigPath({}, home, () => {})
    expect(readConfig(file, "mac")).toMatchObject({ server: "https://hub.example.com", mode: "always", token: "t" })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(voice)).toBe(true)
  })

  test("an explicit config path bypasses migration", () => {
    const { home } = legacyHome()
    const explicit = path.join(home, "elsewhere.json")
    const lines: string[] = []
    expect(prepareConfigPath({ HUB_SPOKE_CONFIG: explicit }, home, (m) => lines.push(m))).toBe(explicit)
    expect(prepareConfigPath({ OPENCODE_HUB_CONFIG: explicit }, home, (m) => lines.push(m))).toBe(explicit)
    expect(existsSync(path.join(home, ".config", "hub"))).toBe(false)
    expect(lines).toEqual([])
  })

  test("an existing new config is never overwritten", () => {
    const { home } = legacyHome()
    const file = path.join(home, ".config", "hub", "config.json")
    writeConfig(file, normalize({ server: "http://127.0.0.1:4097" }, "mac"))
    prepareConfigPath({}, home, () => {})
    expect(readConfig(file, "mac").server).toBe("http://127.0.0.1:4097")
  })
})

describe("model refs", () => {
  test("voiceModel and workModel accept provider/model[#variant] and drop anything else", () => {
    const c = normalize({ voiceModel: "anthropic/claude-haiku-5-5", workModel: "openrouter/anthropic/claude-sonnet-4.5#high" }, "mac")
    expect(c.voiceModel).toBe("anthropic/claude-haiku-5-5")
    expect(c.workModel).toBe("openrouter/anthropic/claude-sonnet-4.5#high")
    expect(normalize({ voiceModel: "haiku" }, "mac").voiceModel).toBeUndefined()
    expect(normalize({ voiceModel: "a/b c" }, "mac").voiceModel).toBeUndefined()
  })
  test("parseModelRef / formatModelRef round-trip", () => {
    const { parseModelRef, formatModelRef } = require("../src/config")
    expect(parseModelRef("anthropic/claude-haiku-5-5")).toEqual({ providerID: "anthropic", id: "claude-haiku-5-5" })
    expect(parseModelRef("openrouter/anthropic/x#high")).toEqual({ providerID: "openrouter", id: "anthropic/x", variant: "high" })
    expect(formatModelRef({ providerID: "openrouter", id: "anthropic/x", variant: "high" })).toBe("openrouter/anthropic/x#high")
    expect(formatModelRef({ providerID: "anthropic", id: "claude-opus-5-5", variant: "default" })).toBe("anthropic/claude-opus-5-5")
  })
})

describe("lossless persistence (I4)", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "vcfg-raw-"))
  const raw = (file: string) => JSON.parse(readFileSync(file, "utf8"))

  test("writeConfig keeps keys it does not know and drops known keys the config no longer has", () => {
    const file = path.join(dir(), "config.json")
    writeFileSync(file, JSON.stringify({ server: "https://a.example", token: "t", machineID: "m1", futureKey: { nested: [1, 2] }, other: "x" }))
    const read = readConfig(file, "mac")
    const { token: _t, machineID: _m, ...rest } = read
    writeConfig(file, { ...rest, mode: "always" })
    const after = raw(file)
    expect(after.futureKey).toEqual({ nested: [1, 2] })
    expect(after.other).toBe("x")
    expect(after.mode).toBe("always")
    expect(after.token).toBeUndefined()
    expect(after.machineID).toBeUndefined()
    expect(readConfig(file, "mac")).toEqual({ ...rest, mode: "always" })
  })

  test("writeConfig still replaces a file that is not a JSON object", () => {
    const file = path.join(dir(), "config.json")
    writeFileSync(file, "{not json")
    writeConfig(file, normalize({ mode: "always" }, "mac"))
    expect(raw(file).mode).toBe("always")
  })

  test("updateRawConfig merges into the raw JSON atomically with 0600 and leaves no temp file", () => {
    const base = dir()
    const file = path.join(base, "sub", "config.json")
    expect(readRawConfig(file)).toBeUndefined()
    updateRawConfig(file, (r) => ({ ...r, server: "https://a.example" }))
    writeFileSync(file, JSON.stringify({ ...raw(file), unknown: true }))
    updateRawConfig(file, (r) => ({ ...r, token: "t" }))
    expect(raw(file)).toEqual({ server: "https://a.example", unknown: true, token: "t" })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(readdirSync(path.dirname(file))).toEqual(["config.json"])
  })

  test("updateRawConfig refuses a file that is not a JSON object and leaves it untouched", () => {
    const file = path.join(dir(), "config.json")
    for (const content of ["{not json", "[1,2]", "null"]) {
      writeFileSync(file, content)
      expect(() => updateRawConfig(file, (r) => ({ ...r, token: "t" }))).toThrow(/not a JSON object/)
      expect(readFileSync(file, "utf8")).toBe(content)
      expect(() => readRawConfig(file)).toThrow(/not a JSON object/)
    }
  })

  test("a failed write leaves the previous file intact and no temp file behind", () => {
    if (process.getuid?.() === 0) return
    const base = dir()
    const file = path.join(base, "config.json")
    writeFileSync(file, JSON.stringify({ keep: 1 }))
    chmodSync(base, 0o500)
    try {
      expect(() => updateRawConfig(file, (r) => ({ ...r, token: "t" }))).toThrow()
    } finally {
      chmodSync(base, 0o700)
    }
    expect(raw(file)).toEqual({ keep: 1 })
    expect(readdirSync(base)).toEqual(["config.json"])
  })
})
