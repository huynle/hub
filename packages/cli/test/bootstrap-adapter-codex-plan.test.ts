// The Codex adapter's planner: the pinned install-harness, then select-harness-version, then verify-harness with
// real probes; no edit of ~/.codex by default (the spoke passes -c overrides and the wrapper --enable), and the one
// optional edit is TOML, so the setup planner turns it into an unmergeable-format manual edit.
import { describe, expect, test } from "bun:test"
import { createAdapterRegistry, harnessCurrentRef, harnessVersionRef, planDigest, validateAction, validateManualEdit, type Action, type HarnessAdapter } from "../src/bootstrap/contracts/index.ts"
import { CODEX_VERIFY_PROBES, planCodex, type CodexPlanOptions } from "../src/bootstrap/adapters/codex/plan.ts"
import { planSetup } from "../src/bootstrap/preview/plan.ts"
import { CODEX_DISCOVERY_LINUX, CODEX_PINS, codexDiscoveredAt, codexManifest, PROFILE_CODEX } from "./bootstrap/codex-fixtures.ts"
import { DISCOVERY_DARWIN, PROFILE_SESSION_ONLY } from "./bootstrap/fixtures.ts"

const options = (extra: Partial<CodexPlanOptions> = {}): CodexPlanOptions => ({ manifest: codexManifest(), ...extra })
const kinds = (actions: readonly Action[]) => actions.map((a) => a.kind)
const adapter = (o: CodexPlanOptions): HarnessAdapter => ({
  id: "codex",
  discover: async () => {
    throw new Error("unused")
  },
  plan: (input) => planCodex(input, o),
  verify: async () => {
    throw new Error("unused")
  },
})
const setup = (o: CodexPlanOptions, snapshot = CODEX_DISCOVERY_LINUX, profile = PROFILE_CODEX) => {
  const adapters = createAdapterRegistry()
  adapters.register(adapter(o))
  return planSetup({ snapshot, profile, links: () => undefined, adapters })
}

describe("planCodex", () => {
  test("plans the pinned install into its version directory, makes it current, then verifies with real probes", () => {
    const actions = planCodex({ snapshot: CODEX_DISCOVERY_LINUX, profile: PROFILE_CODEX }, options())
    expect(kinds(actions)).toEqual(["install-harness", "select-harness-version", "verify-harness"])
    for (const a of actions) expect(validateAction(a).ok).toBe(true)
    const [install, select, verify] = actions as [Extract<Action, { kind: "install-harness" }>, Extract<Action, { kind: "select-harness-version" }>, Extract<Action, { kind: "verify-harness" }>]
    const pin = CODEX_PINS.find((p) => p.target === "linux-x64")!
    expect(install).toMatchObject({
      harness: "codex",
      version: pin.version,
      target: "linux-x64",
      source: { manifest: codexManifest().release, url: pin.url, file: pin.file },
      size: pin.size,
      sha256: pin.sha256,
      evidence: ["sigstore"],
      path: harnessVersionRef("codex", pin.version),
      owner: "hub",
      rollback: "restore-previous",
      escalation: "user",
    })
    expect(select).toMatchObject({ harness: "codex", version: pin.version, path: harnessCurrentRef("codex"), target: harnessVersionRef("codex", pin.version) })
    expect(verify).toMatchObject({ id: "verify-codex", harness: "codex", probes: [...CODEX_VERIFY_PROBES] })
    expect(CODEX_VERIFY_PROBES).toEqual(["version-exec", "api-health", "provider-auth", "spoke-connected"])
  })

  test("uses the pin for the host's exact target (macOS: no upstream evidence listed)", () => {
    const actions = planCodex({ snapshot: DISCOVERY_DARWIN, profile: PROFILE_CODEX }, options())
    const install = actions.find((a) => a.kind === "install-harness") as Extract<Action, { kind: "install-harness" }>
    expect(install.target).toBe("darwin-arm64")
    expect(install.evidence).toEqual([])
  })

  test("is deterministic, and plans nothing when the profile has no Codex", () => {
    const input = { snapshot: CODEX_DISCOVERY_LINUX, profile: PROFILE_CODEX }
    expect(planCodex(input, options())).toEqual(planCodex(input, options()))
    expect(planCodex({ snapshot: CODEX_DISCOVERY_LINUX, profile: PROFILE_SESSION_ONLY }, options())).toEqual([])
  })

  test("no pin for this target: no install is planned, only verification (an unpinned Codex is never installed)", () => {
    const linuxArm = { ...CODEX_DISCOVERY_LINUX, host: { ...CODEX_DISCOVERY_LINUX.host, arch: "arm64", target: "linux-arm64" } }
    expect(kinds(planCodex({ snapshot: linuxArm, profile: PROFILE_CODEX }, options()))).toEqual(["verify-harness"])
  })

  test("the pinned version already current through hub: only verification", () => {
    expect(kinds(planCodex({ snapshot: codexDiscoveredAt("0.165.0"), profile: PROFILE_CODEX }, options()))).toEqual(["verify-harness"])
  })

  test("an older hub-installed version: install + select, recording the previous version for rollback", () => {
    const previous = { version: "0.160.0", sha256: `sha256:${"9".repeat(64)}` }
    const actions = planCodex({ snapshot: codexDiscoveredAt("0.160.0"), profile: PROFILE_CODEX }, options({ previous }))
    expect(kinds(actions)).toEqual(["install-harness", "select-harness-version", "verify-harness"])
    for (const a of actions.slice(0, 2)) expect((a as { previous?: unknown }).previous).toEqual(previous)
    // A recorded previous version that is not what discovery found is not trusted.
    const stale = planCodex({ snapshot: codexDiscoveredAt("0.150.0"), profile: PROFILE_CODEX }, options({ previous }))
    for (const a of stale.slice(0, 2)) expect((a as { previous?: unknown }).previous).toBeUndefined()
  })

  test("a Codex the user installed elsewhere (brew, npm) is left alone; hub installs and uses its own pinned copy", () => {
    const brew = { ...CODEX_DISCOVERY_LINUX, harnesses: CODEX_DISCOVERY_LINUX.harnesses.map((h) => (h.id === "codex" ? { ...h, installed: true, path: "/home/linuxbrew/.linuxbrew/bin/codex", version: "0.150.0", installMethod: "brew" as const } : h)) }
    const actions = planCodex({ snapshot: brew, profile: PROFILE_CODEX }, options())
    expect(kinds(actions)).toEqual(["install-harness", "select-harness-version", "verify-harness"])
    expect(JSON.stringify(actions)).not.toContain("linuxbrew")
  })

  test("never edits ~/.codex by default", () => {
    const actions = planCodex({ snapshot: CODEX_DISCOVERY_LINUX, profile: PROFILE_CODEX }, options())
    expect(JSON.stringify(actions)).not.toContain(".codex")
  })
})

describe("planCodex through planSetup", () => {
  test("orders install → select → verify, with no command-carrying field, deterministically", () => {
    const a = setup(options())
    const b = setup(options())
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(planDigest(a.value.plan)).toBe(planDigest(b.value.plan))
    expect(kinds(a.value.plan.actions)).toEqual(["ensure-directory", "install-harness", "select-harness-version", "verify-harness"])
    expect(a.value.plan.actions.filter((x) => x.kind === "verify-harness")).toHaveLength(1)
    expect(a.value.evidence).toEqual([{ actionID: "install-codex", kind: "sigstore", status: "deferred" }])
    expect(a.value.blockers).toEqual([])
  })

  test("the opt-in daemon feature edit is TOML: it becomes an unmergeable-format manual edit, never a write", () => {
    const r = setup(options({ ensureDaemonFeature: true }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.plan.actions.some((a) => a.kind === "merge-config")).toBe(false)
    expect(r.value.blockers).toHaveLength(1)
    const edit = r.value.blockers[0]!
    expect(validateManualEdit(edit).ok).toBe(true)
    expect(edit).toEqual({
      kind: "manual-edit",
      reason: "unmergeable-format",
      actionID: "codex-daemon-feature",
      path: { root: "home", rel: ".codex/config.toml" },
      resolvedPath: "/home/dev/.codex/config.toml",
      format: "toml",
      owner: "harness:codex",
      precondition: { exists: true, sha256: CODEX_DISCOVERY_LINUX.configs[0]!.sha256! },
      change: { op: "merge", set: [{ pointer: "/features/daemon_auto_start", value: true }] },
    })
  })

  test("the TOML edit for a host without ~/.codex/config.toml expects the file not to exist", () => {
    const r = setup(options({ ensureDaemonFeature: true }), { ...CODEX_DISCOVERY_LINUX, configs: [] })
    expect(r.ok && r.value.blockers[0]!.precondition).toEqual({ exists: false })
  })
})
