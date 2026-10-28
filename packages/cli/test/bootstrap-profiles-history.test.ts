// Rollback history derived from the contract journals: what each apply on this host changed (digests only), which
// pinned harness versions hub installed, and a rollback plan to an earlier transaction that follows the contract's
// recovery rules (recoveryDecision), simulated newest first so chained changes to one file resolve correctly. User
// edits are kept and reported as conflicts; credentials are cleared, never restored.
import { describe, expect, test } from "bun:test"
import { recoveryDecision } from "../src/bootstrap/contracts/index.ts"
import { installedHarnesses, rollbackHistory, rollbackTo } from "../src/bootstrap/profiles/history.ts"
import { DIGEST, HARNESS_JOURNAL_ENTRY, HOST, JOURNAL_APPLYING, OTHER_HOST } from "./bootstrap/fixtures.ts"
import { clone, D, deepFreeze, HOUR, JOURNAL_ONE, JOURNAL_TWO, PLAN_ONE, PLAN_TWO, stateAfterTwo } from "./bootstrap/profiles-fixtures.ts"

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))
const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}
const context = { hostFingerprint: HOST, plans: [PLAN_ONE, PLAN_TWO] }
const rolledBack = (j: typeof JOURNAL_TWO) => ({ ...j, state: "rolled-back" as const, entries: j.entries.map((e) => ({ ...e, status: "undone" as const, after: e.after ?? e.before })) })

describe("rollbackHistory", () => {
  test("orders this host's transactions oldest first, with outcomes and owned changes (digests only)", () => {
    const history = value(rollbackHistory(deepFreeze(clone([JOURNAL_TWO, JOURNAL_ONE])), context))
    expect(history.map((t) => [t.txID, t.outcome])).toEqual([
      ["tx_one", "committed"],
      ["tx_two", "committed"],
    ])
    expect(history[1]!.changes.map((c) => [c.actionID, c.class, c.backup])).toEqual([
      ["install-claude", "harness", true],
      ["verify-claude", "external", false],
      ["node-json", "file", false],
    ])
    expect(JSON.stringify(history)).not.toContain("content")
  })

  test("annotates harness installs with their pinned version and the version they replaced", () => {
    const history = value(rollbackHistory([JOURNAL_ONE, JOURNAL_TWO], context))
    expect(history[0]!.harnesses).toEqual([{ harness: "claude-code", version: "2.1.85", sha256: DIGEST.c, status: "done" }])
    expect(history[1]!.harnesses).toEqual([{ harness: "claude-code", version: "2.1.90", sha256: DIGEST.f, previous: { version: "2.1.85", sha256: DIGEST.c }, status: "done" }])
  })

  test("without the plan, an install's version is unknown and not guessed", () => {
    const history = value(rollbackHistory([JOURNAL_TWO], { hostFingerprint: HOST }))
    expect(history[0]!.harnesses).toEqual([])
  })

  test("interrupted transactions are marked so they are recovered first", () => {
    const history = value(rollbackHistory([JOURNAL_APPLYING, JOURNAL_ONE], context))
    expect(history.map((t) => [t.txID, t.outcome])).toEqual([
      ["tx_0001", "interrupted"],
      ["tx_one", "committed"],
    ])
  })

  test("refuses another host's journals, duplicates, mismatched plans and invalid journals", () => {
    expect(codes(rollbackHistory([{ ...JOURNAL_ONE, hostFingerprint: OTHER_HOST }], context))).toEqual(["inconsistent"])
    expect(codes(rollbackHistory([JOURNAL_ONE, JOURNAL_ONE], context))).toEqual(["duplicate"])
    expect(codes(rollbackHistory([{ ...JOURNAL_ONE, entries: [{ ...JOURNAL_ONE.entries[0]!, content: "x" }] }], context))).toContain("unknown_field")
    expect(codes(rollbackHistory([JOURNAL_ONE], { hostFingerprint: HOST, plans: [{ ...PLAN_ONE, target: "windows-x64" }] }))).toContain("unsupported_platform")
  })
})

describe("installedHarnesses", () => {
  test("the newest committed hub install of each harness", () => {
    const history = value(rollbackHistory([JOURNAL_ONE, JOURNAL_TWO], context))
    expect(installedHarnesses(history)).toEqual({ "claude-code": { version: "2.1.90", sha256: DIGEST.f, txID: "tx_two" } })
  })

  test("a rolled-back install no longer counts", () => {
    const history = value(rollbackHistory([JOURNAL_ONE, rolledBack(JOURNAL_TWO)], context))
    expect(installedHarnesses(history)).toEqual({ "claude-code": { version: "2.1.85", sha256: DIGEST.c, txID: "tx_one" } })
  })
})

describe("rollbackTo", () => {
  test("rolling back to tx_one undoes tx_two newest first and restores the previous harness version", () => {
    const plan = value(rollbackTo([JOURNAL_ONE, JOURNAL_TWO], "tx_one", stateAfterTwo(), context))
    expect(plan.steps.map((s) => [s.txID, s.seq, s.actionID, s.decision])).toEqual([
      ["tx_two", 3, "node-json", "remove-created"],
      ["tx_two", 2, "verify-claude", "nothing-to-do"],
      ["tx_two", 1, "install-claude", "restore-backup"],
    ])
    expect(plan.steps[2]!.restores).toEqual({ harness: "claude-code", version: "2.1.85", sha256: DIGEST.c })
    expect(plan.conflicts).toEqual([])
    expect(plan.complete).toBe(true)
    expect(plan.writes).toBe(0)
  })

  test("rolling everything back chains through the same file: tx_one's install is removed after tx_two's is restored", () => {
    const plan = value(rollbackTo([JOURNAL_ONE, JOURNAL_TWO], undefined, stateAfterTwo(), context))
    expect(plan.steps.map((s) => [s.txID, s.actionID, s.decision])).toEqual([
      ["tx_two", "node-json", "remove-created"],
      ["tx_two", "verify-claude", "nothing-to-do"],
      ["tx_two", "install-claude", "restore-backup"],
      ["tx_one", "verify-claude", "nothing-to-do"],
      ["tx_one", "install-claude", "remove-created"],
      ["tx_one", "opencode-hub", "restore-backup"],
    ])
  })

  test("the decisions are the contract's recovery rules", () => {
    const plan = value(rollbackTo([JOURNAL_TWO], undefined, stateAfterTwo(), context))
    const install = plan.steps.find((s) => s.actionID === "install-claude")!
    expect(install.decision).toBe(recoveryDecision(HARNESS_JOURNAL_ENTRY, { exists: true, sha256: DIGEST.f, mode: 0o755 }))
  })

  test("a user edit is kept and reported; older changes to that file are kept too", () => {
    const plan = value(rollbackTo([JOURNAL_ONE, JOURNAL_TWO], undefined, stateAfterTwo({ "config:opencode/opencode.json": { exists: true, sha256: D.opencodeUserEdited, mode: 0o644 } }), context))
    expect(plan.conflicts.map((s) => [s.txID, s.actionID, s.decision])).toEqual([["tx_one", "opencode-hub", "keep-user-edit"]])
    expect(plan.complete).toBe(false)
  })

  test("an interrupted newer transaction is recovered first; its credential is cleared, never restored", () => {
    const plan = value(rollbackTo([JOURNAL_ONE, { ...JOURNAL_APPLYING, startedAt: JOURNAL_ONE.startedAt + HOUR, updatedAt: JOURNAL_ONE.startedAt + HOUR }], "tx_one", stateAfterTwo({ "config:opencode/opencode.json": { exists: true, sha256: DIGEST.e, mode: 0o644 }, "config:hub/node.json": { exists: false } }), context))
    expect(plan.steps.map((s) => [s.txID, s.actionID, s.decision])).toEqual([
      ["tx_0001", "node-json", "nothing-to-do"],
      ["tx_0001", "enroll", "clear-credential"],
      ["tx_0001", "opencode-plugin", "restore-backup"],
      ["tx_0001", "state-dir", "remove-created"],
    ])
  })

  test("a transaction already rolled back is skipped", () => {
    const plan = value(rollbackTo([JOURNAL_ONE, rolledBack(JOURNAL_TWO)], "tx_one", stateAfterTwo(), context))
    expect(plan.steps).toEqual([])
  })

  test("the target must be a committed transaction of this history", () => {
    expect(codes(rollbackTo([JOURNAL_ONE, JOURNAL_TWO], "tx_nope", stateAfterTwo(), context))).toEqual(["invalid_value"])
    expect(codes(rollbackTo([JOURNAL_ONE, rolledBack(JOURNAL_TWO)], "tx_two", stateAfterTwo(), context))).toEqual(["invalid_value"])
  })
})
