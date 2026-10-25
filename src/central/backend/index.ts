// The hub's backends (design §9): interfaces in ./types, in-memory implementations for the single-process hub,
// a file StateStore under <stateDir>/agent, and the cluster bundle (Postgres + Valkey). startCentral creates the bundle its config selects (hubBackends:
// file, or cluster when HUB_DATABASE_URL/HUB_VALKEY_URL are set) or takes one in its options, exposes it to
// new code only, and flushes its state on stop.
import { FileStateStore, type FileStateStoreOptions } from "./file-state"
import { MemoryBus } from "./memory-bus"
import { MemoryCatalog } from "./memory-catalog"
import { MemoryCounters, MemoryLocks } from "./memory-counters"
import { MemoryEventLog } from "./memory-events"
import { MemoryKv } from "./memory-kv"
import { MemoryStateStore } from "./memory-state"
import { randomUUID } from "node:crypto"
import { RedisClient } from "bun"
import { PostgresStateStore } from "./postgres-state"
import { ValkeyBus } from "./valkey-bus"
import { ValkeyCatalog } from "./valkey-catalog"
import { ValkeyCounters } from "./valkey-counters"
import { ValkeyEventLog } from "./valkey-events"
import { ValkeyKv } from "./valkey-kv"
import { ValkeyLocks } from "./valkey-locks"
import type { CentralConfig, ClusterConfig } from "../config"
import type { Backends, Clock, Timers } from "./types"

export * from "./types"

export interface MemoryBackendsOptions {
  /** The clock every backend reads (default Date.now). */
  readonly now?: Clock
  /** Timers for bus request timeouts (default real, unref'd timers). */
  readonly timers?: Timers
}

/** Every backend in process memory, on one clock. */
export function memoryBackends(options: MemoryBackendsOptions = {}): Backends {
  const now = options.now ?? Date.now
  return {
    state: new MemoryStateStore({ now }),
    bus: new MemoryBus(options.timers ? { timers: options.timers } : {}),
    events: new MemoryEventLog({ now }),
    counters: new MemoryCounters({ now }),
    locks: new MemoryLocks({ now }),
    catalog: new MemoryCatalog({ now }),
    kv: new MemoryKv({ now }),
  }
}


export interface FileBackendsOptions extends MemoryBackendsOptions, Pick<FileStateStoreOptions, "debounceMs" | "warn"> {
  /** The hub's state directory; the StateStore writes under <stateDir>/agent. */
  readonly stateDir: string
}

/** The StateStore in files under the state directory, every other backend in process memory, on one clock. */
export function fileBackends(options: FileBackendsOptions): Backends {
  const { stateDir, debounceMs, warn, ...memory } = options
  const state = new FileStateStore({
    stateDir,
    ...(memory.now ? { now: memory.now } : {}),
    ...(memory.timers ? { timers: memory.timers } : {}),
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(warn ? { warn } : {}),
  })
  return { ...memoryBackends(memory), state }
}

export interface ClusterBackendsOptions extends MemoryBackendsOptions {
  /** HUB_DATABASE_URL / HUB_VALKEY_URL and the pod id (see ../config). */
  readonly cluster: ClusterConfig
  /** Opens the Valkey client kv, counters, locks, events and catalog share (default: Bun.RedisClient; tests). */
  readonly valkeyClient?: (url: string) => RedisClient
}

/** Cluster mode configured in a build that cannot run it. No longer thrown (kept for main.ts until P6-T14). */
export class ClusterUnavailableError extends Error {
  constructor() {
    super("Cluster mode (HUB_DATABASE_URL and HUB_VALKEY_URL) is not available in this build; unset both to run a single-process hub")
    this.name = "ClusterUnavailableError"
  }
}

/**
 * State in Postgres, everything else in Valkey (design §9). Built synchronously, nothing connects until first
 * use: the Postgres pool checks the schema then (it never migrates: `hub-server migrate` does), and one Valkey
 * client, opened on the first command, serves kv, counters, locks, events and catalog; the bus opens its own
 * (pub/sub needs dedicated connections). close() closes them all. URLs are never put in a message.
 */
export function clusterBackends(options: ClusterBackendsOptions): Backends {
  const { cluster } = options
  const now = options.now
  const open = options.valkeyClient ?? ((url: string) => new RedisClient(url))
  let client: RedisClient | undefined
  // One lazily opened client behind the shape the Valkey backends use (send / close).
  const shared = {
    send: (command: string, args: string[]) => (client ??= open(cluster.valkeyURL)).send(command, args),
    close: () => {
      client?.close()
      client = undefined
    },
  } as unknown as RedisClient
  const state = new PostgresStateStore({ url: cluster.databaseURL, ...(now ? { now } : {}) })
  const bus = new ValkeyBus(cluster.valkeyURL, { instanceID: `${cluster.podID}-${randomUUID().slice(0, 8)}`, ...(options.timers ? { timers: options.timers } : {}) })
  return {
    state,
    bus,
    events: new ValkeyEventLog(shared, now ? { now } : {}),
    counters: new ValkeyCounters(shared),
    locks: new ValkeyLocks(shared, now ? { now } : {}),
    catalog: new ValkeyCatalog(shared, now ? { now } : {}),
    kv: new ValkeyKv(shared),
    async close() {
      bus.close()
      shared.close()
      await state.close()
    },
  }
}

/** The hub's bundle for its config: the cluster one when cluster mode is configured, else the file one. */
export function hubBackends(config: Pick<CentralConfig, "stateDir" | "cluster">, options: MemoryBackendsOptions = {}): Backends {
  return config.cluster ? clusterBackends({ ...options, cluster: config.cluster }) : fileBackends({ ...options, stateDir: config.stateDir })
}
