// Crash injection for the transactional applier, rollback side: a simulated kill after every single filesystem
// mutation of an apply (and of the rollback of a failed apply), then recovery in a fresh "process" (new pid, the
// old one dead). Whatever the boundary, recovery rolls the host back to exactly where it started (or finds the
// transaction committed), leaves no staging files, never leaves the new credential in place, and the host can be
// set up again afterwards. The resume side is in bootstrap-transaction-resume.test.ts.
import { describe, expect, test } from "bun:test"
import { countMutations, CRASH_CONSENT, isCommitted, killedApply, NEW_TOKEN, nextProcess, stagingFiles, World } from "./bootstrap/transaction-fixtures.ts"

const CREDENTIAL_DIR = "home/.config/hub"
const without = (snap: Record<string, string>, prefix: string) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith(prefix)))

describe("crash injection: rollback", () => {
  test("a kill after any mutation of an apply rolls back to the starting state", async () => {
    const { ok, total, final } = await countMutations()
    expect(ok).toBe(true)
    expect(total).toBeGreaterThan(40)
    for (let k = 0; k < total; k++) {
      const w = new World()
      try {
        const before = w.snapshot()
        expect({ k, dead: await killedApply(w, k) }).toEqual({ k, dead: true })
        const r = await nextProcess(w).recover({ mode: "rollback" })
        expect({ k, ok: r.ok }).toEqual({ k, ok: true })
        const snap = w.snapshot()
        if (isCommitted(w)) expect({ k, snap }).toEqual({ k, snap: final })
        else {
          // A credential the transaction stored is cleared (the rest of its config file is kept), never restored.
          expect({ k, snap: without(snap, CREDENTIAL_DIR) }).toEqual({ k, snap: without(before, CREDENTIAL_DIR) })
          if (snap[`${CREDENTIAL_DIR}/config.json`]) expect(w.read("config", "hub/config.json")).not.toContain(NEW_TOKEN)
        }
        expect({ k, staging: stagingFiles(w) }).toEqual({ k, staging: [] })
        // The host is usable again: a new preview applies cleanly.
        const again = await nextProcess(w).apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
        expect({ k, ok: again.ok }).toEqual({ k, ok: true })
      } finally {
        w.cleanup()
      }
    }
  }, 300_000)

  test("a kill during the rollback of a failed apply is recovered by rolling back again", async () => {
    const { ok, total } = await countMutations({ verifyFails: true })
    expect(ok).toBe(false)
    for (let k = 0; k < total; k++) {
      const w = new World({ verifyFails: true })
      try {
        const before = w.snapshot()
        expect({ k, dead: await killedApply(w, k) }).toEqual({ k, dead: true })
        const r = await nextProcess(w).recover({ mode: "rollback" })
        expect({ k, ok: r.ok }).toEqual({ k, ok: true })
        expect({ k, snap: w.snapshot() }).toEqual({ k, snap: before })
        expect({ k, staging: stagingFiles(w) }).toEqual({ k, staging: [] })
      } finally {
        w.cleanup()
      }
    }
  }, 300_000)

  test("apply refuses while an interrupted transaction awaits recovery", async () => {
    const { total } = await countMutations()
    const w = new World()
    try {
      await killedApply(w, Math.floor(total / 2))
      const r = await nextProcess(w).apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
      expect(r.ok ? "ok" : r.code).toBe("recovery_required")
      expect((await nextProcess(w).recover({ mode: "rollback" })).ok).toBe(true)
    } finally {
      w.cleanup()
    }
  }, 60_000)
})
