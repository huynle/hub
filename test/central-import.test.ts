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
import { formatImportReport, importState, tokenKeysMaterial } from "../src/central/import"
import { HUB_ROWS, Store } from "../src/central/store"
import { DEVICE_TOKEN, fixtureStateDir, MACHINE_TOKEN, TOKEN_KEYS } from "./import-fixture"

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

  test("a second run finds every row unchanged and changes nothing (versions included)", async () => {
    const { dir, backends } = await setup()
    const first = await importState({ stateDir: dir, state: backends.state })
    const users = [HUB_ROWS, ...AGENT.map(([user]) => user)]
    const collections = [...HUB_COLLECTIONS, ...AGENT.flatMap(([, c]) => c)]
    const after = await dump(backends.state, users, collections)
    // Later: an upgrade that stamps "now" (the local owner it adds) must not make the rows differ.
    await Bun.sleep(5)
    const second = await importState({ stateDir: dir, state: backends.state })
    expect(await dump(backends.state, users, collections)).toEqual(after)
    for (const [name, counts] of Object.entries(second.collections)) {
      expect({ name, ...counts }).toEqual({ name, rows: first.collections[name]!.rows, created: 0, unchanged: first.collections[name]!.rows, conflicts: 0, overwritten: 0, failed: 0 })
    }
    expect(first.collections.users).toMatchObject({ rows: 3, created: 3 })
    expect(first.collections.settings).toMatchObject({ rows: 3, created: 3 })
    expect(first.collections["agent:grants"]).toMatchObject({ rows: 1, created: 1 })
    expect(first.collections["claims:names"]).toMatchObject({ rows: 1, created: 1 })
  })

  test("a dry run counts and reports conflicts but writes nothing", async () => {
    const { dir, backends } = await setup()
    const dry = await importState({ stateDir: dir, state: backends.state, dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.collections.machines).toMatchObject({ rows: 1, created: 1 })
    expect(await backends.state.list(HUB_ROWS, "users")).toEqual([])
    expect(await backends.state.list("u_alice", "messages")).toEqual([])
    expect(await backends.state.claimOf("names", "u_alice/api")).toBeUndefined()

    await importState({ stateDir: dir, state: backends.state })
    await backends.state.put(HUB_ROWS, "users", "u_bob", { id: "u_bob", role: "admin", created: 3, lastSeen: 99 })
    await backends.state.release("names", "u_alice/api", "ses_1")
    await backends.state.claim("names", "u_alice/api", "ses_other")
    const conflicted = await importState({ stateDir: dir, state: backends.state, dryRun: true, force: true })
    expect(conflicted.conflicts).toEqual([`users ${HUB_ROWS}/u_bob`, "claims:names u_alice/api"])
    expect(conflicted.collections.users).toMatchObject({ rows: 3, unchanged: 2, conflicts: 1, overwritten: 1 })
    expect((await backends.state.get(HUB_ROWS, "users", "u_bob"))?.value).toMatchObject({ role: "admin" })
    expect((await backends.state.claimOf("names", "u_alice/api"))?.owner).toBe("ses_other")
  })

  test("existing rows that differ are skipped, and overwritten with force", async () => {
    const { dir, backends } = await setup()
    await importState({ stateDir: dir, state: backends.state })
    await backends.state.put(HUB_ROWS, "users", "u_bob", { id: "u_bob", role: "admin", created: 3, lastSeen: 99 })
    await backends.state.put("u_alice", "launches", "lch_1", { id: "lch_1", state: "ended" })
    await backends.state.release("names", "u_alice/api", "ses_1")
    await backends.state.claim("names", "u_alice/api", "ses_other")

    const skipped = await importState({ stateDir: dir, state: backends.state })
    expect(skipped.conflicts).toEqual([`users ${HUB_ROWS}/u_bob`, "agent:launches u_alice/lch_1", "claims:names u_alice/api"])
    expect(skipped.collections["agent:launches"]).toMatchObject({ conflicts: 1, overwritten: 0 })
    expect((await backends.state.get(HUB_ROWS, "users", "u_bob"))?.value).toMatchObject({ role: "admin" })

    const forced = await importState({ stateDir: dir, state: backends.state, force: true })
    expect(forced.collections.users).toMatchObject({ conflicts: 1, overwritten: 1 })
    expect(forced.failed).toBe(0)
    expect((await backends.state.get(HUB_ROWS, "users", "u_bob"))?.value).toMatchObject({ role: "user", disabled: true })
    expect((await backends.state.get("u_alice", "launches", "lch_1"))?.value).toEqual({ id: "lch_1", state: "running" })
    expect((await backends.state.claimOf("names", "u_alice/api"))?.owner).toBe("ses_1")
    // Now in step: nothing left to do.
    expect((await importState({ stateDir: dir, state: backends.state })).conflicts).toEqual([])
  })

  test("rows the target cannot hold are reported as failures, the rest still imported", async () => {
    const { dir, backends } = await setup()
    const failing: StateStore = Object.assign(Object.create(backends.state), {
      put: (user: string, collection: string, key: string, value: unknown, options: object) =>
        key === "m_1" ? Promise.reject(new Error("unsupported Unicode escape sequence")) : backends.state.put(user, collection, key, value, options),
    })
    const report = await importState({ stateDir: dir, state: failing })
    expect(report.failures).toEqual([{ row: "agent:messages u_alice/m_1", error: "unsupported Unicode escape sequence" }])
    expect(report.failed).toBe(1)
    expect(await backends.state.get("Bob@Example.com", "messages", "m_2")).toBeDefined()
  })

  test("a directory without state is refused", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-import-empty-"))
    dirs.push(dir)
    await expect(importState({ stateDir: dir, state: new MemoryStateStore() })).rejects.toThrow(/No hub state/)
  })
})

describe("token keys", () => {
  test("the report names the key ids only; tokenKeysMaterial is the HUB_TOKEN_KEYS value", async () => {
    const { dir, backends } = await setup()
    const report = await importState({ stateDir: dir, state: backends.state })
    expect(report.tokenKeys).toEqual({ active: "k_new", kids: ["k_old", "k_new"] })
    expect(JSON.stringify(report)).not.toContain(TOKEN_KEYS.keys[0]!.secret)
    const material = tokenKeysMaterial(dir)!
    expect(material).not.toContain("\n")
    expect(JSON.parse(material)).toEqual(TOKEN_KEYS)
  })

  test("without token-keys.json there are none; an invalid one is refused without its content", async () => {
    const { dir, backends } = await setup()
    rmSync(path.join(dir, "token-keys.json"))
    expect((await importState({ stateDir: dir, state: backends.state })).tokenKeys).toBeUndefined()
    expect(tokenKeysMaterial(dir)).toBeUndefined()
    writeFileSync(path.join(dir, "token-keys.json"), JSON.stringify({ active: "k1", keys: [{ kid: "k1", secret: "c2hvcnQ=" }] }))
    expect(() => tokenKeysMaterial(dir)).toThrow(/token-keys\.json/)
    try {
      tokenKeysMaterial(dir)
    } catch (error) {
      expect((error as Error).message).not.toContain("c2hvcnQ=")
    }
  })
})

describe("formatImportReport", () => {
  test("a table per collection, the conflicts, failures and the signing keys (ids only, how to get them)", async () => {
    const { dir, backends } = await setup()
    await importState({ stateDir: dir, state: backends.state })
    await backends.state.put(HUB_ROWS, "users", "u_bob", { id: "u_bob", role: "admin", created: 3, lastSeen: 99 })
    const text = formatImportReport(await importState({ stateDir: dir, state: backends.state, dryRun: true })).join("\n")
    expect(text).toContain("dry run")
    expect(text).toMatch(/conflict\s+overwritten\s+failed/)
    expect(text).toMatch(/users\s+3\s+0\s+2\s+1\s+0\s+0/)
    expect(text).toMatch(/agent:messages\s+2\s+0\s+2/)
    expect(text).toContain(`users ${HUB_ROWS}/u_bob`)
    expect(text).toContain("--force")
    expect(text).toContain("k_old, k_new (active k_new)")
    expect(text).toContain("--print-token-keys")
    expect(text).not.toContain(TOKEN_KEYS.keys[1]!.secret)
  })
})

