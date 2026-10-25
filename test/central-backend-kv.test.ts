// Backend Kv contract: string values with optional expiry (PX) and set-if-absent (NX), get, getdel and del,
// run against every implementation in test/backend-impls.ts. The fake-clock tests need `timeTravel`; the
// real-time ones run everywhere (a cluster uses Valkey SET/GET/GETDEL/DEL with server-side expiry).
import { describe, expect, test } from "bun:test"
import { implementations } from "./backend-impls"

for (const impl of implementations("kv")) {
  describe(impl.name, () => {
    test("set then get; unknown keys are undefined", async () => {
      const kv = await impl.make({ now: () => 0 })
      expect(await kv.get("k")).toBeUndefined()
      expect(await kv.set("k", "v1")).toBe(true)
      expect(await kv.get("k")).toBe("v1")
      expect(await kv.set("k", "v2")).toBe(true)
      expect(await kv.get("k")).toBe("v2")
      expect(await kv.get("other")).toBeUndefined()
    })

    test.skipIf(!impl.supports("timeTravel"))("px expires the key at its ttl; a plain set clears the expiry", async () => {
      let t = 0
      const kv = await impl.make({ now: () => t })
      await kv.set("k", "v", { px: 1000 })
      t = 999
      expect(await kv.get("k")).toBe("v")
      t = 1000
      expect(await kv.get("k")).toBeUndefined()
      await kv.set("k", "v", { px: 1000 })
      await kv.set("k", "w")
      t = 5000
      expect(await kv.get("k")).toBe("w")
    })

    test.skipIf(!impl.supports("timeTravel"))("nx sets only when the key is absent (or expired)", async () => {
      let t = 0
      const kv = await impl.make({ now: () => t })
      expect(await kv.set("k", "a", { nx: true, px: 1000 })).toBe(true)
      expect(await kv.set("k", "b", { nx: true, px: 1000 })).toBe(false)
      expect(await kv.get("k")).toBe("a")
      t = 1000
      expect(await kv.set("k", "c", { nx: true })).toBe(true)
      expect(await kv.get("k")).toBe("c")
    })

    test.skipIf(!impl.supports("timeTravel"))("getdel returns the value once and removes it", async () => {
      let t = 0
      const kv = await impl.make({ now: () => t })
      await kv.set("code", "payload", { px: 100 })
      expect(await kv.getdel("code")).toBe("payload")
      expect(await kv.getdel("code")).toBeUndefined()
      expect(await kv.get("code")).toBeUndefined()
      await kv.set("late", "x", { px: 100 })
      t = 100
      expect(await kv.getdel("late")).toBeUndefined()
    })

    test.skipIf(!impl.supports("timeTravel"))("del removes a key; true only when it existed", async () => {
      let t = 0
      const kv = await impl.make({ now: () => t })
      await kv.set("k", "v")
      expect(await kv.del("k")).toBe(true)
      expect(await kv.del("k")).toBe(false)
      expect(await kv.get("k")).toBeUndefined()
      await kv.set("e", "v", { px: 10 })
      t = 10
      expect(await kv.del("e")).toBe(false)
    })

    test("invalid ttls are refused", async () => {
      const kv = await impl.make({ now: () => 0 })
      for (const px of [0, -1, 1.5, Number.NaN]) await expect(kv.set("k", "v", { px })).rejects.toThrow(/px/)
      expect(await kv.get("k")).toBeUndefined()
    })
  })

  // Real time: these hold for an implementation whose expiry is server-side (no fake clock).
  describe(`${impl.name} (real time)`, () => {
    test("px: the key is there before its ttl and gone after it", async () => {
      const kv = await impl.make()
      expect(await kv.set("k", "v", { px: 150 })).toBe(true)
      expect(await kv.get("k")).toBe("v")
      await Bun.sleep(300)
      expect(await kv.get("k")).toBeUndefined()
      expect(await kv.getdel("k")).toBeUndefined()
      expect(await kv.del("k")).toBe(false)
      expect(await kv.set("k", "again", { nx: true })).toBe(true)
      expect(await kv.get("k")).toBe("again")
    })

    test("a plain set after a px set drops the expiry", async () => {
      const kv = await impl.make()
      await kv.set("k", "v", { px: 100 })
      await kv.set("k", "w")
      await Bun.sleep(250)
      expect(await kv.get("k")).toBe("w")
    })

    test("nx refuses while the key lives and leaves its value and expiry alone", async () => {
      const kv = await impl.make()
      expect(await kv.set("k", "a", { nx: true, px: 150 })).toBe(true)
      expect(await kv.set("k", "b", { nx: true })).toBe(false)
      expect(await kv.set("k", "b", { nx: true, px: 60_000 })).toBe(false)
      expect(await kv.get("k")).toBe("a")
      await Bun.sleep(300)
      expect(await kv.get("k")).toBeUndefined()
      expect(await kv.set("k", "c", { nx: true, px: 60_000 })).toBe(true)
    })

    test("concurrent getdels redeem a code exactly once; concurrent nx sets: exactly one wins", async () => {
      const kv = await impl.make()
      await kv.set("code", "payload", { px: 60_000 })
      const redeemed = await Promise.all(Array.from({ length: 5 }, () => kv.getdel("code")))
      expect(redeemed.filter((v) => v !== undefined)).toEqual(["payload"])
      const wins = await Promise.all(["a", "b", "c", "d"].map((v) => kv.set("lock", v, { nx: true, px: 60_000 })))
      expect(wins.filter(Boolean).length).toBe(1)
      expect(["a", "b", "c", "d"][wins.indexOf(true)]).toBe((await kv.get("lock"))!)
    })

    test("values are opaque strings: empty, unicode and JSON come back as written; keys are independent", async () => {
      const kv = await impl.make()
      const values: Record<string, string> = { empty: "", unicode: "héllo ✓ 🚀", json: JSON.stringify({ a: [1, "x"], b: null }), "pair:ABC-123": "u_1" }
      for (const [key, value] of Object.entries(values)) expect(await kv.set(key, value)).toBe(true)
      for (const [key, value] of Object.entries(values)) expect(await kv.get(key)).toBe(value)
      expect(await kv.getdel("empty")).toBe("")
      expect(await kv.del("unicode")).toBe(true)
      expect(await kv.get("json")).toBe(values.json!)
      expect(await kv.get("pair:ABC")).toBeUndefined()
    })
  })
}
