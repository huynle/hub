import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { centralConfig } from "../src/central/config"
import { hashToken, MODEL_PREFS_LIMIT, newToken, READS_LIMIT, Store } from "../src/central/store"

const tmp = () => mkdtempSync(path.join(tmpdir(), "voice-store-"))

describe("centralConfig", () => {
  test("defaults", () => {
    const config = centralConfig({}, "/home/u")
    expect(config).toEqual({
      host: "127.0.0.1",
      port: 4097,
      publicURL: "http://127.0.0.1:4097",
      stateDir: "/home/u/.local/state/opencode-voice",
      apiKey: undefined,
      sttModel: "openai/gpt-4o-mini-transcribe",
      ttsModel: "microsoft/mai-voice-2.1-flash",
      voice: "en-US-Harper:MAI-Voice-2.1-Flash",
      maxAudioBytes: 10 * 1024 * 1024,
      maxSpeechChars: 800,
      turnTimeoutMs: 600_000,
      vapidSubject: "mailto:opencode-voice@localhost",
      auth: { mode: "pairing" },
    })
  })

  test("reads env, strips trailing slash, ignores bad numbers", () => {
    const config = centralConfig(
      {
        VOICE_HOST: "0.0.0.0",
        VOICE_PORT: "4300",
        VOICE_PUBLIC_URL: "https://voice.example.com/",
        VOICE_STATE_DIR: "/data",
        OPENROUTER_API_KEY: "k",
        VOICE_MAX_AUDIO_BYTES: "nope",
        VOICE_MAX_SPEECH_CHARS: "-5",
        VOICE_TURN_TIMEOUT_MS: "1000",
        VOICE_STT_MODEL: "openai/whisper-1",
      },
      "/home/u",
    )
    expect(config.host).toBe("0.0.0.0")
    expect(config.port).toBe(4300)
    expect(config.publicURL).toBe("https://voice.example.com")
    expect(config.stateDir).toBe("/data")
    expect(config.apiKey).toBe("k")
    expect(config.maxAudioBytes).toBe(10 * 1024 * 1024)
    expect(config.maxSpeechChars).toBe(800)
    expect(config.turnTimeoutMs).toBe(1000)
    expect(config.sttModel).toBe("openai/whisper-1")
  })

  test("public URL defaults to host:port, and port 0 is allowed", () => {
    expect(centralConfig({ VOICE_HOST: "0.0.0.0", VOICE_PORT: "0" }, "/h").port).toBe(0)
    expect(centralConfig({ VOICE_PORT: "5000" }, "/h").publicURL).toBe("http://127.0.0.1:5000")
  })

  test("rejects a non-http public URL", () => {
    expect(() => centralConfig({ VOICE_PUBLIC_URL: "ftp://x" }, "/h")).toThrow(/VOICE_PUBLIC_URL/)
  })
})

describe("tokens", () => {
  test("32 random bytes, base64url, hashed as sha256 hex", () => {
    const token = newToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newToken()).not.toBe(token)
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).toBe(hashToken(token))
  })
})

describe("Store", () => {
  test("adds machines, finds them by token, never stores the token", () => {
    const dir = tmp()
    const store = Store.open(path.join(dir, "state"))
    const { machine, token } = store.addMachine("laptop")
    expect(machine.name).toBe("laptop")
    expect(store.findMachine(token)?.id).toBe(machine.id)
    expect(store.findMachine("wrong")).toBeUndefined()
    expect(store.findMachine("")).toBeUndefined()
    const raw = readFileSync(path.join(dir, "state", "state.json"), "utf8")
    expect(raw).not.toContain(token)
    expect(raw).toContain(hashToken(token))
  })

  test("revoked machines no longer authenticate", () => {
    const store = Store.open(tmp())
    const { machine, token } = store.addMachine("laptop")
    expect(store.revokeMachine(machine.id)).toBe(true)
    expect(store.findMachine(token)).toBeUndefined()
    expect(store.revokeMachine("missing")).toBe(false)
    expect(store.machines()[0]?.revoked).toBe(true)
  })

  test("devices add, find, remove", () => {
    const store = Store.open(tmp())
    const { device, token } = store.addDevice("phone")
    expect(store.findDevice(token)?.id).toBe(device.id)
    expect(store.devices()).toHaveLength(1)
    expect(store.removeDevice(device.id)).toBe(true)
    expect(store.findDevice(token)).toBeUndefined()
    expect(store.removeDevice(device.id)).toBe(false)
  })

  test("persists across reopen with private permissions", () => {
    const dir = path.join(tmp(), "nested", "state")
    const a = Store.open(dir)
    const { token } = a.addDevice("phone")
    const { token: mtoken } = a.addMachine("box")
    const b = Store.open(dir)
    expect(b.findDevice(token)?.name).toBe("phone")
    expect(b.findMachine(mtoken)?.name).toBe("box")
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600)
    expect(b.data().push).toEqual([])
  })

  test("refuses to start over a corrupt state file instead of overwriting it", () => {
    const dir = tmp()
    writeFileSync(path.join(dir, "state.json"), "{not json")
    expect(() => Store.open(dir)).toThrow(/state\.json/)
  })

  test("touch updates lastSeen", () => {
    let now = 1000
    const store = Store.open(tmp(), () => now)
    const { device } = store.addDevice("phone")
    now = 1000 + 120_000
    store.touchDevice(device.id)
    expect(store.devices()[0]?.lastSeen).toBe(now)
  })

  test("persists isolated per-user model preferences by session and bounds old entries", () => {
    const dir = tmp()
    const store = Store.open(dir)
    const alice = store.upsertUser({ email: "alice@example.test", role: "user" })
    const bob = store.upsertUser({ email: "bob@example.test", role: "user" })
    const voice = { providerID: "anthropic", modelID: "claude-haiku", variant: "fast" }
    const worker = { providerID: "anthropic", modelID: "claude-opus", variant: "thinking" }
    expect(store.setModelPrefs(alice.id, "ses_one", { voice, worker })).toEqual({ voice, worker })
    expect(store.modelPrefs(alice.id, "ses_one")).toEqual({ voice, worker })
    expect(store.modelPrefs(bob.id, "ses_one")).toEqual({})
    expect(store.setModelPrefs(alice.id, "ses_one", { voice: null })).toEqual({ worker })
    expect(Store.open(dir).modelPrefs(alice.id, "ses_one")).toEqual({ worker })

    for (let i = 0; i <= MODEL_PREFS_LIMIT; i++) {
      store.setModelPrefs(alice.id, `ses_${i}`, { voice: { providerID: "p", modelID: `m${i}` } })
    }
    expect(store.modelPrefs(alice.id, "ses_0")).toEqual({})
    expect(store.modelPrefs(alice.id, `ses_${MODEL_PREFS_LIMIT}`).voice?.modelID).toBe(`m${MODEL_PREFS_LIMIT}`)
    expect(Store.open(dir).modelPrefs(alice.id, `ses_${MODEL_PREFS_LIMIT}`).voice?.modelID).toBe(`m${MODEL_PREFS_LIMIT}`)
  })

  test("read marks are per user, only move forward, persist and are bounded", () => {
    const dir = tmp()
    const store = Store.open(dir)
    const alice = store.upsertUser({ email: "alice@example.test", role: "user" })
    const bob = store.upsertUser({ email: "bob@example.test", role: "user" })
    expect(store.markRead(alice.id, "ses_one", 100)).toEqual({ ses_one: 100 })
    expect(store.markRead(alice.id, "ses_one", 50)).toEqual({ ses_one: 100 })
    expect(store.reads(bob.id)).toEqual({})
    expect(Store.open(dir).reads(alice.id)).toEqual({ ses_one: 100 })
    for (let i = 0; i <= READS_LIMIT; i++) store.markRead(alice.id, `ses_${i}`, 200 + i)
    const reads = store.reads(alice.id)
    expect(Object.keys(reads)).toHaveLength(READS_LIMIT)
    expect(reads.ses_one).toBeUndefined()
    expect(reads[`ses_${READS_LIMIT}`]).toBe(200 + READS_LIMIT)
  })
})
