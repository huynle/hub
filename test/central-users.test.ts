import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AUDIT_LIMIT, LOCAL_USER, Store } from "../src/central/store"

const dir = () => mkdtempSync(path.join(tmpdir(), "voice-users-"))
const read = (d: string) => JSON.parse(readFileSync(path.join(d, "state.json"), "utf8"))

describe("users and migration", () => {
  test("a new state has the local admin user and empty audit", () => {
    const d = dir()
    const store = Store.open(d)
    expect(store.users()).toEqual([{ id: LOCAL_USER, role: "admin", created: expect.any(Number), lastSeen: expect.any(Number) }])
    expect(read(d).audit).toEqual([])
    expect((statSync(path.join(d, "state.json")).mode & 0o777).toString(8)).toBe("600")
  })

  test("migration backfills ownerID 'local' and is idempotent", () => {
    const d = dir()
    writeFileSync(
      path.join(d, "state.json"),
      JSON.stringify({
        machines: [{ id: "mch_1", name: "laptop", tokenHash: "aa", created: 1, lastSeen: 1 }],
        devices: [{ id: "dev_1", name: "phone", tokenHash: "bb", created: 1, lastSeen: 1 }],
        push: [],
        speech: { tts: { voice: "nova" } },
      }),
    )
    Store.open(d)
    const once = read(d)
    expect(once.machines[0].ownerID).toBe(LOCAL_USER)
    expect(once.devices[0].ownerID).toBe(LOCAL_USER)
    expect(once.users.map((u: any) => u.id)).toEqual([LOCAL_USER])
    expect(once.speech).toEqual({ tts: { voice: "nova" } })
    Store.open(d)
    expect(read(d)).toEqual(once)
  })

  test("pairing mode re-enables the local admin", async () => {
    const d = dir()
    const store = Store.open(d)
    await store.setUser(LOCAL_USER, { disabled: true })
    expect(Store.open(d).user(LOCAL_USER)?.disabled).toBe(true)
    expect(Store.open(d, Date.now, { mode: "pairing" }).user(LOCAL_USER)).toMatchObject({ role: "admin" })
    expect(Store.open(d, Date.now, { mode: "pairing" }).user(LOCAL_USER)?.disabled).toBeUndefined()
  })

  test("new machines and devices default to the local owner, or take the given one", async () => {
    const store = Store.open(dir())
    expect((await store.addMachine("m")).machine.ownerID).toBe(LOCAL_USER)
    expect((await store.addDevice("d")).device.ownerID).toBe(LOCAL_USER)
    const alice = await store.upsertUser({ email: "alice@example.com", name: "Alice", role: "user" })
    expect((await store.addMachine("m2", alice.id)).machine.ownerID).toBe(alice.id)
    expect((await store.addDevice("d2", alice.id)).device.ownerID).toBe(alice.id)
  })

  test("upsertUser creates by lowercased email, then updates name and lastSeen", async () => {
    let t = 1000
    const store = Store.open(dir(), () => t)
    const alice = await store.upsertUser({ email: "Alice@Example.com", name: "Alice", role: "user" })
    expect(alice).toMatchObject({ email: "alice@example.com", name: "Alice", role: "user", created: 1000, lastSeen: 1000 })
    expect(alice.id).toMatch(/^[A-Za-z0-9_-]{12,}$/)
    t = 99_000
    const again = await store.upsertUser({ email: "alice@example.com", name: "Alice L", role: "user" })
    expect(again.id).toBe(alice.id)
    expect(again).toMatchObject({ name: "Alice L", lastSeen: 99_000, created: 1000 })
    expect(store.userByEmail("ALICE@example.com")?.id).toBe(alice.id)
    // role "admin" from config promotes; "user" never demotes an existing admin
    await store.upsertUser({ email: "alice@example.com", role: "admin" })
    expect(store.user(alice.id)?.role).toBe("admin")
    await store.upsertUser({ email: "alice@example.com", role: "user" })
    expect(store.user(alice.id)?.role).toBe("admin")
  })

  test("migrateLocal reassigns local records once and disables local", async () => {
    const store = Store.open(dir())
    const m = (await store.addMachine("m")).machine
    const d = (await store.addDevice("d")).device
    const admin = await store.upsertUser({ email: "admin@example.com", role: "admin" })
    expect(await store.migrateLocal(admin.id)).toBe(true)
    expect(store.machines().find((x) => x.id === m.id)?.ownerID).toBe(admin.id)
    expect(store.devices().find((x) => x.id === d.id)?.ownerID).toBe(admin.id)
    expect(store.user(LOCAL_USER)?.disabled).toBe(true)
    expect(store.auditLog()[0]).toMatchObject({ actor: "system", action: "migrate.local", target: admin.id })
    const other = await store.upsertUser({ email: "other@example.com", role: "admin" })
    expect(await store.migrateLocal(other.id)).toBe(false)
  })

  test("audit ring keeps the newest 500; auditLog is newest first, max 200", async () => {
    let t = 0
    const store = Store.open(dir(), () => ++t)
    for (let i = 0; i < AUDIT_LIMIT + 20; i++) await store.audit({ actor: "system", action: "device.pair", target: `dev_${i}` })
    expect(store.data().audit.length).toBe(AUDIT_LIMIT)
    expect(store.data().audit[0]!.target).toBe("dev_20")
    const log = store.auditLog()
    expect(log.length).toBe(200)
    expect(log[0]!.target).toBe(`dev_${AUDIT_LIMIT + 19}`)
  })

  test("per-user speech settings are separate from the server default", async () => {
    const store = Store.open(dir())
    const alice = await store.upsertUser({ email: "alice@example.com", role: "user" })
    await store.setUserSpeech(alice.id, { tts: { voice: "nova", apiKey: "sk-alice-key-123" } })
    expect(store.userSpeech(alice.id)).toEqual({ tts: { voice: "nova", apiKey: "sk-alice-key-123" } })
    expect(store.speechSettings()).toEqual({})
    const copy = store.userSpeech(alice.id)
    copy.tts!.voice = "mutated"
    expect(store.userSpeech(alice.id).tts!.voice).toBe("nova")
  })

  test("setUser updates role and disabled; enabling removes the flag", async () => {
    const store = Store.open(dir())
    const bob = await store.upsertUser({ email: "bob@example.com", role: "user" })
    await store.setUser(bob.id, { role: "admin", disabled: true })
    expect(store.user(bob.id)).toMatchObject({ role: "admin", disabled: true })
    await store.setUser(bob.id, { disabled: false })
    expect("disabled" in store.user(bob.id)!).toBe(false)
  })
})
