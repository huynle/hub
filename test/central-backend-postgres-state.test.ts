// The Postgres StateStore beyond the shared contract (test/central-backend-state.test.ts runs that): a lazy
// client that never shows its URL, the schema check, and races between pods (separate store instances, each
// with its own connection pool, on one database). The database tests need HUB_IT_CLUSTER=1 and docker.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { migrate, SCHEMA_VERSION } from "../src/central/backend/postgres-migrate"
import { PostgresStateStore, SchemaOutdatedError } from "../src/central/backend/postgres-state"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"

const SECRET = "s3cret-pw-do-not-print"
const UNREACHABLE = `postgres://hubuser:${SECRET}@127.0.0.1:1/hub`

describe("PostgresStateStore without a database", () => {
  test("constructing connects to nothing; the url is not visible on the instance", async () => {
    const store = new PostgresStateStore({ url: UNREACHABLE })
    expect(Bun.inspect(store)).not.toContain(SECRET)
    expect(JSON.stringify(store) ?? "").not.toContain(SECRET)
    expect(Object.values(store).join(" ")).not.toContain(SECRET)
    await store.close()
  })

  test("a failed connection rejects without naming the url", async () => {
    const store = new PostgresStateStore({ url: UNREACHABLE, connectionTimeoutSeconds: 2 })
    let error: unknown
    try {
      await store.get("alice", "c", "k")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(`${(error as Error).message} ${(error as Error).stack} ${Bun.inspect(error)}`).not.toContain(SECRET)
    await store.close()
  })
})

const enabled = itClusterEnabled() && (await dockerAvailable())
const cluster = enabled ? new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) }) : undefined
const stores: PostgresStateStore[] = []
const closeStores = () => Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})))
// Start the container before the tests: under load it can take longer than one test's timeout.
beforeAll(async () => {
  await cluster?.postgres()
}, 120_000)
// Every store has its own pool: close them after each test, or the server runs out of connections.
afterEach(closeStores)
afterAll(async () => {
  await closeStores()
  await cluster?.stop()
})

function open(url: string, options: { migrate?: boolean; now?: () => number } = {}): PostgresStateStore {
  const store = new PostgresStateStore({ url, migrate: true, ...options })
  stores.push(store)
  return store
}

/** `count` pods on one migrated database. */
async function pods(count: number): Promise<PostgresStateStore[]> {
  const url = await cluster!.freshDatabase()
  const first = open(url)
  await first.get("_", "_", "_")
  return [first, ...Array.from({ length: count - 1 }, () => open(url, { migrate: false }))]
}

describe.skipIf(!enabled)("PostgresStateStore schema (HUB_IT_CLUSTER=1)", () => {
  test("without migrate, an unmigrated database is refused with a hint and no url", async () => {
    const url = await cluster!.freshDatabase()
    const store = open(url, { migrate: false })
    const error = await store.get("alice", "c", "k").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SchemaOutdatedError)
    expect((error as Error).message).toContain("hub-server migrate")
    expect((error as Error).message).toContain(`version 0`)
    expect((error as Error).message).not.toContain(url)
  })

  test("after the migration runs elsewhere, the same store works (the check is retried)", async () => {
    const url = await cluster!.freshDatabase()
    const store = open(url, { migrate: false })
    await expect(store.get("alice", "c", "k")).rejects.toBeInstanceOf(SchemaOutdatedError)
    const admin = new Bun.SQL(url, { max: 1 })
    try {
      expect((await migrate(admin)).version).toBe(SCHEMA_VERSION)
    } finally {
      await admin.close()
    }
    expect(await store.put("alice", "c", "k", 1)).toEqual({ ok: true, version: 1 })
  })

  test("migrate: true migrates on first use; data survives a reopen", async () => {
    const url = await cluster!.freshDatabase()
    const a = open(url)
    await a.put("alice", "c", "k", { deep: { list: [1, "two", null, true] }, unicode: "héllo ✓" })
    await a.close()
    const b = open(url, { migrate: false })
    expect(await b.get("alice", "c", "k")).toEqual({ value: { deep: { list: [1, "two", null, true] }, unicode: "héllo ✓" }, version: 1 })
  })

  test("strings, numbers, arrays and null round-trip as values (not double-encoded)", async () => {
    const [store] = await pods(1)
    for (const [key, value] of [["s", "{\"looks\":\"json\"}"], ["n", 1.5], ["a", [1, [2]]], ["z", null], ["b", false]] as const) {
      await store!.put("alice", "c", key, value)
      expect((await store!.get("alice", "c", key))!.value).toEqual(value)
    }
  })
})

describe.skipIf(!enabled)("PostgresStateStore races between pods (HUB_IT_CLUSTER=1)", () => {
  test("concurrent writes at one ifVersion: exactly one wins, the rest see the new version", async () => {
    const all = await pods(4)
    await all[0]!.put("alice", "c", "k", "base")
    const results = await Promise.all(all.flatMap((pod, i) => [0, 1].map((j) => pod.put("alice", "c", "k", `w${i}${j}`, { ifVersion: 1 }))))
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, version: 2 }])
    expect(results.filter((r) => !r.ok)).toEqual(Array(7).fill({ ok: false, version: 2 }))
    expect((await all[3]!.get("alice", "c", "k"))!.version).toBe(2)
  })

  test("concurrent creates (ifVersion 0): exactly one wins", async () => {
    const all = await pods(4)
    const results = await Promise.all(all.flatMap((pod, i) => [0, 1].map((j) => pod.put("alice", "c", "new", `c${i}${j}`, { ifVersion: 0 }))))
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, version: 1 }])
    expect(results.filter((r) => !r.ok).length).toBe(7)
  })

  test("unconditional concurrent puts never lose a version", async () => {
    const all = await pods(3)
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => all[i % 3]!.put("alice", "c", "k", i)))
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    expect((await all[0]!.get("alice", "c", "k"))!.version).toBe(30)
  })

  test("read-modify-write with ifVersion retries loses no update", async () => {
    const all = await pods(4)
    const increment = async (pod: PostgresStateStore) => {
      for (;;) {
        const current = await pod.get<number>("alice", "c", "counter")
        const result = await pod.put("alice", "c", "counter", (current?.value ?? 0) + 1, { ifVersion: current?.version ?? 0 })
        if (result.ok) return
      }
    }
    await Promise.all(all.flatMap((pod) => Array.from({ length: 10 }, () => increment(pod))))
    expect(await all[0]!.get("alice", "c", "counter")).toEqual({ value: 40, version: 40 })
  })

  test("concurrent deletes at one ifVersion: exactly one wins", async () => {
    const all = await pods(3)
    await all[0]!.put("alice", "c", "k", 1)
    const results = await Promise.all(all.map((pod) => pod.delete("alice", "c", "k", { ifVersion: 1 })))
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, version: 0 }])
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, version: 0 }, { ok: false, version: 0 }])
  })

  test("concurrent claims from different pods: exactly one owner, everyone sees it", async () => {
    const all = await pods(4)
    const results = await Promise.all(all.flatMap((pod, i) => [0, 1, 2].map((j) => pod.claim("alice:names", "scout", `agent_${i}_${j}`))))
    const winners = results.filter((r) => r.ok)
    expect(winners.length).toBe(1)
    const owner = winners[0]!.ok ? winners[0]!.claim.owner : ""
    for (const r of results) if (!r.ok) expect(r.conflict.owner).toBe(owner)
    for (const pod of all) expect((await pod.claimOf("alice:names", "scout"))!.owner).toBe(owner)
  })

  test("claim racing a release: the key ends with one consistent owner", async () => {
    const all = await pods(2)
    await all[0]!.claim("ns", "k", "first")
    const [released, claimed] = await Promise.all([all[0]!.release("ns", "k", "first"), all[1]!.claim("ns", "k", "second")])
    expect(released).toBe(true)
    const holder = await all[0]!.claimOf("ns", "k")
    if (claimed.ok) expect(holder!.owner).toBe("second")
    else expect(holder).toBeUndefined()
  })
})
