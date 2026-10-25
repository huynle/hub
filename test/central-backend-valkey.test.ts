// Valkey Counters, Locks and Kv (src/central/backend/valkey-*.ts): what the shared contracts
// (central-backend-{counters,kv}.test.ts) cannot check. The connection helper runs everywhere; the rest needs
// a real Valkey (HUB_IT_CLUSTER=1 and docker, see test/cluster-it.ts) and skips otherwise.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { ValkeyConnection, type ValkeyClient } from "../src/central/backend/valkey-client"
import { ValkeyCounters } from "../src/central/backend/valkey-counters"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { cluster } from "./backend-impls"

const open: Array<{ close(): void | Promise<void> }> = []
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close()
})
afterAll(() => cluster?.stop())

/** A client that records commands (and whether it was closed) without a server. */
function recordingClient(): ValkeyClient & { calls: Array<[string, string[]]>; closed: number } {
  const client = {
    calls: [] as Array<[string, string[]]>,
    closed: 0,
    async send(command: string, args: string[]) {
      client.calls.push([command, args])
      return "OK"
    },
    close() {
      client.closed++
    },
  }
  return client
}

describe("ValkeyConnection", () => {
  test("a url is not connected (or even parsed) until the first command", async () => {
    const connection = new ValkeyConnection("nope://127.0.0.1:1")
    await expect(connection.send("PING", [])).rejects.toThrow(/protocol/)
    connection.close()
  })

  test("a given client is used as is and left open on close; a url's own client is closed", async () => {
    const client = recordingClient()
    const shared = new ValkeyConnection(client)
    expect(await shared.send("GET", ["k"])).toBe("OK")
    expect(client.calls).toEqual([["GET", ["k"]]])
    shared.close()
    expect(client.closed).toBe(0)
    const own = new ValkeyConnection("redis://127.0.0.1:1")
    own.close()
    own.close()
  })
})

describe.skipIf(!cluster)("Valkey (real server)", () => {
  const url = () => cluster!.freshValkey()
  /** A plain client on the same server (no flush). */
  const raw = (at: string) => {
    const client = new Bun.RedisClient(at)
    open.push(client)
    return client
  }

  test("ValkeyKv keeps its keys under its prefix", async () => {
    const at = await url()
    const kv = new ValkeyKv(at)
    open.push(kv)
    await kv.set("pair:ABC", "u_1", { px: 60_000 })
    const client = raw(at)
    expect(await client.send("GET", ["kv:pair:ABC"])).toBe("u_1")
    expect(Number(await client.send("PTTL", ["kv:pair:ABC"]))).toBeGreaterThan(50_000)
    const other = new ValkeyKv(client, { prefix: "other:" })
    expect(await other.get("pair:ABC")).toBeUndefined()
  })

  test("Bun.RedisClient accepts valkey:// urls", async () => {
    const kv = new ValkeyKv((await url()).replace(/^redis:/, "valkey:"))
    open.push(kv)
    expect(await kv.set("k", "v")).toBe(true)
    expect(await kv.get("k")).toBe("v")
  })

  test("ValkeyCounters: the window starts at the first increment (server-side) and later ones do not extend it", async () => {
    const at = await url()
    const counters = new ValkeyCounters(at)
    open.push(counters)
    expect(await counters.incr("rate:alice", 400)).toBe(1)
    const client = raw(at)
    const ttl = Number(await client.send("PTTL", ["ctr:rate:alice"]))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(400)
    await Bun.sleep(200)
    expect(await counters.incr("rate:alice", 400)).toBe(2)
    expect(Number(await client.send("PTTL", ["ctr:rate:alice"]))).toBeLessThanOrEqual(220)
    expect(await counters.get("rate:alice")).toBe(2)
    await Bun.sleep(350)
    expect(await counters.get("rate:alice")).toBe(0)
    expect(await counters.incr("rate:alice", 400)).toBe(1)
  })

  test("ValkeyCounters: concurrent increments each get their own count", async () => {
    const counters = new ValkeyCounters(await url())
    open.push(counters)
    const counts = await Promise.all(Array.from({ length: 20 }, () => counters.incr("k", 60_000)))
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(await counters.get("k")).toBe(20)
  })

  test("ValkeyCounters: invalid windows are refused", async () => {
    const counters = new ValkeyCounters(await url())
    open.push(counters)
    for (const ttl of [0, -1, 1.5, Number.NaN]) await expect(counters.incr("k", ttl)).rejects.toThrow(/ttl/)
    expect(await counters.get("k")).toBe(0)
  })
})
