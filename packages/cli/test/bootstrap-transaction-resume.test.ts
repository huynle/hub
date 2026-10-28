// Crash injection for the transactional applier, resume side: a simulated kill after every single filesystem
// mutation of an apply, then `recover --resume` in a fresh "process". Resume finishes the stored plan and reaches
// exactly the host a clean apply reaches (or, if the kill came before the transaction started, leaves the host
// untouched), with no staging files left behind. The rollback side is in bootstrap-transaction-crash.test.ts.
import { describe, expect, test } from "bun:test"
import { countMutations, CRASH_CONSENT, isStarted, killedApply, nextProcess, stagingFiles, World } from "./bootstrap/transaction-fixtures.ts"

describe("crash injection: resume", () => {
  test("a kill after any mutation of an apply resumes to exactly the state a clean apply reaches", async () => {
    const { ok, total, final } = await countMutations()
    expect(ok).toBe(true)
    for (let k = 0; k < total; k++) {
      const w = new World()
      try {
        const before = w.snapshot()
        expect({ k, dead: await killedApply(w, k) }).toEqual({ k, dead: true })
        const started = isStarted(w)
        const r = await nextProcess(w).recover({ mode: "resume", consent: CRASH_CONSENT })
        expect({ k, ok: r.ok }).toEqual({ k, ok: true })
        expect({ k, snap: w.snapshot() }).toEqual({ k, snap: started ? final : before })
        expect({ k, staging: stagingFiles(w) }).toEqual({ k, staging: [] })
      } finally {
        w.cleanup()
      }
    }
  }, 300_000)

  test("resume needs the same explicit consent again", async () => {
    const { total } = await countMutations()
    const w = new World()
    try {
      await killedApply(w, Math.floor(total / 2))
      const r = await nextProcess(w).recover({ mode: "resume" })
      expect(r.ok ? "ok" : r.code).toBe("needs_user")
      expect((await nextProcess(w).recover({ mode: "resume", consent: CRASH_CONSENT })).ok).toBe(true)
    } finally {
      w.cleanup()
    }
  }, 60_000)
})
