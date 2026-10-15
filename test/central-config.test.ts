// Hub configuration: ~/.config/opencode-hub/hub.json (or $HUB_CONFIG) under env vars, with
// validated speech settings and API keys refused from a file other users can read.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
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
  test("defaults under ~/.config, honors XDG_CONFIG_HOME and HUB_CONFIG", () => {
    expect(hubConfigPath({}, HOME)).toBe("/home/me/.config/opencode-hub/hub.json")
    expect(hubConfigPath({ XDG_CONFIG_HOME: "/xdg" }, HOME)).toBe("/xdg/opencode-hub/hub.json")
    expect(hubConfigPath({ HUB_CONFIG: "/etc/hub.json", XDG_CONFIG_HOME: "/xdg" }, HOME)).toBe("/etc/hub.json")
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
    expect(centralConfig({ HUB_PORT: "5000", HUB_STATE_DIR: "/s/env" }, HOME, hub)).toMatchObject({
      port: 5000,
      publicURL: "http://localhost:4320",
      stateDir: "/s/env",
    })
    expect(centralConfig({}, HOME, { port: 4330 })).toMatchObject({ host: "127.0.0.1", port: 4330, publicURL: "http://127.0.0.1:4330" })
    expect(centralConfig({}, HOME)).toMatchObject({ port: 4097, stateDir: "/home/me/.local/state/opencode-hub" })
  })

  test("speech from the file is passed through for the settings layer", () => {
    const speech = { tts: { model: "tts-1", voice: "alloy" } }
    expect(centralConfig({}, HOME, { speech }).speech).toEqual(speech)
    expect(centralConfig({}, HOME).speech).toBeUndefined()
  })

  test("loadCentralConfig reads the file named by HUB_CONFIG", () => {
    const p = file({ port: 4322, speech: { tts: { voice: "nova" } } })
    const loaded = loadCentralConfig({ HUB_CONFIG: p }, HOME)
    expect(loaded.path).toBe(p)
    expect(loaded.loaded).toBe(true)
    expect(loaded.config).toMatchObject({ port: 4322, publicURL: "http://127.0.0.1:4322", speech: { tts: { voice: "nova" } } })
    expect(loadCentralConfig({ HUB_CONFIG: path.join(path.dirname(p), "missing.json") }, HOME).loaded).toBe(false)
  })
})

describe("public URL default for a wildcard listen address", () => {
  test("0.0.0.0 / :: (e.g. Docker) default to the loopback origin a local browser uses, not the bind address", () => {
    expect(centralConfig({ HUB_HOST: "0.0.0.0", HUB_PORT: "4097" }, HOME).publicURL).toBe("http://127.0.0.1:4097")
    expect(centralConfig({ HUB_HOST: "::", HUB_PORT: "4100" }, HOME).publicURL).toBe("http://127.0.0.1:4100")
    expect(centralConfig({ HUB_HOST: "0.0.0.0", HUB_PUBLIC_URL: "https://voice.example.com" }, HOME).publicURL).toBe("https://voice.example.com")
    expect(centralConfig({ HUB_HOST: "10.0.0.20", HUB_PORT: "4097" }, HOME).publicURL).toBe("http://10.0.0.20:4097")
  })
})

describe("legacy VOICE_* names", () => {
  test("are read as fallbacks; HUB_* wins", () => {
    const quiet = centralConfig({ VOICE_PORT: "4500", VOICE_PUBLIC_URL: "https://hub.example.com", VOICE_STATE_DIR: "/legacy" }, HOME)
    expect(quiet).toMatchObject({ port: 4500, publicURL: "https://hub.example.com", stateDir: "/legacy" })
    expect(centralConfig({ VOICE_PORT: "4500", HUB_PORT: "4600" }, HOME).port).toBe(4600)
    expect(hubConfigPath({ VOICE_HUB_CONFIG: "/old/hub.json" }, HOME)).toBe("/old/hub.json")
    expect(hubConfigPath({ VOICE_HUB_CONFIG: "/old/hub.json", HUB_CONFIG: "/new/hub.json" }, HOME)).toBe("/new/hub.json")
  })

  test("legacy oidc settings still configure sign-in", () => {
    const config = centralConfig(
      { VOICE_AUTH: "oidc", VOICE_OIDC_CLIENT_ID: "id", VOICE_OIDC_CLIENT_SECRET: "secret", VOICE_OIDC_ALLOWED: "@example.com", VOICE_ADMIN_EMAILS: "admin@example.com" },
      HOME,
    )
    expect(config.auth).toMatchObject({ mode: "oidc", clientId: "id", allowed: ["@example.com"], admins: ["admin@example.com"] })
  })

  test("error messages name the new variables", () => {
    expect(() => centralConfig({ HUB_AUTH: "nope" }, HOME)).toThrow(/HUB_AUTH/)
    expect(() => centralConfig({ HUB_PUBLIC_URL: "https://hub.example.com/path" }, HOME)).toThrow(/HUB_PUBLIC_URL/)
  })
})

describe("migration from opencode-voice", () => {
  function legacyHome(hub: unknown = { port: 4555 }) {
    const home = mkdtempSync(path.join(tmpdir(), "hub-home-"))
    const legacyConfig = path.join(home, ".config", "opencode-voice", "hub.json")
    mkdirSync(path.dirname(legacyConfig), { recursive: true })
    writeFileSync(legacyConfig, JSON.stringify(hub))
    chmodSync(legacyConfig, 0o600)
    const legacyState = path.join(home, ".local", "state", "opencode-voice")
    mkdirSync(legacyState, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(legacyState, "machines.json"), "[]", { mode: 0o600 })
    writeFileSync(path.join(legacyState, "hub.pid"), "{}", { mode: 0o600 })
    return { home, legacyConfig, legacyState }
  }

  test("copies hub.json and the state directory on first start, keeping modes and the old copies", () => {
    const { home, legacyConfig, legacyState } = legacyHome()
    const lines: string[] = []
    const loaded = loadCentralConfig({}, home, { log: (m) => lines.push(m) })
    const config = path.join(home, ".config", "opencode-hub", "hub.json")
    const state = path.join(home, ".local", "state", "opencode-hub")
    expect(loaded.path).toBe(config)
    expect(loaded.loaded).toBe(true)
    expect(loaded.config.port).toBe(4555)
    expect(loaded.config.stateDir).toBe(state)
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(state, "machines.json"), "utf8")).toBe("[]")
    expect(statSync(path.join(state, "machines.json")).mode & 0o777).toBe(0o600)
    expect(existsSync(path.join(state, "hub.pid"))).toBe(false)
    expect(existsSync(legacyConfig)).toBe(true)
    expect(existsSync(path.join(legacyState, "machines.json"))).toBe(true)
    expect(lines).toHaveLength(2)
    loadCentralConfig({}, home, { log: (m) => lines.push(m) })
    expect(lines).toHaveLength(2)
  })

  test("explicit HUB_CONFIG and HUB_STATE_DIR bypass migration", () => {
    const { home } = legacyHome()
    const explicit = path.join(home, "my-hub.json")
    const lines: string[] = []
    const loaded = loadCentralConfig({ HUB_CONFIG: explicit, HUB_STATE_DIR: path.join(home, "my-state") }, home, { log: (m) => lines.push(m) })
    expect(loaded.loaded).toBe(false)
    expect(existsSync(path.join(home, ".config", "opencode-hub"))).toBe(false)
    expect(existsSync(path.join(home, ".local", "state", "opencode-hub"))).toBe(false)
    expect(lines).toEqual([])
  })

  test("a stateDir in hub.json bypasses the state migration", () => {
    const { home } = legacyHome({ stateDir: "~/custom-state" })
    loadCentralConfig({}, home, { log: () => {} })
    expect(existsSync(path.join(home, ".local", "state", "opencode-hub"))).toBe(false)
  })
})
