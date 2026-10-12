import { describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { configPath, isExposed, normalize, readConfig, setSession, withServer, writeConfig } from "../src/config"

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
    expect(configPath({ OPENCODE_VOICE_CONFIG: "/x/c.json" })).toBe("/x/c.json")
    expect(configPath({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/opencode-voice/config.json")
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
