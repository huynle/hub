// The hub's backends (design §9): interfaces in ./types, in-memory implementations for the single-process hub,
// and a file StateStore under <stateDir>/agent. startCentral creates the file bundle (or takes one in its
// options), exposes it to new code only, and flushes its state on stop.
import { FileStateStore, type FileStateStoreOptions } from "./file-state"
import { MemoryBus } from "./memory-bus"
import { MemoryCatalog } from "./memory-catalog"
import { MemoryCounters, MemoryLocks } from "./memory-counters"
import { MemoryEventLog } from "./memory-events"
import { MemoryStateStore } from "./memory-state"
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
