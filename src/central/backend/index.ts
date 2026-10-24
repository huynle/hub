// The hub's backends (design §9): interfaces in ./types, in-memory implementations for the single-process hub.
// startCentral creates the bundle (or takes one in its options) and exposes it to new code only.
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
