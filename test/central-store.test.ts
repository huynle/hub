import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { centralConfig } from "../src/central/config"
import { hashToken, LOCAL_USER, MODEL_PREFS_LIMIT, newToken, READS_LIMIT, Store } from "../src/central/store"

const tmp = () => mkdtempSync(path.join(tmpdir(), "voice-store-"))

describe("centralConfig", () => {
  test("defaults", () => {
    const config = centralConfig({}, "/home/u")
    expect(config).toEqual({
      host: "127.0.0.1",
      port: 4097,
      publicURL: "http://127.0.0.1:4097",
      stateDir: "/home/u/.local/state/hub",
      apiKey: undefined,
      sttModel: "openai/gpt-4o-mini-transcribe",
      ttsModel: "microsoft/mai-voice-2.1-flash",
      voice: "en-US-Harper:MAI-Voice-2.1-Flash",
      maxAudioBytes: 10 * 1024 * 1024,
      maxSpeechChars: 800,
      turnTimeoutMs: 600_000,
      vapidSubject: "mailto:hub@localhost",
      auth: { mode: "pairing" },
    })
  })

  test("reads env, strips trailing slash, ignores bad numbers", () => {
    const config = centralConfig(
      {
        HUB_HOST: "0.0.0.0",
        HUB_PORT: "4300",
        HUB_PUBLIC_URL: "https://voice.example.com/",
        HUB_STATE_DIR: "/data",
        OPENROUTER_API_KEY: "k",
        HUB_MAX_AUDIO_BYTES: "nope",
        HUB_MAX_SPEECH_CHARS: "-5",
        HUB_TURN_TIMEOUT_MS: "1000",
        HUB_STT_MODEL: "openai/whisper-1",
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
    expect(centralConfig({ HUB_HOST: "0.0.0.0", HUB_PORT: "0" }, "/h").port).toBe(0)
    expect(centralConfig({ HUB_PORT: "5000" }, "/h").publicURL).toBe("http://127.0.0.1:5000")
  })

  test("rejects a non-http public URL", () => {
    expect(() => centralConfig({ HUB_PUBLIC_URL: "ftp://x" }, "/h")).toThrow(/HUB_PUBLIC_URL/)
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

  test("archived sessions are the stored hiddenSessions list: kept as-is across restarts (no migration), up to 5000", () => {
    const dir = path.join(tmp(), "state")
    const store = Store.open(dir)
    // What 0.6 stored as hidden is what 0.7 shows as archived.
    const archived = Array.from({ length: 5000 }, (_, i) => `ses_${i}`)
    store.setViewPrefs("local", { hiddenSessions: archived, pinnedSessions: ["ses_p"] })
    const again = Store.open(dir)
    expect(again.viewPrefs("local")).toEqual({ hiddenSessions: archived, hiddenWorkspaces: [], pinnedSessions: ["ses_p"], pinnedWorkspaces: [] })
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

describe("Store state directory permissions", () => {
  const eperm = () => Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" })

  test("a chmod EPERM on a writable state dir (fresh k8s volume) is a warning, files stay 0600", () => {
    const dir = tmp()
    const warnings: string[] = []
    const store = Store.open(dir, Date.now, {
      chmodDir: () => {
        throw eperm()
      },
      warn: (message) => warnings.push(message),
    })
    store.addMachine("laptop")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(dir)
    expect(warnings[0]).not.toContain("\n")
    expect(statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600)
  })

  test("a chmod EACCES on a dir the process cannot write still fails", () => {
    const dir = tmp()
    expect(() =>
      Store.open(dir, Date.now, {
        chmodDir: () => {
          throw Object.assign(new Error("EACCES: permission denied, chmod"), { code: "EACCES" })
        },
        writable: () => false,
        warn: () => {},
      }),
    ).toThrow(/EACCES/)
  })

  test("other chmod errors still fail", () => {
    expect(() =>
      Store.open(tmp(), Date.now, {
        chmodDir: () => {
          throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
        },
        warn: () => {},
      }),
    ).toThrow(/EIO/)
  })

  test("no warning when chmod succeeds; the dir is 0700", () => {
    const dir = path.join(tmp(), "state")
    const warnings: string[] = []
    Store.open(dir, Date.now, { warn: (m) => warnings.push(m) })
    expect(warnings).toEqual([])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe("Store agent data and token epochs", () => {
  const stateFile = (dir: string) => path.join(dir, "state.json")
  const readState = (dir: string) => JSON.parse(readFileSync(stateFile(dir), "utf8"))
  const writeState = (dir: string, state: unknown) => writeFileSync(stateFile(dir), JSON.stringify(state), { mode: 0o600 })
  /** A state.json as written by 0.6 (no agent data, no epochs). */
  const oldState = () => ({
    machines: [{ id: "mch_1", name: "box", tokenHash: hashToken("m"), created: 1, lastSeen: 1, ownerID: "u1" }],
    devices: [],
    push: [],
    users: [
      { id: LOCAL_USER, role: "admin", created: 1, lastSeen: 1 },
      { id: "u1", email: "a@example.test", role: "user", created: 1, lastSeen: 1 },
    ],
    audit: [],
  })

  test("an old state file loads unchanged: no agent data, epochs default to 0 lazily", () => {
    const dir = tmp()
    writeState(dir, oldState())
    const store = Store.open(dir)
    expect(store.agentData("u1")).toEqual({})
    expect(store.userEpoch("u1")).toBe(0)
    expect(store.machineEpoch("mch_1")).toBe(0)
    expect(store.userEpoch("missing")).toBe(0)
    expect(readState(dir)).toEqual(oldState())
  })

  test("migrate normalises agent data and epochs, keeps unknown inner fields, and is idempotent", () => {
    const dir = tmp()
    const state = oldState() as any
    state.users[1].agent = {
      future: { kept: true },
      names: [
        { name: "api", sessionID: "ses_1", extra: 1 },
        { name: "api", sessionID: "ses_dup" },
        { name: 5, sessionID: "ses_2" },
        "junk",
        { name: "web", sessionID: "ses_3" },
      ],
      roles: [{ role: "reviewer", sessionID: "ses_1" }, { role: "reviewer", sessionID: "ses_1" }, { role: "x" }],
      sessions: "not a list",
      appTokens: [{ id: "tok_1", tokenHash: "h1", label: "ci", scopes: ["sessions:read"] }, { id: "tok_2" }],
    }
    state.users[1].tokenEpoch = 3
    state.users[0].tokenEpoch = -1
    state.users.push({ id: "u2", role: "user", created: 1, lastSeen: 1, agent: "bad", tokenEpoch: "7" })
    state.machines[0].tokenEpoch = 2.5
    writeState(dir, state)
    const store = Store.open(dir)
    expect(store.agentData("u1")).toEqual({
      future: { kept: true },
      names: [
        { name: "api", sessionID: "ses_1", extra: 1 },
        { name: "web", sessionID: "ses_3" },
      ],
      roles: [{ role: "reviewer", sessionID: "ses_1" }],
      appTokens: [{ id: "tok_1", tokenHash: "h1", label: "ci", scopes: ["sessions:read"] }],
    })
    expect(store.userEpoch("u1")).toBe(3)
    expect(store.userEpoch(LOCAL_USER)).toBe(0)
    expect(store.agentData("u2")).toEqual({})
    expect(store.userEpoch("u2")).toBe(0)
    expect(store.machineEpoch("mch_1")).toBe(0)
    const first = readFileSync(stateFile(dir), "utf8")
    Store.open(dir)
    expect(readFileSync(stateFile(dir), "utf8")).toBe(first)
    const raw = readState(dir)
    expect("agent" in raw.users[2]).toBe(false)
    expect("tokenEpoch" in raw.users[2]).toBe(false)
    expect("tokenEpoch" in raw.machines[0]).toBe(false)
  })

  test("agentData returns a copy; updateAgentData normalises, persists and saves only on real change", () => {
    const dir = tmp()
    const store = Store.open(dir)
    const alice = store.upsertUser({ email: "alice@example.test", role: "user" })
    const copy = store.agentData(alice.id)
    copy.names = [{ name: "x", sessionID: "ses_x" }]
    expect(store.agentData(alice.id)).toEqual({})

    const next = store.updateAgentData(alice.id, (data) => {
      data.names = [{ name: "api", sessionID: "ses_1" }, { name: "api", sessionID: "ses_2" }]
      data.sessions = [{ sessionID: "ses_1", machineID: "mch_1" }]
    })
    expect(next).toEqual({ names: [{ name: "api", sessionID: "ses_1" }], sessions: [{ sessionID: "ses_1", machineID: "mch_1" }] })
    expect(Store.open(dir).agentData(alice.id)).toEqual(next!)

    const inode = statSync(stateFile(dir)).ino
    expect(store.updateAgentData(alice.id, () => {})).toEqual(next!)
    expect(store.updateAgentData(alice.id, (data) => ({ ...data }))).toEqual(next!)
    expect(statSync(stateFile(dir)).ino).toBe(inode)

    store.updateAgentData(alice.id, (data) => {
      data.roles = [{ role: "reviewer", sessionID: "ses_1" }]
    })
    expect(statSync(stateFile(dir)).ino).not.toBe(inode)
    expect(Store.open(dir).agentData(alice.id).roles).toEqual([{ role: "reviewer", sessionID: "ses_1" }])
    expect(store.updateAgentData("missing", () => ({ names: [] }))).toBeUndefined()
  })

  test("epoch bumps persist", () => {
    const dir = tmp()
    const store = Store.open(dir)
    const alice = store.upsertUser({ email: "alice@example.test", role: "user" })
    const { machine } = store.addMachine("box", alice.id)
    expect(store.bumpUserEpoch(alice.id)).toBe(1)
    expect(store.bumpUserEpoch(alice.id)).toBe(2)
    expect(store.bumpMachineEpoch(machine.id)).toBe(1)
    expect(store.bumpUserEpoch("missing")).toBeUndefined()
    expect(store.bumpMachineEpoch("missing")).toBeUndefined()
    const again = Store.open(dir)
    expect(again.userEpoch(alice.id)).toBe(2)
    expect(again.machineEpoch(machine.id)).toBe(1)
  })

  test("migrateLocal moves the local user's agent data to the admin (no duplicates) and bumps epochs", () => {
    const dir = tmp()
    const store = Store.open(dir)
    const own = store.addMachine("own").machine
    const admin = store.upsertUser({ email: "admin@example.test", role: "admin" })
    const adminMachine = store.addMachine("admin box", admin.id).machine
    store.updateAgentData(LOCAL_USER, () => ({
      names: [{ name: "api", sessionID: "ses_1" }, { name: "web", sessionID: "ses_2" }],
      appTokens: [{ id: "tok_1", tokenHash: "h1" }],
      future: { a: 1 },
    }))
    store.updateAgentData(admin.id, () => ({ names: [{ name: "api", sessionID: "ses_1" }], roles: [{ role: "lead", sessionID: "ses_9" }] }))
    expect(store.migrateLocal(admin.id)).toBe(true)
    const expected = {
      names: [{ name: "api", sessionID: "ses_1" }, { name: "web", sessionID: "ses_2" }],
      roles: [{ role: "lead", sessionID: "ses_9" }],
      appTokens: [{ id: "tok_1", tokenHash: "h1" }],
      future: { a: 1 },
    }
    expect(store.agentData(admin.id)).toEqual(expected)
    expect(store.agentData(LOCAL_USER)).toEqual({})
    expect(store.userEpoch(LOCAL_USER)).toBe(1)
    expect(store.machineEpoch(own.id)).toBe(1)
    expect(store.machineEpoch(adminMachine.id)).toBe(0)
    const again = Store.open(dir)
    expect(again.agentData(admin.id)).toEqual(expected)
    expect(again.userEpoch(LOCAL_USER)).toBe(1)
    expect(again.machineEpoch(own.id)).toBe(1)
  })

  test("downgrade: an older hub keeping only known top-level keys keeps user.agent and epochs", () => {
    const dir = tmp()
    const store = Store.open(dir)
    const alice = store.upsertUser({ email: "alice@example.test", role: "user" })
    const { machine } = store.addMachine("box", alice.id)
    store.updateAgentData(alice.id, () => ({ names: [{ name: "api", sessionID: "ses_1" }] }))
    store.bumpUserEpoch(alice.id)
    store.bumpMachineEpoch(machine.id)
    // What 0.6's Store.open does: keep only the known top-level keys, persist users/machines as-is, save.
    const raw = readState(dir)
    const known = ["machines", "devices", "vapid", "push", "speech", "users", "audit"]
    writeState(dir, Object.fromEntries(Object.entries({ ...raw, unknownTop: 1 }).filter(([key]) => known.includes(key))))
    const again = Store.open(dir)
    expect(again.agentData(alice.id)).toEqual({ names: [{ name: "api", sessionID: "ses_1" }] })
    expect(again.userEpoch(alice.id)).toBe(1)
    expect(again.machineEpoch(machine.id)).toBe(1)
  })
})
