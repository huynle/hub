// The connection directory (decision vkxkqiuf §5, design §9): connID → the pod holding it, in the shared Kv
// (dir:<connID>, 45 s TTL refreshed by a 15 s heartbeat), removed when the connection closes; a pod's own
// liveness key (pod:<podID>) lets lookups sweep the entries of a pod that died without cleaning up.
import { afterAll, describe, expect, test } from "bun:test"
import { MemoryKv } from "../src/central/backend/memory-kv"
import type { Kv, Timers } from "../src/central/backend/types"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { ConnDirectory, DIRECTORY_HEARTBEAT_MS, DIRECTORY_TTL_MS } from "../src/central/cluster/directory"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"

/** Timers whose callbacks run only when the test fires them. */
class ManualTimers implements Timers {
  readonly pending = new Map<number, { fn: () => void; ms: number }>()
  private next = 0
  set(fn: () => void, ms: number): unknown {
    const id = ++this.next
    this.pending.set(id, { fn, ms })
    return id
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number)
  }
  fire(): void {
    const due = [...this.pending.values()]
    this.pending.clear()
    for (const { fn } of due) fn()
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Variant {
  readonly name: string
  /** A Kv on a clock the test moves (memory) or real time (valkey: expiry not tested). */
  make(): Promise<{ kv: Kv; advance?: (ms: number) => void; dispose(): Promise<void> }>
}

const variants: Variant[] = [
  {
    name: "memory",
    async make() {
      let t = 1_000_000
      const kv = new MemoryKv({ now: () => t })
      return { kv, advance: (ms) => void (t += ms), dispose: async () => {} }
    },
  },
]

let cluster: ItCluster | undefined
if (itClusterEnabled() && (await dockerAvailable())) {
  const it = new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) })
  cluster = it
  await it.valkey()
  variants.push({
    name: "valkey",
    async make() {
      const kv = new ValkeyKv(await it.freshValkey())
      return { kv, dispose: async () => kv.close() }
    },
  })
}
afterAll(async () => {
  await cluster?.stop()
})

test("the directory heartbeats every 15 s and entries live 45 s", () => {
  expect(DIRECTORY_HEARTBEAT_MS).toBe(15_000)
  expect(DIRECTORY_TTL_MS).toBe(45_000)
})

for (const variant of variants) {
  describe(`ConnDirectory (${variant.name})`, () => {
    test("a registered connection is found from another pod; unregister removes it", async () => {
      const { kv, dispose } = await variant.make()
      const a = new ConnDirectory({ kv, podID: "pod-a", timers: new ManualTimers() })
      const b = new ConnDirectory({ kv, podID: "pod-b", timers: new ManualTimers() })
      try {
        await a.start()
        await b.start()
        await a.register("conn_1", "mch_1")
        expect(await b.lookup("conn_1")).toEqual({ pod: "pod-a", machineID: "mch_1" })
        expect(a.local()).toEqual(["conn_1"])
        await a.unregister("conn_1")
        expect(await b.lookup("conn_1")).toBeUndefined()
        expect(a.local()).toEqual([])
      } finally {
        await a.stop()
        await b.stop()
        await dispose()
      }
    })

    test("an entry of a pod that is not alive is swept on lookup", async () => {
      const { kv, dispose } = await variant.make()
      const b = new ConnDirectory({ kv, podID: "pod-b", timers: new ManualTimers() })
      try {
        await b.start()
        await kv.set("dir:conn_dead", JSON.stringify({ pod: "pod-gone", machineID: "mch_1" }), { px: DIRECTORY_TTL_MS })
        expect(await b.podAlive("pod-gone")).toBe(false)
        expect(await b.lookup("conn_dead")).toBeUndefined()
        expect(await kv.get("dir:conn_dead")).toBeUndefined()
      } finally {
        await b.stop()
        await dispose()
      }
    })

    test("forget drops an entry only while it still names that pod", async () => {
      const { kv, dispose } = await variant.make()
      const a = new ConnDirectory({ kv, podID: "pod-a", timers: new ManualTimers() })
      const b = new ConnDirectory({ kv, podID: "pod-b", timers: new ManualTimers() })
      try {
        await a.start()
        await b.start()
        await a.register("conn_1", "mch_1")
        await b.forget("conn_1", "pod-x")
        expect(await b.lookup("conn_1")).toEqual({ pod: "pod-a", machineID: "mch_1" })
        await b.forget("conn_1", "pod-a")
        expect(await b.lookup("conn_1")).toBeUndefined()
      } finally {
        await a.stop()
        await b.stop()
        await dispose()
      }
    })

    test("stop removes the pod's entries and its liveness key", async () => {
      const { kv, dispose } = await variant.make()
      const a = new ConnDirectory({ kv, podID: "pod-a", timers: new ManualTimers() })
      const b = new ConnDirectory({ kv, podID: "pod-b", timers: new ManualTimers() })
      try {
        await a.start()
        await b.start()
        await a.register("conn_1", "mch_1")
        expect(await b.podAlive("pod-a")).toBe(true)
        await a.stop()
        expect(await b.podAlive("pod-a")).toBe(false)
        expect(await kv.get("dir:conn_1")).toBeUndefined()
      } finally {
        await b.stop()
        await dispose()
      }
    })

    test("a malformed entry reads as no entry", async () => {
      const { kv, dispose } = await variant.make()
      const b = new ConnDirectory({ kv, podID: "pod-b", timers: new ManualTimers() })
      try {
        await kv.set("dir:conn_bad", "not json", { px: 1000 })
        expect(await b.lookup("conn_bad")).toBeUndefined()
      } finally {
        await dispose()
      }
    })

    if (variant.name === "memory") {
      test("the heartbeat keeps entries and the pod alive past the TTL; without it they expire", async () => {
        const { kv, advance, dispose } = await variant.make()
        const timers = new ManualTimers()
        const a = new ConnDirectory({ kv, podID: "pod-a", timers })
        const b = new ConnDirectory({ kv, podID: "pod-b", timers: new ManualTimers() })
        try {
          await a.start()
          await a.register("conn_1", "mch_1")
          expect([...timers.pending.values()].map((t) => t.ms)).toEqual([DIRECTORY_HEARTBEAT_MS])
          for (let i = 0; i < 4; i++) {
            advance!(DIRECTORY_HEARTBEAT_MS)
            timers.fire()
            await settle()
            await settle()
          }
          expect(await b.lookup("conn_1")).toEqual({ pod: "pod-a", machineID: "mch_1" })
          expect(timers.pending.size).toBe(1)
          // The pod dies: no more heartbeats.
          timers.pending.clear()
          advance!(DIRECTORY_TTL_MS + 1)
          expect(await b.podAlive("pod-a")).toBe(false)
          expect(await b.lookup("conn_1")).toBeUndefined()
        } finally {
          await dispose()
        }
      })
    }
  })
}
