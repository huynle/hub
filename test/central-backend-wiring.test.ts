// Backends bundle: memoryBackends shares one clock across the in-memory backends, and startCentral exposes the
// bundle (its own by default, or the one passed in) for new code.
import { afterEach, describe, expect, test } from "bun:test"
import { memoryBackends } from "../src/central/backend"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { MemoryCatalog } from "../src/central/backend/memory-catalog"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryEventLog } from "../src/central/backend/memory-events"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import { harness, type Harness } from "./central-harness"

describe("memoryBackends", () => {
  test("bundles the in-memory implementations", () => {
    const backends = memoryBackends()
    expect(backends.state).toBeInstanceOf(MemoryStateStore)
    expect(backends.bus).toBeInstanceOf(MemoryBus)
    expect(backends.events).toBeInstanceOf(MemoryEventLog)
    expect(backends.counters).toBeInstanceOf(MemoryCounters)
    expect(backends.locks).toBeInstanceOf(MemoryLocks)
    expect(backends.catalog).toBeInstanceOf(MemoryCatalog)
  })

  test("every backend uses the injected clock", async () => {
    let t = 0
    const backends = memoryBackends({ now: () => t })
    await backends.counters.incr("k", 100)
    await backends.locks.acquire("l", "o", 100)
    await backends.catalog.set("u", "s", "c", {}, { ttlMs: 100 })
    expect((await backends.state.claim("ns", "k", "o")).ok && (await backends.state.claimOf("ns", "k"))!.at).toBe(0)
    t = 100
    expect(await backends.counters.get("k")).toBe(0)
    expect(await backends.locks.holder("l")).toBeUndefined()
    expect(await backends.catalog.list("u")).toEqual([])
    await backends.events.append("u", { type: "x" })
    expect(await backends.events.since("u", (await backends.events.latest("u")).replace(/\.\d+$/, ".0"))).toMatchObject({ events: [{ at: 100 }] })
  })
})

describe("startCentral backends", () => {
  let hub: Harness | undefined
  afterEach(async () => {
    await hub?.stop()
    hub = undefined
  })

  test("creates in-memory backends by default", () => {
    hub = harness()
    expect(hub.backends.state).toBeInstanceOf(MemoryStateStore)
    expect(hub.backends.bus).toBeInstanceOf(MemoryBus)
  })

  test("uses the backends it is given", () => {
    const backends = memoryBackends()
    hub = harness({ backends })
    expect(hub.backends).toBe(backends)
  })
})
