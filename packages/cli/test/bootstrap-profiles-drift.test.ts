// Managed-field drift. Hub owns exactly the fields its plans set (merge-config pointers, its mcp registration, the
// files it writes). Detection compares three things: what hub applied (the last plan, per its journal entries),
// what hub wants now (the fresh plan) and what is there (snapshot digests + observed values). Hub may repair only
// its own fields that are missing or still exactly as it left them; anything the user changed is reported and
// never overwritten. Detection is pure and never writes; reports carry digests of user values, never the values.
import { describe, expect, test } from "bun:test"
import { findSecrets, validateAction, type Action, type MergeConfig } from "../src/bootstrap/contracts/index.ts"
import { detectDrift, driftRepairs, managedFields, type DriftReport, type Observation } from "../src/bootstrap/profiles/drift.ts"
import { HOST, OTHER_HOST } from "./bootstrap/fixtures.ts"
import { APPLIED_JOURNAL, APPLIED_PLAN, clone, D, deepFreeze, FRESH_PLAN, NODE_JSON, OPENCODE_JSON, snapshotWith } from "./bootstrap/profiles-fixtures.ts"

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))
const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}
const K = {
  plugin: "config:opencode/opencode.json#/plugin/-",
  mode: "config:opencode/opencode.json#/hub/mode",
  bound: "config:opencode/opencode.json#/hub/launchMaxS",
  mcp: "mcp:opencode/hub",
  node: "config:hub/node.json",
} as const
const statuses = (report: DriftReport) => Object.fromEntries(report.fields.map((f) => [f.key, f.status]))
const applied = { plan: APPLIED_PLAN, journal: APPLIED_JOURNAL }
const observe = (fields: Record<string, unknown>, registration?: "ours" | "absent" | "foreign"): Observation => ({
  fields: Object.entries(fields).map(([pointer, v]) => (v === undefined ? { path: OPENCODE_JSON, pointer, state: "absent" as const } : { path: OPENCODE_JSON, pointer, state: "value" as const, value: v as never })),
  registrations: registration ? [{ harness: "opencode", name: "hub", state: registration }] : [],
})
const USER_SECRET = "sk-abcdefghijklmnopqrstuvwx"

describe("managedFields", () => {
  test("lists exactly the fields a plan sets, keyed by path and pointer", () => {
    expect(managedFields(FRESH_PLAN).map((f) => f.key)).toEqual([K.plugin, K.mode, K.bound, K.mcp, K.node])
  })
})

describe("detectDrift", () => {
  test("nothing touched since the apply: hub's own older values are outdated, new ones missing", () => {
    const report = value(detectDrift(deepFreeze(clone({ desired: FRESH_PLAN, snapshot: snapshotWith(D.opencodeApplied, D.nodeV1), applied, observed: observe({ "/hub/launchMaxS": undefined }) }))))
    expect(statuses(report)).toEqual({ [K.plugin]: "in-sync", [K.mode]: "outdated", [K.bound]: "missing", [K.mcp]: "in-sync", [K.node]: "outdated" })
    expect(report.userChanged).toEqual([])
    expect(report.changedSinceApply).toEqual([])
    expect(report.inSync).toBe(false)
    expect(report.writes).toBe(0)
  })

  test("user-changed hub fields are reported, never repaired; user values appear only as digests", () => {
    const observed = observe({ "/plugin": ["@huynle/hub", "their-plugin"], "/hub/mode": USER_SECRET, "/hub/launchMaxS": undefined }, "ours")
    const snapshot = snapshotWith(D.opencodeUserEdited, D.nodeUserEdited)
    const report = value(detectDrift({ desired: FRESH_PLAN, snapshot, applied, observed }))
    expect(statuses(report)).toEqual({ [K.plugin]: "in-sync", [K.mode]: "user-changed", [K.bound]: "missing", [K.mcp]: "in-sync", [K.node]: "user-changed" })
    expect(report.userChanged.map((f) => f.key)).toEqual([K.mode, K.node])
    expect(report.userChanged.every((f) => !f.repairable)).toBe(true)
    expect(report.changedSinceApply).toEqual([OPENCODE_JSON, NODE_JSON])
    expect(JSON.stringify(report)).not.toContain(USER_SECRET)
    expect(findSecrets(report)).toEqual([])
    expect(report.userChanged[0]!.currentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const repairs = driftRepairs(report, FRESH_PLAN, snapshot)
    expect(repairs.map((a) => a.id)).toEqual(["opencode-hub"])
    const merge = repairs[0] as MergeConfig
    expect(merge.set).toEqual([{ pointer: "/hub/launchMaxS", value: 3600 }])
    expect(merge.precondition).toEqual({ exists: true, sha256: D.opencodeUserEdited })
  })

  test("a user edit to unrelated fields is preserved: hub's fields still repair, losslessly, on top of it", () => {
    const observed = observe({ "/plugin": ["@huynle/hub"], "/hub/mode": "session", "/hub/launchMaxS": undefined }, "ours")
    const snapshot = snapshotWith(D.opencodeUserEdited, D.nodeV1)
    const report = value(detectDrift({ desired: FRESH_PLAN, snapshot, applied, observed }))
    expect(statuses(report)).toEqual({ [K.plugin]: "in-sync", [K.mode]: "outdated", [K.bound]: "missing", [K.mcp]: "in-sync", [K.node]: "outdated" })
    expect(report.userChanged).toEqual([])
    expect(report.changedSinceApply).toEqual([OPENCODE_JSON])
    const repairs = driftRepairs(report, FRESH_PLAN, snapshot)
    for (const action of repairs) expect(validateAction(action).ok).toBe(true)
    expect(repairs.map((a) => a.kind)).toEqual(["merge-config", "write-file"])
    const merge = repairs[0] as MergeConfig
    expect(merge.preserveUnknown).toBe(true)
    expect(merge.set).toEqual([
      { pointer: "/hub/mode", value: "launch" },
      { pointer: "/hub/launchMaxS", value: 3600 },
    ])
  })

  test("what the user removed stays removed", () => {
    const observed = observe({ "/plugin": ["their-plugin"], "/hub/mode": "session", "/hub/launchMaxS": 3600 }, "absent")
    const report = value(detectDrift({ desired: FRESH_PLAN, snapshot: snapshotWith(D.opencodeUserEdited, null), applied, observed }))
    expect(statuses(report)).toEqual({ [K.plugin]: "user-changed", [K.mode]: "outdated", [K.bound]: "in-sync", [K.mcp]: "user-changed", [K.node]: "user-changed" })
    const repairs = driftRepairs(report, FRESH_PLAN, snapshotWith(D.opencodeUserEdited, null))
    expect(repairs.map((a) => a.kind)).toEqual(["merge-config"])
    expect((repairs[0] as MergeConfig).set).toEqual([{ pointer: "/hub/mode", value: "launch" }])
  })

  test("never applied: pre-existing user values are the user's; absent fields are missing", () => {
    const observed = observe({ "/plugin": undefined, "/hub/mode": "mine", "/hub/launchMaxS": undefined }, "foreign")
    const snapshot = snapshotWith(D.opencodeOriginal, null)
    const report = value(detectDrift({ desired: FRESH_PLAN, snapshot, observed }))
    expect(statuses(report)).toEqual({ [K.plugin]: "missing", [K.mode]: "user-changed", [K.bound]: "missing", [K.mcp]: "user-changed", [K.node]: "missing" })
    const repairs = driftRepairs(report, FRESH_PLAN, snapshot)
    expect(repairs.map((a) => a.kind)).toEqual(["merge-config", "write-file"])
    expect((repairs[0] as MergeConfig).set.map((s) => s.pointer)).toEqual(["/plugin/-", "/hub/launchMaxS"])
    expect((repairs[0] as MergeConfig).precondition).toEqual({ exists: true, sha256: D.opencodeOriginal })
  })

  test("a rolled-back apply owns nothing", () => {
    const journal = { ...APPLIED_JOURNAL, state: "rolled-back" as const, entries: APPLIED_JOURNAL.entries.map((e) => ({ ...e, status: "undone" as const })) }
    const observed = observe({ "/plugin": undefined, "/hub/mode": "session", "/hub/launchMaxS": undefined }, "absent")
    const report = value(detectDrift({ desired: FRESH_PLAN, snapshot: snapshotWith(D.opencodeOriginal, null), applied: { plan: APPLIED_PLAN, journal }, observed }))
    // "session" was hub's value, but that apply was undone: whatever is there now is the user's.
    expect(statuses(report)[K.mode]).toBe("user-changed")
    expect(statuses(report)[K.mcp]).toBe("missing")
  })

  test("without observations a changed file is unobserved and nothing is repaired", () => {
    const snapshot = snapshotWith(D.opencodeUserEdited, undefined)
    const report = value(detectDrift({ desired: FRESH_PLAN, snapshot, applied }))
    expect(new Set(Object.values(statuses(report)))).toEqual(new Set(["unobserved"]))
    expect(driftRepairs(report, FRESH_PLAN, snapshot)).toEqual([])
  })

  test("a field hub no longer sets is retired, not removed; an outdated array entry is reported, not appended twice", () => {
    const desired = clone(FRESH_PLAN)
    const merge = desired.actions[0] as unknown as { set: { pointer: string; value: unknown }[] }
    merge.set = [{ pointer: "/plugin/-", value: "@huynle/hub@2" }]
    const report = value(detectDrift({ desired, snapshot: snapshotWith(D.opencodeApplied, D.nodeV2), applied }))
    expect(report.fields.find((f) => f.key === K.mode)).toMatchObject({ status: "retired", repairable: false })
    expect(report.fields.find((f) => f.key === K.plugin)).toMatchObject({ status: "outdated", repairable: false })
    expect(driftRepairs(report, desired, snapshotWith(D.opencodeApplied, D.nodeV2)).flatMap((a) => (a.kind === "merge-config" ? a.set : []))).toEqual([])
  })

  test("detection never writes: inputs are untouched and the report holds no actions", () => {
    const input = deepFreeze(clone({ desired: FRESH_PLAN, snapshot: snapshotWith(D.opencodeApplied, D.nodeV1), applied, observed: observe({}) }))
    const before = JSON.stringify(input)
    const report = value(detectDrift(input))
    expect(JSON.stringify(input)).toBe(before)
    expect(report.writes).toBe(0)
    expect(JSON.stringify(report)).not.toContain('"kind"')
  })

  test("everything in sync", () => {
    const report = value(detectDrift({ desired: APPLIED_PLAN, snapshot: snapshotWith(D.opencodeApplied, D.nodeV1), applied }))
    expect(report.inSync).toBe(true)
    expect(driftRepairs(report, APPLIED_PLAN, snapshotWith(D.opencodeApplied, D.nodeV1))).toEqual([])
  })

  test("history from another host, or a journal for another plan, is refused", () => {
    const snapshot = snapshotWith(D.opencodeApplied, D.nodeV1)
    expect(codes(detectDrift({ desired: FRESH_PLAN, snapshot, applied: { plan: APPLIED_PLAN, journal: { ...APPLIED_JOURNAL, hostFingerprint: OTHER_HOST } } }))).toEqual(["inconsistent"])
    expect(codes(detectDrift({ desired: FRESH_PLAN, snapshot, applied: { plan: FRESH_PLAN, journal: APPLIED_JOURNAL } }))).toEqual(["inconsistent"])
    expect(codes(detectDrift({ desired: { ...FRESH_PLAN, hostFingerprint: OTHER_HOST }, snapshot }))).toEqual(["inconsistent"])
    expect(HOST).not.toBe(OTHER_HOST)
  })

  test("invalid documents are rejected with their validators' codes", () => {
    const badAction = { ...FRESH_PLAN, actions: [{ ...FRESH_PLAN.actions[0], command: "rm -rf ~" } as unknown as Action] }
    expect(codes(detectDrift({ desired: badAction, snapshot: snapshotWith(D.opencodeApplied, D.nodeV1) }))).toContain("exec_field")
  })
})
