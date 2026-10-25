// ValkeyBus against an in-process fake of Valkey pub/sub (test/fake-redis.ts): two bus instances stand for two
// pods. The shared Bus contract runs against real Valkey with HUB_IT_CLUSTER=1 (test/cluster-impls/valkey-bus.ts).
import { describe, expect, test } from "bun:test"
import { ValkeyBus, type ValkeyBusOptions } from "../src/central/backend/valkey-bus"
import { FakeRedisServer } from "./fake-redis"

function pods(count = 2, options: Omit<ValkeyBusOptions, "client"> = {}) {
  const server = new FakeRedisServer()
  const buses = Array.from({ length: count }, (_, i) => new ValkeyBus("redis://fake", { client: () => server.client(), instanceID: `pod${i + 1}`, ...options }))
  return { server, buses }
}

describe("ValkeyBus publish/subscribe", () => {
  test("connects lazily: constructing a bus opens no connection", () => {
    const { server } = pods(2)
    expect(server.opened).toBe(0)
  })

  test("a message published on one pod reaches every subscriber on another; publish counts them", async () => {
    const { buses } = pods(2)
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    const got: Array<[string, string, unknown]> = []
    await b.subscribe("user.alice", (message, topic) => void got.push(["h1", topic, message]))
    await b.subscribe("user.alice", (message, topic) => void got.push(["h2", topic, message]))
    await b.subscribe("user.bob", () => void got.push(["wrong", "", null]))
    expect(await a.publish("user.alice", { n: 1 })).toBe(2)
    await b.sync()
    expect(got.sort()).toEqual([
      ["h1", "user.alice", { n: 1 }],
      ["h2", "user.alice", { n: 1 }],
    ])
    expect(await a.publish("nobody", {})).toBe(0)
  })

  test("messages arrive in publish order", async () => {
    const { buses } = pods(2)
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    const got: unknown[] = []
    await b.subscribe("t", (m) => void got.push(m))
    for (let n = 1; n <= 5; n++) await a.publish("t", n)
    await b.sync()
    expect(got).toEqual([1, 2, 3, 4, 5])
  })

  test("unsubscribe stops delivery, is idempotent, and frees the connection slot for the topic", async () => {
    const { server, buses } = pods(2)
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    const got: unknown[] = []
    const off = await b.subscribe("t", (m) => void got.push(m))
    await b.subscribe("other", () => {})
    await a.publish("t", 1)
    await b.sync()
    await off()
    await off()
    expect(await a.publish("t", 2)).toBe(0)
    await b.sync()
    expect(got).toEqual([1])
    await b.subscribe("t", (m) => void got.push(m))
    // b: one command connection (for sync) and one subscriber connection; a: one command connection.
    expect(server.opened).toBe(3)
  })

  test("a failing subscriber or an undecodable message goes to onError, not to the publisher", async () => {
    const errors: string[] = []
    const { server, buses } = pods(2, { onError: (error, topic) => void errors.push(`${topic}: ${(error as Error).message}`) })
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    const got: unknown[] = []
    await b.subscribe("t", () => {
      throw new Error("boom")
    })
    await b.subscribe("t", async () => {
      throw new Error("async boom")
    })
    await b.subscribe("t", (m) => void got.push(m))
    expect(await a.publish("t", "x")).toBe(3)
    await server.client().publish("hub:bus:t:t", "not json")
    await b.sync()
    expect(got).toEqual(["x"])
    expect(errors.filter((e) => e.includes("boom")).sort()).toEqual(["t: async boom", "t: boom"])
    expect(errors.filter((e) => !e.includes("boom"))).toHaveLength(3)
  })
})

describe("ValkeyBus close", () => {
  test("close() closes every connection it opened; later calls reject", async () => {
    const { server, buses } = pods(1)
    const [a] = buses as [ValkeyBus]
    await a.subscribe("t", () => {})
    await a.subscribe("t", () => {})
    await a.publish("t", 1)
    expect(server.connections.size).toBe(3)
    a.close()
    a.close()
    expect(server.connections.size).toBe(0)
    expect(await a.publish("t", 1).catch((e) => e)).toBeInstanceOf(Error)
    expect(await a.subscribe("t", () => {}).catch((e) => e)).toBeInstanceOf(Error)
    expect(server.opened).toBe(3)
  })

  test("close() while a subscriber connection is still opening closes it when it arrives", async () => {
    const { server, buses } = pods(1)
    const [a] = buses as [ValkeyBus]
    const subscribing = a.subscribe("t", () => {}).catch((e) => e)
    a.close()
    expect(await subscribing).toBeInstanceOf(Error)
    expect(server.connections.size).toBe(0)
  })
})
