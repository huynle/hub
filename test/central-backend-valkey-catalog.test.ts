// The Valkey Catalog beyond the shared contract (test/central-backend-catalog.test.ts): pods sharing one hash,
// the per-connection index deleteConn uses, and expired reports leaving Valkey. Runs with HUB_IT_CLUSTER=1
// against the docker Valkey (test/cluster-it.ts); otherwise it skips.
import { RedisClient } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { cluster, implementations } from "./backend-impls"
import { valkeyCatalogKeys } from "../src/central/backend/valkey-catalog"

const impl = implementations("catalog").find((i) => i.backend === "valkey")
const make = (options: Parameters<NonNullable<typeof impl>["make"]>[0] = {}) => impl!.make(options)

let raws: RedisClient[] = []
afterEach(() => {
  for (const raw of raws) raw.close()
  raws = []
})
/** A plain client on the test Valkey (call after make(), which flushes it). */
async function raw(): Promise<RedisClient> {
  const client = new RedisClient((await cluster!.valkey()).url)
  raws.push(client)
  return client
}

describe.skipIf(!impl)("ValkeyCatalog (hash per user)", () => {
  test("pods share the catalog: each writes its own reports, any reads them merged, any drops a dead pod's conn", async () => {
    const a = await make({ now: () => 1 })
    const b = await make({ now: () => 2 })
    // b's make() flushed Valkey again; both now share the same empty server.
    await a.set("alice", "s1", "pod_a_conn", { state: "working" })
    await b.set("alice", "s1", "pod_b_conn", { title: "T" })
    await a.set("alice", "s2", "pod_a_conn", { state: "idle" })
    expect(await b.get("alice", "s1")).toEqual({ sessionID: "s1", value: { state: "working", title: "T" }, connIDs: ["pod_a_conn", "pod_b_conn"], at: 2 })
    await b.deleteConn("alice", "pod_a_conn")
    expect(await a.list("alice")).toEqual([{ sessionID: "s1", value: { title: "T" }, connIDs: ["pod_b_conn"], at: 2 }])
  })

  test("report order is write order even when times tie", async () => {
    const catalog = await make({ now: () => 5 })
    await catalog.set("alice", "s", "c2", { v: 2 })
    await catalog.set("alice", "s", "c1", { v: 1 })
    expect(await catalog.get("alice", "s")).toMatchObject({ value: { v: 1 }, connIDs: ["c2", "c1"] })
    await catalog.set("alice", "s", "c2", { v: 3 })
    expect(await catalog.get("alice", "s")).toMatchObject({ value: { v: 3 }, connIDs: ["c1", "c2"] })
  })

  test("the per-connection index follows every delete, so deleteConn removes exactly that conn's reports", async () => {
    const catalog = await make()
    const keys = valkeyCatalogKeys("alice")
    const client = await raw()
    await catalog.set("alice", "s1", "c1", { a: 1 })
    await catalog.set("alice", "s2", "c1", { b: 2 })
    await catalog.set("alice", "s1", "c2", { c: 3 })
    expect(Number(await client.send("SCARD", [keys.conn("c1")]))).toBe(2)
    await catalog.delete("alice", "s1")
    expect(Number(await client.send("SCARD", [keys.conn("c1")]))).toBe(1)
    expect(Number(await client.send("EXISTS", [keys.conn("c2")]))).toBe(0)
    await catalog.deleteConn("alice", "c1")
    expect(Number(await client.send("EXISTS", [keys.conn("c1")]))).toBe(0)
    expect(Number(await client.send("EXISTS", [keys.reports]))).toBe(0)
    expect(await catalog.list("alice")).toEqual([])
  })

  test("expired reports are filtered on read and leave Valkey (hash and index)", async () => {
    let t = 0
    const catalog = await make({ now: () => t })
    const keys = valkeyCatalogKeys("alice")
    const client = await raw()
    await catalog.set("alice", "s", "dead", { state: "working" }, { ttlMs: 1000 })
    await catalog.set("alice", "s", "live", { title: "T" })
    t = 1000
    expect(await catalog.entries("alice")).toEqual([{ sessionID: "s", connID: "live", value: { title: "T" }, at: 0 }])
    expect(Number(await client.send("HLEN", [keys.reports]))).toBe(1)
    expect(Number(await client.send("EXISTS", [keys.conn("dead")]))).toBe(0)
  })

  test("ids with separators and quotes stay apart", async () => {
    const catalog = await make({ now: () => 0 })
    await catalog.set("alice", 'a"b', "c:d", { one: 1 })
    await catalog.set("alice", "a", 'b",c:d', { two: 2 })
    expect((await catalog.list("alice")).map((s) => [s.sessionID, s.connIDs, s.value])).toEqual([
      ["a", ['b",c:d'], { two: 2 }],
      ['a"b', ["c:d"], { one: 1 }],
    ])
    await catalog.delete("alice", "a")
    expect((await catalog.list("alice")).map((s) => s.sessionID)).toEqual(['a"b'])
  })

  test("keys keep users apart and carry a hash tag (one slot per user)", () => {
    const alice = valkeyCatalogKeys("alice")
    expect(alice.reports).not.toBe(valkeyCatalogKeys("bob").reports)
    for (const key of [alice.reports, alice.seq, alice.conn("c1")]) expect(key).toContain("{alice}")
    expect(valkeyCatalogKeys("alice", "x:").reports.startsWith("x:")).toBe(true)
  })
})
