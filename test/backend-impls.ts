// The backend implementations every contract suite (test/central-backend-*.test.ts) runs against.
//
// Memory and file implementations are always there. With HUB_IT_CLUSTER=1 (and docker), every module in
// test/cluster-impls/*.ts registers its Postgres / Valkey implementations too: each exports a default
// `register(registry, cluster)` that calls registry.add(kind, spec), and its make() takes a fresh database or a
// flushed Valkey from the cluster (test/cluster-it.ts). One module per backend task, so nobody edits this file.
//
// A contract suite loops over implementations(kind), builds each instance with `await impl.make(options)`, and
// skips the tests an implementation cannot run with `test.skipIf(!impl.supports(...))`. Instances are disposed
// after every test; the containers are removed after the file.
import { afterAll, afterEach } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileStateStore } from "../src/central/backend/file-state"
import { MemoryBus, type MemoryBusOptions } from "../src/central/backend/memory-bus"
import { MemoryCatalog, type CatalogMerge } from "../src/central/backend/memory-catalog"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryEventLog, type MemoryEventLogOptions } from "../src/central/backend/memory-events"
import { MemoryKv } from "../src/central/backend/memory-kv"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import type { Backends, Clock } from "../src/central/backend/types"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"

export type BackendKind = keyof Backends
export const BACKEND_KINDS: readonly BackendKind[] = ["state", "bus", "events", "counters", "locks", "catalog", "kv"]

/**
 * What a contract test may rely on beyond the interface:
 * - clock: the `now` option stamps times the implementation reports (claim `at`, lease `expiresAt`, report `at`)
 * - timeTravel: the `now` option also decides expiry (a server-side TTL does not: such tests skip)
 * - timers: the `timers` option drives timeouts (bus requests)
 * - options: the implementation-specific options of the memory implementation (event `epoch`/`max`/`maxAgeMs`
 *   and its id format, catalog `merge`, bus `onError`)
 */
export type Capability = "clock" | "timeTravel" | "timers" | "options"
export const ALL_CAPABILITIES: readonly Capability[] = ["clock", "timeTravel", "timers", "options"]

/** The options make() takes, per kind (the memory implementations' constructor options). */
export interface ImplOptions {
  state: { readonly now?: Clock }
  bus: MemoryBusOptions
  events: MemoryEventLogOptions
  counters: { readonly now?: Clock }
  locks: { readonly now?: Clock }
  catalog: { readonly now?: Clock; readonly merge?: CatalogMerge }
  kv: { readonly now?: Clock }
}

/** How a backend task registers an implementation. */
export interface ImplSpec<K extends BackendKind> {
  /** Shown in the describe titles (e.g. "PostgresStateStore"). */
  readonly name: string
  /** "memory", "file", "postgres", "valkey". */
  readonly backend: string
  readonly supports: readonly Capability[]
  /** A fresh, empty instance (cluster: on a fresh database or a flushed Valkey). */
  make(options?: ImplOptions[K]): Backends[K] | Promise<Backends[K]>
  /** Closes the instance's clients (after every test). */
  dispose?(instance: Backends[K]): void | Promise<void>
}

/** An implementation as contract suites see it. */
export interface BackendImpl<K extends BackendKind> {
  readonly name: string
  readonly backend: string
  /** True when the implementation has every one of these capabilities. */
  supports(...capabilities: Capability[]): boolean
  make(options?: ImplOptions[K]): Promise<Backends[K]>
}

/** What a test/cluster-impls/*.ts module exports as default. */
export type RegisterClusterImpls = (registry: ImplRegistry, cluster: ItCluster) => void | Promise<void>

export class ImplRegistry {
  private readonly impls = new Map<BackendKind, BackendImpl<BackendKind>[]>()
  private live: Array<() => void | Promise<void>> = []
  private readonly dirs = new Set<string>()

  add<K extends BackendKind>(kind: K, spec: ImplSpec<K>): void {
    const supported = new Set(spec.supports)
    const impl: BackendImpl<K> = {
      name: spec.name,
      backend: spec.backend,
      supports: (...capabilities) => capabilities.every((c) => supported.has(c)),
      make: async (options) => {
        const instance = await spec.make(options)
        if (spec.dispose) this.live.push(() => spec.dispose!(instance))
        return instance
      },
    }
    const list = this.impls.get(kind) ?? []
    list.push(impl as unknown as BackendImpl<BackendKind>)
    this.impls.set(kind, list)
  }

  list<K extends BackendKind>(kind: K): BackendImpl<K>[] {
    return [...(this.impls.get(kind) ?? [])] as unknown as BackendImpl<K>[]
  }

  /** A temporary directory, removed by disposeAll. */
  tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    this.dirs.add(dir)
    this.live.push(() => {
      rmSync(dir, { recursive: true, force: true })
      this.dirs.delete(dir)
    })
    return dir
  }

  /** The temporary directories not yet removed. */
  tempDirs(): string[] {
    return [...this.dirs]
  }

  /** Disposes every instance made so far, newest first; rethrows the first failure after trying them all. */
  async disposeAll(): Promise<void> {
    const live = this.live.reverse()
    this.live = []
    let failure: unknown
    for (const dispose of live) {
      try {
        await dispose()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }

  /** Registers the implementations of every *.ts module in `dir` (sorted); returns the module file names. */
  async loadCluster(dir: string, cluster: ItCluster): Promise<string[]> {
    if (!existsSync(dir)) return []
    const files = [...new Bun.Glob("*.ts").scanSync({ cwd: dir })].filter((f) => !f.endsWith(".d.ts")).sort()
    for (const file of files) {
      const module = (await import(path.join(dir, file))) as { default?: RegisterClusterImpls }
      if (typeof module.default !== "function") throw new Error(`${file}: no default register(registry, cluster) export`)
      await module.default(this, cluster)
    }
    return files
  }
}

/** The memory implementations of every kind, and the file StateStore (in a temporary state directory). */
export function standardImpls(registry: ImplRegistry): void {
  const all = ALL_CAPABILITIES
  registry.add("state", { name: "MemoryStateStore", backend: "memory", supports: all, make: (options) => new MemoryStateStore(options) })
  registry.add("state", {
    name: "FileStateStore",
    backend: "file",
    supports: all,
    make: (options) => {
      // Registered before the store, so the directory goes after the store has flushed (newest first).
      const stateDir = registry.tempDir("hub-file-state-")
      return new FileStateStore({ stateDir, ...options })
    },
    dispose: (store) => store.flush?.(),
  })
  registry.add("bus", { name: "MemoryBus", backend: "memory", supports: all, make: (options) => new MemoryBus(options) })
  registry.add("events", { name: "MemoryEventLog", backend: "memory", supports: all, make: (options) => new MemoryEventLog(options) })
  registry.add("counters", { name: "MemoryCounters", backend: "memory", supports: all, make: (options) => new MemoryCounters(options) })
  registry.add("locks", { name: "MemoryLocks", backend: "memory", supports: all, make: (options) => new MemoryLocks(options) })
  registry.add("catalog", { name: "MemoryCatalog", backend: "memory", supports: all, make: (options) => new MemoryCatalog(options) })
  registry.add("kv", { name: "MemoryKv", backend: "memory", supports: all, make: (options) => new MemoryKv(options) })
}

/** Where the cluster implementation modules live. */
export const CLUSTER_IMPLS_DIR = path.join(import.meta.dir, "cluster-impls")

const registry = new ImplRegistry()
standardImpls(registry)

/** The docker cluster when HUB_IT_CLUSTER=1 and docker answers; otherwise undefined (cluster suites skip). */
export const cluster: ItCluster | undefined = await (async () => {
  if (!itClusterEnabled()) return undefined
  if (!(await dockerAvailable())) {
    console.warn("HUB_IT_CLUSTER=1 but docker is not available: skipping the Postgres/Valkey implementations")
    return undefined
  }
  const it = new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) })
  await registry.loadCluster(CLUSTER_IMPLS_DIR, it)
  return it
})()

afterEach(() => registry.disposeAll())
afterAll(async () => {
  await registry.disposeAll()
  await cluster?.stop()
})

/** The implementations of a backend kind, standard first. */
export function implementations<K extends BackendKind>(kind: K): BackendImpl<K>[] {
  return registry.list(kind)
}
