// The Claude Code HarnessAdapter's planning and discovery: a deterministic, typed plan (pinned install-harness →
// select-harness-version → a hub-owned integration config → verify-harness), the downgrade policy, user-managed
// installs left alone, and no action that could touch ~/.claude or carry a command.
import { describe, expect, test } from "bun:test"
import {
  checkHarnessPin,
  createAdapterRegistry,
  findExecKeys,
  harnessCurrentRef,
  harnessVersionRef,
  validateAction,
  type Action,
  type DiscoverySnapshot,
  type InstallHarness,
  type Profile,
} from "../src/bootstrap/contracts/index.ts"
import { CLAUDE_CONFIG_REF, createClaudeAdapter, planClaude } from "../src/bootstrap/adapters/claude/adapter.ts"
import { discover } from "../src/bootstrap/discovery/discover.ts"
import { planSetup } from "../src/bootstrap/preview/plan.ts"
import { claudePin, signedHubManifest } from "./bootstrap/claude-adapter-fixtures.ts"
import { dir, exe, LINUX_NATIVE, link, MAC_NATIVE, MACHO, memoryProbe } from "./bootstrap/discovery-fixtures.ts"
import { DISCOVERY_DARWIN, PROFILE_SESSION_ONLY, T0 } from "./bootstrap/fixtures.ts"

const manifest = signedHubManifest()
const PIN = claudePin("darwin-arm64")
const PROFILE: Profile = { ...PROFILE_SESSION_ONLY, harnesses: ["claude-code"] }
const OLD = { version: "2.1.85", sha256: `sha256:${"c".repeat(64)}` }
const CURRENT_BIN = "/Users/dev/.local/share/hub/harnesses/claude-code/current/claude"

const withClaude = (presence: Partial<DiscoverySnapshot["harnesses"][number]>, patch: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot => ({
  ...DISCOVERY_DARWIN,
  harnesses: DISCOVERY_DARWIN.harnesses.map((h) => (h.id === "claude-code" ? { ...h, installed: true, ...presence } : h)),
  ...patch,
})

const kinds = (actions: readonly Action[]) => actions.map((a) => `${a.kind}:${a.id}`)
const plan = (snapshot: DiscoverySnapshot = DISCOVERY_DARWIN, options: Parameters<typeof planClaude>[1] = { manifest }, profile = PROFILE) => planClaude({ snapshot, profile }, options)
const codeOf = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? "ok" : r.issues![0]!.code)

describe("planClaude", () => {
  test("a fresh host: pinned install, select, the hub-owned config, then real verification", () => {
    const r = plan()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.decision).toBe("install")
    expect(kinds(r.value.actions)).toEqual([
      "install-harness:install-claude-code",
      "select-harness-version:select-claude-code",
      "merge-config:claude-code-config",
      "verify-harness:verify-claude-code",
    ])
    const [install, select, config, verify] = r.value.actions as [InstallHarness, Extract<Action, { kind: "select-harness-version" }>, Extract<Action, { kind: "merge-config" }>, Extract<Action, { kind: "verify-harness" }>]
    expect(install).toMatchObject({ harness: "claude-code", version: PIN.version, target: "darwin-arm64", size: PIN.size, sha256: PIN.sha256, evidence: PIN.evidence, owner: "hub", rollback: "restore-previous", escalation: "user" })
    expect(install.source).toEqual({ manifest: manifest.release, url: PIN.url, file: "claude" })
    expect(install.path).toEqual(harnessVersionRef("claude-code", PIN.version))
    expect(install.previous).toBeUndefined()
    expect(checkHarnessPin(manifest, install).ok).toBe(true)
    expect(select).toMatchObject({ path: harnessCurrentRef("claude-code"), target: harnessVersionRef("claude-code", PIN.version), version: PIN.version })
    expect(config).toMatchObject({ path: CLAUDE_CONFIG_REF, format: "json", owner: "hub", precondition: { exists: false }, preserveUnknown: true, set: [{ pointer: "/binary", value: CURRENT_BIN }] })
    expect(verify).toMatchObject({ harness: "claude-code", probes: ["version-exec", "provider-auth", "spoke-connected"] })
    for (const a of r.value.actions) expect(validateAction(a).ok).toBe(true)
  })

  test("is deterministic", () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()))
  })

  test("never plans a command, and never a path under ~/.claude or ~/.claude.json", () => {
    for (const r of [plan(), plan(withClaude({ installMethod: "native", version: "2.1.90", path: "/Users/dev/.local/bin/claude" }), { manifest, prefer: "hub" })]) {
      if (!r.ok) throw new Error("plan failed")
      expect(findExecKeys(r.value.actions)).toEqual([])
      for (const a of r.value.actions) {
        const refs = [("path" in a ? a.path : undefined), ("target" in a && typeof a.target === "object" ? a.target : undefined)].filter(Boolean) as { root: string; rel: string }[]
        for (const ref of refs) expect(ref.root === "home" && ref.rel.startsWith(".claude")).toBe(false)
      }
    }
  })

  test("a profile without Claude Code plans nothing", () => {
    const r = plan(DISCOVERY_DARWIN, { manifest }, PROFILE_SESSION_ONLY)
    expect(r.ok && r.value.actions).toEqual([])
  })

  test("a user-managed Claude Code is kept and only verified (unless hub is preferred)", () => {
    const user = withClaude({ installMethod: "native", version: "2.1.90", path: "/Users/dev/.local/bin/claude" })
    const kept = plan(user)
    expect(kept.ok && kept.value.decision).toBe("user-managed")
    expect(kept.ok && kinds(kept.value.actions)).toEqual(["verify-harness:verify-claude-code"])
    // No manifest needed to keep what the user installed.
    expect(codeOf(plan(user, {}))).toBe("ok")
    const hub = plan(user, { manifest, prefer: "hub" })
    expect(hub.ok && hub.value.decision).toBe("install")
  })

  test("the pinned version already current: nothing to install", () => {
    const r = plan(withClaude({ installMethod: "hub", version: PIN.version, path: CURRENT_BIN }), { manifest, installed: { version: PIN.version, sha256: PIN.sha256 } })
    expect(r.ok && r.value.decision).toBe("keep")
    expect(r.ok && kinds(r.value.actions)).toEqual(["verify-harness:verify-claude-code"])
  })

  test("the pinned version installed but not current: select it again", () => {
    const r = plan(withClaude({ installMethod: "hub", version: "2.1.85", path: CURRENT_BIN }), { manifest, installed: { version: PIN.version, sha256: PIN.sha256 } })
    expect(r.ok && r.value.decision).toBe("select")
    expect(r.ok && kinds(r.value.actions)).toEqual(["select-harness-version:select-claude-code", "merge-config:claude-code-config", "verify-harness:verify-claude-code"])
  })

  test("an upgrade records the previous version for rollback", () => {
    const r = plan(withClaude({ installMethod: "hub", version: OLD.version, path: CURRENT_BIN }), { manifest, installed: OLD })
    expect(r.ok && r.value.decision).toBe("upgrade")
    if (!r.ok) return
    expect((r.value.actions[0] as InstallHarness).previous).toEqual(OLD)
    expect((r.value.actions[1] as Extract<Action, { kind: "select-harness-version" }>).previous).toEqual(OLD)
  })

  test("the downgrade policy and the security floor apply", () => {
    const newer = { version: "2.1.95", sha256: `sha256:${"d".repeat(64)}` }
    expect(codeOf(plan(DISCOVERY_DARWIN, { manifest, installed: newer }))).toBe("downgrade_rejected")
    const allowed = plan(DISCOVERY_DARWIN, { manifest, installed: newer, allowDowngrade: true })
    expect(allowed.ok && allowed.value.decision).toBe("downgrade")
    expect(codeOf(plan(DISCOVERY_DARWIN, { manifest, floor: "2.2.0" }))).toBe("below_security_floor")
    expect(codeOf(plan(DISCOVERY_DARWIN, { manifest, installed: { version: PIN.version, sha256: `sha256:${"e".repeat(64)}` } }))).toBe("integrity_mismatch")
  })

  test("no pin for this target, or no verified manifest, is unpinned", () => {
    const arm = { ...DISCOVERY_DARWIN, host: { ...DISCOVERY_DARWIN.host, arch: "x64", target: "darwin-x64" } }
    expect(codeOf(plan(arm))).toBe("unpinned_artifact")
    expect(codeOf(plan(DISCOVERY_DARWIN, {}))).toBe("unpinned_artifact")
  })

  test("an existing hub claude-code.json is pinned by its digest", () => {
    const digest = `sha256:${"a".repeat(64)}`
    const snapshot = { ...DISCOVERY_DARWIN, configs: [...DISCOVERY_DARWIN.configs, { path: "/Users/dev/.config/hub/claude-code.json", owner: "hub" as const, format: "json" as const, sha256: digest }] }
    const r = plan(snapshot)
    expect(r.ok && (r.value.actions[2] as Extract<Action, { kind: "merge-config" }>).precondition).toEqual({ exists: true, sha256: digest })
    // Until discovery records it, the integrator can supply the file's state.
    const injected = plan(DISCOVERY_DARWIN, { manifest, configState: (p) => (p === "/Users/dev/.config/hub/claude-code.json" ? { exists: true, sha256: digest } : undefined) })
    expect(injected.ok && (injected.value.actions[2] as Extract<Action, { kind: "merge-config" }>).precondition).toEqual({ exists: true, sha256: digest })
  })
})

describe("the HarnessAdapter", () => {
  test("plans through the registry and planSetup: ordered, valid, evidence deferred to apply", () => {
    const registry = createAdapterRegistry()
    registry.register(createClaudeAdapter({ manifest }))
    const r = planSetup({ snapshot: DISCOVERY_DARWIN, profile: PROFILE, links: () => undefined, adapters: registry })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(kinds(r.value.plan.actions)).toEqual([
      "ensure-directory:state-dir",
      "install-harness:install-claude-code",
      "select-harness-version:select-claude-code",
      "merge-config:claude-code-config",
      "verify-harness:verify-claude-code",
    ])
    expect(r.value.evidence).toEqual([
      { actionID: "install-claude-code", kind: "gpg-manifest", status: "deferred" },
      { actionID: "install-claude-code", kind: "macos-notarization", status: "deferred" },
    ])
    expect(r.value.blockers).toEqual([])
  })

  test("a hub config directory linked into dotfiles becomes a manual edit, never a write", () => {
    const registry = createAdapterRegistry()
    registry.register(createClaudeAdapter({ manifest }))
    const links = (ref: { root: string; rel: string }) => (ref.root === "config" && ref.rel.startsWith("hub/") ? { linkPath: "/Users/dev/.config/hub", resolvedPath: `/Users/dev/dot/hub/${ref.rel.slice(4)}` } : undefined)
    const r = planSetup({ snapshot: DISCOVERY_DARWIN, profile: PROFILE, links, adapters: registry })
    expect(r.ok && r.value.blockers.map((b) => [b.actionID, b.resolvedPath])).toEqual([["claude-code-config", "/Users/dev/dot/hub/claude-code.json"]])
  })

  test("plan() of an unplannable host still verifies (so it reports not ready), never throws", () => {
    const adapter = createClaudeAdapter({})
    expect(kinds(adapter.plan({ snapshot: DISCOVERY_DARWIN, profile: PROFILE }))).toEqual(["verify-harness:verify-claude-code"])
  })
})

describe("discover and the binary readiness runs against", () => {
  const ctx = (home: string, platform: string) => ({ env: {}, home, platform, arch: "x64", now: () => T0 })

  test("a native install is found through its link, with the version from its layout (never run)", async () => {
    const probe = memoryProbe(LINUX_NATIVE)
    const adapter = createClaudeAdapter({ probe })
    const presence = await adapter.discover(ctx("/home/dev", "linux"))
    expect(presence).toEqual({ id: "claude-code", installed: true, path: "/home/dev/.local/bin/claude", version: "2.1.90", installMethod: "native", health: { state: "unverified", probes: [] } })
    expect(adapter.binary()).toEqual({ path: "/home/dev/.local/share/claude/versions/2.1.90", version: "2.1.90" })
    expect(probe.calls.some((c) => c.path?.includes("/.claude/") || c.path?.endsWith("/.claude.json"))).toBe(false)
  })

  test("hub's current version is preferred, with the version it links to", async () => {
    const spec = {
      ...MAC_NATIVE,
      files: {
        ...MAC_NATIVE.files,
        "/Users/dev/.local/share/hub/harnesses/claude-code/2.1.90": dir,
        "/Users/dev/.local/share/hub/harnesses/claude-code/2.1.90/claude": exe(MACHO),
        "/Users/dev/.local/share/hub/harnesses/claude-code/current": link("2.1.90"),
      },
    }
    const adapter = createClaudeAdapter({ probe: memoryProbe(spec) })
    const presence = await adapter.discover(ctx("/Users/dev", "darwin"))
    expect(presence).toMatchObject({ installed: true, installMethod: "hub", version: "2.1.90", path: CURRENT_BIN })
    expect(adapter.binary()).toEqual({ path: CURRENT_BIN, version: "2.1.90" })
  })

  test("nothing installed: not installed, and no binary to verify", async () => {
    const adapter = createClaudeAdapter({ probe: memoryProbe(MAC_NATIVE) })
    expect(await adapter.discover(ctx("/Users/dev", "darwin"))).toEqual({ id: "claude-code", installed: false, health: { state: "unverified", probes: [] } })
    expect("problem" in adapter.binary()).toBe(true)
  })

  test("a shim into a container is never what readiness runs from the host", async () => {
    const spec = { ...MAC_NATIVE, files: { ...MAC_NATIVE.files, "/opt/homebrew/bin/claude": exe("#!/bin/sh\nexec docker exec -i box /usr/local/bin/claude \"$@\"\n") } }
    const adapter = createClaudeAdapter({ probe: memoryProbe(spec) })
    const bin = adapter.binary()
    expect("problem" in bin && bin.problem).toContain("container")
  })

  test("discover agrees with the full discovery snapshot", async () => {
    const probe = memoryProbe(LINUX_NATIVE)
    const snap = discover(probe, { now: T0 })
    const adapter = createClaudeAdapter({ probe })
    const presence = await adapter.discover(ctx("/home/dev", "linux"))
    expect(snap.ok && snap.value.harnesses.find((h) => h.id === "claude-code")).toEqual(presence)
  })
})
