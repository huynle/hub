// Contract amendment v1.1 (docs/bootstrap-contracts.md, every item marked "v1.1"): the canonical snapshot digest,
// container-aware root resolution, the separate-enrollment option, the new issue/error codes and the insecure
// enrollment state, the journal recovery and backup rules, the versioned harness layout with select-harness-version,
// unmergeable-format manual edits, service deactivation and removal, and profile revisions (profile v2).
import { describe, expect, test } from "bun:test"
import {
  ACTION_KINDS,
  BOOTSTRAP_EXIT,
  CONTRACT_AMENDMENT,
  digestOf,
  ENROLLMENT_MODES,
  ENROLLMENT_STATES,
  ERROR_CODES,
  executionContextOf,
  enrollmentStatusFrom,
  exitFor,
  harnessCurrentRef,
  harnessVersionRef,
  migrateProfile,
  PROFILE_MIGRATIONS,
  PROFILE_VERSION,
  recoveryDecision,
  resolvePathRef,
  rootPathIn,
  snapshotDigest,
  unmergeableEditFor,
  validateAction,
  validateEnrollmentStatus,
  validateJournal,
  validateManualEdit,
  validateProfile,
  validateSetupPlan,
  type Action,
  type IssueCode,
  type Result,
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

// v1.2 (bootstrap-contracts-v12.test.ts) is additive: everything v1.1 defines still holds.
test("the amendment is v1.1 or a later additive amendment", () => expect(["1.1", "1.2"]).toContain(CONTRACT_AMENDMENT))

describe("v1.1 snapshotDigest", () => {
  test("is the canonical digest of the snapshot without capturedAt", () => {
    expect(snapshotDigest(F.DISCOVERY_DARWIN)).toBe(digestOf({ ...F.DISCOVERY_DARWIN, capturedAt: undefined }))
    expect(snapshotDigest({ ...F.DISCOVERY_DARWIN, capturedAt: F.T0 + 5 * F.MINUTE })).toBe(snapshotDigest(F.DISCOVERY_DARWIN))
  })
  test("changes with anything else", () => {
    expect(snapshotDigest({ ...F.DISCOVERY_DARWIN, configs: [] })).not.toBe(snapshotDigest(F.DISCOVERY_DARWIN))
    expect(snapshotDigest(F.DISCOVERY_DARWIN)).not.toBe(digestOf(F.DISCOVERY_DARWIN))
  })
})

describe("v1.1 container roots", () => {
  const home = { id: "home", path: "/home/dev", containerPath: "/workspace/home" } as const
  const plain = { id: "config", path: "/home/dev/.config" } as const
  test("path is the host's view; inside the container a root is containerPath ?? path", () => {
    expect(rootPathIn(home, "host")).toBe("/home/dev")
    expect(rootPathIn(home, "container")).toBe("/workspace/home")
    expect(rootPathIn(plain, "container")).toBe("/home/dev/.config")
  })
  test("resolvePathRef resolves for the execution context (host by default)", () => {
    const roots = F.DISCOVERY_LINUX_CONTAINER.roots
    expect(resolvePathRef({ root: "home", rel: ".claude.json" }, roots)).toEqual({ ok: true, value: "/home/dev/.claude.json" })
    expect(resolvePathRef({ root: "home", rel: ".claude.json" }, roots, "container")).toEqual({ ok: true, value: "/workspace/home/.claude.json" })
    expect(resolvePathRef({ root: "config", rel: "hub/config.json" }, roots, "container")).toEqual({ ok: true, value: "/home/dev/.config/hub/config.json" })
  })
  test("a snapshot taken inside a container plans for the container context", () => {
    expect(executionContextOf(F.DISCOVERY_LINUX_CONTAINER)).toBe("container")
    expect(executionContextOf(F.DISCOVERY_DARWIN)).toBe("host")
  })
})

describe("v1.1 profile v2: revision and enrollment mode", () => {
  test("version 2 is current; the fixtures validate", () => {
    expect(PROFILE_VERSION).toBe(2)
    for (const p of [F.PROFILE_SESSION_ONLY, F.PROFILE_LAUNCH_NODE, F.PROFILE_FULL_HARNESS, F.PROFILE_SEPARATE_ENROLLMENT]) expectValid(validateProfile(p))
    expect(ENROLLMENT_MODES).toEqual(["inline", "separate"])
  })
  test("a version-1 profile migrates to version 2 unchanged otherwise", () => {
    expect(typeof PROFILE_MIGRATIONS[1]).toBe("function")
    expect(migrateProfile(F.PROFILE_V1)).toEqual({ ok: true, value: F.PROFILE_SESSION_ONLY })
    expectRejected(validateProfile(F.PROFILE_V1), "unsupported_version")
    expectRejected(migrateProfile({ ...F.PROFILE_SESSION_ONLY, version: 3 }), "unsupported_version")
  })
  test("plans record either profile version (a v1.0 plan still resumes)", () => {
    expectValid(validateSetupPlan({ ...F.PLAN_LAUNCH_NODE, profile: { id: "launch-node", version: 1 } }))
    expectValid(validateSetupPlan(F.PLAN_LAUNCH_NODE))
    expectRejected(validateSetupPlan({ ...F.PLAN_LAUNCH_NODE, profile: { id: "launch-node", version: 3 } }), "unsupported_version")
  })
})

describe("v1.1 codes", () => {
  test("planner issue codes exist", () => {
    const codes: IssueCode[] = ["escalation_required", "no_service_manager"]
    expect(codes).toHaveLength(2)
  })
  test("enrollment and cancellation error codes map to the exits they had", () => {
    for (const code of ["enrollment_denied", "enrollment_expired", "cancelled", "no_service_manager"]) expect(ERROR_CODES as readonly string[]).toContain(code)
    expect(exitFor("enrollment_denied")).toBe(BOOTSTRAP_EXIT.forbidden)
    expect(exitFor("enrollment_expired")).toBe(BOOTSTRAP_EXIT.needsUser)
    expect(exitFor("cancelled")).toBe(BOOTSTRAP_EXIT.needsUser)
    expect(exitFor("no_service_manager")).toBe(BOOTSTRAP_EXIT.unavailable)
    expect(exitFor("escalation_required")).toBe(BOOTSTRAP_EXIT.needsUser)
  })
  test("an existing credential for a plain-http, non-loopback hub is insecure, never probed", () => {
    expect(ENROLLMENT_STATES).toContain("insecure")
    expectValid(validateEnrollmentStatus(F.ENROLLMENT_INSECURE))
    const credential = { server: "http://hub.lan:8080", machineID: "mach_01", token: "mt_secret" }
    expect(enrollmentStatusFrom(credential, undefined, F.T0)).toEqual(F.ENROLLMENT_INSECURE)
    // Even a probe result (which a caller must never produce for it) does not make it verified.
    expect(enrollmentStatusFrom(credential, { reachable: true, accepted: true }, F.T0)).toEqual(F.ENROLLMENT_INSECURE)
    // Loopback plain http stays an ordinary, checkable hub.
    expect(enrollmentStatusFrom({ ...credential, server: "http://127.0.0.1:4096" }, undefined, F.T0).state).toBe("configured")
  })
})

describe("v1.1 journal", () => {
  test("a pending credential entry with no after whose file changed is cleared on rollback", () => {
    const e = F.JOURNAL_PENDING_CREDENTIAL
    expectValid(validateJournal({ ...F.JOURNAL_APPLYING, entries: [e] }))
    expect(recoveryDecision(e, { exists: true, sha256: F.DIGEST.b, mode: 0o600 })).toBe("clear-credential")
    expect(recoveryDecision(e, e.before)).toBe("nothing-to-do")
    // Any other class keeps what it cannot attribute.
    expect(recoveryDecision({ ...e, class: "config", kind: "merge-config", backup: { id: "bk_1" } }, { exists: true, sha256: F.DIGEST.b })).toBe("keep-user-edit")
  })
  test("a skipped entry needs no backup; anything else that changed an existing file does", () => {
    expectValid(validateJournal({ ...F.JOURNAL_APPLYING, entries: [F.JOURNAL_SKIPPED_ENTRY] }))
    expectRejected(validateJournal({ ...F.JOURNAL_APPLYING, entries: [{ ...F.JOURNAL_SKIPPED_ENTRY, status: "pending" }] }), "inconsistent")
  })
})

describe("v1.1 harness layout", () => {
  test("versions live in immutable directories; current is a link", () => {
    expect(harnessVersionRef("claude-code", "2.1.90")).toEqual({ root: "data", rel: "hub/harnesses/claude-code/2.1.90" })
    expect(harnessCurrentRef("claude-code")).toEqual({ root: "data", rel: "hub/harnesses/claude-code/current" })
  })
  test("select-harness-version and the service downgrade actions are typed actions", () => {
    for (const kind of ["select-harness-version", "deactivate-service", "remove-service"] as const) {
      expect(ACTION_KINDS).toContain(kind)
      expectValid(validateAction(F.ACTIONS[kind]))
    }
    expectValid(validateAction(F.SELECT_CLAUDE))
  })
  test("install → select → verify is a valid plan; the select's rollback restores the previous link", () => {
    expectValid(validateSetupPlan(F.PLAN_HARNESS_INSTALL))
    const install = F.HARNESS_INSTALL_JOURNAL_ENTRY
    const select = F.HARNESS_JOURNAL_ENTRY
    expectValid(validateJournal({ ...F.JOURNAL_APPLYING, entries: [install, select] }))
    expect(recoveryDecision(select, select.after!)).toBe("restore-backup")
    expect(recoveryDecision(install, install.after!)).toBe("remove-created")
    expectRejected(validateJournal({ ...F.JOURNAL_APPLYING, entries: [install, { ...select, backup: undefined }] }), "inconsistent")
  })
  test("remove-service may only follow its deactivation", () => {
    const plan = { ...F.PLAN_HARNESS_INSTALL, actions: [F.ACTIONS["deactivate-service"], F.ACTIONS["remove-service"]] }
    expectValid(validateSetupPlan(plan))
  })
})

describe("v1.1 unmergeable-format manual edits", () => {
  test("validate without a link", () => expectValid(validateManualEdit(F.MANUAL_EDIT_TOML)))
  test("unmergeableEditFor turns a merge into the exact edit for the file itself", () => {
    const merge: Action = {
      id: "codex-hub",
      kind: "merge-config",
      escalation: "user",
      summary: "Enable the hub MCP server in Codex",
      path: { root: "home", rel: ".codex/config.toml" },
      format: "toml",
      owner: "harness:codex",
      precondition: { exists: true, sha256: F.DIGEST.a },
      set: [{ pointer: "/mcp_servers/hub/enabled", value: true }],
      preserveUnknown: true,
    }
    expect(unmergeableEditFor(merge, "/Users/dev/.codex/config.toml")).toEqual(F.MANUAL_EDIT_TOML)
    expect(unmergeableEditFor(F.ACTIONS["enroll-machine"], "/x")).toBeUndefined()
  })
})
