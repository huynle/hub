// The hub's backends (design §9): interfaces in ./types, in-memory implementations for the single-process hub,
// and a file StateStore under <stateDir>/agent. startCentral creates the bundle its config selects (hubBackends:
// file, or cluster when HUB_DATABASE_URL/HUB_VALKEY_URL are set) or takes one in its options, exposes it to
// new code only, and flushes its state on stop.
import { FileStateStore, type FileStateStoreOptions } from "./file-state"
import { MemoryBus } from "./memory-bus"
import { MemoryCatalog } from "./memory-catalog"
import { MemoryCounters, MemoryLocks } from "./memory-counters"
import { MemoryEventLog } from "./memory-events"
import { MemoryKv } from "./memory-kv"
import { MemoryStateStore } from "./memory-state"
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
}

/** Cluster mode is configured but this build cannot run it yet. The message names no URL. */
export class ClusterUnavailableError extends Error {
  constructor() {
    super("Cluster mode (HUB_DATABASE_URL and HUB_VALKEY_URL) is not yet available in this build; unset both to run a single-process hub")
    this.name = "ClusterUnavailableError"
  }
}

/**
 * State in Postgres, everything else in Valkey (design §9). Not yet available: throws ClusterUnavailableError
 * until the Postgres and Valkey implementations land.
 */
export function clusterBackends(_options: ClusterBackendsOptions): Backends {
  throw new ClusterUnavailableError()
}

/** The hub's bundle for its config: the cluster one when cluster mode is configured, else the file one. */
export function hubBackends(config: Pick<CentralConfig, "stateDir" | "cluster">, options: MemoryBackendsOptions = {}): Backends {
  return config.cluster ? clusterBackends({ ...options, cluster: config.cluster }) : fileBackends({ ...options, stateDir: config.stateDir })
}
