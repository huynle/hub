// The Store on shared backends (cluster mode, decision vkxkqiuf §3/§4): rows under user "_hub" in a StateStore,
// a per-pod cache kept current by store.changed on the Bus plus a TTL reload, async mutations with optimistic
// versions, and token lookups / security re-checks that go to the database. Two Store instances stand for two
// pods: by default on one shared memoryBackends() bundle; with HUB_IT_CLUSTER=1 also on real Postgres and Valkey
// (two PostgresStateStore pools on one database, two ValkeyBus instances), see test/cluster-it.ts.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { memoryBackends } from "../src/central/backend"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { PostgresStateStore } from "../src/central/backend/postgres-state"
import type { Bus, StateStore, Timers } from "../src/central/backend/types"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { HUB_ROWS, STORE_CHANGED_TOPIC, Store, type SharedStoreOptions } from "../src/central/store"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"

/** Timers whose callbacks run only when the test fires them (the TTL reload). */
class ManualTimers implements Timers {
  private readonly pending = new Map<number, () => void>()
  private next = 0
  set(fn: () => void): unknown {
    const id = ++this.next
    this.pending.set(id, fn)
    return id
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number)
  }
  /** Runs every pending callback once. */
  fire(): void {
    const fns = [...this.pending.values()]
    this.pending.clear()
    for (const fn of fns) fn()
  }
}

interface Pod {
  readonly store: Store
  readonly bus: Bus
  readonly timers: ManualTimers
  readonly state: StateStore
}

interface Pods {
  readonly a: Pod
  readonly b: Pod
  /** Waits until B has handled everything A published (and the other way round). */
  settle(): Promise<void>
}

interface Variant {
  readonly name: string
  /** `isolatedBus`: B never hears A's store.changed (a lost message, a Bus reconnect). */
  make(options?: { readonly isolatedBus?: boolean; readonly now?: () => number }): Promise<Pods>
}

const disposers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

function pod(state: StateStore, bus: Bus, instanceID: string, now?: () => number): Pod {
  const timers = new ManualTimers()
  const options: SharedStoreOptions = { state, bus, timers, instanceID, ...(now ? { now } : {}) }
  const store = Store.shared(options)
  disposers.push(() => store.close())
  return { store, bus, timers, state }
}

const memoryVariant: Variant = {
  name: "memory",
  async make(options = {}) {
    const backends = memoryBackends(options.now ? { now: options.now } : {})
    const busB = options.isolatedBus ? new MemoryBus() : backends.bus
    const a = pod(backends.state, backends.bus, "pod-a", options.now)
    const b = pod(backends.state, busB, "pod-b", options.now)
    await Promise.all([a.store.ready(), b.store.ready()])
    // The memory bus runs handlers before publish resolves.
    return { a, b, settle: async () => {} }
  },
}

const variants: Variant[] = [memoryVariant]

let cluster: ItCluster | undefined
if (itClusterEnabled() && (await dockerAvailable())) {
  const it = new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) })
  cluster = it
  await Promise.all([it.postgres(), it.valkey()])
  variants.push({
    name: "postgres+valkey",
    async make(options = {}) {
      const db = await it.freshDatabase()
      const valkey = await it.freshValkey()
      const stateA = new PostgresStateStore({ url: db, migrate: true, ...(options.now ? { now: options.now } : {}) })
      const stateB = new PostgresStateStore({ url: db, migrate: true, ...(options.now ? { now: options.now } : {}) })
      const busA = new ValkeyBus(valkey, { instanceID: "bus-a" })
      const busB = new ValkeyBus(valkey, { instanceID: "bus-b", ...(options.isolatedBus ? { prefix: "isolated:" } : {}) })
      disposers.push(async () => {
        busA.close()
        busB.close()
        await stateA.close()
        await stateB.close()
      })
      const a = pod(stateA, busA, "pod-a", options.now)
      const b = pod(stateB, busB, "pod-b", options.now)
      await Promise.all([a.store.ready(), b.store.ready()])
      return {
        a,
        b,
        settle: async () => {
          await busA.sync()
          await busB.sync()
        },
      }
    },
  })
}
afterAll(async () => {
  await cluster?.stop()
})

for (const variant of variants) {
  describe(`shared Store (${variant.name})`, () => {
    test("each pod sees the other's writes: users, machines, devices, settings, audit", async () => {
      const { a, b, settle } = await variant.make()
      const alice = await a.store.upsertUser({ email: "alice@example.test", role: "user" })
      const { machine, token: machineToken } = await a.store.addMachine("laptop", alice.id)
      const { device, token: deviceToken } = await a.store.addDevice("phone", alice.id)
      await a.store.setActingPaused(true)
      await a.store.audit({ actor: alice.id, action: "machine.enroll", target: machine.id })
      await settle()

      expect(b.store.user(alice.id)?.email).toBe("alice@example.test")
      expect(b.store.userByEmail("alice@example.test")?.id).toBe(alice.id)
      expect(b.store.machines().map((m) => m.id)).toEqual([machine.id])
      expect(b.store.devices().map((d) => d.id)).toEqual([device.id])
      expect(b.store.actingPaused()).toBe(true)
      expect(b.store.auditLog()).toEqual([expect.objectContaining({ action: "machine.enroll", target: machine.id })])
      expect((await b.store.findMachine(machineToken))?.id).toBe(machine.id)
      expect((await b.store.findDevice(deviceToken))?.id).toBe(device.id)

      // B's writes reach A the same way.
      await b.store.setPushPrefs(device.id, { turn: true })
      await b.store.markRead(alice.id, "ses_1", 5)
      await settle()
      expect(a.store.pushPrefs(device.id).turn).toBe(true)
      expect(a.store.reads(alice.id)).toEqual({ ses_1: 5 })
    })

    test("rows live under user _hub, token lookups go through token-hash index rows", async () => {
      const { a } = await variant.make()
      const { machine } = await a.store.addMachine("box")
      const { device } = await a.store.addDevice("phone")
      expect((await a.state.get(HUB_ROWS, "machines", machine.id))?.value).toMatchObject({ id: machine.id, name: "box" })
      expect((await a.state.get(HUB_ROWS, "machine-tokens", machine.tokenHash))?.value).toEqual({ id: machine.id })
      expect((await a.state.get(HUB_ROWS, "device-tokens", device.tokenHash))?.value).toEqual({ id: device.id })
    })

    test("archive mutations preserve concurrent writes across pods and remain idempotent", async () => {
      const { a, b, settle } = await variant.make()
      const user = await a.store.upsertUser({ email: "archive@example.test", role: "user" })
      await a.store.setViewPrefs(user.id, { pinnedSessions: ["ses_pinned"] })
      await settle()
      await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).store.setSessionArchived(user.id, `ses_${i}`, true)))
      expect(await a.store.setSessionArchived(user.id, "ses_0", true)).toEqual({ changed: false })
      await settle()
      for (const pod of [a, b]) {
        expect(pod.store.viewPrefs(user.id).hiddenSessions.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `ses_${i}`).sort())
        expect(pod.store.viewPrefs(user.id).pinnedSessions).toEqual(["ses_pinned"])
      }
      await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? b : a).store.setSessionArchived(user.id, `ses_${i}`, false)))
      await settle()
      expect(a.store.viewPrefs(user.id).hiddenSessions).toEqual([])
      expect(b.store.viewPrefs(user.id).hiddenSessions).toEqual([])
    })

    test("a token B has not cached yet (store.changed lost) is found in the database", async () => {
      const { a, b } = await variant.make({ isolatedBus: true })
      const { machine, token } = await a.store.addMachine("box")
      const { device, token: deviceToken } = await a.store.addDevice("phone")
      expect(b.store.machines()).toEqual([])
      expect((await b.store.findMachine(token))?.id).toBe(machine.id)
      expect((await b.store.findDevice(deviceToken))?.id).toBe(device.id)
      expect(await b.store.findMachine("not-a-token")).toBeUndefined()
      expect(await b.store.findDevice("")).toBeUndefined()
    })

    for (const isolatedBus of [false, true]) {
      const how = isolatedBus ? "even when store.changed is lost" : "through store.changed"
      test(`revoking a machine or removing a device on A rejects its token on B (${how})`, async () => {
        const { a, b, settle } = await variant.make({ isolatedBus })
        const { machine, token } = await a.store.addMachine("box")
        const { device, token: deviceToken } = await a.store.addDevice("phone")
        expect((await b.store.findMachine(token))?.id).toBe(machine.id)
        expect((await b.store.findDevice(deviceToken))?.id).toBe(device.id)

        expect(await a.store.revokeMachine(machine.id)).toBe(true)
        expect(await a.store.removeDevice(device.id)).toBe(true)
        await settle()
        expect(await b.store.findMachine(token)).toBeUndefined()
        expect(await b.store.findDevice(deviceToken)).toBeUndefined()
        expect(b.store.machines().find((m) => m.id === machine.id)?.revoked).toBe(true)
      })

      test(`epoch bumps and disabled users on A are seen by B's security re-check (${how})`, async () => {
        const { a, b, settle } = await variant.make({ isolatedBus })
        const alice = await a.store.upsertUser({ email: "alice@example.test", role: "user" })
        const { machine } = await a.store.addMachine("box", alice.id)
        await b.store.recheck({ users: [alice.id], machines: [machine.id] })
        expect(b.store.userEpoch(alice.id)).toBe(0)

        expect(await a.store.bumpUserEpoch(alice.id)).toBe(1)
        expect(await a.store.bumpMachineEpoch(machine.id)).toBe(1)
        await a.store.setUser(alice.id, { disabled: true })
        await settle()
        await b.store.recheck({ users: [alice.id], machines: [machine.id] })
        expect(b.store.userEpoch(alice.id)).toBe(1)
        expect(b.store.machineEpoch(machine.id)).toBe(1)
        expect(b.store.user(alice.id)?.disabled).toBe(true)
      })
    }

    test("concurrent updateAgentData on A and B converge (a version conflict retries on fresh data)", async () => {
      const { a, b, settle } = await variant.make({ isolatedBus: true })
      const alice = await a.store.upsertUser({ email: "alice@example.test", role: "user" })
      await b.store.recheck({ users: [alice.id] })
      const results = await Promise.all([
        a.store.updateAgentData(alice.id, (data) => {
          data.names = [...(data.names ?? []), { name: "api", sessionID: "ses_a" }]
        }),
        b.store.updateAgentData(alice.id, (data) => {
          data.names = [...(data.names ?? []), { name: "web", sessionID: "ses_b" }]
        }),
      ])
      await settle()
      const names = (data: { names?: { name: string }[] } | undefined) => (data?.names ?? []).map((n) => n.name).sort()
      expect(names(results[0]).length + names(results[1]).length).toBeGreaterThanOrEqual(3)
      await a.store.recheck({ users: [alice.id] })
      await b.store.recheck({ users: [alice.id] })
      expect(names(a.store.agentData(alice.id))).toEqual(["api", "web"])
      expect(names(b.store.agentData(alice.id))).toEqual(["api", "web"])
    })

    test("many concurrent updates from both pods all land", async () => {
      const { a, b } = await variant.make()
      const alice = await a.store.upsertUser({ email: "alice@example.test", role: "user" })
      await b.store.recheck({ users: [alice.id] })
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? a : b).store.updateAgentData(alice.id, (data) => {
            data.sessions = [...(data.sessions ?? []), { sessionID: `ses_${i}` }]
          }),
        ),
      )
      await a.store.recheck({ users: [alice.id] })
      expect(a.store.agentData(alice.id).sessions?.length).toBe(10)
    })

    test("VAPID keys: concurrent first writes agree on one pair (ifVersion 0, then re-read)", async () => {
      const { a, b, settle } = await variant.make({ isolatedBus: true })
      const [ka, kb] = await Promise.all([
        a.store.setVapid({ publicKey: "pubA", privateKey: "privA" }),
        b.store.setVapid({ publicKey: "pubB", privateKey: "privB" }),
      ])
      await settle()
      expect(ka).toEqual(kb)
      expect(a.store.vapid()).toEqual(ka)
      expect(b.store.vapid()).toEqual(ka)
      // Later calls keep the stored pair.
      expect(await a.store.setVapid({ publicKey: "pubC", privateKey: "privC" })).toEqual(ka)
    })

    test("concurrent sign-ins of one email on two pods make one user", async () => {
      const { a, b } = await variant.make({ isolatedBus: true })
      const [ua, ub] = await Promise.all([
        a.store.upsertUser({ email: "Bob@example.test", role: "user" }),
        b.store.upsertUser({ email: "bob@example.test", name: "Bob", role: "user" }),
      ])
      expect(ua.id).toBe(ub.id)
      expect((await a.state.list(HUB_ROWS, "users")).filter((row) => (row.value as { email?: string }).email === "bob@example.test")).toHaveLength(1)
    })

    test("the cache reloads after the TTL when store.changed was lost", async () => {
      const { a, b } = await variant.make({ isolatedBus: true })
      const alice = await a.store.upsertUser({ email: "alice@example.test", role: "user" })
      await a.store.setSpeechSettings({ voice: "nova" } as never)
      expect(b.store.user(alice.id)).toBeUndefined()
      b.timers.fire()
      await b.store.ready()
      await Bun.sleep(0)
      for (let i = 0; i < 50 && !b.store.user(alice.id); i++) await Bun.sleep(10)
      expect(b.store.user(alice.id)?.email).toBe("alice@example.test")
      expect(b.store.speechSettings()).toEqual({ voice: "nova" } as never)
    })

    test("store.changed from a pod names rows and versions, never values", async () => {
      const { a } = await variant.make()
      const seen: unknown[] = []
      await a.bus.subscribe(STORE_CHANGED_TOPIC, (message) => void seen.push(message))
      const { token } = await a.store.addDevice("phone")
      await (a.bus as { sync?: () => Promise<void> }).sync?.()
      expect(seen.length).toBeGreaterThan(0)
      expect(JSON.stringify(seen)).not.toContain(token)
      expect(seen[0]).toMatchObject({ from: "pod-a", rows: expect.arrayContaining([["devices", expect.any(String), 1]]) })
    })

    test("removing a device removes its push subscriptions and token index row", async () => {
      const { a, b, settle } = await variant.make()
      const { device } = await a.store.addDevice("phone")
      await a.store.addPushSubscription(device.id, { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } })
      await settle()
      expect(b.store.pushSubscriptions()).toHaveLength(1)
      await a.store.removeDevice(device.id)
      await settle()
      expect(b.store.pushSubscriptions()).toEqual([])
      expect(await a.state.get(HUB_ROWS, "device-tokens", device.tokenHash)).toBeUndefined()
    })

    test("audit keeps the newest AUDIT_LIMIT entries across pods", async () => {
      const { a, b, settle } = await variant.make()
      for (let i = 0; i < 5; i++) await (i % 2 ? a : b).store.audit({ actor: "system", action: `a${i}` })
      await settle()
      expect(a.store.auditLog().map((e) => e.action)).toEqual(["a4", "a3", "a2", "a1", "a0"])
      expect(b.store.auditLog().map((e) => e.action)).toEqual(["a4", "a3", "a2", "a1", "a0"])
    })

    test("audit entries written one after another on two pods keep that order, even in the same millisecond and with store.changed lost", async () => {
      // Regression: each pod keyed its entry after the newest key in its own cache; when the other pod's entry had
      // not reached it yet (the Bus is asynchronous or lost the message) and the clock tied, the random key suffix
      // decided the order.
      const { a, b } = await variant.make({ isolatedBus: true, now: () => 1_000 })
      const actions = Array.from({ length: 12 }, (_, i) => `a${i}`)
      for (const [i, action] of actions.entries()) await (i % 2 ? a : b).store.audit({ actor: "system", action })
      const stored = (await a.state.list<{ action: string }>(HUB_ROWS, "audit")).map((row) => row.value.action)
      expect(stored).toEqual(actions)
      for (const pod of [a, b]) {
        pod.timers.fire()
        for (let i = 0; i < 50 && pod.store.auditLog().length < actions.length; i++) await Bun.sleep(10)
        expect(pod.store.auditLog().map((e) => e.action)).toEqual([...actions].reverse())
      }
    })
  })
}

describe("shared Store lifecycle", () => {
  test("nothing touches the backends before ready(); close() stops listening", async () => {
    const backends = memoryBackends()
    let calls = 0
    const counting = new Proxy(backends.state, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === "function" ? (...args: unknown[]) => (calls++, value.apply(target, args)) : value
      },
    })
    const store = Store.shared({ state: counting, bus: backends.bus, timers: new ManualTimers(), instanceID: "pod-a" })
    expect(calls).toBe(0)
    await store.ready()
    expect(calls).toBeGreaterThan(0)
    await store.close()
    expect(await backends.bus.publish(STORE_CHANGED_TOPIC, { from: "x", rows: [] })).toBe(0)
  })

  test("mutations wait for the first load", async () => {
    const backends = memoryBackends()
    const a = Store.shared({ state: backends.state, bus: backends.bus, timers: new ManualTimers(), instanceID: "pod-a" })
    const alice = await a.upsertUser({ email: "alice@example.test", role: "user" })
    const b = Store.shared({ state: backends.state, bus: backends.bus, timers: new ManualTimers(), instanceID: "pod-b" })
    await b.setUser(alice.id, { role: "admin" })
    expect(b.user(alice.id)?.role).toBe("admin")
    await a.close()
    await b.close()
  })
})
