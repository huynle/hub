// Backend Counters and Locks (in memory): fixed-window counters and expiring leases, against a fake clock.
import { describe, expect, test } from "bun:test"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"

describe("MemoryCounters", () => {
  test("incr counts up within a window and get reads it; unknown keys are 0", async () => {
    let t = 0
    const counters = new MemoryCounters({ now: () => t })
    expect(await counters.get("k")).toBe(0)
    expect(await counters.incr("k", 1000)).toBe(1)
    expect(await counters.incr("k", 1000)).toBe(2)
    expect(await counters.incr("other", 1000)).toBe(1)
    expect(await counters.get("k")).toBe(2)
  })

  test("the window starts at the first increment and is not extended by later ones", async () => {
    let t = 0
    const counters = new MemoryCounters({ now: () => t })
    await counters.incr("k", 1000)
    t = 900
    expect(await counters.incr("k", 1000)).toBe(2)
    t = 999
    expect(await counters.get("k")).toBe(2)
    t = 1000
    expect(await counters.get("k")).toBe(0)
    expect(await counters.incr("k", 1000)).toBe(1)
    t = 1999
    expect(await counters.get("k")).toBe(1)
    t = 2000
    expect(await counters.get("k")).toBe(0)
  })
})

describe("MemoryLocks", () => {
  test("one holder at a time; others get undefined until it releases", async () => {
    let t = 0
    const locks = new MemoryLocks({ now: () => t })
    const lease = await locks.acquire("placement:alice", "pod_a", 5000)
    expect(lease).toEqual({ key: "placement:alice", owner: "pod_a", fence: 1, expiresAt: 5000 })
    expect(await locks.acquire("placement:alice", "pod_b", 5000)).toBeUndefined()
    expect(await locks.holder("placement:alice")).toEqual(lease!)
    expect(await locks.release("placement:alice", "pod_b")).toBe(false)
    expect(await locks.release("placement:alice", "pod_a")).toBe(true)
    expect(await locks.holder("placement:alice")).toBeUndefined()
    expect(await locks.acquire("placement:alice", "pod_b", 5000)).toMatchObject({ owner: "pod_b", fence: 2 })
  })

  test("a lease expires at its ttl: then anyone may take it, with a higher fence", async () => {
    let t = 0
    const locks = new MemoryLocks({ now: () => t })
    await locks.acquire("k", "a", 1000)
    t = 999
    expect(await locks.acquire("k", "b", 1000)).toBeUndefined()
    t = 1000
    expect(await locks.holder("k")).toBeUndefined()
    expect(await locks.acquire("k", "b", 1000)).toEqual({ key: "k", owner: "b", fence: 2, expiresAt: 2000 })
  })

  test("renew extends the holder's lease (same fence); after expiry or takeover renew fails", async () => {
    let t = 0
    const locks = new MemoryLocks({ now: () => t })
    await locks.acquire("k", "a", 1000)
    t = 800
    expect(await locks.renew("k", "a", 1000)).toEqual({ key: "k", owner: "a", fence: 1, expiresAt: 1800 })
    expect(await locks.renew("k", "b", 1000)).toBeUndefined()
    t = 1700
    expect(await locks.acquire("k", "b", 1000)).toBeUndefined()
    t = 1800
    expect(await locks.renew("k", "a", 1000)).toBeUndefined()
    await locks.acquire("k", "b", 1000)
    expect(await locks.renew("k", "a", 1000)).toBeUndefined()
    expect(await locks.release("k", "a")).toBe(false)
  })

  test("the holder acquiring again renews its lease and keeps the fence", async () => {
    let t = 0
    const locks = new MemoryLocks({ now: () => t })
    await locks.acquire("k", "a", 1000)
    t = 500
    expect(await locks.acquire("k", "a", 1000)).toEqual({ key: "k", owner: "a", fence: 1, expiresAt: 1500 })
  })

  test("releasing an expired lease is refused", async () => {
    let t = 0
    const locks = new MemoryLocks({ now: () => t })
    await locks.acquire("k", "a", 1000)
    t = 1000
    expect(await locks.release("k", "a")).toBe(false)
  })

  test("concurrent acquires: exactly one wins", async () => {
    const locks = new MemoryLocks({ now: () => 0 })
    const leases = await Promise.all(["a", "b", "c"].map((owner) => locks.acquire("k", owner, 1000)))
    expect(leases.filter(Boolean).length).toBe(1)
  })
})
