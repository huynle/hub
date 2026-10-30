// The plan contributors the CLI adds beside the harness adapters and node services (HBS-13):
//   hubctlContributor     with a verified manifest that pins hubctl for this host: install-artifact into
//                         user-bin:hubctl (the stable authority services and MCP clients run), then the hub alias
//                         (link-executable user-bin:hub → user-bin:hubctl). Without one: nothing.
//   enrollmentContributor inline enrollment: one enroll-machine for the given hub, only while the machine is not
//                         enrolled with it. Never a credential in the action.
//   refusing              turns a contributor's Result refusal into a typed PlanRefusal (planSetup has no refusal
//                         channel for contributors), so the CLI maps it through exitFor instead of crashing.
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { findSecrets, manifestPayload, validateAction, verifyManifest, type ArtifactManifest, type PlanInput, type VerifiedManifest } from "../src/bootstrap/contracts/index.ts"
import { enrollmentContributor, hubctlContributor, PlanRefusal, refusing } from "../src/setup/contributors.ts"
import { DISCOVERY_DARWIN, MANIFEST_UNSIGNED, PROFILE_SESSION_ONLY, TRUST_ROOT_TEMPLATE } from "./bootstrap/fixtures.ts"

function verified(body: Omit<ArtifactManifest, "signatures"> = MANIFEST_UNSIGNED): VerifiedManifest {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const manifest = { ...body, signatures: [{ keyID: "hub-release-1", algorithm: "ed25519" as const, value: sign(null, Buffer.from(manifestPayload(body)), privateKey).toString("base64") }] }
  const root = { ...TRUST_ROOT_TEMPLATE, keys: [{ ...TRUST_ROOT_TEMPLATE.keys[0]!, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }] }
  const r = verifyManifest(manifest, root)
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

const input: PlanInput = { snapshot: DISCOVERY_DARWIN, profile: PROFILE_SESSION_ONLY }

describe("hubctlContributor", () => {
  test("installs the pinned hubctl for this target into user-bin:hubctl and links hub to it", () => {
    const manifest = verified()
    const actions = hubctlContributor({ manifest })(input)
    expect(actions.map((a) => a.kind)).toEqual(["install-artifact", "link-executable"])
    const [install, link] = actions as [Extract<(typeof actions)[number], { kind: "install-artifact" }>, Extract<(typeof actions)[number], { kind: "link-executable" }>]
    const pinned = MANIFEST_UNSIGNED.artifacts.find((a) => a.target === DISCOVERY_DARWIN.host.target)!
    expect(install).toMatchObject({ artifact: "hubctl", version: "0.8.0", target: DISCOVERY_DARWIN.host.target, sha256: pinned.sha256, path: { root: "user-bin", rel: "hubctl" } })
    expect(link).toMatchObject({ path: { root: "user-bin", rel: "hub" }, target: { root: "user-bin", rel: "hubctl" } })
    for (const a of actions) expect(validateAction(a).ok).toBe(true)
  })

  test("no manifest, or no artifact for this target: nothing", () => {
    expect(hubctlContributor({})(input)).toEqual([])
    const other = verified({ ...MANIFEST_UNSIGNED, artifacts: MANIFEST_UNSIGNED.artifacts.filter((a) => a.target !== DISCOVERY_DARWIN.host.target) })
    expect(hubctlContributor({ manifest: other })(input)).toEqual([])
  })
})

// HBS-12 acceptance (E3): a converged host plans no hubctl install and no hub link, whatever path the hubctl that
// previews runs from: the installed file is compared by digest with the pinned artifact, the link by its target.
describe("hubctlContributor on a converged host", () => {
  const pinned = MANIFEST_UNSIGNED.artifacts.find((a) => a.target === DISCOVERY_DARWIN.host.target)!
  const inspector = (files: Record<string, string>, links: Record<string, string>) => ({
    sha256: (ref: { root: string; rel: string }) => files[`${ref.root}:${ref.rel}`],
    linksTo: (ref: { root: string; rel: string }, target: { root: string; rel: string }) => links[`${ref.root}:${ref.rel}`] === `${target.root}:${target.rel}`,
  })

  test("the pinned hubctl already installed and hub linked to it: nothing", () => {
    const installed = inspector({ "user-bin:hubctl": pinned.sha256 }, { "user-bin:hub": "user-bin:hubctl" })
    expect(hubctlContributor({ manifest: verified(), installed })(input)).toEqual([])
  })

  test("the pinned hubctl installed, the link missing or elsewhere: only the link", () => {
    for (const links of [{}, { "user-bin:hub": "home:elsewhere" }] as Record<string, string>[]) {
      const actions = hubctlContributor({ manifest: verified(), installed: inspector({ "user-bin:hubctl": pinned.sha256 }, links) })(input)
      expect(actions.map((a) => a.id)).toEqual(["link-hub"])
    }
  })

  test("another hubctl (other bytes) or none: installed, and linked when needed", () => {
    const other = `sha256:${"ab".repeat(32)}`
    expect(hubctlContributor({ manifest: verified(), installed: inspector({ "user-bin:hubctl": other }, { "user-bin:hub": "user-bin:hubctl" }) })(input).map((a) => a.id)).toEqual(["install-hubctl"])
    expect(hubctlContributor({ manifest: verified(), installed: inspector({}, {}) })(input).map((a) => a.id)).toEqual(["install-hubctl", "link-hub"])
  })
})

describe("enrollmentContributor", () => {
  test("enrolls with the given hub while the machine is not enrolled with it", () => {
    const actions = enrollmentContributor({ server: "https://hub.example", machineName: "laptop", enrolledWith: undefined })(input)
    expect(actions).toEqual([{ id: "enroll-machine", kind: "enroll-machine", escalation: "user", summary: "Enroll this machine with https://hub.example (device code; you approve it on the hub)", server: "https://hub.example", machineName: "laptop" }])
    expect(validateAction(actions[0]!).ok).toBe(true)
    expect(findSecrets(actions)).toEqual([])
  })

  test("already enrolled with that hub, or no hub given: nothing", () => {
    expect(enrollmentContributor({ server: "https://hub.example", machineName: "laptop", enrolledWith: "https://hub.example" })(input)).toEqual([])
    expect(enrollmentContributor({ machineName: "laptop", enrolledWith: undefined })(input)).toEqual([])
  })
})

describe("refusing", () => {
  test("a Result refusal becomes a typed PlanRefusal with the issue's error code", () => {
    const contributor = refusing(() => ({ ok: false, issues: [{ path: "/node", code: "missing_field", message: "needs workspace roots" }] }))
    let caught: unknown
    try {
      contributor(input)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PlanRefusal)
    expect((caught as PlanRefusal).code).toBe("invalid")
    expect((caught as PlanRefusal).message).toContain("needs workspace roots")
    const noManager = refusing(() => ({ ok: false, issues: [{ path: "/managers/service", code: "no_service_manager", message: "none" }] }))
    expect(() => noManager(input)).toThrow(PlanRefusal)
    try {
      noManager(input)
    } catch (error) {
      expect((error as PlanRefusal).code).toBe("no_service_manager")
    }
  })

  test("a success passes its actions through", () => {
    expect(refusing(() => ({ ok: true, value: [] }))(input)).toEqual([])
  })
})
