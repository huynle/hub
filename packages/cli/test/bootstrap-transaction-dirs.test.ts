// Directories an apply creates, and what a rollback does with them (HBS-12 acceptance):
//
//   - a missing root directory (a fresh home without ~/.local/bin or ~/.local/share) is created as owned, journaled
//     directories under the home root, so a rollback removes it again, exactly like the directories created inside
//     a root; a directory that existed before is never touched;
//   - a directory hub created that now holds files hub did not write (a harness probe wrote its cache there, say)
//     is kept, and reported as an informational note (`kept`), not as a conflict.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { validateJournal } from "../src/bootstrap/contracts/index.ts"
import { TxStore } from "../src/bootstrap/transaction/store.ts"
import { nodeFs } from "../src/bootstrap/transaction/fs.ts"
import { CRASH_CONSENT, World, type WorldOptions } from "./bootstrap/transaction-fixtures.ts"

let worlds: World[] = []
afterEach(() => {
  for (const w of worlds) w.cleanup()
  worlds = []
})
const world = (options: WorldOptions = {}) => {
  const w = new World(options)
  worlds.push(w)
  return w
}
const codeOf = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)

describe("root directories an apply creates", () => {
  test("a missing ~/.local/bin and ~/.local/share are journaled under home and removed by the rollback", async () => {
    const w = world({ verifyFails: true, missingRoots: ["user-bin", "data"] })
    const bin = w.box.path("user-bin", "").slice(0, -1)
    const data = w.box.path("data", "").slice(0, -1)
    expect(existsSync(bin)).toBe(false)
    let seen = false
    const hooks = {
      beforeAction: (entry: { actionID: string }) => {
        if (entry.actionID === "verify-opencode") seen = existsSync(bin) && existsSync(data)
      },
    }
    const r = await w.applier({ hooks }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(seen).toBe(true)
    expect(existsSync(bin)).toBe(false)
    expect(existsSync(data)).toBe(false)
    expect(r.report?.conflicts).toEqual([])
    // ~/.local existed (the state root lives in it): it is never removed.
    expect(existsSync(w.box.path("state", ""))).toBe(true)
    const journal = new TxStore(nodeFs, w.box.roots).journals()[0]!
    expect(validateJournal(journal).ok).toBe(true)
    expect(journal.entries.filter((e) => e.path?.root === "home").map((e) => [e.class, e.path!.rel])).toEqual([
      ["directory", ".local/bin"],
      ["directory", ".local/share"],
    ])
  })

  test("a committed apply keeps the roots it created; a later rollback removes them", async () => {
    const w = world({ missingRoots: ["user-bin"] })
    const applier = w.applier({ keepBackups: true })
    const applied = await applier.apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
    expect(applied.ok).toBe(true)
    expect(existsSync(w.box.path("user-bin", "hubctl"))).toBe(true)
    const rolled = await applier.rollback({})
    expect(rolled.ok).toBe(true)
    expect(existsSync(w.box.path("user-bin", "").slice(0, -1))).toBe(false)
  })

  test("roots that existed are not journaled", async () => {
    const w = world({ verifyFails: true })
    const r = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
    expect(codeOf(r)).toBe("harness_not_ready")
    const journal = new TxStore(nodeFs, w.box.roots).journals()[0]!
    expect(journal.entries.some((e) => e.path?.root === "home")).toBe(false)
    expect(existsSync(w.box.path("user-bin", ""))).toBe(true)
  })
})

describe("a created directory that now holds other files", () => {
  test("is kept and reported as an informational note, not a conflict", async () => {
    const w = world({ verifyFails: true, missingRoots: ["data"] })
    const hooks = {
      beforeAction: (entry: { actionID: string }) => {
        // A harness probe writes its own cache into a directory hub created.
        if (entry.actionID !== "verify-opencode") return
        mkdirSync(w.box.path("data", "hub/cache"), { recursive: true })
        writeFileSync(w.box.path("data", "hub/cache/models.json"), "{}")
      },
    }
    const r = await w.applier({ hooks }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(r.report?.conflicts).toEqual([])
    const kept = r.report?.kept ?? []
    expect(kept.map((k) => k.path)).toEqual([w.box.path("data", "hub"), w.box.path("data", "").slice(0, -1)])
    for (const k of kept) {
      expect(k.reason).toContain("left in place")
      expect(k.reason).not.toMatch(/conflict|not empty/i)
    }
    expect(existsSync(w.box.path("data", "hub/cache/models.json"))).toBe(true)
    // What hub created inside it and nobody else touched is still removed.
    expect(existsSync(w.box.path("data", "hub/harnesses"))).toBe(false)
  })
})
