// The shared backend implementation list (test/backend-impls.ts) the central-backend-*.test.ts contracts run
// over: memory and file always, cluster implementations from test/cluster-impls/*.ts with HUB_IT_CLUSTER=1.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileStateStore } from "../src/central/backend/file-state"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { MemoryCatalog } from "../src/central/backend/memory-catalog"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryEventLog } from "../src/central/backend/memory-events"
import { MemoryKv } from "../src/central/backend/memory-kv"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import { BACKEND_KINDS, ImplRegistry, implementations, standardImpls } from "./backend-impls"
import type { ItCluster } from "./cluster-it"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-impls-"))
  dirs.push(dir)
  return dir
}

describe("the standard implementations", () => {
  test("memory for every kind, and file for state", () => {
    const names = Object.fromEntries(BACKEND_KINDS.map((kind) => [kind, implementations(kind).map((impl) => `${impl.backend}:${impl.name}`)]))
    expect(names).toMatchObject({
      state: ["memory:MemoryStateStore", "file:FileStateStore"],
      bus: ["memory:MemoryBus"],
      events: ["memory:MemoryEventLog"],
      counters: ["memory:MemoryCounters"],
      locks: ["memory:MemoryLocks"],
      catalog: ["memory:MemoryCatalog"],
      kv: ["memory:MemoryKv"],
    })
  })

  test("make builds the implementation with the given options", async () => {
    const registry = new ImplRegistry()
    standardImpls(registry)
    const [memoryState, fileState] = registry.list("state")
    expect(await memoryState!.make()).toBeInstanceOf(MemoryStateStore)
    const file = (await fileState!.make({ now: () => 5 })) as FileStateStore
    expect(file).toBeInstanceOf(FileStateStore)
    expect((await file.claim("ns", "k", "o")).ok && (await file.claimOf("ns", "k"))!.at).toBe(5)
    expect(await registry.list("bus")[0]!.make()).toBeInstanceOf(MemoryBus)
    expect(await registry.list("events")[0]!.make({ epoch: "zz" })).toBeInstanceOf(MemoryEventLog)
    expect(await registry.list("counters")[0]!.make()).toBeInstanceOf(MemoryCounters)
    expect(await registry.list("locks")[0]!.make()).toBeInstanceOf(MemoryLocks)
    expect(await registry.list("catalog")[0]!.make()).toBeInstanceOf(MemoryCatalog)
    const kv = await registry.list("kv")[0]!.make({ now: () => 0 })
    expect(kv).toBeInstanceOf(MemoryKv)
    await registry.disposeAll()
  })

  test("memory and file support every capability", () => {
    for (const kind of BACKEND_KINDS)
      for (const impl of implementations(kind)) expect(impl.supports("clock", "timeTravel", "timers", "options")).toBe(true)
  })

  test("the file state directory is removed when the instance is disposed (after flushing)", async () => {
    const registry = new ImplRegistry()
    standardImpls(registry)
    const store = (await registry.list("state")[1]!.make()) as FileStateStore
    await store.put("alice", "c", "k", 1)
    const [dir] = registry.tempDirs()
    expect(dir).toBeDefined()
    if (!dir) return
    expect(existsSync(dir)).toBe(true)
    await registry.disposeAll()
    expect(existsSync(dir)).toBe(false)
  })
})

describe("ImplRegistry", () => {
  test("add registers an implementation; supports checks every named capability", async () => {
    const registry = new ImplRegistry()
    registry.add("kv", { name: "FakeKv", backend: "valkey", supports: ["clock"], make: async () => new MemoryKv() })
    const [impl] = registry.list("kv")
    expect(impl!.name).toBe("FakeKv")
    expect(impl!.backend).toBe("valkey")
    expect(impl!.supports("clock")).toBe(true)
    expect(impl!.supports("clock", "timeTravel")).toBe(false)
    expect(impl!.supports()).toBe(true)
    expect(registry.list("bus")).toEqual([])
  })

  test("instances made are disposed by disposeAll, newest first, each once; a failing dispose does not stop the rest", async () => {
    const registry = new ImplRegistry()
    const disposed: string[] = []
    let n = 0
    registry.add("kv", {
      name: "K",
      backend: "valkey",
      supports: [],
      make: async () => Object.assign(new MemoryKv(), { id: `k${++n}` }),
      dispose: async (kv) => {
        disposed.push((kv as MemoryKv & { id: string }).id)
        if ((kv as MemoryKv & { id: string }).id === "k2") throw new Error("close failed")
      },
    })
    const impl = registry.list("kv")[0]!
    await impl.make()
    await impl.make()
    await impl.make()
    await expect(registry.disposeAll()).rejects.toThrow(/close failed/)
    expect(disposed).toEqual(["k3", "k2", "k1"])
    await registry.disposeAll()
    expect(disposed.length).toBe(3)
  })

  test("loadCluster registers every module in the folder with the cluster", async () => {
    const dir = tempDir()
    const impls = path.join(import.meta.dir, "backend-impls.ts")
    writeFileSync(
      path.join(dir, "fake-kv.ts"),
      `import { MemoryKv } from ${JSON.stringify(path.join(import.meta.dir, "../src/central/backend/memory-kv.ts"))}
import type { ImplRegistry } from ${JSON.stringify(impls)}
export default function register(registry: ImplRegistry, cluster: { tag: string }) {
  registry.add("kv", { name: "ValkeyKv(" + cluster.tag + ")", backend: "valkey", supports: [], make: async () => new MemoryKv() })
}
`,
    )
    writeFileSync(path.join(dir, "README.md"), "not a module")
    const registry = new ImplRegistry()
    standardImpls(registry)
    expect(await registry.loadCluster(dir, { tag: "it" } as unknown as ItCluster)).toEqual(["fake-kv.ts"])
    expect(registry.list("kv").map((impl) => impl.name)).toEqual(["MemoryKv", "ValkeyKv(it)"])
  })

  test("loadCluster of a missing folder registers nothing", async () => {
    const registry = new ImplRegistry()
    expect(await registry.loadCluster(path.join(tempDir(), "absent"), {} as ItCluster)).toEqual([])
  })
})
