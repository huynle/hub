// Leader loops (design §9, decision vkxkqiuf §7): a timed job runs on one pod at a time under a fenced lease in the
// shared Locks (leader:<name>). The leader renews it every renewMs; a pod that loses it (expired, taken) stops its
// job; the others try to take it on every tick and at once when the leader releases it (stop). Kicks reach only the
// leader; requests go to the leader wherever it runs. Memory backends by default; with HUB_IT_CLUSTER=1 also Valkey
// locks and bus.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { MemoryLocks } from "../src/central/backend/memory-counters"
import type { Bus, Lease, Locks, Timers } from "../src/central/backend/types"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { ValkeyLocks } from "../src/central/backend/valkey-locks"
import { LeaderLoop, NoLeaderError, type LeaderLoopOptions } from "../src/central/cluster/leader"
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

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 2))
}

interface Variant {
  readonly name: string
  /** Shared locks and bus; `advance` moves the locks' clock (memory only: Valkey expires in real time). */
  make(): Promise<{ locks: Locks; bus: () => Bus; now?: () => number; advance?: (ms: number) => void; dispose(): Promise<void> }>
}

const variants: Variant[] = [
  {
    name: "memory",
    async make() {
      let t = 1_000_000
      const locks = new MemoryLocks({ now: () => t })
      const bus = new MemoryBus()
      return { locks, bus: () => bus, now: () => t, advance: (ms) => void (t += ms), dispose: async () => {} }
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
      const url = await it.freshValkey()
      const locks = new ValkeyLocks(url)
      const buses: ValkeyBus[] = []
      return {
        locks,
        bus: () => {
          const bus = new ValkeyBus(url, { instanceID: `leader-${buses.length}` })
          buses.push(bus)
          return bus
        },
        dispose: async () => {
          for (const bus of buses) bus.close()
          await locks.close()
        },
      }
    },
  })
}
afterAll(async () => {
  await cluster?.stop()
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Pod {
  readonly loop: LeaderLoop
  readonly timers: ManualTimers
  readonly events: string[]
  readonly kicks: unknown[]
}

for (const variant of variants) {
  describe(`leader loop (${variant.name})`, () => {
    async function setup() {
      const backends = await variant.make()
      cleanups.push(() => backends.dispose())
      const pod = (owner: string, extra: Partial<LeaderLoopOptions> = {}): Pod => {
        const timers = new ManualTimers()
        const events: string[] = []
        const kicks: unknown[] = []
        const loop = new LeaderLoop({
          locks: backends.locks,
          bus: backends.bus(),
          name: "job",
          owner,
          ttlMs: 3000,
          renewMs: 1000,
          timers,
          ...(backends.now ? { now: backends.now } : {}),
          onElected: (lease: Lease) => void events.push(`elected:${lease.fence}`),
          onDeposed: () => void events.push("deposed"),
          onKick: (message) => void kicks.push(message),
          onRequest: (message) => ({ from: owner, echo: message }),
          ...extra,
        })
        cleanups.push(() => loop.stop())
        return { loop, timers, events, kicks }
      }
      return { ...backends, pod }
    }

    test("a single pod is the leader at once and runs its job once", async () => {
      const { pod } = await setup()
      const a = pod("pod-a")
      await a.loop.start()
      expect(a.loop.isLeader()).toBe(true)
      expect(a.events).toEqual([expect.stringMatching(/^elected:\d+$/)])
      a.timers.fire()
      await settle()
      // Renewing does not elect it again.
      expect(a.events).toHaveLength(1)
      expect(a.loop.isLeader()).toBe(true)
    })

    test("of two pods exactly one leads; the other takes over at once when it stops", async () => {
      const { pod } = await setup()
      const a = pod("pod-a")
      const b = pod("pod-b")
      await a.loop.start()
      await b.loop.start()
      expect(a.loop.isLeader()).toBe(true)
      expect(b.loop.isLeader()).toBe(false)
      b.timers.fire()
      await settle()
      expect(b.loop.isLeader()).toBe(false)
      await a.loop.stop()
      expect(a.events.at(-1)).toBe("deposed")
      expect(a.loop.isLeader()).toBe(false)
      // The release notice: B tries at once (no tick needed).
      await settle()
      expect(b.loop.isLeader()).toBe(true)
      const fenceA = Number(a.events[0]!.split(":")[1])
      const fenceB = Number(b.events[0]!.split(":")[1])
      expect(fenceB).toBeGreaterThan(fenceA)
    })

    test("kicks reach the leader only; requests go to the leader from any pod", async () => {
      const { pod } = await setup()
      const a = pod("pod-a")
      const b = pod("pod-b")
      await a.loop.start()
      await b.loop.start()
      await b.loop.kick({ user: "u1" })
      await settle()
      expect(a.kicks).toEqual([{ user: "u1" }])
      expect(b.kicks).toEqual([])
      expect(await b.loop.request<object>({ q: 1 }, { timeoutMs: 2000 })).toEqual({ from: "pod-a", echo: { q: 1 } })
      expect(await a.loop.request<object>({ q: 2 }, { timeoutMs: 2000 })).toEqual({ from: "pod-a", echo: { q: 2 } })
      await a.loop.stop()
      await b.loop.stop()
      await expect(b.loop.request({ q: 3 }, { timeoutMs: 2000 })).rejects.toBeInstanceOf(NoLeaderError)
    })

    test("a leader that dies without releasing is replaced once its lease expires", async () => {
      const { pod, advance } = await setup()
      if (!advance) return
      const a = pod("pod-a")
      const b = pod("pod-b")
      await a.loop.start()
      await b.loop.start()
      // A dies: its timers never fire again. Within the TTL B keeps trying in vain.
      advance(2000)
      b.timers.fire()
      await settle()
      expect(b.loop.isLeader()).toBe(false)
      advance(1500)
      b.timers.fire()
      await settle()
      expect(b.loop.isLeader()).toBe(true)
      expect(b.events).toEqual([expect.stringMatching(/^elected:\d+$/)])
    })

    test("a leader whose lease was lost steps down on its next renewal", async () => {
      const { pod, advance, locks } = await setup()
      if (!advance) return
      const a = pod("pod-a")
      await a.loop.start()
      advance(3500)
      // Someone else took the expired lease meanwhile.
      expect(await locks.acquire("leader:job", "pod-x", 3000)).toBeDefined()
      a.timers.fire()
      await settle()
      expect(a.loop.isLeader()).toBe(false)
      expect(a.events.at(-1)).toBe("deposed")
    })

    test("a renewal that fails with an error steps down before the lease could expire", async () => {
      const { pod, advance, locks } = await setup()
      if (!advance) return
      let broken = false
      const flaky: Locks = {
        acquire: (...args) => locks.acquire(...args),
        renew: (...args) => (broken ? Promise.reject(new Error("valkey down")) : locks.renew(...args)),
        release: (...args) => locks.release(...args),
        holder: (...args) => locks.holder(...args),
      }
      const a = pod("pod-a", { locks: flaky, onError: () => {} })
      await a.loop.start()
      broken = true
      advance(1000)
      a.timers.fire()
      await settle()
      // 2 s left: one more failed renewal could still be fine.
      expect(a.loop.isLeader()).toBe(true)
      advance(1000)
      a.timers.fire()
      await settle()
      // 1 s left (one renew interval): it steps down rather than risk running past its lease.
      expect(a.loop.isLeader()).toBe(false)
      expect(a.events.at(-1)).toBe("deposed")
    })
  })
}
