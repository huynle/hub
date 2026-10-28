// The Claude Code HarnessAdapter (contracts §3.10): a pure planner over the discovery snapshot and the verified hub
// manifest, discovery of the claude binary through the read-only DiscoveryProbe, and verification through real
// probes (verify.ts). It never gets a shell.
//
// Plan (in planSetup's phase order):
//   install-harness         the artifact hub's signed manifest pins for this target, into its own immutable
//                           directory data:hub/harnesses/claude-code/<version> (downgrade policy: decideHarnessInstall)
//   select-harness-version  makes that version current (rollback: the previous version is current again)
//   merge-config            hub's own config:hub/claude-code.json gets {"binary": <current/claude>}, the one
//                           hub-owned entry that points the existing spoke (daemon, `hub claude`, the plugin it
//                           writes) at the hub-installed binary. Created by hub, so a rollback removes it; a
//                           symlinked hub config dir becomes a manual edit (planSetup).
//   verify-harness          version-exec, provider-auth, spoke-connected (install is never readiness)
//
// ~/.claude and ~/.claude.json are never planned: the existing integration loads the hub plugin with --plugin-dir
// and never edits the user's Claude Code files (docs/harnesses.md). A Claude Code the user installed themselves is
// kept and only verified, unless the caller prefers a hub-managed install.
import {
  checkHarnessPin,
  decideHarnessInstall,
  executionContextOf,
  fail,
  harnessCurrentRef,
  harnessVersionRef,
  ok,
  REQUIRED_PROBES,
  resolvePathRef,
  rootPathIn,
  type Action,
  type DiscoverySnapshot,
  type ExecutionContext,
  type HarnessAdapter,
  type HarnessPresence,
  type InstallHarness,
  type MergeConfig,
  type PathRef,
  type PlanInput,
  type Precondition,
  type Result,
  type RootMapping,
  type SelectHarnessVersion,
  type VerifiedManifest,
  type VerifyHarness,
} from "../../contracts/index.ts"
import { classifyExecutable, HARNESS_BINARIES, installOf, pathDirs, which } from "../../discovery/executables.ts"
import { discoverRoots } from "../../discovery/host.ts"
import type { DiscoveryProbe } from "../../discovery/probe.ts"
import type { ProbeRunner } from "./ports.ts"
import { verifyClaude, type ClaudeBinary, type ClaudeProbes } from "./verify.ts"

const HARNESS = "claude-code" as const
const BINARY = HARNESS_BINARIES[HARNESS]

/** Hub's own Claude Code integration config (hub-owned; never a Claude Code file). */
export const CLAUDE_CONFIG_REF: PathRef = Object.freeze({ root: "config", rel: "hub/claude-code.json" })
/** The key in it naming the claude binary the spoke runs. */
export const CLAUDE_CONFIG_POINTER = "/binary"
/** The hub-installed binary, inside the `current` link. */
export const currentBinaryRel = `${harnessCurrentRef(HARNESS).rel}/${BINARY}`

export type ClaudeDecision = "none" | "user-managed" | "keep" | "select" | "install" | "upgrade" | "downgrade"

export interface ClaudePlan {
  readonly decision: ClaudeDecision
  readonly actions: readonly Action[]
}

export interface ClaudeAdapterOptions {
  /** The hub release manifest, verified against the shipped trust root. Without it nothing is installed. */
  readonly manifest?: VerifiedManifest
  /** What hub installed before, from the history (installedHarnesses). */
  readonly installed?: { readonly version: string; readonly sha256: string }
  /** The highest Claude Code floor this machine has seen. */
  readonly floor?: string
  /** Explicit --allow-downgrade. */
  readonly allowDowngrade?: boolean
  /** existing (default): keep a Claude Code the user installed; hub: install the pinned one beside it. */
  readonly prefer?: "existing" | "hub"
  /** The state of a config file discovery does not record (config:hub/claude-code.json), by its path. */
  readonly configState?: (path: string) => Precondition | undefined
  /** Read-only host access for discover() and the binary readiness runs against. */
  readonly probe?: DiscoveryProbe
  /** The roots (default: discovered through the probe) and where hubctl runs (default host). */
  readonly roots?: readonly RootMapping[]
  readonly context?: ExecutionContext
  /** Real probes (verify.ts); without a runner nothing can be verified. */
  readonly probes?: { readonly runner: ProbeRunner } & Pick<ClaudeProbes, "spoke" | "conformance">
}

const VERB = { install: "Install", upgrade: "Upgrade", downgrade: "Downgrade" } as const

const verifyAction = (): VerifyHarness => ({
  id: `verify-${HARNESS}`,
  kind: "verify-harness",
  escalation: "user",
  summary: "Verify Claude Code runs, is logged in, and its spoke connects to the hub",
  harness: HARNESS,
  probes: REQUIRED_PROBES[HARNESS].filter((p): p is Exclude<typeof p, "presence"> => p !== "presence"),
})

function selectAction(version: string, previous?: { readonly version: string; readonly sha256: string }): SelectHarnessVersion {
  return {
    id: `select-${HARNESS}`,
    kind: "select-harness-version",
    escalation: "user",
    summary: `Make Claude Code ${version} the current version`,
    harness: HARNESS,
    version,
    path: harnessCurrentRef(HARNESS),
    target: harnessVersionRef(HARNESS, version),
    ...(previous ? { previous: { ...previous } } : {}),
  }
}

/** Where a root is for the context the plan runs in. */
function rootPath(snapshot: DiscoverySnapshot, id: string): string | undefined {
  const root = snapshot.roots.find((r) => r.id === id)
  return root ? rootPathIn(root, executionContextOf(snapshot)) : undefined
}

function configAction(snapshot: DiscoverySnapshot, options: ClaudeAdapterOptions): Result<MergeConfig> {
  const data = rootPath(snapshot, "data")
  const where = resolvePathRef(CLAUDE_CONFIG_REF, snapshot.roots, executionContextOf(snapshot))
  if (!data || !where.ok) return fail("/roots", "unmapped_root", "this host has no data or config root for the hub-installed Claude Code")
  const known = snapshot.configs.find((c) => c.path === where.value)
  const precondition: Precondition = known ? (known.sha256 ? { exists: true, sha256: known.sha256 } : { exists: false }) : (options.configState?.(where.value) ?? { exists: false })
  return ok({
    id: `${HARNESS}-config`,
    kind: "merge-config",
    escalation: "user",
    summary: "Point hub's Claude Code spoke at the hub-installed claude",
    path: CLAUDE_CONFIG_REF,
    format: "json",
    owner: "hub",
    precondition,
    set: [{ pointer: CLAUDE_CONFIG_POINTER, value: `${data}/${currentBinaryRel}` }],
    preserveUnknown: true,
  })
}

/** Plans Claude Code for this snapshot and profile, with the reason when it cannot. Pure and deterministic. */
export function planClaude(input: PlanInput, options: ClaudeAdapterOptions): Result<ClaudePlan> {
  const { snapshot, profile } = input
  if (!profile.harnesses.includes(HARNESS)) return ok({ decision: "none", actions: [] })
  const presence = snapshot.harnesses.find((h) => h.id === HARNESS)
  const verify = verifyAction()
  if (presence?.installed && presence.installMethod !== "hub" && options.prefer !== "hub") return ok({ decision: "user-managed", actions: [verify] })
  const target = snapshot.host.target
  const manifest = options.manifest
  const pin = manifest?.harnesses.find((p) => p.harness === HARNESS && p.target === target)
  if (!manifest || !pin) return fail("/harnesses/claude-code", "unpinned_artifact", manifest ? `hub ${manifest.release} pins no Claude Code for ${target}` : "no verified hub manifest to install Claude Code from")
  const decided = decideHarnessInstall(pin, { ...(options.installed ? { installed: options.installed } : {}), ...(options.floor ? { floor: options.floor } : {}), allowDowngrade: options.allowDowngrade })
  if (!decided.ok) return decided
  const config = configAction(snapshot, options)
  if (!config.ok) return config
  const currentIsPinned = presence?.installed === true && presence.installMethod === "hub" && presence.version === pin.version
  if (decided.value === "reinstall" || (currentIsPinned && !options.installed)) {
    if (currentIsPinned) return ok({ decision: "keep", actions: [verify] })
    return ok({ decision: "select", actions: [selectAction(pin.version), config.value, verify] })
  }
  const previous = options.installed
  const install: InstallHarness = {
    id: `install-${HARNESS}`,
    kind: "install-harness",
    escalation: "user",
    summary: `${VERB[decided.value]} Claude Code ${pin.version} for ${pin.target} (pinned by hub ${manifest.release})`,
    harness: HARNESS,
    version: pin.version,
    target: pin.target,
    source: { manifest: manifest.release, url: pin.url, file: pin.file },
    size: pin.size,
    sha256: pin.sha256,
    evidence: [...pin.evidence],
    path: harnessVersionRef(HARNESS, pin.version),
    owner: "hub",
    rollback: "restore-previous",
    ...(previous ? { previous: { ...previous } } : {}),
  }
  const pinned = checkHarnessPin(manifest, install)
  if (!pinned.ok) return pinned
  return ok({ decision: decided.value, actions: [install, selectAction(pin.version, previous), config.value, verify] })
}

export interface ClaudeAdapter extends HarnessAdapter {
  /** The binary readiness runs against (hub's current version, else the program `claude` on PATH resolves to). */
  binary(): ClaudeBinary
}

export function createClaudeAdapter(options: ClaudeAdapterOptions): ClaudeAdapter {
  const context = options.context ?? "host"
  const roots = (): readonly RootMapping[] => options.roots ?? (options.probe ? (discoverRoots(options.probe) ?? []) : [])
  const at = (id: string) => {
    const r = roots().find((x) => x.id === id)
    return r ? rootPathIn(r, context) : undefined
  }
  const current = () => {
    const data = at("data")
    return data ? `${data}/${currentBinaryRel}` : undefined
  }

  /** `claude` on PATH (or in upstream's own install directories), as discovery finds it. */
  const onPath = (probe: DiscoveryProbe, home: string) => {
    const dirs = pathDirs(probe)
    const known = [`${home}/.local/bin`, `${home}/.claude/local`].filter((d) => !dirs.includes(d))
    const path = which(probe, [...dirs, ...known], BINARY)
    return path ? classifyExecutable(probe, BINARY, path) : undefined
  }

  const adapter: ClaudeAdapter = {
    id: HARNESS,
    async discover(ctx): Promise<HarnessPresence> {
      const none: HarnessPresence = { id: HARNESS, installed: false, health: { state: "unverified", probes: [] } }
      const probe = options.probe
      if (!probe) return none
      const home = at("home") ?? ctx.home
      const shim = onPath(probe, home)
      const hub = current()
      const found = shim ?? (hub && probe.executable(hub) ? classifyExecutable(probe, BINARY, hub) : undefined)
      if (!found) return none
      const install = installOf(probe, HARNESS, found, roots(), context)
      return { id: HARNESS, installed: true, path: found.path, ...(install.version ? { version: install.version } : {}), installMethod: install.installMethod, health: { state: "unverified", probes: [] } }
    },
    plan(input) {
      const planned = planClaude(input, options)
      // Unplannable (unpinned, refused downgrade): verify only, so the setup reports Claude Code as not ready.
      return planned.ok ? planned.value.actions : input.profile.harnesses.includes(HARNESS) ? [verifyAction()] : []
    },
    async verify(ctx) {
      const probes = options.probes
      if (!probes) return verifyClaude({ runner: { run: async () => ({ kind: "error", message: "no runner" }) }, binary: () => ({ problem: "this hubctl has no probe runner" }) }, ctx)
      return verifyClaude({ ...probes, binary: () => adapter.binary() }, ctx)
    },
    binary(): ClaudeBinary {
      const probe = options.probe
      if (!probe) return { problem: "no read-only host probe to find claude" }
      const hub = current()
      if (hub && probe.executable(hub)) {
        const version = installOf(probe, HARNESS, classifyExecutable(probe, BINARY, hub), roots(), context).version
        return { path: hub, ...(version ? { version } : {}) }
      }
      const shim = onPath(probe, at("home") ?? probe.home)
      if (!shim) return { problem: "Claude Code is not installed (no claude on PATH or in hub's harness directory)" }
      if (shim.kind === "container-shim") return { problem: `${shim.path} is a shim into a container; readiness is checked against a binary on this host` }
      const path = shim.resolvesTo ?? shim.path
      const version = installOf(probe, HARNESS, shim, roots(), context).version
      return { path, ...(version ? { version } : {}) }
    },
  }
  return adapter
}
