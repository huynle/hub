// Contract amendment v1.1 in the Ansible renderer: the profile it hands the role always plans with a separate
// enrollment (so the role's plan digest equals the direct path's with --enrollment separate), version-1 profiles are
// migrated, and a plan can be cross-checked against the snapshot it was made from with the contract's one canonical
// snapshot digest.
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { digestOf, manifestPayload, planDigest, snapshotDigest, verifyManifest, type VerifiedManifest } from "../src/bootstrap/contracts/index.ts"
import { renderRoleVars, type RenderInput } from "../src/bootstrap/ansible/index.ts"
import { planSetup } from "../src/bootstrap/preview/index.ts"
import * as F from "./bootstrap/fixtures.ts"

function verifiedManifest(): VerifiedManifest {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const root = { ...F.TRUST_ROOT_TEMPLATE, keys: [{ ...F.TRUST_ROOT_TEMPLATE.keys[0]!, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }] }
  const v = verifyManifest({ ...F.MANIFEST_UNSIGNED, signatures: [{ keyID: "hub-release-1", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(F.MANIFEST_UNSIGNED)), privateKey).toString("base64") }] }, root)
  if (!v.ok) throw new Error(JSON.stringify(v.issues))
  return v.value
}

const MANIFEST = verifiedManifest()
const BASE = "https://github.com/huynle/hub/releases/download/v0.8.0"
const render = (patch: Partial<RenderInput> = {}) => renderRoleVars({ profile: F.PROFILE_LAUNCH_NODE, manifest: MANIFEST, options: { releaseBaseURL: BASE, confirmActivation: true }, ...patch })

describe("v1.1 the Ansible path enrolls separately", () => {
  test("the rendered profile sets enrollment: separate (and its digest is of exactly that profile)", () => {
    const r = render()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.vars.hub_bootstrap_profile).toEqual({ ...F.PROFILE_LAUNCH_NODE, enrollment: "separate" })
    expect(r.vars.hub_bootstrap_profile_digest).toBe(digestOf({ ...F.PROFILE_LAUNCH_NODE, enrollment: "separate" }))
  })

  test("an explicitly inline profile is rendered separate too", () => {
    const r = render({ profile: { ...F.PROFILE_LAUNCH_NODE, enrollment: "inline" } })
    expect(r.ok && r.vars.hub_bootstrap_profile.enrollment).toBe("separate")
  })

  test("a version-1 profile is migrated first", () => {
    const r = render({ profile: F.PROFILE_V1 })
    expect(r.ok && r.vars.hub_bootstrap_profile).toEqual({ ...F.PROFILE_SESSION_ONLY, enrollment: "separate" })
  })

  test("the plan hubctl makes from the rendered profile has the direct path's digest, and renders", () => {
    const r = render()
    if (!r.ok) throw new Error(r.error.message)
    const withEnroll = [() => [F.ACTIONS["enroll-machine"]]]
    const ansible = planSetup({ snapshot: F.DISCOVERY_DARWIN, profile: r.vars.hub_bootstrap_profile, links: () => undefined, contributors: withEnroll })
    const direct = planSetup({ snapshot: F.DISCOVERY_DARWIN, profile: F.PROFILE_LAUNCH_NODE, links: () => undefined, contributors: withEnroll, enrollment: "separate" })
    if (!ansible.ok || !direct.ok) throw new Error("plan failed")
    expect(planDigest(ansible.value.plan)).toBe(planDigest(direct.value.plan))
    expect(ansible.value.plan.actions.map((a) => a.kind)).not.toContain("enroll-machine")
    const bound = render({ plan: ansible.value.plan })
    expect(bound.ok && bound.vars.hub_bootstrap_expected_plan?.planDigest).toBe(planDigest(ansible.value.plan))
  })
})

describe("v1.1 canonical snapshot digest", () => {
  const planned = planSetup({ snapshot: F.DISCOVERY_DARWIN, profile: F.PROFILE_LAUNCH_NODE, links: () => undefined, enrollment: "separate" })
  const plan = planned.ok ? planned.value.plan : undefined

  test("a plan rendered with its snapshot must have been made from it (capture time excluded)", () => {
    expect(plan?.snapshotDigest).toBe(snapshotDigest(F.DISCOVERY_DARWIN))
    expect(render({ plan, snapshot: { ...F.DISCOVERY_DARWIN, capturedAt: F.T0 + 10 * F.MINUTE } }).ok).toBe(true)
    const r = render({ plan, snapshot: { ...F.DISCOVERY_DARWIN, configs: [] } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("preview_stale")
  })

  test("an invalid snapshot is refused", () => {
    const r = render({ plan, snapshot: F.DISCOVERY_INVALID.secretInSnapshot!.value })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("invalid")
  })
})
