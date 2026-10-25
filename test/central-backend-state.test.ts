// Backend StateStore contract (per-user versioned entries and unique claims), run against every
// implementation: in memory, and in files under a temporary state directory.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileStateStore } from "../src/central/backend/file-state"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import type { Clock, StateStore } from "../src/central/backend/types"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const implementations: [string, (options?: { now?: Clock }) => StateStore][] = [
  ["MemoryStateStore", (options) => new MemoryStateStore(options)],
  [
    "FileStateStore",
    (options) => {
      const stateDir = mkdtempSync(path.join(tmpdir(), "hub-file-state-"))
      dirs.push(stateDir)
      return new FileStateStore({ stateDir, ...options })
    },
  ],
]

for (const [name, make] of implementations) {
  describe(`${name} entries`, () => {
    test("put then get returns the value with version 1; later puts bump the version", async () => {
      const state = make()
      expect(await state.get("alice", "agents", "a1")).toBeUndefined()
      expect(await state.put("alice", "agents", "a1", { name: "scout" })).toEqual({ ok: true, version: 1 })
      expect(await state.get("alice", "agents", "a1")).toEqual({ value: { name: "scout" }, version: 1 })
      expect(await state.put("alice", "agents", "a1", { name: "scout2" })).toEqual({ ok: true, version: 2 })
      expect(await state.get("alice", "agents", "a1")).toEqual({ value: { name: "scout2" }, version: 2 })
    })

    test("users and collections are isolated", async () => {
      const state = make()
      await state.put("alice", "agents", "a1", 1)
      await state.put("bob", "agents", "a1", 2)
      await state.put("alice", "roles", "a1", 3)
      expect((await state.get("alice", "agents", "a1"))!.value).toBe(1)
      expect((await state.get("bob", "agents", "a1"))!.value).toBe(2)
      expect((await state.get("alice", "roles", "a1"))!.value).toBe(3)
      expect(await state.list("carol", "agents")).toEqual([])
    })

    test("ifVersion: a stale write is refused with the current version; 0 means create only", async () => {
      const state = make()
      expect(await state.put("alice", "c", "k", "a", { ifVersion: 0 })).toEqual({ ok: true, version: 1 })
      expect(await state.put("alice", "c", "k", "b", { ifVersion: 0 })).toEqual({ ok: false, version: 1 })
      expect(await state.put("alice", "c", "k", "b", { ifVersion: 1 })).toEqual({ ok: true, version: 2 })
      expect(await state.put("alice", "c", "k", "c", { ifVersion: 1 })).toEqual({ ok: false, version: 2 })
      expect((await state.get("alice", "c", "k"))!.value).toBe("b")
      expect(await state.put("alice", "c", "new", "x", { ifVersion: 3 })).toEqual({ ok: false, version: 0 })
    })

    test("delete removes; with ifVersion only at that version; a deleted key starts over at version 1", async () => {
      const state = make()
      await state.put("alice", "c", "k", "a")
      expect(await state.delete("alice", "c", "k", { ifVersion: 7 })).toEqual({ ok: false, version: 1 })
      expect(await state.delete("alice", "c", "k", { ifVersion: 1 })).toEqual({ ok: true, version: 0 })
      expect(await state.get("alice", "c", "k")).toBeUndefined()
      expect(await state.delete("alice", "c", "k")).toEqual({ ok: true, version: 0 })
      expect(await state.put("alice", "c", "k", "b")).toEqual({ ok: true, version: 1 })
    })

    test("list returns the collection's entries sorted by key", async () => {
      const state = make()
      await state.put("alice", "c", "b", 2)
      await state.put("alice", "c", "a", 1)
      await state.put("alice", "c", "a", 11)
      expect(await state.list("alice", "c")).toEqual([
        { key: "a", value: 11, version: 2 },
        { key: "b", value: 2, version: 1 },
      ])
    })

    test("values are copied: mutating what was put or read does not change the store", async () => {
      const state = make()
      const value = { tags: ["x"] }
      await state.put("alice", "c", "k", value)
      value.tags.push("mutated")
      const read = (await state.get<{ tags: string[] }>("alice", "c", "k"))!
      read.value.tags.push("again")
      expect((await state.get("alice", "c", "k"))!.value).toEqual({ tags: ["x"] })
    })
  })

  describe(`${name} claims`, () => {
    test("a claim is unique per namespace: a second owner gets the conflict", async () => {
      let t = 100
      const state = make({ now: () => t })
      expect(await state.claim("alice:names", "scout", "agent_1")).toEqual({ ok: true, claim: { namespace: "alice:names", key: "scout", owner: "agent_1", at: 100 } })
      t = 200
      expect(await state.claim("alice:names", "scout", "agent_2")).toEqual({ ok: false, conflict: { namespace: "alice:names", key: "scout", owner: "agent_1", at: 100 } })
      expect((await state.claim("bob:names", "scout", "agent_2")).ok).toBe(true)
      expect((await state.claim("alice:names", "other", "agent_2")).ok).toBe(true)
    })

    test("claiming again for the same owner is ok and keeps the original claim", async () => {
      let t = 1
      const state = make({ now: () => t })
      await state.claim("ns", "k", "o")
      t = 5
      expect(await state.claim("ns", "k", "o")).toEqual({ ok: true, claim: { namespace: "ns", key: "k", owner: "o", at: 1 } })
    })

    test("only the owner releases; after a release someone else can claim", async () => {
      const state = make({ now: () => 0 })
      await state.claim("ns", "k", "o1")
      expect(await state.release("ns", "k", "o2")).toBe(false)
      expect((await state.claimOf("ns", "k"))!.owner).toBe("o1")
      expect(await state.release("ns", "k", "o1")).toBe(true)
      expect(await state.claimOf("ns", "k")).toBeUndefined()
      expect(await state.release("ns", "k", "o1")).toBe(false)
      expect((await state.claim("ns", "k", "o2")).ok).toBe(true)
    })

    test("concurrent claims for one key: exactly one wins", async () => {
      const state = make()
      const results = await Promise.all(["a", "b", "c", "d"].map((owner) => state.claim("ns", "k", owner)))
      expect(results.filter((r) => r.ok).length).toBe(1)
      const winner = results.find((r) => r.ok)!
      for (const r of results) if (!r.ok) expect(r.conflict.owner).toBe(winner.ok ? winner.claim.owner : "")
    })
  })
}
