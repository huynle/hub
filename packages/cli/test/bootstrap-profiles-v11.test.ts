// Contract amendment v1.1 in the profile layer: catalog profiles record their revision (profile v2) and rebases
// start from it; profile downgrades plan typed deactivate-service / remove-service actions (still only with explicit
// consent); audits pin the canonical snapshot digest; services without a manager are no_service_manager.
import { describe, expect, test } from "bun:test"
import { snapshotDigest, validateAction, validateSetupPlan, type Profile } from "../src/bootstrap/contracts/index.ts"
import { auditProfile } from "../src/bootstrap/profiles/audit.ts"
import { defaultProfile, PROFILE_CATALOG, type ProfileCatalog } from "../src/bootstrap/profiles/catalog.ts"
import { desiredState } from "../src/bootstrap/profiles/desired.ts"
import { installedServiceUnits, rollbackHistory } from "../src/bootstrap/profiles/history.ts"
import { planProfileChange, rebaseProfile } from "../src/bootstrap/profiles/upgrade.ts"
import { DIGEST, DISCOVERY_DARWIN, DISCOVERY_LINUX_CONTAINER, HOST, PROFILE_FULL_HARNESS, PROFILE_LAUNCH_NODE, PROFILE_SESSION_ONLY } from "./bootstrap/fixtures.ts"
import { JOURNAL_ONE, PLAN_ONE } from "./bootstrap/profiles-fixtures.ts"

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))
const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

describe("v1.1 profile revisions", () => {
  test("catalog profiles record the catalog revision they come from", () => {
    expect(value(defaultProfile("launch-node")).revision).toBe(PROFILE_CATALOG.revision)
    for (const p of Object.values(PROFILE_CATALOG.profiles)) expect(p.revision).toBe(PROFILE_CATALOG.revision)
  })

  const v2: ProfileCatalog = {
    revision: 2,
    profiles: {
      ...PROFILE_CATALOG.profiles,
      "launch-node": { ...PROFILE_CATALOG.profiles["launch-node"], revision: 2, harnesses: ["opencode", "claude-code"] },
    },
  }

  test("rebaseProfile finds the defaults a profile was made from by its revision", () => {
    const current: Profile = { ...value(defaultProfile("launch-node")), launch: { enabled: true, maxDurationS: 900 } }
    const r = value(rebaseProfile({ current, next: v2.profiles["launch-node"], catalogs: [PROFILE_CATALOG, v2] }))
    expect(r.profile).toEqual({ ...current, revision: 2, harnesses: ["opencode", "claude-code"] })
    expect(r.kept).toEqual(["launch"])
    expect(r.updated).toEqual(["harnesses"])
  })

  test("an explicit base must be the revision the profile came from", () => {
    const current = value(defaultProfile("launch-node"))
    expect(codes(rebaseProfile({ current, base: v2.profiles["launch-node"], next: v2.profiles["launch-node"] }))).toEqual(["inconsistent"])
  })

  test("a profile without a revision needs an explicit base; an unknown revision is refused", () => {
    expect(codes(rebaseProfile({ current: PROFILE_LAUNCH_NODE, next: v2.profiles["launch-node"], catalogs: [PROFILE_CATALOG, v2] }))).toEqual(["missing_field"])
    expect(codes(rebaseProfile({ current: { ...PROFILE_LAUNCH_NODE, revision: 7 }, next: v2.profiles["launch-node"], catalogs: [PROFILE_CATALOG, v2] }))).toEqual(["invalid_value"])
  })

  test("a rebase never goes back to an older revision", () => {
    const current = { ...v2.profiles["launch-node"] }
    expect(codes(rebaseProfile({ current, next: PROFILE_CATALOG.profiles["launch-node"], catalogs: [PROFILE_CATALOG, v2] }))).toEqual(["downgrade_rejected"])
  })

  test("the enrollment mode is a user choice the rebase keeps", () => {
    const current: Profile = { ...value(defaultProfile("launch-node")), enrollment: "separate" }
    const r = value(rebaseProfile({ current, next: v2.profiles["launch-node"], catalogs: [PROFILE_CATALOG, v2] }))
    expect(r.profile.enrollment).toBe("separate")
    expect(r.kept).toEqual(["enrollment"])
  })
})

describe("v1.1 downgrades plan typed service removal", () => {
  const services = { manager: "launchd" as const, installed: { "claude-code": DIGEST.c, "codex-spoke": DIGEST.d } }

  test("removing a component deactivates its service, then removes the unit hub installed", () => {
    const to: Profile = { ...PROFILE_FULL_HARNESS, harnesses: ["opencode", "claude-code"], services: ["node", "claude-code"] }
    const change = value(planProfileChange(PROFILE_FULL_HARNESS, to, { allowDowngrade: true, services }))
    expect(change.actions).toEqual([
      { id: "deactivate-codex-spoke", kind: "deactivate-service", escalation: "user", summary: "Unload the hub codex-spoke service (profile downgrade)", service: "codex-spoke", manager: "launchd" },
      {
        id: "remove-codex-spoke",
        kind: "remove-service",
        escalation: "user",
        summary: "Remove the hub codex-spoke launchd unit (profile downgrade)",
        service: "codex-spoke",
        manager: "launchd",
        path: { root: "launch-agents", rel: "io.github.huynle.hub-codex-spoke.plist" },
        sha256: DIGEST.d,
      },
    ])
    for (const a of change.actions) expect(validateAction(a).ok).toBe(true)
    expect(validateSetupPlan({ schema: "hub.setup-plan", version: 1, hostFingerprint: HOST, snapshotDigest: DIGEST.b, target: "darwin-arm64", profile: { id: "full-harness", version: 2 }, requiresEscalation: false, activatesServices: false, actions: change.actions }).ok).toBe(true)
    // The removed harness itself has no typed uninstall: it is retained (rolled back with the history).
    expect(change.retained).toEqual(["harness:codex"])
  })

  test("a unit hub has no record of installing is only deactivated, never removed", () => {
    const change = value(planProfileChange(PROFILE_LAUNCH_NODE, PROFILE_SESSION_ONLY, { allowDowngrade: true, services: { manager: "launchd", installed: {} } }))
    expect(change.actions.map((a) => a.kind)).toEqual(["deactivate-service"])
    expect(change.retained).toEqual(["service:node", "launch"])
  })

  test("downgrades still need explicit consent; without service facts nothing is planned", () => {
    expect(codes(planProfileChange(PROFILE_FULL_HARNESS, PROFILE_SESSION_ONLY, { services }))).toEqual(["downgrade_rejected"])
    expect(value(planProfileChange(PROFILE_LAUNCH_NODE, PROFILE_SESSION_ONLY, { allowDowngrade: true })).actions).toEqual([])
  })

  test("the units hub installed come from the history", () => {
    const plan = { ...PLAN_ONE, actions: [...PLAN_ONE.actions] }
    const journal = {
      ...JOURNAL_ONE,
      entries: [
        ...JOURNAL_ONE.entries,
        {
          seq: JOURNAL_ONE.entries.length + 1,
          actionID: "node-service",
          kind: "install-service" as const,
          class: "service" as const,
          path: { root: "launch-agents" as const, rel: "io.github.huynle.hub-node.plist" },
          before: { exists: false },
          after: { exists: true, sha256: DIGEST.e, mode: 0o644 },
          status: "done" as const,
        },
      ],
    }
    const history = value(rollbackHistory([journal], { hostFingerprint: HOST, plans: [plan] }))
    expect(installedServiceUnits(history, "launchd")).toEqual({ node: DIGEST.e })
  })
})

describe("v1.1 audit and desired state", () => {
  test("an audit pins the canonical snapshot digest (capture time excluded)", () => {
    const report = value(auditProfile(PROFILE_SESSION_ONLY, DISCOVERY_DARWIN))
    expect(report.plan.snapshotDigest).toBe(snapshotDigest(DISCOVERY_DARWIN))
  })

  test("services on a host without a user service manager: no_service_manager", () => {
    expect(codes(desiredState(PROFILE_LAUNCH_NODE, DISCOVERY_LINUX_CONTAINER))).toContain("no_service_manager")
  })
})
