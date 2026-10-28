// Built-in profiles and profile → desired state. The catalog only produces valid contract profiles with safe
// defaults (never escalation, OpenShell only when asked for); desired state is a pure function of (profile,
// snapshot) that fails explicitly on hosts it cannot serve instead of half-configuring them.
import { describe, expect, test } from "bun:test"
import { validateProfile } from "../src/bootstrap/contracts/index.ts"
import { defaultProfile, PROFILE_CATALOG } from "../src/bootstrap/profiles/catalog.ts"
import { desiredState } from "../src/bootstrap/profiles/desired.ts"
import { DISCOVERY_DARWIN, DISCOVERY_LINUX_CONTAINER, DISCOVERY_UNSUPPORTED, PROFILE_FULL_HARNESS, PROFILE_LAUNCH_NODE, PROFILE_SESSION_ONLY } from "./bootstrap/fixtures.ts"
import { clone, deepFreeze } from "./bootstrap/profiles-fixtures.ts"

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))
const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

describe("profile catalog", () => {
  test("every built-in profile is a valid contract profile with safe defaults", () => {
    for (const profile of Object.values(PROFILE_CATALOG.profiles)) {
      expect(validateProfile(profile).ok).toBe(true)
      expect(profile.escalation).toBe("never")
      expect(profile.runtimes).toEqual([])
    }
    expect(PROFILE_CATALOG.revision).toBe(1)
  })

  test("the defaults match the documented profiles", () => {
    expect(value(defaultProfile("session-only"))).toEqual(PROFILE_SESSION_ONLY)
    expect(value(defaultProfile("launch-node"))).toEqual(PROFILE_LAUNCH_NODE)
    expect(value(defaultProfile("full-harness"))).toEqual({ ...PROFILE_FULL_HARNESS, runtimes: [], escalation: "never" })
  })

  test("chosen harnesses are put in harness order, and full-harness runs exactly their spokes", () => {
    const p = value(defaultProfile("full-harness", { harnesses: ["codex", "opencode"] }))
    expect(p.harnesses).toEqual(["opencode", "codex"])
    expect(p.services).toEqual(["node", "codex-spoke"])
  })

  test("OpenShell is opt-in", () => {
    expect(value(defaultProfile("launch-node", { openshell: true })).runtimes).toEqual(["openshell"])
    expect(value(defaultProfile("launch-node")).runtimes).toEqual([])
  })

  test("bad choices fail with the contract's codes", () => {
    expect(codes(defaultProfile("root-everything" as never))).toEqual(["invalid_value"])
    expect(codes(defaultProfile("session-only", { harnesses: [] }))).toEqual(["invalid_value"])
    expect(codes(defaultProfile("session-only", { harnesses: ["vim" as never] }))).toContain("invalid_value")
  })
})

describe("desiredState", () => {
  test("full-harness on macOS: every harness, service and runtime, with owners and probes", () => {
    const snapshot = clone(DISCOVERY_DARWIN)
    const withShell = { ...snapshot, runtimes: [{ id: "openshell" as const, present: true, version: "0.4.0" }] }
    const d = value(desiredState(deepFreeze(clone(PROFILE_FULL_HARNESS)), deepFreeze(withShell)))
    expect(d.profile).toEqual({ id: "full-harness", version: 2 })
    expect(d.target).toBe("darwin-arm64")
    expect(d.harnesses).toEqual([
      { id: "opencode", presence: "installed", owner: "user", version: "2.0.26", verify: ["version-exec", "provider-auth", "spoke-connected"] },
      { id: "claude-code", presence: "missing", owner: "hub", verify: ["version-exec", "provider-auth", "spoke-connected"] },
      { id: "codex", presence: "missing", owner: "hub", verify: ["version-exec", "provider-auth", "spoke-connected"] },
    ])
    expect(d.services).toEqual([
      { id: "node", manager: "launchd", activation: "explicit" },
      { id: "claude-code", manager: "launchd", activation: "explicit" },
      { id: "codex-spoke", manager: "launchd", activation: "explicit" },
    ])
    expect(d.runtimes).toEqual([{ id: "openshell", mode: "verify-only" }])
    expect(d.launch).toEqual({ enabled: true, maxDurationS: 3600 })
    expect(d.escalation).toBe("explicit")
  })

  test("session-only needs no service manager, so it works in a container", () => {
    const profile = { ...PROFILE_SESSION_ONLY, harnesses: ["claude-code"] as const }
    const d = value(desiredState(profile, DISCOVERY_LINUX_CONTAINER))
    expect(d.services).toEqual([])
    expect(d.harnesses[0]).toMatchObject({ id: "claude-code", presence: "installed", owner: "user" })
  })

  test("a harness hub installed is hub-owned", () => {
    const snapshot = { ...DISCOVERY_DARWIN, harnesses: [{ ...DISCOVERY_DARWIN.harnesses[0]!, installMethod: "hub" as const }] }
    expect(value(desiredState(PROFILE_SESSION_ONLY, snapshot)).harnesses[0]!.owner).toBe("hub")
  })

  test("services on a host without a user service manager fail explicitly", () => {
    const r = desiredState({ ...PROFILE_LAUNCH_NODE, harnesses: ["claude-code"] }, DISCOVERY_LINUX_CONTAINER)
    expect(codes(r)).toEqual(["unsupported_platform"])
  })

  test("an unsupported host is refused", () => {
    expect(codes(desiredState(PROFILE_SESSION_ONLY, DISCOVERY_UNSUPPORTED))).toEqual(["unsupported_platform"])
  })

  test("OpenShell is verified, never installed: absent or undiscovered fails explicitly", () => {
    const profile = { ...PROFILE_LAUNCH_NODE, runtimes: ["openshell"] as const }
    expect(codes(desiredState(profile, DISCOVERY_DARWIN))).toEqual(["unsupported_platform"])
    expect(codes(desiredState(profile, { ...DISCOVERY_DARWIN, runtimes: [] }))).toEqual(["unsupported_platform"])
  })

  test("invalid inputs are rejected with their validators' codes", () => {
    expect(codes(desiredState({ ...PROFILE_SESSION_ONLY, services: ["node"] }, DISCOVERY_DARWIN))).toContain("inconsistent")
    expect(codes(desiredState(PROFILE_SESSION_ONLY, { ...DISCOVERY_DARWIN, version: 2 }))).toContain("unsupported_version")
  })

  test("deterministic: the same inputs give the same desired state", () => {
    expect(desiredState(PROFILE_FULL_HARNESS, { ...DISCOVERY_DARWIN, runtimes: [{ id: "openshell", present: true }] })).toEqual(
      desiredState(clone(PROFILE_FULL_HARNESS), clone({ ...DISCOVERY_DARWIN, runtimes: [{ id: "openshell", present: true }] })),
    )
  })
})
