// The Ansible renderer (packages/cli/src/bootstrap/ansible): a profile, or a previewed plan, becomes the vars of the
// optional contrib/ansible hub_bootstrap role. The role only stages the signed hubctl and delegates to `hubctl setup
// preview/apply/verify`, so the vars must carry exactly the direct path's inputs (the canonical profile, the flags)
// and the pins of the signed manifest, never a secret, and never anything that would make Ansible enroll a machine.
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import {
  digestOf,
  type ErrorCode,
  findSecrets,
  manifestPayload,
  planDigest,
  validateProfile,
  verifyManifest,
  type Action,
  type ArtifactManifest,
  type SetupPlan,
  type TrustRoot,
  type VerifiedManifest,
} from "../src/bootstrap/contracts/index.ts"
import { ANSIBLE_VARS_SCHEMA, ROLE_FLAGS, directCommands, renderRoleVars, renderYAML, type RenderInput, type RoleVars } from "../src/bootstrap/ansible/index.ts"
import * as F from "./bootstrap/fixtures.ts"

function verifiedManifest(): VerifiedManifest {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const root: TrustRoot = {
    ...F.TRUST_ROOT_TEMPLATE,
    keys: [{ keyID: "hub-release-1", algorithm: "ed25519", publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), status: "active" }],
  }
  const signed: ArtifactManifest = {
    ...F.MANIFEST_UNSIGNED,
    signatures: [{ keyID: "hub-release-1", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(F.MANIFEST_UNSIGNED)), privateKey).toString("base64") }],
  }
  const v = verifyManifest(signed, root)
  if (!v.ok) throw new Error(JSON.stringify(v.issues))
  return v.value
}

const MANIFEST = verifiedManifest()
const BASE = "https://github.com/huynle/hub/releases/download/v0.8.0"

/** The hubctl install of PLAN_LAUNCH_NODE, pinned to the manifest's darwin-arm64 digest. */
const PINNED_INSTALL = { ...F.ACTIONS["install-artifact"], sha256: F.MANIFEST_UNSIGNED.artifacts[0]!.sha256 } as Action

/** PLAN_LAUNCH_NODE without enrollment (a separate step) and with the hubctl install the manifest pins. */
const PLAN: SetupPlan = {
  ...F.PLAN_LAUNCH_NODE,
  actions: F.PLAN_LAUNCH_NODE.actions.filter((a) => a.kind !== "enroll-machine").map((a) => (a.kind === "install-artifact" ? PINNED_INSTALL : a)),
}

const input = (patch: Partial<RenderInput> = {}): RenderInput => ({
  profile: F.PROFILE_LAUNCH_NODE,
  manifest: MANIFEST,
  options: { releaseBaseURL: BASE },
  ...patch,
})

function rendered(patch: Partial<RenderInput> = {}): { vars: RoleVars; yaml: string } {
  const r = renderRoleVars(input(patch))
  if (!r.ok) throw new Error(`render failed: ${r.error.code}: ${r.error.message}`)
  return { vars: r.vars, yaml: r.yaml }
}

function refused(patch: Partial<RenderInput>, code: ErrorCode) {
  const r = renderRoleVars(input(patch))
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error.code).toBe(code)
}

describe("renderRoleVars from a profile", () => {
  test("carries the canonical profile and its digest", () => {
    const { vars } = rendered()
    expect(vars.hub_bootstrap_vars_schema).toBe(ANSIBLE_VARS_SCHEMA)
    expect(vars.hub_bootstrap_vars_version).toBe(1)
    // v1.1: the role always plans with a separate enrollment.
    expect(vars.hub_bootstrap_profile).toEqual({ ...F.PROFILE_LAUNCH_NODE, enrollment: "separate" })
    expect(vars.hub_bootstrap_profile_digest).toBe(digestOf({ ...F.PROFILE_LAUNCH_NODE, enrollment: "separate" }))
    expect(vars.hub_bootstrap_expected_plan).toBeNull()
  })

  test("pins every hubctl artifact and harness of the verified manifest", () => {
    const { vars } = rendered()
    expect(vars.hub_bootstrap_release).toBe("0.8.0")
    expect(vars.hub_bootstrap_minimum_version).toBe("0.7.0")
    expect(vars.hub_bootstrap_manifest_url).toBe(`${BASE}/hubctl-manifest.json`)
    for (const a of F.MANIFEST_UNSIGNED.artifacts)
      expect(vars.hub_bootstrap_artifacts[a.target]).toEqual({ url: `${BASE}/${a.file}`, file: a.file, size: a.size, sha256: a.sha256 })
    expect(vars.hub_bootstrap_harness_pins).toEqual(F.HARNESS_PINS.map((p) => ({ harness: p.harness, version: p.version, target: p.target, sha256: p.sha256 })))
  })

  test("consent flags default to off and are never implied", () => {
    const { vars } = rendered()
    expect(vars.hub_bootstrap_escalate).toBe(false)
    expect(vars.hub_bootstrap_confirm_activation).toBe(false)
    expect(vars.hub_bootstrap_allow_downgrade).toBe(false)
    expect(vars.hub_bootstrap_require_ready).toBe(true)
  })

  test("refuses an invalid or future profile", () => {
    refused({ profile: F.PROFILE_INVALID.unboundedLaunch!.value }, "invalid")
    refused({ profile: F.PROFILE_INVALID.fromTheFuture!.value }, "invalid")
  })

  test("refuses escalation the profile never allows", () => {
    refused({ profile: F.PROFILE_LAUNCH_NODE, options: { releaseBaseURL: BASE, escalate: true } }, "usage")
    expect(rendered({ profile: F.PROFILE_FULL_HARNESS, options: { releaseBaseURL: BASE, escalate: true } }).vars.hub_bootstrap_escalate).toBe(true)
  })

  test("refuses a non-https, credentialed or parameterised release URL", () => {
    for (const url of ["http://github.com/x", "https://user:pw@github.com/x", "https://github.com/x?sig=abc", "https://github.com/x#frag", "ftp://x"])
      refused({ options: { releaseBaseURL: url } }, "usage")
  })

  test("refuses to render anything secret-shaped (scanned after rendering)", () => {
    refused({ options: { releaseBaseURL: "https://github.com/hat_abcdefghijklmnop/releases" } }, "invalid")
  })
})

describe("renderRoleVars from a previewed plan", () => {
  test("binds the vars to the plan's digest, host and snapshot", () => {
    const { vars } = rendered({ plan: PLAN, options: { releaseBaseURL: BASE, confirmActivation: true } })
    expect(vars.hub_bootstrap_expected_plan).toEqual({ planDigest: planDigest(PLAN), hostFingerprint: PLAN.hostFingerprint, snapshotDigest: PLAN.snapshotDigest, target: PLAN.target })
  })

  test("refuses a plan for another profile", () => {
    refused({ profile: F.PROFILE_SESSION_ONLY, plan: PLAN, options: { releaseBaseURL: BASE, confirmActivation: true } }, "invalid")
  })

  test("refuses an invalid plan", () => {
    refused({ plan: F.PLAN_INVALID.smuggledAction!.value }, "invalid")
  })

  test("enrollment stays a separate, explicit step", () => {
    refused({ plan: { ...F.PLAN_LAUNCH_NODE, actions: F.PLAN_LAUNCH_NODE.actions.map((a) => (a.kind === "install-artifact" ? PINNED_INSTALL : a)) }, options: { releaseBaseURL: BASE, confirmActivation: true } }, "usage")
  })

  test("service activation needs explicit confirmation", () => {
    refused({ plan: PLAN }, "needs_user")
  })

  test("an elevated plan needs explicit escalation", () => {
    const elevated: SetupPlan = { ...F.PLAN_ELEVATED, actions: [{ ...F.PLAN_ELEVATED.actions[0]!, sha256: F.MANIFEST_UNSIGNED.artifacts[0]!.sha256 } as Action] }
    refused({ profile: { ...F.PROFILE_SESSION_ONLY, escalation: "explicit" }, plan: elevated }, "escalation_required")
    expect(rendered({ profile: { ...F.PROFILE_SESSION_ONLY, escalation: "explicit" }, plan: elevated, options: { releaseBaseURL: BASE, escalate: true } }).vars.hub_bootstrap_escalate).toBe(true)
    refused({ profile: F.PROFILE_SESSION_ONLY, plan: elevated, options: { releaseBaseURL: BASE, escalate: true } }, "usage")
  })

  test("the plan's hubctl install must be the manifest's pin", () => {
    refused({ plan: { ...PLAN, actions: PLAN.actions.map((a) => (a.kind === "install-artifact" ? F.ACTIONS["install-artifact"] : a)) }, options: { releaseBaseURL: BASE, confirmActivation: true } }, "integrity_mismatch")
    refused({ plan: { ...PLAN, actions: PLAN.actions.map((a) => (a.kind === "install-artifact" ? { ...PINNED_INSTALL, version: "0.7.9" } : a)) }, options: { releaseBaseURL: BASE, confirmActivation: true } }, "unpinned_artifact")
  })

  test("the plan's harness installs must be the manifest's pins", () => {
    const plan = F.PLAN_HARNESS_INSTALL
    expect(rendered({ profile: F.PROFILE_SESSION_ONLY, plan }).vars.hub_bootstrap_expected_plan?.planDigest).toBe(planDigest(plan))
    for (const [label, code] of [["digestMismatch", "integrity_mismatch"], ["unpinnedVersion", "unpinned_artifact"], ["otherHubRelease", "unpinned_artifact"]] as const) {
      const install = F.HARNESS_PIN_INVALID[label]!.value as Extract<Action, { kind: "install-harness" }>
      // v1.1: the version an install puts in place is the one made current.
      const select = { ...F.ACTIONS["select-harness-version"], version: install.version, target: { root: "data", rel: `hub/harnesses/opencode/${install.version}` } }
      const bad = { ...plan, actions: plan.actions.map((a) => (a.id === "install-opencode" ? install : a.id === "select-opencode" ? select : a)) }
      refused({ profile: F.PROFILE_SESSION_ONLY, plan: bad }, code)
    }
  })

  test("refuses a plan for a target the manifest has no hubctl for", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const body = { ...F.MANIFEST_UNSIGNED, artifacts: F.MANIFEST_UNSIGNED.artifacts.filter((a) => a.target !== "darwin-arm64") }
    const m = verifyManifest(
      { ...body, signatures: [{ keyID: "k", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(body)), privateKey).toString("base64") }] },
      { ...F.TRUST_ROOT_TEMPLATE, keys: [{ keyID: "k", algorithm: "ed25519", publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), status: "active" }] },
    )
    if (!m.ok) throw new Error("manifest")
    refused({ manifest: m.value, plan: F.PLAN_HARNESS_INSTALL, profile: F.PROFILE_SESSION_ONLY }, "wrong_platform")
  })
})

describe("direct and rendered paths have the same plan semantics", () => {
  test("the YAML parses back to exactly the vars (canonical, deterministic)", () => {
    const { vars, yaml } = rendered({ plan: PLAN, options: { releaseBaseURL: BASE, confirmActivation: true } })
    expect(Bun.YAML.parse(yaml)).toEqual(vars as unknown as Record<string, unknown>)
    expect(renderYAML(vars)).toBe(yaml)
    expect(rendered({ plan: PLAN, options: { releaseBaseURL: BASE, confirmActivation: true } }).yaml).toBe(yaml)
  })

  test("the profile the role hands hubctl is the direct path's profile, byte for byte", () => {
    const { yaml } = rendered()
    const back = (Bun.YAML.parse(yaml) as RoleVars).hub_bootstrap_profile
    const checked = validateProfile(back)
    expect(checked.ok).toBe(true)
    expect(digestOf(back)).toBe(digestOf({ ...F.PROFILE_LAUNCH_NODE, enrollment: "separate" }))
  })

  test("the role's commands are the direct commands, with consent only as asked", () => {
    const paths = { hubctl: "/h/.cache/hub/bootstrap/0.8.0/hubctl-darwin-arm64", profile: "/h/.local/state/hub/ansible/profile.json", preview: "/h/.local/state/hub/ansible/preview.json", manifest: "/h/.cache/hub/bootstrap/0.8.0/hubctl-manifest.json" }
    const plain = directCommands(rendered().vars, paths)
    expect(plain.preview).toEqual([paths.hubctl, "setup", "preview", "--profile", paths.profile, "--manifest", paths.manifest, "--out", paths.preview, "--json"])
    expect(plain.apply).toEqual([paths.hubctl, "setup", "apply", "--preview", paths.preview, "--manifest", paths.manifest, "--json"])
    expect(plain.verify).toEqual([paths.hubctl, "setup", "verify", "--profile", paths.profile, "--json"])
    const consenting = directCommands(rendered({ profile: F.PROFILE_FULL_HARNESS, options: { releaseBaseURL: BASE, escalate: true, confirmActivation: true, allowDowngrade: true } }).vars, paths)
    expect(consenting.apply.slice(-4)).toEqual(["--escalate", "--confirm-activation", "--allow-downgrade", "--json"])
    expect(consenting.preview).toEqual(plain.preview)
    expect(Object.values(ROLE_FLAGS).sort()).toEqual(["--allow-downgrade", "--confirm-activation", "--escalate"])
  })

  test("no command ever enrolls the machine", () => {
    const all = Object.values(directCommands(rendered().vars, { hubctl: "/x/hubctl", profile: "/x/p", preview: "/x/q", manifest: "/x/m" })).flat()
    expect(all).not.toContain("enroll")
    expect(all).not.toContain("machine")
  })
})

describe("secret scan of the rendered output", () => {
  test("no rendered vars or YAML carry a credential", () => {
    for (const r of [rendered(), rendered({ plan: PLAN, options: { releaseBaseURL: BASE, confirmActivation: true } }), rendered({ profile: F.PROFILE_SESSION_ONLY, plan: F.PLAN_HARNESS_INSTALL })]) {
      expect(findSecrets(r.vars)).toEqual([])
      expect(findSecrets(Bun.YAML.parse(r.yaml))).toEqual([])
      expect(r.yaml).not.toMatch(/token|password|secret|credential/i)
    }
  })
})
