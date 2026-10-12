// Hub configuration: ~/.config/opencode-voice/hub.json (or $VOICE_HUB_CONFIG) under env vars, with
// validated speech settings and API keys refused from a file other users can read.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { centralConfig, hubConfigPath, loadCentralConfig, readHubFile } from "../src/central/config"

const HOME = "/home/me"
const KEY = "sk-or-v1-FILEKEY0123456789"

function file(content: unknown, mode = 0o600): string {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-hubcfg-"))
  const p = path.join(dir, "hub.json")
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content))
  chmodSync(p, mode)
  return p
}

describe("hub.json path", () => {
  test("defaults under ~/.config, honors XDG_CONFIG_HOME and VOICE_HUB_CONFIG", () => {
    expect(hubConfigPath({}, HOME)).toBe("/home/me/.config/opencode-voice/hub.json")
    expect(hubConfigPath({ XDG_CONFIG_HOME: "/xdg" }, HOME)).toBe("/xdg/opencode-voice/hub.json")
    expect(hubConfigPath({ VOICE_HUB_CONFIG: "/etc/hub.json", XDG_CONFIG_HOME: "/xdg" }, HOME)).toBe("/etc/hub.json")
  })
})

describe("readHubFile", () => {
  test("a missing file is fine", () => {
    expect(readHubFile(path.join(tmpdir(), "nope-voice", "hub.json"))).toEqual({ warnings: [] })
  })

  test("reads server fields and validated speech settings", () => {
    const p = file({
      host: "127.0.0.1",
      port: 4320,
      publicURL: "http://localhost:4320/",
      stateDir: "~/voice-state",
      speech: {
        stt: { provider: "openai-compatible", baseURL: "http://127.0.0.1:8000/v1/", model: "whisper-1", language: "en" },
        tts: { provider: "openrouter", model: "openai/gpt-4o-mini-tts", voice: "nova", speed: 1.2, apiKey: KEY },
      },
    })
    const { file: hub, warnings } = readHubFile(p, HOME)
    expect(warnings).toEqual([])
    expect(hub).toEqual({
      host: "127.0.0.1",
      port: 4320,
      publicURL: "http://localhost:4320/",
      stateDir: "/home/me/voice-state",
      speech: {
        stt: { provider: "openai-compatible", baseURL: "http://127.0.0.1:8000/v1", model: "whisper-1", language: "en" },
        tts: { provider: "openrouter", model: "openai/gpt-4o-mini-tts", voice: "nova", speed: 1.2, apiKey: KEY },
      },
    })
  })

  test("invalid JSON or values fail with the file name", () => {
    expect(() => readHubFile(file("{nope"))).toThrow(/hub\.json/)
    expect(() => readHubFile(file({ port: "4097" }))).toThrow(/port/)
    expect(() => readHubFile(file({ port: 70000 }))).toThrow(/port/)
    expect(() => readHubFile(file({ host: "" }))).toThrow(/host/)
    expect(() => readHubFile(file([1, 2]))).toThrow(/hub\.json/)
    expect(() => readHubFile(file({ speech: { tts: { provider: "openai-compatible" } } }))).toThrow(/baseURL is required/)
    expect(() => readHubFile(file({ speech: { stt: { baseURL: "http://voice.example.com/v1" } } }))).toThrow(/https/)
    expect(() => readHubFile(file({ speech: { tts: { speed: 9 } } }))).toThrow(/speed/)
  })

  test("unknown keys are reported, not fatal", () => {
    const { file: hub, warnings } = readHubFile(file({ prot: 1, port: 4097 }))
    expect(hub).toEqual({ port: 4097 })
    expect(warnings).toEqual([expect.stringContaining('unknown key "prot"')])
  })

  test("keys in a group/other-readable file are refused with a chmod hint; other settings still apply", () => {
    const p = file({ port: 4321, speech: { stt: { apiKey: KEY, model: "m" }, tts: { apiKey: KEY } } }, 0o644)
    const { file: hub, warnings } = readHubFile(p)
    expect(hub).toEqual({ port: 4321, speech: { stt: { model: "m" }, tts: {} } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`chmod 600 ${p}`)
    expect(warnings[0]).not.toContain(KEY)
  })

  test("a readable file without keys is accepted silently", () => {
    const { file: hub, warnings } = readHubFile(file({ port: 4321 }, 0o644))
    expect(hub).toEqual({ port: 4321 })
    expect(warnings).toEqual([])
  })
})

describe("centralConfig precedence", () => {
  test("env > hub.json > defaults for server fields", () => {
    const hub = { host: "127.0.0.1", port: 4320, publicURL: "http://localhost:4320", stateDir: "/s/file" }
    expect(centralConfig({}, HOME, hub)).toMatchObject({ host: "127.0.0.1", port: 4320, publicURL: "http://localhost:4320", stateDir: "/s/file" })
    expect(centralConfig({ VOICE_PORT: "5000", VOICE_STATE_DIR: "/s/env" }, HOME, hub)).toMatchObject({
      port: 5000,
      publicURL: "http://localhost:4320",
      stateDir: "/s/env",
    })
    expect(centralConfig({}, HOME, { port: 4330 })).toMatchObject({ host: "127.0.0.1", port: 4330, publicURL: "http://127.0.0.1:4330" })
    expect(centralConfig({}, HOME)).toMatchObject({ port: 4097, stateDir: "/home/me/.local/state/opencode-voice" })
  })

  test("speech from the file is passed through for the settings layer", () => {
    const speech = { tts: { model: "tts-1", voice: "alloy" } }
    expect(centralConfig({}, HOME, { speech }).speech).toEqual(speech)
    expect(centralConfig({}, HOME).speech).toBeUndefined()
  })

  test("loadCentralConfig reads the file named by VOICE_HUB_CONFIG", () => {
    const p = file({ port: 4322, speech: { tts: { voice: "nova" } } })
    const loaded = loadCentralConfig({ VOICE_HUB_CONFIG: p }, HOME)
    expect(loaded.path).toBe(p)
    expect(loaded.loaded).toBe(true)
    expect(loaded.config).toMatchObject({ port: 4322, publicURL: "http://127.0.0.1:4322", speech: { tts: { voice: "nova" } } })
    expect(loadCentralConfig({ VOICE_HUB_CONFIG: path.join(path.dirname(p), "missing.json") }, HOME).loaded).toBe(false)
  })
})

describe("public URL default for a wildcard listen address", () => {
  test("0.0.0.0 / :: (e.g. Docker) default to the loopback origin a local browser uses, not the bind address", () => {
    expect(centralConfig({ VOICE_HOST: "0.0.0.0", VOICE_PORT: "4097" }, HOME).publicURL).toBe("http://127.0.0.1:4097")
    expect(centralConfig({ VOICE_HOST: "::", VOICE_PORT: "4100" }, HOME).publicURL).toBe("http://127.0.0.1:4100")
    expect(centralConfig({ VOICE_HOST: "0.0.0.0", VOICE_PUBLIC_URL: "https://voice.example.com" }, HOME).publicURL).toBe("https://voice.example.com")
    expect(centralConfig({ VOICE_HOST: "10.0.0.20", VOICE_PORT: "4097" }, HOME).publicURL).toBe("http://10.0.0.20:4097")
  })
})
