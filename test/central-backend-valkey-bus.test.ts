// ValkeyBus against an in-process fake of Valkey pub/sub (test/fake-redis.ts): two bus instances stand for two
// pods. The shared Bus contract runs against real Valkey with HUB_IT_CLUSTER=1 (test/cluster-impls/valkey-bus.ts).
import { describe, expect, test } from "bun:test"
import { BusNoResponderError, BusRemoteError, BusTimeoutError, type Timers } from "../src/central/backend/types"
import { ValkeyBus, type ValkeyBusOptions } from "../src/central/backend/valkey-bus"
import { FakeRedisServer } from "./fake-redis"

/** Timers that fire only when the test says so. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 0
  const timers: Timers = {
    set: (fn, ms) => {
      pending.set(++next, { fn, ms })
      return next
    },
    clear: (handle) => void pending.delete(handle as number),
  }
  return {
    timers,
    pending: () => [...pending.values()].map((p) => p.ms),
    fireAll: () => {
      const due = [...pending.values()]
      pending.clear()
      for (const p of due) p.fn()
    },
  }
}

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

describe("ValkeyBus request/reply", () => {
  test("a request from one pod gets the reply of the responder on another; replies go to the asking pod only", async () => {
    const clock = fakeTimers()
    const { server, buses } = pods(3, { timers: clock.timers })
    const [a, b, c] = buses as [ValkeyBus, ValkeyBus, ValkeyBus]
    await b.serve("pod.b.rpc", async (message, topic) => ({ echo: message, topic }))
    const replies = await Promise.all([
      a.request("pod.b.rpc", { n: 1 }, { timeoutMs: 1000 }),
      a.request("pod.b.rpc", { n: 2 }, { timeoutMs: 1000 }),
      c.request("pod.b.rpc", { n: 3 }, { timeoutMs: 1000 }),
    ])
    expect(replies).toEqual([
      { echo: { n: 1 }, topic: "pod.b.rpc" },
      { echo: { n: 2 }, topic: "pod.b.rpc" },
      { echo: { n: 3 }, topic: "pod.b.rpc" },
    ])
    expect(clock.pending()).toEqual([])
    expect(server.numsub("hub:bus:reply:pod1")).toBe(1)
    expect(server.numsub("hub:bus:reply:pod3")).toBe(1)
    expect(server.numsub("hub:bus:rpc:pod.b.rpc")).toBe(1)
  })

  test("a responder may return nothing", async () => {
    const { buses } = pods(2, { timers: fakeTimers().timers })
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    await b.serve("void", () => undefined)
    expect(await a.request("void", {}, { timeoutMs: 1000 })).toBeUndefined()
  })

  test("no responder anywhere: BusNoResponderError, and its timeout is cleared", async () => {
    const clock = fakeTimers()
    const { buses } = pods(2, { timers: clock.timers })
    const [a] = buses as [ValkeyBus]
    const error = await a.request("pod.gone.rpc", {}, { timeoutMs: 1000 }).catch((e) => e)
    expect(error).toBeInstanceOf(BusNoResponderError)
    expect((error as BusNoResponderError).topic).toBe("pod.gone.rpc")
    expect(clock.pending()).toEqual([])
  })

  test("a responder that never answers: BusTimeoutError when the timeout fires (set at once); a late reply is ignored", async () => {
    const clock = fakeTimers()
    const { buses } = pods(2, { timers: clock.timers })
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    let answer: (value: unknown) => void = () => {}
    let asked!: () => void
    const wasAsked = new Promise<void>((resolve) => (asked = resolve))
    await b.serve("slow", () => {
      asked()
      return new Promise((resolve) => (answer = resolve))
    })
    const reply = a.request("slow", {}, { timeoutMs: 2500 }).catch((e) => e)
    expect(clock.pending()).toEqual([2500])
    await wasAsked
    clock.fireAll()
    const error = await reply
    expect(error).toBeInstanceOf(BusTimeoutError)
    expect((error as BusTimeoutError).timeoutMs).toBe(2500)
    answer("late")
    await a.sync()
  })

  test("a responder that throws: BusRemoteError with its message", async () => {
    const { buses } = pods(2, { timers: fakeTimers().timers })
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    await b.serve("bad", async () => {
      throw new Error("no such session")
    })
    const error = await a.request("bad", {}, { timeoutMs: 1000 }).catch((e) => e)
    expect(error).toBeInstanceOf(BusRemoteError)
    expect((error as Error).message).toBe("no such session")
  })

  test("one responder per topic on a pod; after it stops serving the topic has none", async () => {
    const { buses } = pods(2, { timers: fakeTimers().timers })
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    const stop = await b.serve("t", () => 1)
    expect(await b.serve("t", () => 2).catch((e) => e)).toBeInstanceOf(Error)
    await stop()
    await stop()
    expect(await a.request("t", {}, { timeoutMs: 1000 }).catch((e) => e)).toBeInstanceOf(BusNoResponderError)
    await b.serve("t", () => 3)
    expect(await a.request<number>("t", {}, { timeoutMs: 1000 })).toBe(3)
  })

  test("a request to a responder on the same pod works", async () => {
    const { buses } = pods(1, { timers: fakeTimers().timers })
    const [a] = buses as [ValkeyBus]
    await a.serve("self", (m) => m)
    expect(await a.request<string>("self", "hi", { timeoutMs: 1000 })).toBe("hi")
  })

  test("close() rejects pending requests and clears their timeouts", async () => {
    const clock = fakeTimers()
    const { buses } = pods(2, { timers: clock.timers })
    const [a, b] = buses as [ValkeyBus, ValkeyBus]
    await b.serve("slow", () => new Promise(() => {}))
    const reply = a.request("slow", {}, { timeoutMs: 1000 }).catch((e) => e)
    a.close()
    const error = await reply
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("bus closed")
    expect(clock.pending()).toEqual([])
  })
})
