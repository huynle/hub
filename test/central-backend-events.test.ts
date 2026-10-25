// Backend EventLog contract: per-user replay with count and age bounds; gaps it cannot cover ask for a resync.
// Run against every implementation in test/backend-impls.ts; these tests rely on the memory log's options
// (epoch, max, maxAgeMs) and id format.
import { describe, expect, test } from "bun:test"
import { implementations } from "./backend-impls"
import { EVENT_LOG_AGE_MS, EVENT_LOG_MAX } from "../src/central/events-log"

for (const impl of implementations("events")) {
  describe(impl.name, () => {
    test.skipIf(!impl.supports("clock", "options"))("ids increase per user; since returns the events after an id, oldest first", async () => {
      const log = await impl.make({ epoch: "e1", now: () => 7 })
      const a1 = await log.append("alice", { type: "status", n: 1 })
      await log.append("bob", { type: "status", n: 9 })
      const a2 = await log.append("alice", { type: "status", n: 2 }, { exceptDevice: "dev_1" })
      expect([a1, a2]).toEqual(["e1.1", "e1.2"])
      expect(await log.latest("alice")).toBe("e1.2")
      expect(await log.since("alice", a1)).toEqual({ events: [{ id: "e1.2", message: { type: "status", n: 2 }, exceptDevice: "dev_1", at: 7 }] })
      expect(await log.since("alice", a2)).toEqual({ events: [] })
      expect(await log.since("bob", "e1.0")).toEqual({ events: [{ id: "e1.1", message: { type: "status", n: 9 }, at: 7 }] })
    })

    test.skipIf(!impl.supports("options"))("a client that read latest before any event is covered (not resynced)", async () => {
      const log = await impl.make({ epoch: "e1" })
      const id = await log.latest("carol")
      expect(id).toBe("e1.0")
      expect(await log.since("carol", id)).toEqual({ events: [] })
      await log.append("carol", { type: "status" })
      expect(await log.since("carol", id)).toMatchObject({ events: [{ id: "e1.1" }] })
    })

    test.skipIf(!impl.supports("options"))("resync for another epoch, a future id, an unknown user or garbage", async () => {
      const log = await impl.make({ epoch: "e1" })
      await log.append("alice", { type: "status" })
      expect(await log.since("alice", "e0.1")).toEqual({ resync: true })
      expect(await log.since("alice", "e1.7")).toEqual({ resync: true })
      expect(await log.since("dave", "e1.0")).toEqual({ resync: true })
      expect(await log.since("alice", "nonsense")).toEqual({ resync: true })
    })

    test.skipIf(!impl.supports("options"))("bounded by count: a gap older than `max` events asks for a resync", async () => {
      const log = await impl.make({ epoch: "e", max: 3 })
      for (let i = 0; i < 5; i++) await log.append("alice", { type: "status", i })
      expect(await log.since("alice", "e.1")).toEqual({ resync: true })
      const result = await log.since("alice", "e.2")
      expect("events" in result && result.events.map((e) => e.message.i)).toEqual([2, 3, 4])
    })

    test.skipIf(!impl.supports("timeTravel", "options"))("bounded by age: a gap reaching past dropped events asks for a resync", async () => {
      let t = 0
      const log = await impl.make({ epoch: "e", maxAgeMs: 1000, now: () => t })
      await log.append("alice", { type: "status", i: 0 })
      t = 500
      await log.append("alice", { type: "status", i: 1 })
      t = 1200
      expect(await log.since("alice", "e.0")).toEqual({ resync: true })
      expect(await log.since("alice", "e.1")).toMatchObject({ events: [{ message: { i: 1 } }] })
    })

    test.skipIf(!impl.supports("timeTravel", "options"))("defaults mirror the live-stream log's bounds, and each instance has its own epoch", async () => {
      let t = 0
      const log = await impl.make({ now: () => t })
      for (let i = 0; i <= EVENT_LOG_MAX; i++) await log.append("alice", { type: "status" })
      const epoch = (await log.latest("alice")).split(".")[0]
      expect(await log.since("alice", `${epoch}.0`)).toEqual({ resync: true })
      expect(await log.since("alice", `${epoch}.1`)).toMatchObject({ events: { length: EVENT_LOG_MAX } })
      t = EVENT_LOG_AGE_MS + 1
      expect(await log.since("alice", `${epoch}.1`)).toEqual({ resync: true })
      const other = await impl.make({ now: () => t })
      expect(await other.latest("alice")).not.toBe(await log.latest("alice"))
    })
  })
}
