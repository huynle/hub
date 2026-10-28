// Planning OpenCode (contract §3.10): the OpenCode HarnessAdapter's plan, a pure function of the discovery snapshot,
// the profile and what the adapter was built with (the verified hub manifest, a read-only reader for the configs the
// snapshot already found, the stable hubctl authority). It proposes, in this order (preview/plan.ts PHASE):
//
//   install-harness         the artifact hub's signed manifest pins for this host's exact target (§3.6.1), into its
//                           own immutable version directory; only when OpenCode is missing (or `install: "always"`),
//                           or hub manages it at another, older version. Never a downgrade from planning.
//   select-harness-version  makes that version `current`.
//   merge-config            the Hub plugin in `plugins` (lossless JSONC merge; nothing else changes).
//   register-mcp-server     hubctl's `mcp` at the stable authority (the command is implied by the action kind).
//   verify-harness          real probes: the binary runs, a provider answers, the spoke is connected.
//
// Determinism: config bytes are read only for files the snapshot lists, and must still have the snapshot's digest
// (else preview_stale), so the same snapshot always gives the same plan. A config hubctl must not edit (a duplicate
// plugin, a newer pin, a foreign "hub" server, an unparseable file) is refused, never half-planned: planOpencode
// returns the failure, and the adapter's plan() throws it as an OpencodePlanError (HarnessAdapter.plan returns only
// actions). A config behind a symlink is not this module's concern: planSetup turns those actions into manual edits.
import {
  compareVersions,
  executionContextOf,
  harnessCurrentRef,
  harnessVersionRef,
  REQUIRED_PROBES,
  resolvePathRef,
  type Action,
  type ConfigFormat,
  type DiscoverySnapshot,
  type ErrorCode,
  type HarnessAdapter,
  type HarnessPin,
  type HarnessVerification,
  type AdapterContext,
  type PathRef,
  type PlanInput,
  type Precondition,
  type VerifiedManifest,
} from "../../contracts/index.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"
import { sha256Of } from "../../transaction/state.ts"
import { inspectOpencodeConfig, pluginSets, pluginSpec, type ConfigInspection, type Finding } from "./config.ts"

/** The Hub plugin is an OpenCode 2 plugin (the @opencode/plugin 2 API): no older OpenCode is ever installed for it. */
export const MIN_OPENCODE_VERSION = "2.0.0"

/** The stable hubctl authority: the standalone hubctl hub installs (contract install-artifact, user-bin:hubctl). */
export const DEFAULT_AUTHORITY: PathRef = { root: "user-bin", rel: "hubctl" }
/** Authorities the MCP server may run: hubctl or its hub alias (one command surface), in a bin root. */
const AUTHORITY_ROOTS = new Set<PathRef["root"]>(["user-bin", "system-bin"])
const AUTHORITY_NAMES = new Set(["hubctl", "hub"])

/** The config files OpenCode reads from its global config dir, in the order hubctl prefers to edit them. */
export const CONFIG_REFS: readonly { readonly ref: PathRef; readonly format: ConfigFormat }[] = [
  { ref: { root: "config", rel: "opencode/opencode.jsonc" }, format: "jsonc" },
  { ref: { root: "config", rel: "opencode/opencode.json" }, format: "json" },
]
/** The file a new config is created as (plain JSON is valid JSONC too). */
const NEW_CONFIG = CONFIG_REFS[1]!

export interface OpencodePlanOptions {
  /** The verified hub release manifest whose pins vouch for OpenCode downloads; without it nothing is installed. */
  readonly manifest?: VerifiedManifest
  /** Reads a file the snapshot listed (DiscoveryProbe.readFile): read-only, following links. */
  readonly readConfig: (path: string) => Uint8Array | undefined
  /** The hubctl the MCP server runs (default user-bin:hubctl; user-bin:hub is the same command surface). */
  readonly authority?: PathRef
  /** Pin the Hub plugin to this exact version (this hubctl's own); unpinned when absent. */
  readonly pluginVersion?: string
  /** "if-missing" (default): keep an OpenCode the user installed. "always": install hub's pinned one beside it. */
  readonly install?: "if-missing" | "always"
}

export interface OpencodePlan {
  readonly actions: readonly Action[]
  readonly findings: readonly Finding[]
}

/** A refusal from the adapter's plan(): the config or host cannot be planned for without overwriting something. */
export class OpencodePlanError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "OpencodePlanError"
  }
}

/** Throws if `ref` is not a stable hubctl authority (never a plugin-cache launcher or a path under state/data). */
export function checkAuthority(ref: PathRef): void {
  if (!AUTHORITY_ROOTS.has(ref.root) || !AUTHORITY_NAMES.has(ref.rel))
    throw new Error(`the MCP authority must be the installed hubctl (or its hub alias) in a bin directory, not ${ref.root}:${ref.rel}`)
}

const LABEL = "OpenCode"

function installActions(snapshot: DiscoverySnapshot, manifest: VerifiedManifest, pin: HarnessPin): Action[] {
  return [
    {
      id: "install-opencode",
      kind: "install-harness",
      escalation: "user",
      summary: `Install ${LABEL} ${pin.version} for ${pin.target} (pinned by hub ${manifest.release})`,
      harness: "opencode",
      version: pin.version,
      target: pin.target,
      source: { manifest: manifest.release, url: pin.url, file: pin.file },
      size: pin.size,
      sha256: pin.sha256,
      evidence: [...pin.evidence],
      path: harnessVersionRef("opencode", pin.version),
      owner: "hub",
      rollback: "restore-previous",
    },
    {
      id: "select-opencode",
      kind: "select-harness-version",
      escalation: "user",
      summary: `Make ${LABEL} ${pin.version} the current version`,
      harness: "opencode",
      version: pin.version,
      path: harnessCurrentRef("opencode"),
      target: harnessVersionRef("opencode", pin.version),
    },
  ]
}

/** Whether (and what) to install. */
function planInstall(snapshot: DiscoverySnapshot, options: OpencodePlanOptions, findings: Finding[]): TxResult<Action[]> {
  const presence = snapshot.harnesses.find((h) => h.id === "opencode")
  const installed = presence?.installed === true
  const pin = options.manifest?.harnesses.find((h) => h.harness === "opencode" && h.target === snapshot.host.target)
  if (pin && compareVersions(pin.version, MIN_OPENCODE_VERSION) < 0) return txFail("invalid", `hub pins ${LABEL} ${pin.version}, but the Hub plugin needs ${LABEL} ${MIN_OPENCODE_VERSION} or later`)
  if (presence?.installMethod === "hub" && presence.version) {
    if (!pin || pin.version === presence.version) return txOk([])
    if (compareVersions(pin.version, presence.version) < 0) {
      findings.push({ code: "harness-newer-than-pin", message: `hub manages ${LABEL} ${presence.version}, newer than the pinned ${pin.version}; planning never downgrades it` })
      return txOk([])
    }
    return txOk(installActions(snapshot, options.manifest!, pin))
  }
  if (installed && (options.install ?? "if-missing") === "if-missing") {
    findings.push({ code: "harness-user-installed", message: `${LABEL} is already installed at ${presence!.path} (${presence!.installMethod ?? "unknown"}); hubctl keeps it` })
    return txOk([])
  }
  if (!pin || !options.manifest) return txFail("unpinned_artifact", `this hub release pins no ${LABEL} for ${snapshot.host.target}; install ${LABEL} 2 yourself, or use a hub release that pins it`)
  return txOk(installActions(snapshot, options.manifest, pin))
}

interface ConfigView {
  readonly ref: PathRef
  readonly format: ConfigFormat
  readonly precondition: Precondition
  readonly inspection: ConfigInspection
}

/** The configs the snapshot found, read and inspected (their bytes pinned by the snapshot's digests). */
function readConfigs(snapshot: DiscoverySnapshot, options: OpencodePlanOptions, authority: string): TxResult<ConfigView[]> {
  const context = executionContextOf(snapshot)
  const views: ConfigView[] = []
  for (const { ref, format } of CONFIG_REFS) {
    const where = resolvePathRef(ref, snapshot.roots, context)
    if (!where.ok) return txFail("invalid", `this host has no ${ref.root} root`)
    const found = snapshot.configs.find((c) => c.path === where.value)
    if (!found || found.sha256 === null) continue
    const bytes = options.readConfig(where.value)
    if (!bytes || sha256Of(bytes) !== found.sha256) return txFail("preview_stale", `${where.value} changed since discovery; discover and preview again`)
    const inspection = inspectOpencodeConfig(new TextDecoder().decode(bytes), { authority, ...(options.pluginVersion ? { pluginVersion: options.pluginVersion } : {}) })
    if (!inspection.ok) return txFail(inspection.code, `${where.value}: ${inspection.message}`)
    views.push({ ref, format, precondition: { exists: true, sha256: found.sha256 }, inspection: inspection.value })
  }
  return txOk(views)
}

function planConfig(snapshot: DiscoverySnapshot, options: OpencodePlanOptions, authorityRef: PathRef, findings: Finding[]): TxResult<Action[]> {
  const authority = resolvePathRef(authorityRef, snapshot.roots, executionContextOf(snapshot))
  if (!authority.ok) return txFail("invalid", `this host has no ${authorityRef.root} root for hubctl`)
  const views = readConfigs(snapshot, options, authority.value)
  if (!views.ok) return views
  const fresh: ConfigView = { ...NEW_CONFIG, precondition: { exists: false }, inspection: { plugin: { state: "absent" }, mcp: { state: "absent" }, findings: [] } }
  const preferred = views.value[0] ?? fresh
  // OpenCode merges its config files: an entry in two of them is a duplicate, whichever wins.
  const withPlugin = views.value.filter((v) => v.inspection.plugin.state !== "absent")
  const withMcp = views.value.filter((v) => v.inspection.mcp.state !== "absent")
  if (withPlugin.length > 1) return txFail("conflict", `the Hub plugin is listed in both ${CONFIG_REFS.map((c) => c.ref.rel).join(" and ")}; keep it in one of them`)
  if (withMcp.length > 1) return txFail("conflict", `the hub MCP server is registered in both ${CONFIG_REFS.map((c) => c.ref.rel).join(" and ")}; keep it in one of them`)
  for (const v of views.value) findings.push(...v.inspection.findings)
  const pluginFile = withPlugin[0] ?? preferred
  const mcpFile = withMcp[0] ?? preferred
  const actions: Action[] = []
  const sets = pluginSets(pluginFile.inspection.plugin, options)
  if (sets.length > 0)
    actions.push({
      id: "opencode-plugin",
      kind: "merge-config",
      escalation: "user",
      summary: pluginFile.inspection.plugin.state === "drift" ? `Update the Hub plugin in ${LABEL}'s config to ${pluginSpec(options)}` : `Add the Hub plugin (${pluginSpec(options)}) to ${LABEL}'s config`,
      path: pluginFile.ref,
      format: pluginFile.format,
      owner: "harness:opencode",
      precondition: pluginFile.precondition,
      set: sets,
      preserveUnknown: true,
    })
  if (mcpFile.inspection.mcp.state !== "registered")
    actions.push({
      id: "opencode-mcp",
      kind: "register-mcp-server",
      escalation: "user",
      summary: `Register hubctl's MCP server (${authority.value} mcp) with ${LABEL} as "hub"`,
      harness: "opencode",
      path: mcpFile.ref,
      name: "hub",
      precondition: mcpFile.precondition,
    })
  return txOk(actions)
}

const verifyAction = (): Action => ({
  id: "verify-opencode",
  kind: "verify-harness",
  escalation: "user",
  summary: `Verify ${LABEL} really runs, reaches its provider and connects to the hub`,
  harness: "opencode",
  probes: REQUIRED_PROBES.opencode.filter((p): p is Exclude<typeof p, "presence"> => p !== "presence"),
})

/** The OpenCode actions for this snapshot and profile, with the findings worth showing; or the refusal. */
export function planOpencode(input: PlanInput, options: OpencodePlanOptions): TxResult<OpencodePlan> {
  if (!input.profile.harnesses.includes("opencode")) return txOk({ actions: [], findings: [] })
  const authority = options.authority ?? DEFAULT_AUTHORITY
  try {
    checkAuthority(authority)
  } catch (error) {
    return txFail("invalid", (error as Error).message)
  }
  const findings: Finding[] = []
  const install = planInstall(input.snapshot, options, findings)
  if (!install.ok) return install
  const config = planConfig(input.snapshot, options, authority, findings)
  if (!config.ok) return config
  return txOk({ actions: [...install.value, ...config.value, verifyAction()], findings })
}

export interface OpencodeAdapterOptions extends OpencodePlanOptions {
  /** Presence (adapters/opencode/verify.ts wires discovery); absent: discover() is not available here. */
  readonly discover?: HarnessAdapter["discover"]
  /** The real probes (adapters/opencode/verify.ts); absent: every required probe fails (never ready). */
  readonly verify?: (context: AdapterContext) => Promise<HarnessVerification>
}

/** The OpenCode HarnessAdapter (register it with createAdapterRegistry). */
export function createOpencodeAdapter(options: OpencodeAdapterOptions): HarnessAdapter {
  checkAuthority(options.authority ?? DEFAULT_AUTHORITY)
  return {
    id: "opencode",
    discover: options.discover ?? (async () => ({ id: "opencode", installed: false, health: { state: "unverified", probes: [] } })),
    plan(input) {
      const planned = planOpencode(input, options)
      if (!planned.ok) throw new OpencodePlanError(planned.code, planned.message)
      return planned.value.actions
    },
    verify:
      options.verify ??
      (async (context) => ({ harness: "opencode", probes: REQUIRED_PROBES.opencode.map((kind) => ({ kind, ok: false, observedAt: context.now(), detail: "no probe configured" })) })),
  }
}
