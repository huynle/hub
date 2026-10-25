// Backends bundle: memoryBackends shares one clock across the in-memory backends, fileBackends keeps the
// StateStore in files, and startCentral exposes the bundle (file state under its stateDir by default, or the
// one passed in) for new code, flushing it on stop.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileBackends, memoryBackends } from "../src/central/backend"
import { FileStateStore } from "../src/central/backend/file-state"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { MemoryCatalog } from "../src/central/backend/memory-catalog"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryEventLog } from "../src/central/backend/memory-events"
import { MemoryKv } from "../src/central/backend/memory-kv"
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
    expect(backends.kv).toBeInstanceOf(MemoryKv)
  })

  test("every backend uses the injected clock", async () => {
    let t = 0
    const backends = memoryBackends({ now: () => t })
    await backends.counters.incr("k", 100)
    await backends.locks.acquire("l", "o", 100)
    await backends.catalog.set("u", "s", "c", {}, { ttlMs: 100 })
    await backends.kv.set("kv", "v", { px: 100 })
    expect((await backends.state.claim("ns", "k", "o")).ok && (await backends.state.claimOf("ns", "k"))!.at).toBe(0)
    t = 100
    expect(await backends.counters.get("k")).toBe(0)
    expect(await backends.locks.holder("l")).toBeUndefined()
    expect(await backends.catalog.list("u")).toEqual([])
    expect(await backends.kv.get("kv")).toBeUndefined()
    await backends.events.append("u", { type: "x" })
    expect(await backends.events.since("u", (await backends.events.latest("u")).replace(/\.\d+$/, ".0"))).toMatchObject({ events: [{ at: 100 }] })
  })
})

describe("fileBackends", () => {
  test("keeps state in files under <stateDir>/agent, everything else in memory, on one clock", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "hub-file-backends-"))
    try {
      const backends = fileBackends({ stateDir, now: () => 7 })
      expect(backends.state).toBeInstanceOf(FileStateStore)
      expect(backends.bus).toBeInstanceOf(MemoryBus)
      expect(backends.events).toBeInstanceOf(MemoryEventLog)
      expect(backends.counters).toBeInstanceOf(MemoryCounters)
      expect(backends.locks).toBeInstanceOf(MemoryLocks)
      expect(backends.catalog).toBeInstanceOf(MemoryCatalog)
      expect(backends.kv).toBeInstanceOf(MemoryKv)
      await backends.state.claim("ns", "k", "o")
      await backends.state.flush?.()
      expect(await new FileStateStore({ stateDir }).claimOf("ns", "k")).toEqual({ namespace: "ns", key: "k", owner: "o", at: 7 })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe("startCentral backends", () => {
  let hub: Harness | undefined
  afterEach(async () => {
    await hub?.stop()
    hub = undefined
  })

  test("keeps state in files under its stateDir by default, the rest in memory", () => {
    hub = harness()
    expect(hub.backends.state).toBeInstanceOf(FileStateStore)
    expect(hub.backends.bus).toBeInstanceOf(MemoryBus)
  })

  test("stop flushes pending state; a restarted hub reads it back; state.json stays untouched", async () => {
    hub = harness()
    const { stateDir } = hub
    await hub.backends.state.put("alice", "messages", "m1", { text: "kept" })
    await hub.backends.state.claim("alice:names", "scout", "agent_1")
    expect(existsSync(path.join(stateDir, "agent"))).toBe(false)
    await hub.stop()
    hub = harness({ env: { HUB_STATE_DIR: stateDir } })
    expect(await hub.backends.state.get("alice", "messages", "m1")).toEqual({ value: { text: "kept" }, version: 1 })
    expect((await hub.backends.state.claimOf("alice:names", "scout"))!.owner).toBe("agent_1")
    expect(readFileSync(path.join(stateDir, "state.json"), "utf8")).not.toContain("kept")
  })

  test("uses the backends it is given", () => {
    const backends = memoryBackends()
    hub = harness({ backends })
    expect(hub.backends).toBe(backends)
  })
})
