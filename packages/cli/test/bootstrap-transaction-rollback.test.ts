// `hubctl setup rollback` (HBS-13): undoing committed transactions, newest first, with the same recovery rules as a
// crash recovery (restore what existed from its backup, remove what hub created, clear a credential, keep anything
// changed since). Committed transactions keep their backups only when the applier is told to (keepBackups); without
// them a restore is reported as a conflict, never guessed.
import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import type { Action } from "../src/bootstrap/contracts/index.ts"
import { CRASH_CONSENT, OPENCODE_JSON, World } from "./bootstrap/transaction-fixtures.ts"

let worlds: World[] = []
afterEach(() => {
  for (const w of worlds) w.cleanup()
  worlds = []
})
const world = (options = {}) => {
  const w = new World(options)
  worlds.push(w)
  return w
}

const EXTRA: Action = { id: "extra-dir", kind: "ensure-directory", escalation: "user", summary: "an extra directory", path: { root: "data", rel: "hub/extra" }, mode: 0o700 }

describe("Applier.rollback", () => {
  test("undoes every committed transaction: the host is as it was before, the credential cleared", async () => {
    const w = world({ oldCredential: true })
    const before = w.snapshot()
    const applier = w.applier({ keepBackups: true })
    const applied = await applier.apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
    expect(applied.ok).toBe(true)
    expect(w.read("config", "opencode/opencode.json")).not.toBe(OPENCODE_JSON)

    const r = await applier.rollback({})
    expect(r.ok).toBe(true)
    expect(r.report?.state).toBe("rolled-back")
    expect(w.read("config", "opencode/opencode.json")).toBe(OPENCODE_JSON)
    expect(w.calls).toContain("clear-credential")
    expect(w.calls).toContain("deactivate node")
    const after = w.snapshot()
    // The old credential's file stays (it existed), but without any credential in it.
    delete before["home/.config/hub/config.json"]
    delete after["home/.config/hub/config.json"]
    expect(after).toEqual(before)
    expect(w.read("config", "hub/config.json")).not.toContain("mt_")
    // Rolled back once: a second rollback has nothing to do.
    const again = await applier.rollback({})
    expect(again.ok).toBe(true)
    expect(again.report).toBeUndefined()
  })

  test("--to <txID>: only the transactions after it are undone", async () => {
    const w = world()
    const applier = w.applier({ keepBackups: true })
    const first = await applier.apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
    expect(first.ok).toBe(true)
    const second = await applier.apply({ token: w.token(w.plan({ actions: [EXTRA] })), replan: async () => ({ plan: w.plan({ actions: [EXTRA] }) }), consent: CRASH_CONSENT })
    expect(second.ok).toBe(true)
    const firstID = first.ok ? first.report.txID : ""
    const r = await applier.rollback({ to: firstID })
    expect(r.ok).toBe(true)
    expect(w.snapshot()["home/.local/share/hub/extra"]).toBeUndefined()
    expect(w.read("config", "opencode/opencode.json")).not.toBe(OPENCODE_JSON)
  })

  test("a file changed since the apply is kept and reported", async () => {
    const w = world()
    const applier = w.applier({ keepBackups: true })
    expect((await applier.apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })).ok).toBe(true)
    writeFileSync(w.box.path("config", "opencode/opencode.json"), "{ \"mine\": true }\n")
    const r = await applier.rollback({})
    expect(r.ok).toBe(true)
    expect(r.report?.conflicts.some((c) => c.path?.endsWith("opencode.json"))).toBe(true)
    expect(w.read("config", "opencode/opencode.json")).toBe('{ "mine": true }\n')
  })

  test("without kept backups, a restore is a conflict (never guessed)", async () => {
    const w = world()
    const applier = w.applier()
    expect((await applier.apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })).ok).toBe(true)
    const r = await applier.rollback({})
    expect(r.ok).toBe(true)
    expect(r.report?.conflicts.some((c) => /backup/.test(c.reason))).toBe(true)
  })

  test("an unknown target is refused; an interrupted transaction must be recovered first", async () => {
    const w = world()
    const applier = w.applier({ keepBackups: true })
    expect((await applier.apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })).ok).toBe(true)
    const unknown = await applier.rollback({ to: "tx_nope" })
    expect(unknown.ok).toBe(false)
    expect(!unknown.ok && unknown.code).toBe("invalid")
  })
})
