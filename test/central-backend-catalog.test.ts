// Backend Catalog contract: per-user session reports keyed by (sessionID, connID), merged on read, run against
// every implementation in test/backend-impls.ts.
import { describe, expect, test } from "bun:test"
import { implementations } from "./backend-impls"

for (const impl of implementations("catalog")) {
  describe(impl.name, () => {
    test.skipIf(!impl.supports("clock"))("one connection's report reads back as the session", async () => {
      let t = 10
      const catalog = await impl.make({ now: () => t })
      expect(await catalog.get("alice", "ses_1")).toBeUndefined()
      await catalog.set("alice", "ses_1", "conn_a", { state: "working", title: "Fix" })
      expect(await catalog.get("alice", "ses_1")).toEqual({ sessionID: "ses_1", value: { state: "working", title: "Fix" }, connIDs: ["conn_a"], at: 10 })
    })

    test.skipIf(!impl.supports("clock"))("reports from several connections merge: the newest report wins per field", async () => {
      let t = 10
      const catalog = await impl.make({ now: () => t })
      await catalog.set("alice", "ses_1", "conn_tui", { state: "idle", title: "Fix", open: true })
      t = 20
      await catalog.set("alice", "ses_1", "conn_serve", { state: "working", title: "Fix bug" })
      expect(await catalog.get("alice", "ses_1")).toEqual({
        sessionID: "ses_1",
        value: { state: "working", title: "Fix bug", open: true },
        connIDs: ["conn_tui", "conn_serve"],
        at: 20,
      })
      t = 30
      await catalog.set("alice", "ses_1", "conn_tui", { state: "blocked" })
      expect(await catalog.get("alice", "ses_1")).toMatchObject({ value: { state: "blocked", title: "Fix bug" }, connIDs: ["conn_serve", "conn_tui"], at: 30 })
      expect((await catalog.entries("alice")).map((e) => [e.sessionID, e.connID, e.at])).toEqual([
        ["ses_1", "conn_serve", 20],
        ["ses_1", "conn_tui", 30],
      ])
    })

    test.skipIf(!impl.supports("clock", "options"))("a custom merge decides how reports combine", async () => {
      let t = 0
      const catalog = await impl.make({ now: () => t, merge: (entries) => ({ count: entries.length, conns: entries.map((e) => e.connID).join(",") }) })
      await catalog.set("alice", "s", "a", {})
      t = 1
      await catalog.set("alice", "s", "b", {})
      expect((await catalog.get("alice", "s"))!.value).toEqual({ count: 2, conns: "a,b" })
    })

    test("list gives the user's merged sessions by id; users are isolated", async () => {
      const catalog = await impl.make({ now: () => 0 })
      await catalog.set("alice", "ses_b", "c1", { n: 1 })
      await catalog.set("alice", "ses_a", "c1", { n: 2 })
      await catalog.set("alice", "ses_a", "c2", { m: 3 })
      await catalog.set("bob", "ses_z", "c9", { secret: true })
      const list = await catalog.list("alice")
      expect(list.map((s) => [s.sessionID, s.value])).toEqual([
        ["ses_a", { n: 2, m: 3 }],
        ["ses_b", { n: 1 }],
      ])
      expect(JSON.stringify(list)).not.toContain("secret")
      expect(await catalog.list("carol")).toEqual([])
    })

    test("delete one connection's report, every report of a session, or everything a connection reported", async () => {
      const catalog = await impl.make({ now: () => 0 })
      await catalog.set("alice", "s1", "c1", { a: 1 })
      await catalog.set("alice", "s1", "c2", { b: 2 })
      await catalog.set("alice", "s2", "c1", { c: 3 })
      await catalog.set("alice", "s3", "c2", { d: 4 })
      await catalog.delete("alice", "s1", "c1")
      expect(await catalog.get("alice", "s1")).toMatchObject({ value: { b: 2 }, connIDs: ["c2"] })
      await catalog.deleteConn("alice", "c1")
      expect(await catalog.get("alice", "s2")).toBeUndefined()
      await catalog.delete("alice", "s1")
      expect((await catalog.list("alice")).map((s) => s.sessionID)).toEqual(["s3"])
    })

    test.skipIf(!impl.supports("timeTravel"))("a report with a ttl expires (its process went away without saying so)", async () => {
      let t = 0
      const catalog = await impl.make({ now: () => t })
      await catalog.set("alice", "s", "pod_a_conn", { state: "working" }, { ttlMs: 1000 })
      await catalog.set("alice", "s", "pod_b_conn", { title: "T" })
      t = 999
      expect((await catalog.get("alice", "s"))!.connIDs).toEqual(["pod_a_conn", "pod_b_conn"])
      t = 1000
      expect(await catalog.get("alice", "s")).toMatchObject({ value: { title: "T" }, connIDs: ["pod_b_conn"] })
      await catalog.delete("alice", "s", "pod_b_conn")
      expect(await catalog.list("alice")).toEqual([])
    })

    test("values are copied in and out", async () => {
      const catalog = await impl.make({ now: () => 0 })
      const value = { tags: ["x"] }
      await catalog.set("alice", "s", "c", value)
      value.tags.push("mutated")
      ;((await catalog.get("alice", "s"))!.value.tags as string[]).push("again")
      expect((await catalog.get("alice", "s"))!.value).toEqual({ tags: ["x"] })
    })
  })
}
