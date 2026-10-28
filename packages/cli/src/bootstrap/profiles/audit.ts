// Audit-only verification. `hubctl setup verify` (or any check that must not change the machine) audits the host
// against a profile: it reports each harness and runtime the profile names, and plans only read-only probe actions
// (verify-harness, verify-runtime) for what is there. The plan is a valid contract SetupPlan, so the same applier
// runs it; checkReadOnly lets that applier prove, before it starts, that an audit plan writes nothing.
import {
  Checker,
  ok,
  PLAN_SCHEMA,
  PLAN_VERSION,
  snapshotDigest,
  validateSetupPlan,
  type ActionKind,
  type DiscoverySnapshot,
  type Result,
  type SetupPlan,
  type VerifyHarness,
  type VerifyRuntime,
} from "../contracts/index.ts"
import { desiredState, type DesiredState } from "./desired.ts"

/** The only action kinds an audit may contain: probes that change nothing on disk or in the session manager. */
export const READ_ONLY_KINDS: readonly ActionKind[] = Object.freeze(["verify-harness", "verify-runtime"])

export interface AuditFinding {
  /** "harness:<id>" or "runtime:<id>". */
  readonly subject: string
  /** missing: not installed (an audit never installs). unverified/verified/failed: discovery's health. present: a runtime found. */
  readonly status: "missing" | "unverified" | "verified" | "failed" | "present"
  readonly owner?: "hub" | "user"
}

export interface AuditReport {
  readonly mode: "audit"
  /** Always zero: an audit never writes. */
  readonly writes: 0
  readonly desired: DesiredState
  /** Probe-only plan for this snapshot (checkReadOnly accepts it). */
  readonly plan: SetupPlan
  readonly findings: readonly AuditFinding[]
}

export function auditProfile(profile: unknown, snapshotDoc: unknown): Result<AuditReport> {
  const desired = desiredState(profile, snapshotDoc)
  if (!desired.ok) return desired
  const snapshot = snapshotDoc as DiscoverySnapshot
  const findings: AuditFinding[] = []
  const actions: (VerifyHarness | VerifyRuntime)[] = []
  for (const harness of desired.value.harnesses) {
    const found = snapshot.harnesses.find((h) => h.id === harness.id)
    if (harness.presence === "missing" || !found) {
      findings.push({ subject: `harness:${harness.id}`, status: "missing", owner: harness.owner })
      continue
    }
    findings.push({ subject: `harness:${harness.id}`, status: found.health.state, owner: harness.owner })
    actions.push({ id: `audit-${harness.id}`, kind: "verify-harness", escalation: "user", summary: `Verify ${harness.id} (audit, read-only)`, harness: harness.id, probes: harness.verify })
  }
  for (const runtime of desired.value.runtimes) {
    findings.push({ subject: `runtime:${runtime.id}`, status: "present" })
    actions.push({ id: `audit-${runtime.id}`, kind: "verify-runtime", escalation: "user", summary: `Check ${runtime.id} (audit, read-only)`, runtime: runtime.id })
  }
  const plan: SetupPlan = {
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    hostFingerprint: snapshot.host.fingerprint,
    snapshotDigest: snapshotDigest(snapshot),
    target: desired.value.target,
    profile: desired.value.profile,
    requiresEscalation: false,
    activatesServices: false,
    actions,
  }
  const checked = validateSetupPlan(plan)
  if (!checked.ok) return checked
  return ok({ mode: "audit", writes: 0, desired: desired.value, plan, findings })
}

/**
 * Refuses a plan with any action that is not a read-only probe (each one is named). A valid plan's escalation and
 * activation flags are exact (validateSetupPlan), so a probe-only plan never escalates or activates.
 */
export function checkReadOnly(plan: SetupPlan): Result<SetupPlan> {
  const c = new Checker()
  plan.actions.forEach((action, i) => {
    if (!READ_ONLY_KINDS.includes(action.kind)) c.add(`/actions/${i}`, "inconsistent", `${action.kind} changes the machine; an audit only probes`)
  })
  return c.result(plan)
}
