// Backends bundle: memoryBackends shares one clock across the in-memory backends, fileBackends keeps the
// StateStore in files, clusterBackends builds the Postgres/Valkey bundle (connecting lazily), and startCentral
// exposes the bundle (file state under its stateDir by default, the cluster one with cluster config, or the one
// passed in), flushing it on stop and closing the one it built. In cluster mode its Store lives in the bundle.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { clusterBackends, fileBackends, hubBackends, memoryBackends } from "../src/central/backend"
import { PostgresStateStore } from "../src/central/backend/postgres-state"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { ValkeyCatalog } from "../src/central/backend/valkey-catalog"
import { ValkeyCounters } from "../src/central/backend/valkey-counters"
import { ValkeyEventLog } from "../src/central/backend/valkey-events"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { ValkeyLocks } from "../src/central/backend/valkey-locks"
import { HUB_ROWS } from "../src/central/store"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central } from "../src/central/http"
import { FileStateStore } from "../src/central/backend/file-state"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { MemoryCatalog } from "../src/central/backend/memory-catalog"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryEventLog } from "../src/central/backend/memory-events"
import { MemoryKv } from "../src/central/backend/memory-kv"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import { harness, webDir, type Harness } from "./central-harness"

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

const SECRETS = ["s3cretDB", "s3cretVK", "db.internal", "valkey.internal"]
const CLUSTER_ENV = {
  HUB_AUTH: "oidc",
  HUB_OIDC_CLIENT_ID: "cid",
  HUB_OIDC_CLIENT_SECRET: "csecret",
  HUB_OIDC_ALLOWED: "@example.com",
  HUB_ADMIN_EMAILS: "admin@example.com",
  HUB_DATABASE_URL: "postgres://hub:s3cretDB@db.internal/hub",
  HUB_VALKEY_URL: "redis://:s3cretVK@valkey.internal:6379",
  HUB_TOKEN_KEYS: JSON.stringify({ active: "k1", keys: [{ kid: "k1", secret: Buffer.alloc(32, 1).toString("base64"), created: 0 }] }),
  HUB_POD_ID: "pod-a",
  HUB_PORT: "0",
}

describe("cluster backends", () => {
  test("clusterBackends builds Postgres state, the Valkey bus and Valkey kv/counters/locks/events/catalog; nothing connects", async () => {
    const { cluster } = centralConfig(CLUSTER_ENV, "/home/me")
    const backends = clusterBackends({ cluster: cluster! })
    expect(backends.state).toBeInstanceOf(PostgresStateStore)
    expect(backends.bus).toBeInstanceOf(ValkeyBus)
    expect(backends.events).toBeInstanceOf(ValkeyEventLog)
    expect(backends.counters).toBeInstanceOf(ValkeyCounters)
    expect(backends.locks).toBeInstanceOf(ValkeyLocks)
    expect(backends.catalog).toBeInstanceOf(ValkeyCatalog)
    expect(backends.kv).toBeInstanceOf(ValkeyKv)
    for (const secret of SECRETS) expect(JSON.stringify(Object.keys(backends))).not.toContain(secret)
    await backends.close?.()
  })

  test("one shared Valkey client (made on first use) serves kv, counters, locks, events and catalog; close() closes it", async () => {
    const { cluster } = centralConfig(CLUSTER_ENV, "/home/me")
    const made: string[] = []
    let closed = 0
    const sent: string[] = []
    const backends = clusterBackends({
      cluster: cluster!,
      valkeyClient: (url) => {
        made.push(url)
        return {
          send: async (command: string) => {
            sent.push(command)
            return command === "GET" ? null : 1
          },
          close: () => void closed++,
        } as never
      },
    })
    expect(made).toEqual([])
    await backends.kv.get("k")
    await backends.counters.get("c")
    expect(made).toEqual([cluster!.valkeyURL])
    expect(sent).toEqual(["GET", "GET"])
    await backends.close?.()
    expect(closed).toBe(1)
  })

  test("hubBackends picks the file bundle without cluster config and the cluster bundle with it", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "hub-select-"))
    try {
      expect(hubBackends({ stateDir }).state).toBeInstanceOf(FileStateStore)
      const config = centralConfig({ ...CLUSTER_ENV, HUB_STATE_DIR: stateDir }, "/home/me")
      const backends = hubBackends(config)
      expect(backends.state).toBeInstanceOf(PostgresStateStore)
      await backends.close?.()
      expect(readdirSync(stateDir)).toEqual([])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("startCentral in cluster mode keeps the Store in the shared backends: two pods see each other's devices and revocations", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-start-"))
    const backends = memoryBackends()
    const pods: Central[] = []
    try {
      for (const pod of ["pod-a", "pod-b"]) {
        const config = centralConfig({ ...CLUSTER_ENV, HUB_POD_ID: pod, HUB_STATE_DIR: stateDir }, "/home/me")
        pods.push(startCentral({ config, backends, webDir: webDir() }))
      }
      const [a, b] = pods as [Central, Central]
      await a.store.ready()
      const user = await a.store.upsertUser({ email: "alice@example.com", role: "user" })
      const { device, token } = await a.store.addDevice("phone", user.id)
      const me = (pod: Central) => fetch(`${pod.url}/api/me`, { headers: { cookie: `voice_device=${token}` } })
      expect((await me(b)).status).toBe(200)
      await a.store.removeDevice(device.id)
      expect((await me(b)).status).toBe(401)
      expect(readdirSync(stateDir)).toEqual([])
      expect(await backends.state.get(HUB_ROWS, "users", user.id)).toBeDefined()
    } finally {
      for (const pod of pods) await pod.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("stop() closes the cluster backends startCentral built (not ones it was given)", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-stop-"))
    try {
      const config = centralConfig({ ...CLUSTER_ENV, HUB_STATE_DIR: stateDir }, "/home/me")
      let closed = 0
      const given = { ...memoryBackends(), close: async () => void closed++ }
      const hub = startCentral({ config, backends: given, webDir: webDir() })
      await hub.stop()
      expect(closed).toBe(0)
      const own = startCentral({ config, webDir: webDir() })
      expect(own.backends.state).toBeInstanceOf(PostgresStateStore)
      const close = own.backends.close!
      let ownClosed = 0
      ;(own.backends as { close?: () => Promise<void> }).close = async () => {
        ownClosed++
        await close()
      }
      await own.stop()
      expect(ownClosed).toBe(1)
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

  test("keeps state in files under its stateDir by default, the rest in memory", async () => {
    hub = await harness()
    expect(hub.backends.state).toBeInstanceOf(FileStateStore)
    expect(hub.backends.bus).toBeInstanceOf(MemoryBus)
  })

  test("stop flushes pending state; a restarted hub reads it back; state.json stays untouched", async () => {
    hub = await harness()
    const { stateDir } = hub
    await hub.backends.state.put("alice", "messages", "m1", { text: "kept" })
    await hub.backends.state.claim("alice:names", "scout", "agent_1")
    expect(existsSync(path.join(stateDir, "agent"))).toBe(false)
    await hub.stop()
    hub = await harness({ env: { HUB_STATE_DIR: stateDir } })
    expect(await hub.backends.state.get("alice", "messages", "m1")).toEqual({ value: { text: "kept" }, version: 1 })
    expect((await hub.backends.state.claimOf("alice:names", "scout"))!.owner).toBe("agent_1")
    expect(readFileSync(path.join(stateDir, "state.json"), "utf8")).not.toContain("kept")
  })

  test("uses the backends it is given", async () => {
    const backends = memoryBackends()
    hub = await harness({ backends })
    expect(hub.backends).toBe(backends)
  })
})
