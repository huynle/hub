// Audit-only verification: checks a host against a profile and never writes. Its plan holds only read-only probe
// actions (verify-harness, verify-runtime), is a valid contract plan, needs no escalation and activates nothing.
import { describe, expect, test } from "bun:test"
import { digestOf, validateSetupPlan } from "../src/bootstrap/contracts/index.ts"
import { auditProfile, checkReadOnly, READ_ONLY_KINDS } from "../src/bootstrap/profiles/audit.ts"
import { DISCOVERY_DARWIN, DISCOVERY_LINUX_CONTAINER, DISCOVERY_UNSUPPORTED, PLAN_LAUNCH_NODE, PROFILE_FULL_HARNESS, PROFILE_SESSION_ONLY } from "./bootstrap/fixtures.ts"
import { clone, deepFreeze } from "./bootstrap/profiles-fixtures.ts"

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))
const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}
const DARWIN_WITH_SHELL = { ...DISCOVERY_DARWIN, runtimes: [{ id: "openshell" as const, present: true, version: "0.4.0" }] }

describe("auditProfile", () => {
  test("full-harness: verifies what is installed, reports what is missing, and plans no writes", () => {
    const report = value(auditProfile(deepFreeze(clone(PROFILE_FULL_HARNESS)), deepFreeze(clone(DARWIN_WITH_SHELL))))
    expect(report.mode).toBe("audit")
    expect(report.writes).toBe(0)
    expect(report.plan.actions.map((a) => a.kind)).toEqual(["verify-harness", "verify-runtime"])
    expect(report.plan.actions.every((a) => READ_ONLY_KINDS.includes(a.kind))).toBe(true)
    expect(report.findings).toEqual([
      { subject: "harness:opencode", status: "unverified", owner: "user" },
      { subject: "harness:claude-code", status: "missing", owner: "hub" },
      { subject: "harness:codex", status: "missing", owner: "hub" },
      { subject: "runtime:openshell", status: "present" },
    ])
  })

  test("the audit plan is a valid contract plan bound to this snapshot, without escalation or activation", () => {
    const report = value(auditProfile(PROFILE_FULL_HARNESS, DARWIN_WITH_SHELL))
    expect(validateSetupPlan(report.plan).ok).toBe(true)
    expect(report.plan.requiresEscalation).toBe(false)
    expect(report.plan.activatesServices).toBe(false)
    expect(report.plan.snapshotDigest).toBe(digestOf(DARWIN_WITH_SHELL))
    expect(report.plan.hostFingerprint).toBe(DARWIN_WITH_SHELL.host.fingerprint)
    expect(report.plan.profile).toEqual({ id: "full-harness", version: 2 })
  })

  test("a verified harness is reported verified (readiness still needs fresh probes at run time)", () => {
    const report = value(auditProfile({ ...PROFILE_SESSION_ONLY, harnesses: ["claude-code"] }, DISCOVERY_LINUX_CONTAINER))
    expect(report.findings).toEqual([{ subject: "harness:claude-code", status: "verified", owner: "user" }])
    expect(report.plan.actions).toHaveLength(1)
  })

  test("a failed harness is reported failed and verified again", () => {
    const failed = {
      ...DISCOVERY_DARWIN,
      harnesses: [{ ...DISCOVERY_DARWIN.harnesses[0]!, health: { state: "failed" as const, probes: [{ kind: "provider-auth" as const, ok: false, observedAt: 1 }] } }],
    }
    const report = value(auditProfile(PROFILE_SESSION_ONLY, failed))
    expect(report.findings[0]!.status).toBe("failed")
    expect(report.plan.actions.map((a) => a.kind)).toEqual(["verify-harness"])
  })

  test("deterministic", () => {
    expect(auditProfile(PROFILE_FULL_HARNESS, DARWIN_WITH_SHELL)).toEqual(auditProfile(clone(PROFILE_FULL_HARNESS), clone(DARWIN_WITH_SHELL)))
  })

  test("unsupported hosts and undiscovered OpenShell fail explicitly", () => {
    expect(codes(auditProfile(PROFILE_SESSION_ONLY, DISCOVERY_UNSUPPORTED))).toEqual(["unsupported_platform"])
    expect(codes(auditProfile({ ...PROFILE_SESSION_ONLY, runtimes: ["openshell"] }, DISCOVERY_DARWIN))).toEqual(["unsupported_platform"])
  })
})

describe("checkReadOnly", () => {
  test("accepts probe-only plans", () => {
    const report = value(auditProfile(PROFILE_FULL_HARNESS, DARWIN_WITH_SHELL))
    expect(checkReadOnly(report.plan).ok).toBe(true)
  })

  test("refuses any plan that would write, launch or activate", () => {
    const r = checkReadOnly(PLAN_LAUNCH_NODE)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(new Set(r.issues.map((i) => i.code))).toEqual(new Set(["inconsistent"]))
    // Every non-probe action of the plan is named.
    expect(r.issues.map((i) => i.path)).toEqual(
      PLAN_LAUNCH_NODE.actions.flatMap((a, i) => (a.kind === "verify-harness" ? [] : [`/actions/${i}`])),
    )
  })
})
