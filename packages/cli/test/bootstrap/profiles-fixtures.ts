// Fixtures for the profile layer (packages/cli/src/bootstrap/profiles). Plain, clock-free data built on the shared
// contract fixtures (./fixtures.ts), which this file never changes. Everything a test mutates is a copy.
import { digestOf, planDigest, type Action, type DiscoverySnapshot, type ProfileMigrations, type SetupPlan, type TransactionJournal } from "../../src/bootstrap/contracts/index.ts"
import { DIGEST, DISCOVERY_DARWIN, HOST, PREVIEW, PROFILE_V0, T0 } from "./fixtures.ts"

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
 * The pre-v1 draft shape (PROFILE_V0: one profile name and one harness) upgraded to v1. Injected by tests only:
 * v1 is the first frozen profile version, so hubctl ships no migrations yet.
 */
export const MIGRATIONS_FROM_V0: ProfileMigrations = Object.freeze({
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
  version: 1,
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
  profile: { id: "launch-node", version: 1 },
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
