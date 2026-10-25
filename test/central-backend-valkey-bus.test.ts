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
})
