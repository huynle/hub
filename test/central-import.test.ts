// `hub-server import --state <dir>` (design §10, decision vkxkqiuf): copies a single-process hub's state (state.json
// through the Store's own load/upgrade code, the agent StateStore files under agent/) into the shared backends
// a cluster reads, idempotently: rows already there are left alone (reported as conflicts when they differ)
// unless forced. Token hashes are copied, so machines and devices keep working without re-enrolling. Signing
// keys (token-keys.json) are never stored, only reported (and printed as HUB_TOKEN_KEYS material on request).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { memoryBackends, type StateStore } from "../src/central/backend"
import { FileStateStore } from "../src/central/backend/file-state"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import { importState } from "../src/central/import"
import { hashToken, HUB_ROWS, Store } from "../src/central/store"

export const MACHINE_TOKEN = "machine-token-0123456789abcdef"
export const DEVICE_TOKEN = "device-token-0123456789abcdef"
export const TOKEN_KEYS = { active: "k_new", keys: [{ kid: "k_old", secret: Buffer.alloc(32, 1).toString("base64"), created: 1 }, { kid: "k_new", secret: Buffer.alloc(32, 2).toString("base64"), created: 2 }] }

/** An older single-process hub's state directory: state.json in an old format, agent files, signing keys. */
export async function fixtureStateDir(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-import-"))
  const state = {
    users: [
      { id: "u_alice", email: "alice@example.com", role: "admin", created: 2, lastSeen: 20, agent: { names: [{ name: "api", sessionID: "ses_1" }], generations: { "reviewer\u0000hub": 3 } }, tokenEpoch: 2 },
      { id: "u_bob", email: "bob@example.com", role: "user", created: 3, lastSeen: 30, disabled: true },
    ],
    // No ownerID (before 0.3.0): the upgrade gives it to the local user.
    machines: [{ id: "mch_laptop", name: "laptop", tokenHash: hashToken(MACHINE_TOKEN), created: 4, lastSeen: 40 }],
    // Legacy push prefs (0.5.0): upgraded to the current toggles.
    devices: [{ id: "dev_phone", name: "phone", tokenHash: hashToken(DEVICE_TOKEN), created: 5, lastSeen: 50, ownerID: "u_alice", pushPrefs: { blocked: true, finished: false } }],
    vapid: { publicKey: "vapid-public", privateKey: "vapid-private" },
    push: [{ deviceID: "dev_phone", endpoint: "https://push.example.com/1", keys: { p256dh: "p", auth: "a" }, created: 6 }],
    speech: { tts: { provider: "openrouter", model: "tts-1" } },
    audit: [
      { at: 100, actor: "u_alice", action: "device.pair", target: "dev_phone" },
      { at: 100, actor: "system", action: "machine.enroll", target: "mch_laptop" },
      { at: 101, actor: "u_alice", action: "grant.create" },
    ],
    agentsActingPaused: true,
  }
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state))
  const files = new FileStateStore({ stateDir: dir })
  await files.put("u_alice", "grants", "g_0123456789abcdef", { id: "g_0123456789abcdef", owner: "u_alice", holder: "@@reviewer" })
  await files.put("u_alice", "grants", "g_0123456789abcdef", { id: "g_0123456789abcdef", owner: "u_alice", holder: "@@reviewer", updated: 9 })
  await files.put("u_alice", "launches", "lch_1", { id: "lch_1", state: "running" })
  await files.put("u_alice", "messages", "m_1", { id: "m_1", kind: "msg", text: "hello" })
  await files.put("Bob@Example.com", "messages", "m_2", { id: "m_2", kind: "ask", text: "ok?" })
  await files.claim("names", "u_alice/api", "ses_1")
  await files.flush()
  writeFileSync(path.join(dir, "token-keys.json"), JSON.stringify(TOKEN_KEYS))
  return dir
}

/** Every row of a memory StateStore (for "nothing changed" checks). */
async function dump(state: StateStore, users: string[], collections: string[]): Promise<unknown> {
  const out: Record<string, unknown> = {}
  for (const user of users) for (const collection of collections) out[`${user}/${collection}`] = await state.list(user, collection)
  return out
}

const HUB_COLLECTIONS = ["users", "machines", "devices", "push", "settings", "audit", "machine-tokens", "device-tokens", "user-emails"]
const AGENT = [
  ["u_alice", ["grants", "launches", "messages"]],
  ["Bob@Example.com", ["messages"]],
] as const

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const dir = await fixtureStateDir()
  dirs.push(dir)
  return { dir, backends: memoryBackends() }
}

describe("importState", () => {
  test("imports state.json (upgraded) and the agent files; Store.shared then reads everything", async () => {
    const { dir, backends } = await setup()
    const before = readdirSync(dir).map((f) => [f, statSync(path.join(dir, f)).mtimeMs])
    const stateJSON = readFileSync(path.join(dir, "state.json"), "utf8")

    const report = await importState({ stateDir: dir, state: backends.state })
    expect(report.failed).toBe(0)
    expect(report.conflicts).toEqual([])

    const store = Store.shared({ state: backends.state, bus: backends.bus })
    await store.ready()
    // Users (the upgrade adds the local owner), agent data upgraded (legacy role key), epochs, disabled.
    expect(store.users().map((u) => u.id).sort()).toEqual(["local", "u_alice", "u_bob"])
    expect(store.user("u_alice")!.tokenEpoch).toBe(2)
    expect(store.agentData("u_alice").generations).toEqual({ "reviewer.hub": 3 })
    expect(store.user("u_bob")!.disabled).toBe(true)
    expect((await backends.state.get(HUB_ROWS, "user-emails", "alice@example.com"))?.value).toEqual({ id: "u_alice" })
    // Machines and devices by token hash: no re-enrolment.
    expect((await store.findMachine(MACHINE_TOKEN))?.id).toBe("mch_laptop")
    expect((await store.findMachine(MACHINE_TOKEN))?.ownerID).toBe("local")
    expect((await store.findDevice(DEVICE_TOKEN))?.id).toBe("dev_phone")
    expect(store.devices()[0]!.pushPrefs).not.toHaveProperty("blocked")
    // Push, settings (VAPID, speech, the kill switch), audit in order.
    expect(store.data().push.map((p) => p.endpoint)).toEqual(["https://push.example.com/1"])
    expect(store.data().vapid).toEqual({ publicKey: "vapid-public", privateKey: "vapid-private" })
    expect(store.data().speech).toEqual({ tts: { provider: "openrouter", model: "tts-1" } } as never)
    expect(store.actingPaused()).toBe(true)
    expect(store.data().audit.map((a) => a.action)).toEqual(["device.pair", "machine.enroll", "grant.create"])
    // A second store on the same rows (another pod) sees the same; a new audit entry sorts after the imported.
    await store.audit({ actor: "system", action: "after.import" })
    const other = Store.shared({ state: backends.state, bus: new MemoryBus() })
    await other.ready()
    expect(other.data().audit.map((a) => a.action)).toEqual(["device.pair", "machine.enroll", "grant.create", "after.import"])
    await Promise.all([store.close(), other.close()])

    // Agent rows per user (grants, launches, messages) and claims.
    const source = new FileStateStore({ stateDir: dir })
    for (const [user, collections] of AGENT) {
      for (const collection of collections) {
        expect((await backends.state.list(user, collection)).map((e) => [e.key, e.value])).toEqual((await source.list(user, collection)).map((e) => [e.key, e.value]))
      }
    }
    expect((await backends.state.claimOf("names", "u_alice/api"))?.owner).toBe("ses_1")

    // The source is only read: state.json unchanged, nothing written to the directory.
    expect(readFileSync(path.join(dir, "state.json"), "utf8")).toBe(stateJSON)
    expect(readdirSync(dir).map((f) => [f, statSync(path.join(dir, f)).mtimeMs])).toEqual(before)
    // Signing keys are not stored anywhere.
    const rows = JSON.stringify(await dump(backends.state, [HUB_ROWS, "u_alice"], [...HUB_COLLECTIONS, "token-keys"]))
    expect(rows).not.toContain(TOKEN_KEYS.keys[0]!.secret)
    expect(rows).not.toContain(TOKEN_KEYS.keys[1]!.secret)
  })
})
