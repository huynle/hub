// Fixtures for the profile layer (packages/cli/src/bootstrap/profiles). Plain, clock-free data built on the shared
// contract fixtures (./fixtures.ts), which this file never changes. Everything a test mutates is a copy.
import { digestOf, planDigest, PROFILE_MIGRATIONS, type Action, type InstallHarness, type JournalEntry, type DiscoverySnapshot, type ProfileMigrations, type SetupPlan, type TransactionJournal } from "../../src/bootstrap/contracts/index.ts"
import { ACTIONS, DIGEST, DISCOVERY_DARWIN, HOST, INSTALL_CLAUDE, PREVIEW, PROFILE_V0, T0 } from "./fixtures.ts"

/** Deep-freezes a value so a test can prove a pure function never writes to its inputs. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

/** A deep copy (fixtures are plain JSON). */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * The pre-v1 draft shape (PROFILE_V0: one profile name and one harness) upgraded to v1, then by hubctl's own
 * 1 → 2 migration (v1.1) to the current version. Injected by tests only: hubctl ships no 0 → 1 migration.
 */
export const MIGRATIONS_FROM_V0: ProfileMigrations = Object.freeze({
  ...PROFILE_MIGRATIONS,
  0: (raw: Record<string, unknown>) => ({
    schema: raw.schema,
    version: 1,
    id: raw.profile,
    harnesses: [raw.harness],
    runtimes: [],
    services: [],
    launch: { enabled: false },
    escalation: "never",
  }),
})

export const PROFILE_V0_MIGRATED = {
  schema: "hub.bootstrap-profile",
  version: 2,
  id: "session-only",
  harnesses: ["opencode"],
  runtimes: [],
  services: [],
  launch: { enabled: false },
  escalation: "never",
} as const

export { PROFILE_V0 }

// ---------- drift: an applied plan, its journal, and a fresh plan for the same host ----------

/** Distinct, valid digests named for what they stand for. */
export const D = {
  opencodeOriginal: DIGEST.d,
  opencodeMerged: digestOf("opencode.json after the merge"),
  opencodeApplied: digestOf("opencode.json after the mcp registration"),
  opencodeUserEdited: digestOf("opencode.json after a user edit"),
  nodeV1: digestOf("node.json v1"),
  nodeV2: digestOf("node.json v2"),
  nodeUserEdited: digestOf("node.json edited by the user"),
} as const

export const OPENCODE_JSON = { root: "config", rel: "opencode/opencode.json" } as const
export const NODE_JSON = { root: "config", rel: "hub/node.json" } as const

const merge = (sets: { pointer: string; value: string | number }[], precondition: string): Action => ({
  id: "opencode-hub",
  kind: "merge-config",
  escalation: "user",
  summary: "Add the hub plugin and settings to OpenCode's config",
  path: OPENCODE_JSON,
  format: "json",
  owner: "harness:opencode",
  precondition: { exists: true, sha256: precondition },
  set: sets,
  preserveUnknown: true,
})
const register = (precondition: string): Action => ({
  id: "opencode-mcp",
  kind: "register-mcp-server",
  escalation: "user",
  summary: "Register hubctl mcp with OpenCode",
  harness: "opencode",
  path: OPENCODE_JSON,
  name: "hub",
  precondition: { exists: true, sha256: precondition },
})
const nodeJSON = (sha256: string): Action => ({
  id: "node-json",
  kind: "write-file",
  escalation: "user",
  summary: "Write the node's workspace roots",
  path: NODE_JSON,
  asset: "config/node.json",
  sha256,
  mode: 0o600,
  onConflict: "refuse",
})
const plan = (actions: Action[]): SetupPlan => ({
  schema: "hub.setup-plan",
  version: 1,
  hostFingerprint: HOST,
  snapshotDigest: DIGEST.b,
  target: "darwin-arm64",
  profile: { id: "launch-node", version: 2 },
  requiresEscalation: false,
  activatesServices: false,
  actions,
})

/** What an earlier apply did: the hub plugin, a "session" mode, the mcp registration and node.json v1. */
export const APPLIED_PLAN: SetupPlan = plan([
  merge([{ pointer: "/plugin/-", value: "@huynle/hub" }, { pointer: "/hub/mode", value: "session" }], D.opencodeOriginal),
  register(D.opencodeMerged),
  nodeJSON(D.nodeV1),
])

/** What this hubctl wants now: mode "launch" (changed), a launch bound (new), node.json v2 (changed). */
export const FRESH_PLAN: SetupPlan = plan([
  merge(
    [
      { pointer: "/plugin/-", value: "@huynle/hub" },
      { pointer: "/hub/mode", value: "launch" },
      { pointer: "/hub/launchMaxS", value: 3600 },
    ],
    D.opencodeApplied,
  ),
  register(D.opencodeApplied),
  nodeJSON(D.nodeV2),
])

export const APPLIED_JOURNAL: TransactionJournal = {
  schema: "hub.transaction-journal",
  version: 1,
  txID: "tx_applied",
  planDigest: planDigest(APPLIED_PLAN),
  hostFingerprint: HOST,
  nonce: PREVIEW.nonce,
  state: "committed",
  startedAt: T0,
  updatedAt: T0 + 2000,
  entries: [
    {
      seq: 1,
      actionID: "opencode-hub",
      kind: "merge-config",
      class: "config",
      path: OPENCODE_JSON,
      before: { exists: true, sha256: D.opencodeOriginal, mode: 0o644 },
      after: { exists: true, sha256: D.opencodeMerged, mode: 0o644 },
      backup: { id: "bk_1" },
      status: "done",
    },
    {
      seq: 2,
      actionID: "opencode-mcp",
      kind: "register-mcp-server",
      class: "config",
      path: OPENCODE_JSON,
      before: { exists: true, sha256: D.opencodeMerged, mode: 0o644 },
      after: { exists: true, sha256: D.opencodeApplied, mode: 0o644 },
      backup: { id: "bk_2" },
      status: "done",
    },
    {
      seq: 3,
      actionID: "node-json",
      kind: "write-file",
      class: "file",
      path: NODE_JSON,
      before: { exists: false },
      after: { exists: true, sha256: D.nodeV1, mode: 0o600 },
      status: "done",
    },
  ],
}

/** DISCOVERY_DARWIN with the given digests for opencode.json and node.json (undefined: not discovered). */
export function snapshotWith(opencode: string | null | undefined, node: string | null | undefined): DiscoverySnapshot {
  const others = DISCOVERY_DARWIN.configs.filter((c) => !c.path.endsWith("/opencode.json"))
  return {
    ...DISCOVERY_DARWIN,
    configs: [
      ...others,
      ...(opencode === undefined ? [] : [{ path: "/Users/dev/.config/opencode/opencode.json", owner: "harness:opencode" as const, format: "json" as const, sha256: opencode }]),
      ...(node === undefined ? [] : [{ path: "/Users/dev/.config/hub/node.json", owner: "hub" as const, format: "json" as const, sha256: node }]),
    ],
  }
}

// ---------- history: two committed applies on this host ----------

export const HOUR = 3_600_000
/** v1.1 layout: one immutable directory per version, and the `current` link select-harness-version switches. */
export const CLAUDE_CURRENT = { root: "data", rel: "hub/harnesses/claude-code/current" } as const
export const CLAUDE_185 = { root: "data", rel: "hub/harnesses/claude-code/2.1.85" } as const
export const CLAUDE_190 = { root: "data", rel: "hub/harnesses/claude-code/2.1.90" } as const
/** The digests of the `current` link's target ("2.1.85" / "2.1.90"). */
export const LINK = { to185: digestOf("current -> 2.1.85"), to190: digestOf("current -> 2.1.90") } as const

/** Claude Code 2.1.85, the first hub install (nothing to restore). */
export const INSTALL_CLAUDE_OLD: InstallHarness = {
  ...(INSTALL_CLAUDE as InstallHarness),
  id: "install-claude",
  summary: "Install Claude Code 2.1.85 for darwin-arm64 (pinned by hub 0.7.0)",
  version: "2.1.85",
  source: { manifest: "0.7.0", url: "https://downloads.claude.ai/claude-code-releases/2.1.85/darwin-arm64/claude", file: "claude" },
  sha256: DIGEST.c,
  path: CLAUDE_185,
  previous: undefined,
}
const VERIFY_CLAUDE: Action = { ...(ACTIONS["verify-harness"] as Action & { kind: "verify-harness" }), id: "verify-claude", harness: "claude-code", summary: "Verify Claude Code really runs" }
const select = (version: string, previous?: { version: string; sha256: string }): Action => ({
  id: "select-claude",
  kind: "select-harness-version",
  escalation: "user",
  summary: `Make Claude Code ${version} the current version`,
  harness: "claude-code",
  version,
  path: CLAUDE_CURRENT,
  target: { root: "data", rel: `hub/harnesses/claude-code/${version}` },
  ...(previous ? { previous } : {}),
})

export const PLAN_ONE: SetupPlan = plan([APPLIED_PLAN.actions[0]!, INSTALL_CLAUDE_OLD, select("2.1.85"), VERIFY_CLAUDE])
export const PLAN_TWO: SetupPlan = plan([INSTALL_CLAUDE as InstallHarness, select("2.1.90", { version: "2.1.85", sha256: DIGEST.c }), VERIFY_CLAUDE, nodeJSON(D.nodeV1)])

const entry = (e: Omit<JournalEntry, "status"> & { status?: JournalEntry["status"] }): JournalEntry => ({ status: "done", ...e })

export const JOURNAL_ONE: TransactionJournal = {
  schema: "hub.transaction-journal",
  version: 1,
  txID: "tx_one",
  planDigest: planDigest(PLAN_ONE),
  hostFingerprint: HOST,
  nonce: "nonce-one-0123456789",
  state: "committed",
  startedAt: T0 + HOUR,
  updatedAt: T0 + HOUR + 1000,
  entries: [
    entry({
      seq: 1,
      actionID: "opencode-hub",
      kind: "merge-config",
      class: "config",
      path: OPENCODE_JSON,
      before: { exists: true, sha256: D.opencodeOriginal, mode: 0o644 },
      after: { exists: true, sha256: D.opencodeMerged, mode: 0o644 },
      backup: { id: "bk_one1" },
    }),
    entry({ seq: 2, actionID: "install-claude", kind: "install-harness", class: "harness", path: CLAUDE_185, before: { exists: false }, after: { exists: true, sha256: DIGEST.c, mode: 0o755 } }),
    entry({ seq: 3, actionID: "select-claude", kind: "select-harness-version", class: "link", path: CLAUDE_CURRENT, before: { exists: false }, after: { exists: true, symlink: true, sha256: LINK.to185 } }),
    entry({ seq: 4, actionID: "verify-claude", kind: "verify-harness", class: "external", before: { exists: false } }),
  ],
}

export const JOURNAL_TWO: TransactionJournal = {
  ...JOURNAL_ONE,
  txID: "tx_two",
  planDigest: planDigest(PLAN_TWO),
  nonce: "nonce-two-0123456789",
  startedAt: T0 + 2 * HOUR,
  updatedAt: T0 + 2 * HOUR + 1000,
  entries: [
    entry({ seq: 1, actionID: "install-claude", kind: "install-harness", class: "harness", path: CLAUDE_190, before: { exists: false }, after: { exists: true, sha256: DIGEST.f, mode: 0o755 } }),
    entry({
      seq: 2,
      actionID: "select-claude",
      kind: "select-harness-version",
      class: "link",
      path: CLAUDE_CURRENT,
      before: { exists: true, symlink: true, sha256: LINK.to185 },
      after: { exists: true, symlink: true, sha256: LINK.to190 },
      backup: { id: "bk_two2" },
    }),
    entry({ seq: 3, actionID: "verify-claude", kind: "verify-harness", class: "external", before: { exists: false } }),
    entry({ seq: 4, actionID: "node-json", kind: "write-file", class: "file", path: NODE_JSON, before: { exists: false }, after: { exists: true, sha256: D.nodeV1, mode: 0o600 } }),
  ],
}

/** The state of every path as the second apply left it (the input to a rollback plan). */
export function stateAfterTwo(overrides: Record<string, { exists: boolean; sha256?: string; mode?: number; symlink?: boolean }> = {}) {
  const now: Record<string, { exists: boolean; sha256?: string; mode?: number; symlink?: boolean }> = {
    "config:opencode/opencode.json": { exists: true, sha256: D.opencodeMerged, mode: 0o644 },
    "data:hub/harnesses/claude-code/2.1.85": { exists: true, sha256: DIGEST.c, mode: 0o755 },
    "data:hub/harnesses/claude-code/2.1.90": { exists: true, sha256: DIGEST.f, mode: 0o755 },
    "data:hub/harnesses/claude-code/current": { exists: true, symlink: true, sha256: LINK.to190 },
    "config:hub/node.json": { exists: true, sha256: D.nodeV1, mode: 0o600 },
    "config:hub/config.json": { exists: true, sha256: DIGEST.b, mode: 0o600 },
    "state:hub": { exists: true, mode: 0o700 },
    ...overrides,
  }
  return (e: JournalEntry) => (e.path ? (now[`${e.path.root}:${e.path.rel}`] ?? { exists: false }) : { exists: false })
}
