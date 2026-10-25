// Backend Kv (in memory): string values with optional expiry (PX) and set-if-absent (NX), get, getdel and del,
// against a fake clock. A cluster uses Valkey SET/GET/GETDEL/DEL behind the same contract.
import { describe, expect, test } from "bun:test"
import { MemoryKv } from "../src/central/backend/memory-kv"

describe("MemoryKv", () => {
  test("set then get; unknown keys are undefined", async () => {
    const kv = new MemoryKv({ now: () => 0 })
    expect(await kv.get("k")).toBeUndefined()
    expect(await kv.set("k", "v1")).toBe(true)
    expect(await kv.get("k")).toBe("v1")
    expect(await kv.set("k", "v2")).toBe(true)
    expect(await kv.get("k")).toBe("v2")
    expect(await kv.get("other")).toBeUndefined()
  })

  test("px expires the key at its ttl; a plain set clears the expiry", async () => {
    let t = 0
    const kv = new MemoryKv({ now: () => t })
    await kv.set("k", "v", { px: 1000 })
    t = 999
    expect(await kv.get("k")).toBe("v")
    t = 1000
    expect(await kv.get("k")).toBeUndefined()
    await kv.set("k", "v", { px: 1000 })
    await kv.set("k", "w")
    t = 5000
    expect(await kv.get("k")).toBe("w")
  })

  test("nx sets only when the key is absent (or expired)", async () => {
    let t = 0
    const kv = new MemoryKv({ now: () => t })
    expect(await kv.set("k", "a", { nx: true, px: 1000 })).toBe(true)
    expect(await kv.set("k", "b", { nx: true, px: 1000 })).toBe(false)
    expect(await kv.get("k")).toBe("a")
    t = 1000
    expect(await kv.set("k", "c", { nx: true })).toBe(true)
    expect(await kv.get("k")).toBe("c")
  })

  test("getdel returns the value once and removes it", async () => {
    let t = 0
    const kv = new MemoryKv({ now: () => t })
    await kv.set("code", "payload", { px: 100 })
    expect(await kv.getdel("code")).toBe("payload")
    expect(await kv.getdel("code")).toBeUndefined()
    expect(await kv.get("code")).toBeUndefined()
    await kv.set("late", "x", { px: 100 })
    t = 100
    expect(await kv.getdel("late")).toBeUndefined()
  })

  test("del removes a key; true only when it existed", async () => {
    let t = 0
    const kv = new MemoryKv({ now: () => t })
    await kv.set("k", "v")
    expect(await kv.del("k")).toBe(true)
    expect(await kv.del("k")).toBe(false)
    expect(await kv.get("k")).toBeUndefined()
    await kv.set("e", "v", { px: 10 })
    t = 10
    expect(await kv.del("e")).toBe(false)
  })

  test("invalid ttls are refused", async () => {
    const kv = new MemoryKv({ now: () => 0 })
    for (const px of [0, -1, 1.5, Number.NaN]) await expect(kv.set("k", "v", { px })).rejects.toThrow(/px/)
    expect(await kv.get("k")).toBeUndefined()
  })
})
