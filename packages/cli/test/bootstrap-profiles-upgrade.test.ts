// Upgrade and downgrade planning, following the contract's downgrade policy: profile changes that remove anything
// need explicit consent (downgrade_rejected otherwise); a new catalog revision rebases a profile while keeping every
// field the user changed and never raising privilege or opting in to OpenShell; pinned harness versions go through
// decideHarnessInstall (security floor, --allow-downgrade, same version with other bytes is tampering), and a
// harness the user installed another way is never replaced.
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { checkHarnessPin, manifestPayload, validateAction, verifyManifest, type DiscoverySnapshot, type InstallHarness, type Profile, type VerifiedManifest } from "../src/bootstrap/contracts/index.ts"
import { PROFILE_CATALOG } from "../src/bootstrap/profiles/catalog.ts"
import { desiredState, type DesiredState } from "../src/bootstrap/profiles/desired.ts"
import { planHarnessVersions, planProfileChange, rebaseProfile } from "../src/bootstrap/profiles/upgrade.ts"
import { DIGEST, DISCOVERY_DARWIN, INSTALL_CLAUDE, MANIFEST_UNSIGNED, PROFILE_FULL_HARNESS, PROFILE_LAUNCH_NODE, PROFILE_SESSION_ONLY, TRUST_ROOT_TEMPLATE } from "./bootstrap/fixtures.ts"
import { deepFreeze } from "./bootstrap/profiles-fixtures.ts"

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))
const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

// A manifest signed with an ephemeral key, verified against a trust root holding only that key.
const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const root = { ...TRUST_ROOT_TEMPLATE, keys: [{ ...TRUST_ROOT_TEMPLATE.keys[0]!, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }] }
const MANIFEST: VerifiedManifest = value(
  verifyManifest({ ...MANIFEST_UNSIGNED, signatures: [{ keyID: "hub-release-1", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(MANIFEST_UNSIGNED)), privateKey).toString("base64") }] }, root),
)

const claudeAt = (version: string, installMethod: "hub" | "native"): DiscoverySnapshot => ({
  ...DISCOVERY_DARWIN,
  harnesses: [
    DISCOVERY_DARWIN.harnesses[0]!,
    { id: "claude-code", installed: true, path: "/Users/dev/.local/share/hub/harnesses/claude-code/current/claude", version, installMethod, health: { state: "unverified", probes: [] } },
  ],
})
const claudeOnly: Profile = { ...PROFILE_SESSION_ONLY, harnesses: ["claude-code"] }
const desired = (profile: Profile, snapshot: DiscoverySnapshot): DesiredState => value(desiredState(profile, snapshot))

describe("planProfileChange", () => {
  test("session-only → launch-node is an upgrade that adds the node service and launches", () => {
    const change = value(planProfileChange(PROFILE_SESSION_ONLY, PROFILE_LAUNCH_NODE))
    expect(change.direction).toBe("upgrade")
    expect(change.adds).toEqual(["service:node", "launch"])
    expect(change.removes).toEqual([])
  })

  test("raising escalation counts as adding a capability", () => {
    const change = value(planProfileChange(PROFILE_LAUNCH_NODE, { ...PROFILE_LAUNCH_NODE, escalation: "explicit" }))
    expect(change).toMatchObject({ direction: "upgrade", adds: ["escalation:explicit"] })
  })

  test("removing anything is a downgrade and needs explicit consent", () => {
    expect(codes(planProfileChange(PROFILE_FULL_HARNESS, PROFILE_SESSION_ONLY))).toEqual(["downgrade_rejected"])
    const change = value(planProfileChange(PROFILE_FULL_HARNESS, PROFILE_SESSION_ONLY, { allowDowngrade: true }))
    expect(change.direction).toBe("downgrade")
    expect(change.removes).toEqual(["harness:claude-code", "harness:codex", "runtime:openshell", "service:node", "service:claude-code", "service:codex-spoke", "launch", "escalation:explicit"])
    // There is no typed uninstall action: removals are left in place (undo them with a rollback).
    expect(change.retained).toEqual(change.removes)
  })

  test("the same profile is no change; a shorter launch bound is a setting, not a downgrade", () => {
    expect(value(planProfileChange(PROFILE_LAUNCH_NODE, PROFILE_LAUNCH_NODE)).direction).toBe("same")
    expect(value(planProfileChange(PROFILE_LAUNCH_NODE, { ...PROFILE_LAUNCH_NODE, launch: { enabled: true, maxDurationS: 60 } })).direction).toBe("same")
  })

  test("invalid profiles are rejected", () => {
    expect(codes(planProfileChange(PROFILE_SESSION_ONLY, { ...PROFILE_SESSION_ONLY, version: 3 }))).toEqual(["unsupported_version"])
  })
})

describe("rebaseProfile", () => {
  const base = PROFILE_CATALOG.profiles["launch-node"]
  const next: Profile = { ...base, harnesses: ["opencode", "claude-code"], launch: { enabled: true, maxDurationS: 7200 } }

  test("an unchanged profile follows the new defaults", () => {
    const r = value(rebaseProfile(deepFreeze({ current: base, base, next })))
    expect(r.profile).toEqual(next)
    expect(r.updated).toEqual(["harnesses", "launch"])
    expect(r.kept).toEqual([])
  })

  test("fields the user changed are kept and reported, never overwritten", () => {
    const current: Profile = { ...base, launch: { enabled: true, maxDurationS: 900 } }
    const r = value(rebaseProfile({ current, base, next }))
    expect(r.profile.launch).toEqual({ enabled: true, maxDurationS: 900 })
    expect(r.profile.harnesses).toEqual(["opencode", "claude-code"])
    expect(r.kept).toEqual(["launch"])
    expect(r.updated).toEqual(["harnesses"])
  })

  test("new defaults never raise escalation or opt in to OpenShell", () => {
    const risky: Profile = { ...base, escalation: "explicit", runtimes: ["openshell"] }
    const r = value(rebaseProfile({ current: base, base, next: risky }))
    expect(r.profile.escalation).toBe("never")
    expect(r.profile.runtimes).toEqual([])
    expect(r.refused).toEqual(["runtimes", "escalation"])
  })

  test("a rebase that would be invalid fails instead of guessing", () => {
    const current: Profile = { ...PROFILE_CATALOG.profiles["full-harness"], harnesses: ["opencode"], services: ["node"] }
    const nextFull: Profile = { ...PROFILE_CATALOG.profiles["full-harness"], services: ["node", "claude-code"], harnesses: ["opencode", "claude-code"] }
    // The user narrowed harnesses to OpenCode; the new default adds the Claude Code service, which needs its harness.
    const baseFull: Profile = { ...PROFILE_CATALOG.profiles["full-harness"], harnesses: ["opencode", "claude-code"], services: ["node"] }
    expect(codes(rebaseProfile({ current, base: baseFull, next: nextFull }))).toContain("inconsistent")
  })

  test("all three must be the same profile", () => {
    expect(codes(rebaseProfile({ current: PROFILE_SESSION_ONLY, base, next }))).toEqual(["invalid_value"])
  })
})

describe("planHarnessVersions", () => {
  test("a harness the user installed is kept and never replaced", () => {
    const plan = value(planHarnessVersions({ desired: desired(PROFILE_SESSION_ONLY, DISCOVERY_DARWIN), manifest: MANIFEST, installed: {} }))
    expect(plan).toEqual([{ harness: "opencode", decision: "keep-user-managed", from: "2.0.26" }])
  })

  test("a missing harness is installed from its pin, with no previous version", () => {
    const [step] = value(planHarnessVersions({ desired: desired(claudeOnly, DISCOVERY_DARWIN), manifest: MANIFEST, installed: {} }))
    expect(step).toMatchObject({ harness: "claude-code", decision: "install", to: "2.1.90" })
    expect(validateAction(step!.action).ok).toBe(true)
    expect(checkHarnessPin(MANIFEST, step!.action!).ok).toBe(true)
    expect(step!.action!.previous).toBeUndefined()
  })

  test("a hub install below the pin is upgraded, recording the version a rollback restores", () => {
    const [step] = value(planHarnessVersions({ desired: desired(claudeOnly, claudeAt("2.1.85", "hub")), manifest: MANIFEST, installed: { "claude-code": { version: "2.1.85", sha256: DIGEST.c, txID: "tx_one" } } }))
    expect(step).toMatchObject({ harness: "claude-code", decision: "upgrade", from: "2.1.85", to: "2.1.90" })
    const { id: _id, summary: _summary, ...action } = step!.action!
    const { id: _fid, summary: _fsummary, ...expected } = INSTALL_CLAUDE as InstallHarness
    expect(action).toEqual(expected)
  })

  test("a newer hub install is only downgraded with explicit consent", () => {
    const input = { desired: desired(claudeOnly, claudeAt("2.2.0", "hub")), manifest: MANIFEST, installed: { "claude-code": { version: "2.2.0", sha256: DIGEST.a, txID: "tx_two" } } }
    expect(codes(planHarnessVersions(input))).toEqual(["downgrade_rejected"])
    const [step] = value(planHarnessVersions({ ...input, allowDowngrade: true }))
    expect(step).toMatchObject({ decision: "downgrade", from: "2.2.0", to: "2.1.90" })
    expect(step!.action!.previous).toEqual({ version: "2.2.0", sha256: DIGEST.a })
  })

  test("never below the security floor, even with consent", () => {
    const input = { desired: desired(claudeOnly, claudeAt("2.2.0", "hub")), manifest: MANIFEST, installed: { "claude-code": { version: "2.2.0", sha256: DIGEST.a, txID: "tx_two" } }, floors: { "claude-code": "2.2.0" }, allowDowngrade: true }
    expect(codes(planHarnessVersions(input))).toEqual(["below_security_floor"])
  })

  test("the pinned version already installed is kept; the same version with other bytes is tampering", () => {
    const same = { desired: desired(claudeOnly, claudeAt("2.1.90", "hub")), manifest: MANIFEST }
    expect(value(planHarnessVersions({ ...same, installed: { "claude-code": { version: "2.1.90", sha256: DIGEST.f, txID: "tx_two" } } }))).toEqual([
      { harness: "claude-code", decision: "keep", from: "2.1.90", to: "2.1.90" },
    ])
    expect(codes(planHarnessVersions({ ...same, installed: { "claude-code": { version: "2.1.90", sha256: DIGEST.a, txID: "tx_two" } } }))).toEqual(["integrity_mismatch"])
  })

  test("a harness this release does not pin for the target fails explicitly", () => {
    expect(codes(planHarnessVersions({ desired: desired({ ...PROFILE_SESSION_ONLY, harnesses: ["codex"] }, DISCOVERY_DARWIN), manifest: MANIFEST, installed: {} }))).toEqual(["unpinned_artifact"])
  })

  test("a hub install the history does not know, or that changed version since, is inconsistent", () => {
    expect(codes(planHarnessVersions({ desired: desired(claudeOnly, claudeAt("2.1.85", "hub")), manifest: MANIFEST, installed: {} }))).toEqual(["inconsistent"])
    expect(
      codes(planHarnessVersions({ desired: desired(claudeOnly, claudeAt("2.1.88", "hub")), manifest: MANIFEST, installed: { "claude-code": { version: "2.1.85", sha256: DIGEST.c, txID: "tx_one" } } })),
    ).toEqual(["inconsistent"])
  })
})
