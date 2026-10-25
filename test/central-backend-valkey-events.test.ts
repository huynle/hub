// The Valkey EventLog's own replay and resync tests (the shared contract relies on the memory log's id format).
// Runs with HUB_IT_CLUSTER=1 against the docker Valkey (test/cluster-it.ts); otherwise it skips.
import { RedisClient } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { cluster, implementations } from "./backend-impls"
import { valkeyEventKeys, type ValkeyEventLog } from "../src/central/backend/valkey-events"
import type { SinceResult } from "../src/central/backend/types"

const impl = implementations("events").find((i) => i.backend === "valkey")
const make = (options: Parameters<NonNullable<typeof impl>["make"]>[0] = {}) => impl!.make(options) as Promise<ValkeyEventLog>

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

const ids = (result: SinceResult) => ("events" in result ? result.events.map((e) => e.id) : result)
const messages = (result: SinceResult) => ("events" in result ? result.events.map((e) => e.message) : result)
const epochOf = (id: string) => id.slice(0, id.indexOf("."))

describe.skipIf(!impl)("ValkeyEventLog (Streams)", () => {
  test("ids are <epoch>.<n>, n counting per user from 1; since returns the events after an id, oldest first", async () => {
    const log = await make({ now: () => 7 })
    const a1 = await log.append("alice", { type: "status", n: 1 })
    await log.append("bob", { type: "status", n: 9 })
    const a2 = await log.append("alice", { type: "status", n: 2 }, { exceptDevice: "dev_1" })
    const epoch = epochOf(a1)
    expect(epoch).toMatch(/^[a-z0-9]+$/)
    expect([a1, a2]).toEqual([`${epoch}.1`, `${epoch}.2`])
    expect(await log.latest("alice")).toBe(a2)
    expect(await log.since("alice", a1)).toEqual({ events: [{ id: a2, message: { type: "status", n: 2 }, exceptDevice: "dev_1", at: 7 }] })
    expect(await log.since("alice", a2)).toEqual({ events: [] })
    const bob = await log.since("bob", `${epochOf(await log.latest("bob"))}.0`)
    expect(messages(bob)).toEqual([{ type: "status", n: 9 }])
  })

  test("a client that read latest before any event is covered (not resynced)", async () => {
    const log = await make()
    const id = await log.latest("carol")
    expect(id).toMatch(/^[a-z0-9]+\.0$/)
    expect(await log.since("carol", id)).toEqual({ events: [] })
    const appended = await log.append("carol", { type: "status" })
    expect(epochOf(appended)).toBe(epochOf(id))
    expect(ids(await log.since("carol", id))).toEqual([appended])
  })

  test("resync for an unknown user, garbage, a future id or another epoch", async () => {
    const log = await make()
    const id = await log.append("alice", { type: "status" })
    const epoch = epochOf(id)
    expect(id).toBe(`${epoch}.1`)
    expect(await log.since("dave", `${epoch}.0`)).toEqual({ resync: true })
    expect(await log.since("alice", "nonsense")).toEqual({ resync: true })
    expect(await log.since("alice", `${epoch}.1-0`)).toEqual({ resync: true })
    expect(await log.since("alice", `${epoch}.2`)).toEqual({ resync: true })
    expect(await log.since("alice", `${epoch}.99999999999999999999`)).toEqual({ resync: true })
    expect(await log.since("alice", `zz${epoch}.0`)).toEqual({ resync: true })
    expect(await log.since("alice", `${epoch}.0`)).toMatchObject({ events: [{ id }] })
  })

  test("pods share the log: one appends, another replays", async () => {
    const a = await make()
    const b = await make()
    // make() flushed Valkey again for b; a and b now share the same empty server.
    const id = await b.latest("alice")
    const appended = await a.append("alice", { type: "status", from: "a" })
    expect(await b.latest("alice")).toBe(appended)
    expect(messages(await b.since("alice", id))).toEqual([{ type: "status", from: "a" }])
  })

  test("trimmed: a gap reaching past dropped entries asks for a resync; one whose next entry is kept replays", async () => {
    const log = await make()
    const appended: string[] = []
    for (let i = 0; i < 5; i++) appended.push(await log.append("alice", { type: "status", i }))
    await (await raw()).send("XTRIM", [valkeyEventKeys("alice").stream, "MAXLEN", "2"])
    expect(await log.since("alice", appended[0]!)).toEqual({ resync: true })
    expect(await log.since("alice", appended[1]!)).toEqual({ resync: true })
    expect(messages(await log.since("alice", appended[2]!))).toEqual([
      { type: "status", i: 3 },
      { type: "status", i: 4 },
    ])
  })

  test("bounded by count (MAXLEN ~ max): old entries go and their gap resyncs", async () => {
    const log = await make({ max: 10 })
    const first = await log.append("alice", { type: "status", i: 0 })
    let last = first
    let before = first
    for (let i = 1; i < 400; i++) {
      before = last
      last = await log.append("alice", { type: "status", i })
    }
    const length = Number(await (await raw()).send("XLEN", [valkeyEventKeys("alice").stream]))
    expect(length).toBeGreaterThanOrEqual(10)
    expect(length).toBeLessThan(400)
    expect(await log.since("alice", first)).toEqual({ resync: true })
    expect(ids(await log.since("alice", before))).toEqual([last])
  })

  test("bounded by age: a gap reaching past expired events asks for a resync", async () => {
    let t = 0
    const log = await make({ maxAgeMs: 1000, now: () => t })
    const start = await log.latest("alice")
    const e0 = await log.append("alice", { type: "status", i: 0 })
    t = 500
    await log.append("alice", { type: "status", i: 1 })
    t = 1200
    expect(await log.since("alice", start)).toEqual({ resync: true })
    expect(messages(await log.since("alice", e0))).toEqual([{ type: "status", i: 1 }])
  })

  test("the log expires with its keys: a fresh epoch, old ids resync and old entries never replay", async () => {
    const log = await make()
    const old = await log.append("alice", { type: "status", i: 0 })
    const keys = valkeyEventKeys("alice")
    const client = await raw()
    expect(Number(await client.send("PTTL", [keys.stream]))).toBeGreaterThan(0)
    expect(Number(await client.send("PTTL", [keys.epoch]))).toBeGreaterThan(0)
    // The epoch went (its ttl ran out first): the next reader starts a new epoch over an empty log.
    await client.send("DEL", [keys.epoch])
    const fresh = await log.latest("alice")
    expect(epochOf(fresh)).not.toBe(epochOf(old))
    expect(await log.since("alice", old)).toEqual({ resync: true })
    expect(await log.since("alice", fresh)).toEqual({ events: [] })
  })

  test("keys keep users apart and carry a hash tag (one slot per user)", () => {
    const alice = valkeyEventKeys("alice")
    expect(alice.stream).not.toBe(valkeyEventKeys("bob").stream)
    expect(alice.stream).toContain("{alice}")
    expect(alice.epoch).toContain("{alice}")
    expect(valkeyEventKeys("alice", "x:").stream.startsWith("x:")).toBe(true)
  })
})
