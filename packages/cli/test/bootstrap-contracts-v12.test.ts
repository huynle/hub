// Contract amendment v1.2 (docs/bootstrap-contracts.md §10): install is not readiness, and readiness that waits on
// the user is not an integrity failure. Every probe kind has a class: an `integrity` probe (the binary runs, is the
// pinned version, its local API answers) failing means the install is broken, and apply rolls back; a `user` probe
// (the user's provider login, the spoke the user starts) failing means the harness is installed but pending, which
// apply commits by default and `setup verify` (or `apply --require-ready`) still refuses.
import { describe, expect, test } from "bun:test"
import { CONTRACT_AMENDMENT, harnessReadiness, isHarnessReady, PROBE_CLASS, PROBE_KINDS, PROBE_MAX_AGE_MS, type HarnessVerification, type Probe } from "../src/bootstrap/contracts/index.ts"

const NOW = 1_800_000_000_000
const probe = (kind: Probe["kind"], ok: boolean, detail?: string, observedAt = NOW): Probe => ({ kind, ok, observedAt, ...(detail ? { detail } : {}) })
const oc = (...probes: Probe[]): HarnessVerification => ({ harness: "opencode", probes })

test("the amendment is labelled v1.2", () => expect(CONTRACT_AMENDMENT).toBe("1.2"))

describe("v1.2 probe classes", () => {
  test("every probe kind has a class: the binary and its API are integrity, the user's login and spoke are user", () => {
    for (const kind of PROBE_KINDS) expect(["integrity", "user"]).toContain(PROBE_CLASS[kind])
    expect(PROBE_CLASS["version-exec"]).toBe("integrity")
    expect(PROBE_CLASS["api-health"]).toBe("integrity")
    expect(PROBE_CLASS.presence).toBe("integrity")
    expect(PROBE_CLASS["provider-auth"]).toBe("user")
    expect(PROBE_CLASS["spoke-connected"]).toBe("user")
  })
})

describe("v1.2 harnessReadiness", () => {
  test("every required probe passing is ready, exactly when isHarnessReady is", () => {
    const v = oc(probe("version-exec", true, "opencode 2.2.0"), probe("provider-auth", true), probe("spoke-connected", true))
    const r = harnessReadiness(v, NOW)
    expect(r).toMatchObject({ harness: "opencode", state: "ready" })
    expect(r.probes.map((p) => [p.kind, p.status])).toEqual([["version-exec", "pass"], ["provider-auth", "pass"], ["spoke-connected", "pass"]])
    expect(r.nextSteps).toEqual([])
    expect(isHarnessReady(v, NOW)).toBe(true)
  })

  test("only user probes failing is pending, with the next steps the user takes, and never ready", () => {
    const v = oc(probe("version-exec", true), probe("provider-auth", false, "opencode models exited 1"), probe("spoke-connected", false, "not connected"))
    const r = harnessReadiness(v, NOW)
    expect(r.state).toBe("pending")
    expect(r.probes.map((p) => [p.kind, p.class, p.status])).toEqual([["version-exec", "integrity", "pass"], ["provider-auth", "user", "pending"], ["spoke-connected", "user", "pending"]])
    expect(r.probes[1]!.detail).toBe("opencode models exited 1")
    expect(r.nextSteps.join("\n")).toContain("opencode auth login")
    expect(r.nextSteps.join("\n")).toMatch(/start opencode/i)
    expect(r.nextSteps.at(-1)).toContain("hubctl setup verify")
    expect(isHarnessReady(v, NOW)).toBe(false)
  })

  test("any integrity probe failing is failed, whatever the user probes say", () => {
    for (const v of [
      oc(probe("version-exec", false, "opencode 2.1.0 runs, but hub made 2.2.0 current"), probe("provider-auth", false), probe("spoke-connected", false)),
      oc(probe("version-exec", false, "could not run"), probe("provider-auth", true), probe("spoke-connected", true)),
    ])
      expect(harnessReadiness(v, NOW).state).toBe("failed")
  })

  test("a required probe that was never run is a failure (an adapter must report every probe)", () => {
    const r = harnessReadiness(oc(probe("version-exec", true), probe("provider-auth", false)), NOW)
    expect(r.state).toBe("failed")
    expect(r.probes.find((p) => p.kind === "spoke-connected")).toMatchObject({ status: "fail", class: "user", detail: "not run" })
  })

  test("extra probes the action asks for are required too, with their own class (Codex's app-server is integrity)", () => {
    const v: HarnessVerification = { harness: "codex", probes: [probe("version-exec", true), probe("api-health", false, "did not start"), probe("provider-auth", false), probe("spoke-connected", false)] }
    expect(harnessReadiness(v, NOW, ["api-health"]).state).toBe("failed")
    const pending: HarnessVerification = { harness: "codex", probes: [probe("version-exec", true), probe("api-health", true), probe("provider-auth", false), probe("spoke-connected", true)] }
    const r = harnessReadiness(pending, NOW, ["api-health"])
    expect(r.state).toBe("pending")
    expect(r.nextSteps.join("\n")).toContain("codex login")
  })

  test("a stale passing probe does not count: stale user probes are pending, stale integrity probes failed", () => {
    const old = NOW - PROBE_MAX_AGE_MS - 1
    expect(harnessReadiness(oc(probe("version-exec", true), probe("provider-auth", true, undefined, old), probe("spoke-connected", true)), NOW).state).toBe("pending")
    expect(harnessReadiness(oc(probe("version-exec", true, undefined, old), probe("provider-auth", true), probe("spoke-connected", true)), NOW).state).toBe("failed")
  })

  test("Claude Code's next steps name its own login and spoke", () => {
    const v: HarnessVerification = { harness: "claude-code", probes: [probe("version-exec", true), probe("provider-auth", false), probe("spoke-connected", false)] }
    const steps = harnessReadiness(v, NOW).nextSteps.join("\n")
    expect(steps).toContain("claude auth login")
    expect(steps).toContain("claude-code")
  })
})
