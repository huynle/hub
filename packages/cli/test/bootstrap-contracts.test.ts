// The frozen bootstrap contracts (packages/cli/src/bootstrap/contracts): every validator accepts the shared fixtures
// (test/bootstrap/fixtures.ts) and rejects each threat case with the issue code it names; the pure decision functions
// (preview revalidation, artifact acceptance, recovery, locks, readiness) are checked case by case. No clock,
// network or filesystem beyond an in-memory lstat; signatures use an ephemeral key generated here.
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import {
  ACTION_FIELDS,
  ACTION_KINDS,
  BOOTSTRAP_EXIT,
  COMMAND_ALIASES,
  CONTRACT_VERSION,
  EMBEDDED_ASSETS,
  ERROR_CODES,
  EXEC_KEYS,
  HARNESS_EVIDENCE,
  HARNESS_ORDER,
  PREVIEW_MAX_TTL_MS,
  SERVICE_COMMANDS,
  SUPPORTED_TARGETS,
  UNSUPPORTED_TARGETS,
  canonicalJSON,
  checkArtifactBytes,
  checkHarnessEvidence,
  checkHarnessPin,
  checkNoSymlinkEscape,
  checkTarget,
  commandSurface,
  compareVersions,
  createAdapterRegistry,
  decideHarnessInstall,
  decideInstall,
  digestOf,
  enrollmentStatusFrom,
  exitFor,
  findSecrets,
  hostFingerprint,
  isHarnessReady,
  lockState,
  manifestPayload,
  manualEditFor,
  migrateProfile,
  planDigest,
  previewApplicable,
  programLayout,
  recoveryDecision,
  recoveryPlan,
  resolvePathRef,
  revalidatePreview,
  rotateTrustRoot,
  selectArtifact,
  serviceArgv,
  targetOf,
  validateAction,
  validateApplyLock,
  validateArtifactManifest,
  validateDiscoverySnapshot,
  validateEnrollmentStatus,
  validateEnvelope,
  validateJournal,
  validateManualEdit,
  validatePreviewToken,
  validateProfile,
  validateSetupPlan,
  validateSetupPreview,
  validateTrustRoot,
  verifyManifest,
  type Action,
  type ArtifactManifest,
  type HarnessAdapter,
  type Result,
  type TrustRoot,
} from "../src/bootstrap/contracts/index.ts"
import * as F from "./bootstrap/fixtures"

function expectValid(result: Result<unknown>) {
  if (!result.ok) throw new Error(`expected valid, got ${JSON.stringify(result.issues)}`)
  expect(result.ok).toBe(true)
}

function expectRejected(result: Result<unknown>, code: string) {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.issues.map((i): string => i.code)).toContain(code)
}

function threatSuite(name: string, cases: Record<string, F.ThreatCase>, validate: (v: unknown) => Result<unknown>) {
  describe(`${name} rejects threat cases`, () => {
    for (const [label, threat] of Object.entries(cases)) test(`${label} → ${threat.code}`, () => expectRejected(validate(threat.value), threat.code))
  })
}

describe("contract version", () => {
  test("is 1", () => expect(CONTRACT_VERSION).toBe(1))
})

// ---------- canonical JSON and digests ----------

describe("canonicalJSON / digestOf", () => {
  test("sorts keys at every depth and drops undefined fields", () => {
    expect(canonicalJSON({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}')
  })
  test("is independent of key order", () => {
    expect(digestOf({ x: 1, y: [1, 2] })).toBe(digestOf({ y: [1, 2], x: 1 }))
    expect(digestOf({ x: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
  test("rejects values JSON cannot represent exactly", () => {
    expect(() => canonicalJSON({ n: Number.NaN })).toThrow()
    expect(() => canonicalJSON({ n: Infinity })).toThrow()
    expect(() => canonicalJSON({ d: new Date(0) })).toThrow()
    expect(() => canonicalJSON({ f: () => 1 })).toThrow()
  })
})

describe("hostFingerprint", () => {
  const inputs = { machineID: "4c4c4544-0042", platform: "darwin", arch: "arm64", uid: 501, home: "/Users/dev" } as const
  test("is deterministic and a digest", () => {
    expect(hostFingerprint(inputs)).toBe(hostFingerprint({ ...inputs }))
    expect(hostFingerprint(inputs)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
  test("changes with any input and never contains the raw machine ID", () => {
    expect(hostFingerprint({ ...inputs, uid: 502 })).not.toBe(hostFingerprint(inputs))
    expect(hostFingerprint({ ...inputs, home: "/Users/other" })).not.toBe(hostFingerprint(inputs))
    expect(hostFingerprint(inputs)).not.toContain("4c4c4544")
  })
})

// ---------- platform matrix ----------

describe("supported platform matrix", () => {
  test("enumerates exactly the four Linux and macOS targets", () => {
    expect(SUPPORTED_TARGETS.map((t) => t.target)).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"])
    for (const t of SUPPORTED_TARGETS) expect(t.serviceManager).toBe(t.platform === "darwin" ? "launchd" : "systemd-user")
  })
  test("lists explicit unsupported targets with a reason", () => {
    const names = UNSUPPORTED_TARGETS.map((t) => t.target)
    expect(names).toContain("windows-x64")
    expect(names).toContain("linux-x64-musl")
    for (const t of UNSUPPORTED_TARGETS) expect(t.reason.length).toBeGreaterThan(10)
  })
  test("targetOf names the host; checkTarget fails unsupported ones explicitly", () => {
    expect(targetOf("darwin", "arm64", "none")).toBe("darwin-arm64")
    expect(targetOf("linux", "x64", "glibc")).toBe("linux-x64")
    expect(targetOf("linux", "arm64", "musl")).toBe("linux-arm64-musl")
    expect(targetOf("win32", "x64", "none")).toBe("windows-x64")
    expectValid(checkTarget("linux-arm64"))
    expectRejected(checkTarget("windows-x64"), "unsupported_platform")
    expectRejected(checkTarget("freebsd-x64"), "unsupported_platform")
    expectRejected(checkTarget("linux-x64-musl"), "unsupported_platform")
  })
})

// ---------- paths ----------

describe("path references", () => {
  const roots = F.DISCOVERY_DARWIN.roots
  test("resolve inside their root", () => {
    expect(resolvePathRef({ root: "config", rel: "hub/node.json" }, roots)).toEqual({ ok: true, value: "/Users/dev/.config/hub/node.json" })
  })
  test("reject traversal and roots the host does not map", () => {
    expectRejected(resolvePathRef({ root: "config", rel: "../.ssh/id_ed25519" }, roots), "invalid_path")
    expectRejected(resolvePathRef({ root: "system-bin", rel: "hubctl" }, roots), "unmapped_root")
  })
  test("checkNoSymlinkEscape refuses any symlink between the root and the target", () => {
    const links = new Set(["/Users/dev/.config/hub"])
    const lstat = (p: string) => (links.has(p) ? "symlink" : p.endsWith("node.json") ? "missing" : "directory")
    expectRejected(checkNoSymlinkEscape("/Users/dev/.config", "hub/node.json", lstat), "symlink")
    expectValid(checkNoSymlinkEscape("/Users/dev/.config", "opencode/opencode.json", () => "file"))
    expectRejected(checkNoSymlinkEscape("/Users/dev/.config", "opencode/opencode.json", (p) => (p.endsWith("opencode.json") ? "symlink" : "directory")), "symlink")
  })
})

// ---------- secrets ----------

describe("findSecrets", () => {
  test("flags credential-named keys and token-shaped values with their JSON pointer", () => {
    expect(findSecrets({ a: { machineToken: "x" } })).toEqual(["/a/machineToken"])
    expect(findSecrets({ list: ["fine", "hat_0123456789abcdef"] })).toEqual(["/list/1"])
    expect(findSecrets({ auth: "Bearer abc.def" })).toEqual(["/auth"])
    expect(findSecrets({ k: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA" })).toEqual(["/k"])
    expect(findSecrets({ password: "" })).toEqual(["/password"])
  })
  test("leaves ordinary data alone", () => {
    expect(findSecrets(F.DISCOVERY_DARWIN)).toEqual([])
    expect(findSecrets({ keyID: "hub-release-1", publicKey: "AAAA", tokens: undefined })).toEqual([])
  })
})

// ---------- discovery ----------

describe("DiscoverySnapshot", () => {
  test("accepts the fixtures, including an unsupported host it can only describe", () => {
    expectValid(validateDiscoverySnapshot(F.DISCOVERY_DARWIN))
    expectValid(validateDiscoverySnapshot(F.DISCOVERY_LINUX_CONTAINER))
    expectValid(validateDiscoverySnapshot(F.DISCOVERY_UNSUPPORTED))
  })
})
threatSuite("DiscoverySnapshot", F.DISCOVERY_INVALID, validateDiscoverySnapshot)

// ---------- profiles ----------

describe("Profile", () => {
  test("accepts the three profiles", () => {
    for (const p of [F.PROFILE_SESSION_ONLY, F.PROFILE_LAUNCH_NODE, F.PROFILE_FULL_HARNESS]) expectValid(validateProfile(p))
  })
  test("migrateProfile passes the current version through", () => {
    expect(migrateProfile(F.PROFILE_SESSION_ONLY)).toEqual({ ok: true, value: F.PROFILE_SESSION_ONLY })
  })
  test("migrateProfile applies injected migrations in order, then validates", () => {
    const migrations = {
      0: (raw: Record<string, unknown>) => ({ ...F.PROFILE_SESSION_ONLY, id: raw.profile, harnesses: [raw.harness] }),
    }
    expect(migrateProfile(F.PROFILE_V0, migrations)).toEqual({ ok: true, value: F.PROFILE_SESSION_ONLY })
  })
  test("migrateProfile refuses versions it cannot migrate and versions from the future", () => {
    expectRejected(migrateProfile(F.PROFILE_V0), "unmigratable")
    expectRejected(migrateProfile({ ...F.PROFILE_SESSION_ONLY, version: 2 }), "unsupported_version")
  })
})
threatSuite("Profile", F.PROFILE_INVALID, validateProfile)

// ---------- actions: no arbitrary execution ----------

describe("Action union", () => {
  test("every kind has a fixture that validates", () => {
    expect(Object.keys(F.ACTIONS).sort()).toEqual([...ACTION_KINDS].sort())
    for (const action of Object.values(F.ACTIONS)) expectValid(validateAction(action))
  })
  test("no action kind declares a field that could carry a command", () => {
    for (const kind of ACTION_KINDS) for (const field of ACTION_FIELDS[kind]) expect(EXEC_KEYS).not.toContain(field.toLowerCase())
    expect(ACTION_KINDS).not.toContain("run-command" as never)
  })
  test("no action kind accepts a smuggled command, at the top level or nested", () => {
    for (const action of Object.values(F.ACTIONS))
      for (const smuggled of F.EXEC_SMUGGLING) {
        expectRejected(validateAction({ ...action, ...smuggled }), "exec_field")
        expectRejected(validateAction({ ...action, path: { root: "config", rel: "x", ...smuggled } }), "exec_field")
      }
  })
  test("the type system has no command-shaped field either", () => {
    type Keys<T> = T extends unknown ? keyof T : never
    type ExecKey = (typeof EXEC_KEYS)[number]
    const none: [Extract<Keys<Action>, ExecKey>] extends [never] ? true : false = true
    expect(none).toBe(true)
  })
  test("register-mcp-server never takes the command it registers (it is always this hubctl's mcp)", () => {
    expect(ACTION_FIELDS["register-mcp-server"]).not.toContain("executable")
    expectRejected(validateAction({ ...F.ACTIONS["register-mcp-server"], executable: "/bin/sh" }), "unknown_field")
  })
})
threatSuite("Action", F.ACTION_INVALID, validateAction)

// ---------- plans and previews ----------

describe("SetupPlan", () => {
  test("accepts the fixtures", () => {
    expectValid(validateSetupPlan(F.PLAN_LAUNCH_NODE))
    expectValid(validateSetupPlan(F.PLAN_ELEVATED))
  })
  test("planDigest is deterministic and covers every action", () => {
    const copy = JSON.parse(JSON.stringify(F.PLAN_LAUNCH_NODE))
    expect(planDigest(copy)).toBe(planDigest(F.PLAN_LAUNCH_NODE))
    copy.actions[3].mode = 0o644
    expect(planDigest(copy)).not.toBe(planDigest(F.PLAN_LAUNCH_NODE))
  })
})
threatSuite("SetupPlan", F.PLAN_INVALID, validateSetupPlan)

describe("PreviewToken", () => {
  const digest = planDigest(F.PLAN_LAUNCH_NODE)
  const token = { ...F.PREVIEW, planDigest: digest }
  const context = { now: F.T0 + F.MINUTE, hostFingerprint: F.HOST, plan: F.PLAN_LAUNCH_NODE, usedNonces: new Set<string>() }
  test("accepts the fixture and caps the lifetime", () => {
    expectValid(validatePreviewToken(token))
    expect(PREVIEW_MAX_TTL_MS).toBe(15 * F.MINUTE)
  })
  test("revalidates a fresh, matching, unused preview", () => {
    expectValid(revalidatePreview(token, context))
  })
  test("rejects foreign, expired, early, replayed and stale previews", () => {
    expectRejected(revalidatePreview(token, { ...context, hostFingerprint: F.OTHER_HOST }), "preview_foreign")
    expectRejected(revalidatePreview(token, { ...context, now: token.expiresAt }), "preview_expired")
    expectRejected(revalidatePreview(token, { ...context, now: F.T0 - 2 * F.MINUTE }), "preview_not_yet_valid")
    expectRejected(revalidatePreview(token, { ...context, usedNonces: new Set([token.nonce]) }), "preview_replayed")
    const changed = { ...F.PLAN_LAUNCH_NODE, actions: F.PLAN_LAUNCH_NODE.actions.slice(1) }
    expectRejected(revalidatePreview(token, { ...context, plan: changed }), "preview_stale")
    const resnapped = { ...F.PLAN_LAUNCH_NODE, snapshotDigest: F.DIGEST.e }
    expectRejected(revalidatePreview({ ...token, planDigest: planDigest(resnapped) }, { ...context, plan: resnapped }), "preview_stale")
    expectRejected(revalidatePreview({ ...token, nonce: "x" }, context), "invalid_value")
  })
})
threatSuite("PreviewToken", F.PREVIEW_INVALID, validatePreviewToken)

// ---------- artifacts ----------

function keys(id = "hub-release-1") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const der = publicKey.export({ format: "der", type: "spki" }).toString("base64")
  return { id, der, privateKey }
}

function signManifest(body: Omit<ArtifactManifest, "signatures">, signers: { id: string; privateKey: ReturnType<typeof keys>["privateKey"] }[]): ArtifactManifest {
  const payload = Buffer.from(manifestPayload(body))
  return { ...body, signatures: signers.map((s) => ({ keyID: s.id, algorithm: "ed25519", value: sign(null, payload, s.privateKey).toString("base64") })) }
}

const rootWith = (...entries: { id: string; der: string; status?: "active" | "retired" | "revoked" }[]): TrustRoot => ({
  ...F.TRUST_ROOT_TEMPLATE,
  keys: entries.map((e) => ({ keyID: e.id, algorithm: "ed25519", publicKey: e.der, status: e.status ?? "active" })),
})

describe("ArtifactManifest", () => {
  const k = keys()
  const root = rootWith(k)
  const manifest = signManifest(F.MANIFEST_UNSIGNED, [k])
  test("accepts a signed manifest and a trust root", () => {
    expectValid(validateArtifactManifest(manifest))
    expectValid(validateTrustRoot(root))
  })
  test("verifies a good signature from a trusted key", () => {
    expectValid(verifyManifest(manifest, root))
  })
  test("rejects a tampered manifest", () => {
    const tampered = { ...manifest, artifacts: manifest.artifacts.map((a) => (a.target === "linux-x64" ? { ...a, sha256: F.DIGEST.f } : a)) }
    expectRejected(verifyManifest(tampered, root), "signature_invalid")
  })
  test("rejects unsigned manifests, unknown keys and revoked keys", () => {
    expectRejected(verifyManifest({ ...manifest, signatures: [] }, root), "signature_invalid")
    const stranger = keys("stranger")
    expectRejected(verifyManifest(signManifest(F.MANIFEST_UNSIGNED, [stranger]), root), "signature_invalid")
    expectRejected(verifyManifest(manifest, rootWith({ ...k, status: "revoked" })), "signature_invalid")
  })
  test("counts distinct trusted keys toward the threshold", () => {
    const k2 = keys("hub-release-2")
    const two = { ...rootWith(k, k2), threshold: 2 }
    expectRejected(verifyManifest(signManifest(F.MANIFEST_UNSIGNED, [k, k]), two), "signature_invalid")
    expectValid(verifyManifest(signManifest(F.MANIFEST_UNSIGNED, [k, k2]), two))
  })
  test("selectArtifact pins the host's target and refuses others", () => {
    const picked = selectArtifact(manifest, "linux-arm64")
    expect(picked.ok && picked.value.file).toBe("hubctl-linux-arm64")
    expectRejected(selectArtifact(manifest, "windows-x64"), "wrong_platform")
    expectRejected(selectArtifact({ ...manifest, artifacts: manifest.artifacts.slice(0, 1) }, "linux-x64"), "wrong_platform")
  })
  test("checkArtifactBytes refuses a download whose digest or size differs", () => {
    const artifact = manifest.artifacts[0]!
    expectValid(checkArtifactBytes(artifact, { sha256: artifact.sha256, size: artifact.size }))
    expectRejected(checkArtifactBytes(artifact, { sha256: F.DIGEST.f, size: artifact.size }), "integrity_mismatch")
    expectRejected(checkArtifactBytes(artifact, { sha256: artifact.sha256, size: 1 }), "integrity_mismatch")
  })
})
threatSuite("ArtifactManifest", F.MANIFEST_INVALID, validateArtifactManifest)

describe("versions and downgrades", () => {
  test("compareVersions orders semver, pre-releases below releases", () => {
    expect(compareVersions("0.8.0", "0.7.9")).toBe(1)
    expect(compareVersions("0.8.0", "0.8.0")).toBe(0)
    expect(compareVersions("0.8.0-rc.1", "0.8.0")).toBe(-1)
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1)
  })
  const candidate = { release: "0.8.0", minimumVersion: "0.7.0", sha256: F.DIGEST.a }
  test("fresh installs and upgrades are allowed", () => {
    expectValid(decideInstall({ candidate }))
    expectValid(decideInstall({ candidate, installed: { version: "0.7.1", sha256: F.DIGEST.b }, floor: "0.7.0" }))
  })
  test("downgrades need explicit consent and can never go below the security floor", () => {
    const installed = { version: "0.9.0", sha256: F.DIGEST.b }
    expectRejected(decideInstall({ candidate, installed }), "downgrade_rejected")
    expectValid(decideInstall({ candidate, installed, allowDowngrade: true }))
    expectRejected(decideInstall({ candidate, installed, allowDowngrade: true, floor: "0.8.1" }), "below_security_floor")
  })
  test("the same version with different bytes is tampering", () => {
    expectValid(decideInstall({ candidate, installed: { version: "0.8.0", sha256: F.DIGEST.a } }))
    expectRejected(decideInstall({ candidate, installed: { version: "0.8.0", sha256: F.DIGEST.b } }), "integrity_mismatch")
  })
})

describe("trust root rotation", () => {
  const k1 = keys("hub-release-1")
  const k2 = keys("hub-release-2")
  const current = rootWith(k1)
  const next: TrustRoot = { ...rootWith({ ...k1, status: "retired" }, k2), version: 2 }
  const signNext = (root: TrustRoot, signer: ReturnType<typeof keys>) => [
    { keyID: signer.id, algorithm: "ed25519" as const, value: sign(null, Buffer.from(canonicalJSON(root)), signer.privateKey).toString("base64") },
  ]
  test("accepts a newer root signed by the current root's keys", () => {
    expectValid(rotateTrustRoot(current, next, signNext(next, k1)))
  })
  test("rejects rollbacks and roots signed only by the new keys", () => {
    expectRejected(rotateTrustRoot(current, { ...next, version: 1 }, signNext({ ...next, version: 1 }, k1)), "trust_root_rollback")
    expectRejected(rotateTrustRoot(current, next, signNext(next, k2)), "signature_invalid")
  })
})

// ---------- standalone executable and argv ----------

describe("executable argv contract", () => {
  test("hub and hubctl are one command surface", () => {
    expect(COMMAND_ALIASES).toEqual(["hub", "hubctl"])
    expect(commandSurface("hub")).toBe(commandSurface("hubctl"))
    expect(commandSurface("/usr/local/bin/hubctl")).toBe(commandSurface("hub"))
    expect(commandSurface("sudo-hub")).toBeUndefined()
  })
  test("a compiled binary is standalone; a script needs its runtime", () => {
    expect(programLayout({ execPath: "/Users/dev/.local/bin/hubctl", entry: "/$bunfs/root/hubctl" })).toEqual({ kind: "standalone", executable: "/Users/dev/.local/bin/hubctl" })
    expect(programLayout({ execPath: "/opt/bun", entry: "/opt/hub/hub-cli.js" })).toEqual({ kind: "script", runtime: "/opt/bun", entry: "/opt/hub/hub-cli.js" })
  })
  test("service argv is a word list, never a shell string", () => {
    expect(serviceArgv({ kind: "standalone", executable: "/u/bin/hubctl" }, "node")).toEqual(["/u/bin/hubctl", "node", "run"])
    expect(serviceArgv({ kind: "script", runtime: "/opt/bun", entry: "/opt/hub tools/cli.js" }, "codex-spoke")).toEqual(["/opt/bun", "/opt/hub tools/cli.js", "codex-spoke", "serve"])
    expect(SERVICE_COMMANDS["claude-code"]).toEqual(["claude-code", "daemon"])
    expect(() => serviceArgv({ kind: "standalone", executable: "hubctl" }, "node")).toThrow()
    expect(() => serviceArgv({ kind: "standalone", executable: "/u/bin/hub\nctl" }, "node")).toThrow()
  })
  test("every service and platform has an embedded template asset", () => {
    for (const service of Object.keys(SERVICE_COMMANDS))
      for (const manager of ["launchd", "systemd-user"]) expect(Object.values(EMBEDDED_ASSETS).some((a) => a.service === service && a.manager === manager)).toBe(true)
  })
})

// ---------- enrollment ----------

describe("EnrollmentStatus", () => {
  test("accepts the fixtures", () => {
    expectValid(validateEnrollmentStatus(F.ENROLLMENT_VERIFIED))
    expectValid(validateEnrollmentStatus(F.ENROLLMENT_UNCONFIGURED))
  })
  const credential = { server: "https://hub.example", machineID: "mach_01", machineName: "dev-mac", token: "mt_secret" }
  test("enrollmentStatusFrom derives the state without ever carrying the token", () => {
    expect(enrollmentStatusFrom(undefined, undefined, F.T0).state).toBe("unconfigured")
    expect(enrollmentStatusFrom(credential, undefined, F.T0).state).toBe("configured")
    expect(enrollmentStatusFrom(credential, { reachable: false }, F.T0).state).toBe("offline")
    expect(enrollmentStatusFrom(credential, { reachable: true, accepted: false }, F.T0).state).toBe("revoked")
    const verified = enrollmentStatusFrom(credential, { reachable: true, accepted: true }, F.T0)
    expect(verified).toEqual(F.ENROLLMENT_VERIFIED)
    expect(JSON.stringify(verified)).not.toContain("mt_secret")
  })
})
threatSuite("EnrollmentStatus", F.ENROLLMENT_INVALID, validateEnrollmentStatus)

// ---------- journal, recovery and lock ----------

describe("TransactionJournal", () => {
  test("accepts the fixture", () => expectValid(validateJournal(F.JOURNAL_APPLYING)))
  const [dir, config, credential, file] = F.JOURNAL_APPLYING.entries as [any, any, any, any]
  test("a done entry still as we left it is undone", () => {
    expect(recoveryDecision(dir, { exists: true, mode: 0o700 })).toBe("remove-created")
    expect(recoveryDecision(config, config.after)).toBe("restore-backup")
  })
  test("an intervening user edit is never overwritten", () => {
    expect(recoveryDecision(config, { exists: true, sha256: F.DIGEST.c, mode: 0o644 })).toBe("keep-user-edit")
    expect(recoveryDecision(config, { exists: false })).toBe("keep-user-edit")
  })
  test("a stale credential is never restored", () => {
    expect(recoveryDecision(credential, credential.after)).toBe("clear-credential")
    expect(recoveryDecision(credential, { exists: true, sha256: F.DIGEST.c, mode: 0o600 })).toBe("keep-user-edit")
  })
  test("a pending entry interrupted mid-write is undone only if it matches our result", () => {
    expect(recoveryDecision(file, { exists: false })).toBe("nothing-to-do")
    expect(recoveryDecision(file, file.after)).toBe("remove-created")
    expect(recoveryDecision(file, { exists: true, sha256: F.DIGEST.a, mode: 0o600 })).toBe("keep-user-edit")
  })
  test("recoveryPlan walks entries newest first and leaves finished transactions alone", () => {
    const state = (entry: any) => (entry.status === "pending" ? { exists: false } : entry.after)
    expect(recoveryPlan(F.JOURNAL_APPLYING, state).map((s) => [s.seq, s.decision])).toEqual([
      [4, "nothing-to-do"],
      [3, "clear-credential"],
      [2, "restore-backup"],
      [1, "remove-created"],
    ])
    expect(recoveryPlan({ ...F.JOURNAL_APPLYING, state: "committed" }, state)).toEqual([])
  })
})
threatSuite("TransactionJournal", F.JOURNAL_INVALID, validateJournal)

describe("ApplyLock", () => {
  const alive = () => true
  const dead = () => false
  test("accepts the fixture", () => expectValid(validateApplyLock(F.LOCK)))
  test("no lock is free; a live same-host lock is held", () => {
    expect(lockState(undefined, { now: F.T0, hostFingerprint: F.HOST, isAlive: alive })).toBe("free")
    expect(lockState(F.LOCK, { now: F.T0 + F.MINUTE, hostFingerprint: F.HOST, isAlive: alive })).toBe("held")
  })
  test("a dead or expired same-host lock is stale; another host's lock is never broken", () => {
    expect(lockState(F.LOCK, { now: F.T0 + F.MINUTE, hostFingerprint: F.HOST, isAlive: dead })).toBe("stale")
    expect(lockState(F.LOCK, { now: F.LOCK.expiresAt, hostFingerprint: F.HOST, isAlive: alive })).toBe("stale")
    expect(lockState(F.LOCK, { now: F.LOCK.expiresAt + 1, hostFingerprint: F.OTHER_HOST, isAlive: dead })).toBe("foreign")
  })
  test("rejects malformed locks", () => {
    expectRejected(validateApplyLock({ ...F.LOCK, pid: 0 }), "invalid_value")
    expectRejected(validateApplyLock({ ...F.LOCK, expiresAt: F.T0 }), "invalid_value")
  })
})

// ---------- harness adapters ----------

describe("harness readiness and adapters", () => {
  const now = F.T0 + F.MINUTE
  test("installed is not ready; real probes are", () => {
    expect(isHarnessReady(F.VERIFICATION_INSTALLED_ONLY, now)).toBe(false)
    expect(isHarnessReady(F.VERIFICATION_READY, now)).toBe(true)
  })
  test("a failed or stale probe makes it not ready", () => {
    const failed = { ...F.VERIFICATION_READY, probes: F.VERIFICATION_READY.probes.map((p) => (p.kind === "provider-auth" ? { ...p, ok: false } : p)) }
    expect(isHarnessReady(failed, now)).toBe(false)
    expect(isHarnessReady(F.VERIFICATION_READY, F.T0 + 60 * F.MINUTE)).toBe(false)
  })
  const adapter = (id: HarnessAdapter["id"]): HarnessAdapter => ({
    id,
    discover: async () => ({ id, installed: false, health: { state: "unverified", probes: [] } }),
    plan: () => [],
    verify: async () => ({ harness: id, probes: [] }),
  })
  test("the registry orders adapters OpenCode, Claude Code, Codex and refuses duplicates", () => {
    expect(HARNESS_ORDER).toEqual(["opencode", "claude-code", "codex"])
    const registry = createAdapterRegistry()
    registry.register(adapter("codex"))
    registry.register(adapter("opencode"))
    registry.register(adapter("claude-code"))
    expect(registry.list().map((a) => a.id)).toEqual(["opencode", "claude-code", "codex"])
    expect(() => registry.register(adapter("codex"))).toThrow()
    expect(() => registry.register(adapter("openshell" as never))).toThrow()
  })
})

// ---------- output envelope and exit codes ----------

describe("ResultEnvelope and exit codes", () => {
  test("accepts the fixtures", () => {
    expectValid(validateEnvelope(F.ENVELOPE_OK))
    expectValid(validateEnvelope(F.ENVELOPE_ERROR))
  })
  test("keeps the CLI's existing exit codes and adds bootstrap ones above them", () => {
    expect(BOOTSTRAP_EXIT.ok).toBe(0)
    expect(BOOTSTRAP_EXIT.usage).toBe(2)
    expect(BOOTSTRAP_EXIT.unavailable).toBe(7)
    expect(BOOTSTRAP_EXIT.conflict).toBe(10)
    const values = Object.values(BOOTSTRAP_EXIT)
    expect(new Set(values).size).toBe(values.length)
  })
  test("every error code maps to an exit code", () => {
    for (const code of ERROR_CODES) expect(Object.values(BOOTSTRAP_EXIT) as number[]).toContain(exitFor(code))
    expect(exitFor("unsupported_platform")).toBe(BOOTSTRAP_EXIT.unavailable)
    expect(exitFor("signature_invalid")).toBe(BOOTSTRAP_EXIT.artifactRejected)
    expect(exitFor("preview_stale")).toBe(BOOTSTRAP_EXIT.previewInvalid)
    expect(exitFor("locked")).toBe(BOOTSTRAP_EXIT.locked)
    expect(exitFor("conflict")).toBe(BOOTSTRAP_EXIT.conflict)
  })
})
threatSuite("ResultEnvelope", F.ENVELOPE_INVALID, validateEnvelope)

// ---------- pinned harness installs (Q1–Q4) ----------

describe("install-harness action", () => {
  test("accepts the pinned installs", () => {
    for (const a of [F.ACTIONS["install-harness"], F.INSTALL_CLAUDE, F.INSTALL_CODEX]) expectValid(validateAction(a))
  })
  test("evidence each harness may offer: none for OpenCode, GPG + notarization for Claude Code, sigstore for Codex", () => {
    expect(HARNESS_EVIDENCE).toEqual({ opencode: [], "claude-code": ["gpg-manifest", "macos-notarization"], codex: ["sigstore"] })
  })
})
threatSuite("install-harness", F.HARNESS_ACTION_INVALID, validateAction)

describe("harness pins in the signed hub manifest", () => {
  const k = keys()
  const root = rootWith(k)
  const verified = verifyManifest(signManifest(F.MANIFEST_UNSIGNED, [k]), root)
  if (!verified.ok) throw new Error(JSON.stringify(verified.issues))
  const manifest = verified.value
  test("the manifest validates with its harness pins, and the pins are covered by the signature", () => {
    expect(manifest.harnesses).toEqual(F.HARNESS_PINS)
    const tamperedPin = { ...manifest, harnesses: manifest.harnesses.map((h) => (h.harness === "opencode" ? { ...h, sha256: F.DIGEST.a } : h)) }
    expectRejected(verifyManifest(tamperedPin, root), "signature_invalid")
  })
  test("rejects malformed pins", () => {
    const pin = F.HARNESS_PINS[0]!
    const bad = (patch: Record<string, unknown>) => ({ ...F.MANIFEST_UNSIGNED, signatures: [], harnesses: [{ ...pin, ...patch }] })
    expectRejected(validateArtifactManifest(bad({ url: "http://github.com/x" })), "invalid_value")
    expectRejected(validateArtifactManifest(bad({ target: "windows-x64" })), "unsupported_platform")
    expectRejected(validateArtifactManifest(bad({ evidence: ["gpg-manifest"] })), "invalid_value")
    expectRejected(validateArtifactManifest({ ...F.MANIFEST_UNSIGNED, signatures: [], harnesses: [pin, pin] }), "duplicate")
    expectRejected(validateArtifactManifest(bad({ version: "2.0.26", minimumVersion: "2.1.0" })), "inconsistent")
  })
  test("an install matching its pin exactly is accepted", () => {
    for (const a of [F.ACTIONS["install-harness"], F.INSTALL_CLAUDE, F.INSTALL_CODEX]) expectValid(checkHarnessPin(manifest, a as never))
  })
  describe("unpinned or mismatched installs are rejected", () => {
    for (const [label, threat] of Object.entries(F.HARNESS_PIN_INVALID)) test(`${label} → ${threat.code}`, () => expectRejected(checkHarnessPin(manifest, threat.value as never), threat.code))
  })
})

describe("harness download evidence", () => {
  const bytes = { sha256: F.DIGEST.f, size: 200_000_000 }
  const claude = F.INSTALL_CLAUDE as never
  test("the pinned digest is always checked first (never neither)", () => {
    expectRejected(checkHarnessEvidence(claude, { ...bytes, sha256: F.DIGEST.a }, []), "integrity_mismatch")
  })
  test("optional evidence is recorded as verified or unavailable, never required", () => {
    const report = checkHarnessEvidence(claude, bytes, [{ kind: "gpg-manifest", status: "verified" }])
    expect(report).toEqual({
      ok: true,
      value: [
        { kind: "sha256-pin", status: "verified" },
        { kind: "gpg-manifest", status: "verified" },
        { kind: "macos-notarization", status: "unavailable" },
      ],
    })
    const codex = checkHarnessEvidence(F.INSTALL_CODEX as never, { sha256: F.DIGEST.b, size: 30_000_000 }, [{ kind: "sigstore", status: "unavailable", detail: "no sigstore verifier" }])
    expect(codex.ok && codex.value.map((e) => [e.kind, e.status])).toEqual([["sha256-pin", "verified"], ["sigstore", "unavailable"]])
  })
  test("failed evidence rejects the artifact; evidence that was not planned is refused", () => {
    expectRejected(checkHarnessEvidence(claude, bytes, [{ kind: "macos-notarization", status: "failed" }]), "evidence_failed")
    expectRejected(checkHarnessEvidence(claude, bytes, [{ kind: "sigstore", status: "verified" }]), "inconsistent")
  })
})

describe("harness downgrade policy", () => {
  const pin = F.HARNESS_PINS[1]! // claude-code 2.1.90, floor 2.1.89
  test("installs and upgrades are allowed", () => {
    expectValid(decideHarnessInstall(pin, {}))
    expectValid(decideHarnessInstall(pin, { installed: { version: "2.1.85", sha256: F.DIGEST.c } }))
  })
  test("downgrades need consent and never go below the floor", () => {
    const installed = { version: "2.1.95", sha256: F.DIGEST.c }
    expectRejected(decideHarnessInstall(pin, { installed }), "downgrade_rejected")
    expectValid(decideHarnessInstall(pin, { installed, allowDowngrade: true }))
    expectRejected(decideHarnessInstall(pin, { installed, allowDowngrade: true, floor: "2.1.91" }), "below_security_floor")
  })
})

describe("plans with harness installs", () => {
  test("install is followed by verification (install is not readiness)", () => expectValid(validateSetupPlan(F.PLAN_HARNESS_INSTALL)))
})
threatSuite("SetupPlan (harness installs)", F.PLAN_HARNESS_INVALID, validateSetupPlan)

describe("harness rollback", () => {
  test("a replaced harness binary is restored from its backup; a new one is removed", () => {
    const e = F.HARNESS_JOURNAL_ENTRY
    expectValid(validateJournal({ ...F.JOURNAL_APPLYING, entries: [e] }))
    expect(recoveryDecision(e, e.after!)).toBe("restore-backup")
    expect(recoveryDecision({ ...e, before: { exists: false }, backup: undefined }, e.after!)).toBe("remove-created")
    expectRejected(validateJournal({ ...F.JOURNAL_APPLYING, entries: [{ ...e, backup: undefined }] }), "inconsistent")
  })
})

// ---------- symlinked configs (Q8) ----------

describe("manual edits for symlinked configs", () => {
  test("validate", () => {
    expectValid(validateManualEdit(F.MANUAL_EDIT_MERGE))
    expectValid(validateManualEdit(F.MANUAL_EDIT_MCP))
  })
  test("manualEditFor turns a refused config action into the exact edit, without a command or secret", () => {
    expect(manualEditFor(F.ACTIONS["merge-config"], F.SYMLINK)).toEqual(F.MANUAL_EDIT_MERGE)
    expect(manualEditFor(F.ACTIONS["register-mcp-server"], F.SYMLINK)).toEqual(F.MANUAL_EDIT_MCP)
    const write = manualEditFor(F.ACTIONS["write-file"], F.SYMLINK)
    expect(write?.change).toEqual({ op: "write-file", asset: "config/node.json", sha256: F.DIGEST.d, mode: 0o600 })
    expect(manualEditFor(F.ACTIONS["enroll-machine"], F.SYMLINK)).toBeUndefined()
  })
})
threatSuite("ManualEdit", F.MANUAL_EDIT_INVALID, validateManualEdit)

describe("SetupPreview (plan output)", () => {
  const plan = F.PLAN_HARNESS_INSTALL
  const digest = planDigest(plan)
  const preview = {
    schema: "hub.setup-preview",
    version: 1,
    plan,
    planDigest: digest,
    token: { ...F.PREVIEW, planDigest: digest },
    blockers: [],
    evidence: [
      { actionID: "install-claude", kind: "gpg-manifest", status: "verified" },
      { actionID: "install-claude", kind: "macos-notarization", status: "deferred" },
    ],
  }
  test("a preview without blockers or failed evidence can be applied", () => {
    expectValid(validateSetupPreview(preview))
    expectValid(previewApplicable(preview as never))
  })
  test("a symlinked config blocks apply until the user makes the edit and previews again (the edit replaces its action)", () => {
    const blocked = { ...preview, blockers: [F.MANUAL_EDIT_MERGE] }
    expectValid(validateSetupPreview(blocked))
    expectRejected(previewApplicable(blocked as never), "manual_edit_required")
    expect(exitFor("manual_edit_required")).toBe(BOOTSTRAP_EXIT.conflict)
  })
  test("failed evidence blocks apply", () => {
    const failed = { ...preview, evidence: [{ actionID: "install-claude", kind: "gpg-manifest", status: "failed" }] }
    expectRejected(previewApplicable(failed as never), "evidence_failed")
    expect(exitFor("evidence_failed")).toBe(BOOTSTRAP_EXIT.artifactRejected)
    expect(exitFor("unpinned_artifact")).toBe(BOOTSTRAP_EXIT.artifactRejected)
  })
  test("rejects previews that do not match their plan, or report evidence nobody planned", () => {
    expectRejected(validateSetupPreview({ ...preview, planDigest: F.DIGEST.a }), "inconsistent")
    expectRejected(validateSetupPreview({ ...preview, token: F.PREVIEW }), "inconsistent")
    expectRejected(validateSetupPreview({ ...preview, evidence: [{ actionID: "install-opencode", kind: "sigstore", status: "verified" }] }), "inconsistent")
    // A manual edit replaces its action; a plan that still has the refused action is inconsistent.
    expectRejected(validateSetupPreview({ ...preview, blockers: [{ ...F.MANUAL_EDIT_MERGE, actionID: "install-opencode" }] }), "inconsistent")
  })
})
