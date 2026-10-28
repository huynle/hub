// The typed Action union: everything a setup plan can ask the applier to do. There is deliberately no "run a
// command" action and no field that could carry one: each kind names a local operation the applier implements
// itself (write this embedded asset there, merge these keys into that config, load this user service). A plan that
// smuggles a command-shaped key anywhere, at any depth, is refused (exec_field), as is any unknown field or kind.
import { EMBEDDED_ASSETS, SERVICE_IDS, type ServiceID } from "./exec.ts"
import { HARNESS_EVIDENCE, HARNESS_ORDER, REAL_PROBES, RUNTIME_IDS, type EvidenceKind, type HarnessID, type ProbeKind, type RuntimeID } from "./harness.ts"
import { checkPathRef, ELEVATED_ROOTS, type PathRef } from "./paths.ts"
import { supportedTarget } from "./platform.ts"
import { findSecrets, isSecretKey } from "./secrets.ts"
import { bool, Checker, digest, FILE_NAME, httpsURL, hubURL, int, isRecord, list, oneOf, pointer, semver, shape, subset, text, type Json, type Result } from "./validate.ts"

/** Keys that would let a document carry something to execute. No action field is named like these, at any depth. */
export const EXEC_KEYS = ["command", "cmd", "commands", "shell", "script", "scripts", "exec", "execute", "argv", "args", "arguments", "run", "eval", "sh", "bash", "program", "spawn", "hook", "hooks"] as const

export type Escalation = "user" | "elevated"
export type ConfigOwner = "user" | "hub" | `harness:${HarnessID}`
export const CONFIG_OWNERS: readonly ConfigOwner[] = ["user", "hub", ...HARNESS_ORDER.map((h) => `harness:${h}` as const)]
export type ConfigFormat = "json" | "jsonc" | "toml"
export type ServiceManagerID = "launchd" | "systemd-user"

/** What the target file must look like for an edit to apply; anything else is a conflicting user edit. */
export interface Precondition {
  readonly exists: boolean
  readonly sha256?: string
}

interface Base<K extends string> {
  readonly id: string
  readonly kind: K
  readonly escalation: Escalation
  /** One printable line shown in the preview. */
  readonly summary: string
}

export interface EnsureDirectory extends Base<"ensure-directory"> {
  readonly path: PathRef
  readonly mode: number
}

export interface InstallArtifact extends Base<"install-artifact"> {
  readonly artifact: "hubctl"
  readonly version: string
  readonly target: string
  /** The manifest's digest for this target; the download must match it. */
  readonly sha256: string
  readonly path: PathRef
}

/**
 * Installs a harness from an artifact pinned in hub's signed hubctl release manifest (transitive trust): exact
 * version, target, source and digest, all of which must equal the manifest's pin (checkHarnessPin). Upstream
 * evidence (GPG manifest, notarization, sigstore) is attempted and recorded, never a substitute for the pin. The
 * install is owned by hub and rolls back by restoring the previous binary/version. Installing is not readiness:
 * a plan verifies every harness it installs.
 */
export interface InstallHarness extends Base<"install-harness"> {
  readonly harness: HarnessID
  readonly version: string
  readonly target: string
  readonly source: {
    /** The hub release whose signed manifest pins this artifact. */
    readonly manifest: string
    readonly url: string
    readonly file: string
  }
  readonly size: number
  readonly sha256: string
  /** Upstream evidence to attempt: exactly the kinds the pin lists as available. */
  readonly evidence: readonly EvidenceKind[]
  /** The install root: v1.1, exactly harnessVersionRef(harness, version), an immutable versioned directory. */
  readonly path: PathRef
  readonly owner: "hub"
  readonly rollback: "restore-previous"
  /** The version it replaces, as discovery found it (restored on rollback). */
  readonly previous?: { readonly version: string; readonly sha256: string }
}

/**
 * v1.1 harness layout. Every pinned version installs into its own immutable directory
 * data:hub/harnesses/<harness>/<version> (install-harness), and data:hub/harnesses/<harness>/current is a symlink to
 * the version in use. select-harness-version switches that link atomically (stage, rename); its rollback restores
 * the previous link from its backup, so the previous version is current again, and a rolled-back install removes
 * only its own fresh directory.
 */
export const harnessVersionRef = (harness: HarnessID, version: string): PathRef => ({ root: "data", rel: `hub/harnesses/${harness}/${version}` })
export const harnessCurrentRef = (harness: HarnessID): PathRef => ({ root: "data", rel: `hub/harnesses/${harness}/current` })

/** Points harnessCurrentRef(harness) at harnessVersionRef(harness, version). */
export interface SelectHarnessVersion extends Base<"select-harness-version"> {
  readonly harness: HarnessID
  readonly version: string
  /** The `current` link: harnessCurrentRef(harness). */
  readonly path: PathRef
  /** The version directory it points to: harnessVersionRef(harness, version). */
  readonly target: PathRef
  /** The version `current` pointed at before, as discovery found it (current again after a rollback). */
  readonly previous?: { readonly version: string; readonly sha256: string }
}

/** A symlink (the hub ↔ hubctl alias); `target` is where it points. */
export interface LinkExecutable extends Base<"link-executable"> {
  readonly path: PathRef
  readonly target: PathRef
}

/** Writes an embedded or rendered asset whose content digest is pinned in the plan. */
export interface WriteFile extends Base<"write-file"> {
  readonly path: PathRef
  readonly asset: string
  readonly sha256: string
  readonly mode: number
  /** An existing file that is not ours, or not as we left it, is never overwritten. */
  readonly onConflict: "refuse"
}

export interface ConfigSet {
  /** RFC 6901 pointer; "-" appends to an array. */
  readonly pointer: string
  readonly value: Json
}

/** A lossless merge: only the listed pointers change; every other key (known or not) is preserved byte for byte. */
export interface MergeConfig extends Base<"merge-config"> {
  readonly path: PathRef
  readonly format: ConfigFormat
  readonly owner: ConfigOwner
  readonly precondition: Precondition
  readonly set: readonly ConfigSet[]
  readonly preserveUnknown: true
}

/** Registers this hubctl's `mcp` subcommand with a harness. The command is implied, never carried. */
export interface RegisterMcpServer extends Base<"register-mcp-server"> {
  readonly harness: HarnessID
  readonly path: PathRef
  readonly name: string
  readonly precondition: Precondition
}

export interface InstallService extends Base<"install-service"> {
  readonly service: ServiceID
  readonly manager: ServiceManagerID
  readonly path: PathRef
  /** An EMBEDDED_ASSETS key for this service and manager. */
  readonly asset: string
  /** Digest of the rendered unit. */
  readonly sha256: string
}

/** Loads a user service. Only ever explicit: the user confirmed this step. */
export interface ActivateService extends Base<"activate-service"> {
  readonly service: ServiceID
  readonly manager: ServiceManagerID
  readonly confirm: "explicit"
}

/** v1.1: unloads a hub user service (a profile downgrade; needs --allow-downgrade). Rollback loads it again. */
export interface DeactivateService extends Base<"deactivate-service"> {
  readonly service: ServiceID
  readonly manager: ServiceManagerID
}

/**
 * v1.1: removes a hub service unit (a profile downgrade; needs --allow-downgrade), only while it is still exactly
 * the unit hub installed (`sha256`); a unit the user changed is a conflict, never removed. Rollback restores it.
 */
export interface RemoveService extends Base<"remove-service"> {
  readonly service: ServiceID
  readonly manager: ServiceManagerID
  readonly path: PathRef
  readonly sha256: string
}

/** Device-code enrollment of this machine (the user approves it on the hub); carries no credential. */
export interface EnrollMachine extends Base<"enroll-machine"> {
  readonly server: string
  readonly machineName: string
}

export interface VerifyHarness extends Base<"verify-harness"> {
  readonly harness: HarnessID
  readonly probes: readonly Exclude<ProbeKind, "presence">[]
}

/** Opt-in check of a sandboxed runtime (OpenShell); never installs or configures it. */
export interface VerifyRuntime extends Base<"verify-runtime"> {
  readonly runtime: RuntimeID
}

/** One bounded session launch to prove the setup end to end. */
export interface LaunchSession extends Base<"launch-session"> {
  readonly harness: HarnessID
  readonly workspace: PathRef
  readonly maxDurationS: number
}

export type Action =
  | EnsureDirectory
  | InstallArtifact
  | InstallHarness
  | SelectHarnessVersion
  | LinkExecutable
  | WriteFile
  | MergeConfig
  | RegisterMcpServer
  | InstallService
  | ActivateService
  | DeactivateService
  | RemoveService
  | EnrollMachine
  | VerifyHarness
  | VerifyRuntime
  | LaunchSession

export type ActionKind = Action["kind"]

const COMMON = ["id", "kind", "escalation", "summary"] as const

/** Every field each kind accepts (all required unless listed in ACTION_OPTIONAL). */
export const ACTION_FIELDS: Readonly<Record<ActionKind, readonly string[]>> = Object.freeze({
  "ensure-directory": [...COMMON, "path", "mode"],
  "install-artifact": [...COMMON, "artifact", "version", "target", "sha256", "path"],
  "install-harness": [...COMMON, "harness", "version", "target", "source", "size", "sha256", "evidence", "path", "owner", "rollback"],
  "select-harness-version": [...COMMON, "harness", "version", "path", "target"],
  "link-executable": [...COMMON, "path", "target"],
  "write-file": [...COMMON, "path", "asset", "sha256", "mode", "onConflict"],
  "merge-config": [...COMMON, "path", "format", "owner", "precondition", "set", "preserveUnknown"],
  "register-mcp-server": [...COMMON, "harness", "path", "name", "precondition"],
  "install-service": [...COMMON, "service", "manager", "path", "asset", "sha256"],
  "activate-service": [...COMMON, "service", "manager", "confirm"],
  "deactivate-service": [...COMMON, "service", "manager"],
  "remove-service": [...COMMON, "service", "manager", "path", "sha256"],
  "enroll-machine": [...COMMON, "server", "machineName"],
  "verify-harness": [...COMMON, "harness", "probes"],
  "verify-runtime": [...COMMON, "runtime"],
  "launch-session": [...COMMON, "harness", "workspace", "maxDurationS"],
})

/** Optional fields per kind. */
export const ACTION_OPTIONAL: Readonly<Partial<Record<ActionKind, readonly string[]>>> = Object.freeze({ "install-harness": ["previous"], "select-harness-version": ["previous"] })

export const ACTION_KINDS = Object.keys(ACTION_FIELDS) as ActionKind[]

const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ASSET_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/
const MACHINE_NAME = /^[A-Za-z0-9._-]{1,64}$/
const MCP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/
const SERVICE_ROOT: Record<ServiceManagerID, string> = { launchd: "launch-agents", "systemd-user": "systemd-user" }
const EXEC = new Set<string>(EXEC_KEYS)

/** JSON pointers of every key named like EXEC_KEYS inside `value`. */
export function findExecKeys(value: unknown, base = ""): string[] {
  const found: string[] = []
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, pointer(path, i)))
    else if (isRecord(v))
      for (const [key, item] of Object.entries(v)) {
        const p = pointer(path, key)
        if (EXEC.has(key.toLowerCase())) found.push(p)
        walk(item, p)
      }
  }
  walk(value, base)
  return found
}

const mode = (c: Checker, path: string, v: unknown) => int(c, path, v, 0, 0o7777)
const sameRef = (v: unknown, ref: PathRef) => isRecord(v) && v.root === ref.root && v.rel === ref.rel

function checkPrevious(c: Checker, path: string, v: unknown) {
  if (v === undefined) return
  const prev = shape(c, path, v, ["version", "sha256"])
  if (!prev) return
  semver(c, pointer(path, "version"), prev.version)
  digest(c, pointer(path, "sha256"), prev.sha256)
}

function checkServiceUnitPath(c: Checker, at: (key: string) => string, r: Record<string, unknown>) {
  const p = r.path as PathRef | undefined
  const root = typeof r.manager === "string" ? SERVICE_ROOT[r.manager as ServiceManagerID] : undefined
  if (root && p && root !== p.root) c.add(at("path"), "inconsistent", `${String(r.manager)} units go in the ${root} root`)
}

export function checkPrecondition(c: Checker, path: string, v: unknown) {
  const r = shape(c, path, v, ["exists"], ["sha256"])
  if (!r) return
  if (bool(c, pointer(path, "exists"), r.exists)) {
    if (r.exists && r.sha256 === undefined) c.add(pointer(path, "sha256"), "missing_field", "an existing file is pinned by its digest")
    if (!r.exists && r.sha256 !== undefined) c.add(pointer(path, "sha256"), "inconsistent", "a missing file has no digest")
  }
  if (r.sha256 !== undefined) digest(c, pointer(path, "sha256"), r.sha256)
}

function jsonValue(c: Checker, path: string, v: unknown, depth = 0): void {
  if (depth > 32) return c.add(path, "invalid_value", "too deeply nested")
  if (v === null || typeof v === "boolean" || typeof v === "string") return
  if (typeof v === "number") return void (Number.isFinite(v) || c.add(path, "invalid_value", "not a finite number"))
  if (Array.isArray(v)) return v.forEach((item, i) => jsonValue(c, pointer(path, i), item, depth + 1))
  if (isRecord(v)) return Object.entries(v).forEach(([k, item]) => jsonValue(c, pointer(path, k), item, depth + 1))
  c.add(path, "invalid_value", "not JSON")
}

/** A list of config sets: JSON pointers (never to a credential-named key) and JSON values. */
export function checkConfigSets(c: Checker, path: string, v: unknown) {
  if (Array.isArray(v) && v.length === 0) c.add(path, "invalid_value", "a merge sets at least one key")
  list(c, path, v, 64, (p, item) => {
    const s = shape(c, p, item, ["pointer", "value"])
    if (!s) return
    if (text(c, pointer(p, "pointer"), s.pointer, 512, JSON_POINTER) && s.pointer.split("/").some((seg) => isSecretKey(seg)))
      c.add(pointer(p, "pointer"), "secret", "credentials are never written by a config merge")
    jsonValue(c, pointer(p, "value"), s.value)
  })
}

/** Path-bearing fields of an action (for escalation and ownership checks). */
export function actionPaths(action: Action): PathRef[] {
  const refs: PathRef[] = []
  if ("path" in action) refs.push(action.path)
  if (action.kind === "link-executable" || action.kind === "select-harness-version") refs.push(action.target)
  if (action.kind === "launch-session") refs.push(action.workspace)
  return refs
}

export function checkAction(c: Checker, path: string, value: unknown): void {
  for (const p of findExecKeys(value, path)) c.add(p, "exec_field", "actions never carry commands")
  if (!isRecord(value)) return c.add(path, "invalid_value", "expected an action object")
  const kind = value.kind
  if (!oneOf(c, pointer(path, "kind"), kind, ACTION_KINDS)) {
    if (kind === undefined) c.add(pointer(path, "kind"), "missing_field", "missing kind")
    return
  }
  const r = shape(c, path, value, ACTION_FIELDS[kind], ACTION_OPTIONAL[kind])!
  text(c, pointer(path, "id"), r.id, 64, ACTION_ID)
  oneOf(c, pointer(path, "escalation"), r.escalation, ["user", "elevated"] as const)
  text(c, pointer(path, "summary"), r.summary)
  const at = (key: string) => pointer(path, key)
  const refs: unknown[] = []
  const ref = (key: string) => {
    if (r[key] === undefined) return
    checkPathRef(c, at(key), r[key])
    refs.push(r[key])
  }
  switch (kind) {
    case "ensure-directory":
      ref("path")
      mode(c, at("mode"), r.mode)
      break
    case "install-artifact":
      if (r.artifact !== "hubctl") c.add(at("artifact"), "invalid_value", "only the hubctl artifact is installed by the bootstrap")
      semver(c, at("version"), r.version)
      if (typeof r.target !== "string" || !supportedTarget(r.target)) c.add(at("target"), "unsupported_platform", "not a supported target")
      digest(c, at("sha256"), r.sha256)
      ref("path")
      break
    case "install-harness": {
      const harnessOK = oneOf(c, at("harness"), r.harness, HARNESS_ORDER)
      semver(c, at("version"), r.version)
      if (typeof r.target !== "string" || !supportedTarget(r.target)) c.add(at("target"), "unsupported_platform", "not a supported target")
      const src = shape(c, at("source"), r.source, ["manifest", "url", "file"])
      if (src) {
        semver(c, pointer(at("source"), "manifest"), src.manifest)
        httpsURL(c, pointer(at("source"), "url"), src.url)
        if (typeof src.file !== "string" || !FILE_NAME.test(src.file)) c.add(pointer(at("source"), "file"), "invalid_path", "expected a plain file name")
      }
      int(c, at("size"), r.size, 1, 2 ** 40)
      digest(c, at("sha256"), r.sha256)
      if (harnessOK) subset(c, at("evidence"), r.evidence, HARNESS_EVIDENCE[r.harness as HarnessID])
      ref("path")
      if (r.owner !== "hub") c.add(at("owner"), "invalid_value", "harness installs are owned by hub (recorded in the journal)")
      if (r.rollback !== "restore-previous") c.add(at("rollback"), "invalid_value", "harness installs roll back by restoring the previous version")
      checkPrevious(c, at("previous"), r.previous)
      if (harnessOK && typeof r.version === "string" && r.path !== undefined && !sameRef(r.path, harnessVersionRef(r.harness as HarnessID, r.version)))
        c.add(at("path"), "inconsistent", `a harness version installs into its own directory data:${harnessVersionRef(r.harness as HarnessID, r.version).rel}`)
      break
    }
    case "select-harness-version": {
      const harnessOK = oneOf(c, at("harness"), r.harness, HARNESS_ORDER)
      const versionOK = semver(c, at("version"), r.version)
      ref("path")
      ref("target")
      checkPrevious(c, at("previous"), r.previous)
      if (harnessOK && r.path !== undefined && !sameRef(r.path, harnessCurrentRef(r.harness as HarnessID)))
        c.add(at("path"), "inconsistent", `the current version is the link data:${harnessCurrentRef(r.harness as HarnessID).rel}`)
      if (harnessOK && versionOK && r.target !== undefined && !sameRef(r.target, harnessVersionRef(r.harness as HarnessID, r.version as string)))
        c.add(at("target"), "inconsistent", `the link points at the version directory data:${harnessVersionRef(r.harness as HarnessID, r.version as string).rel}`)
      break
    }
    case "link-executable":
      ref("path")
      ref("target")
      break
    case "write-file":
      ref("path")
      text(c, at("asset"), r.asset, 128, ASSET_ID)
      digest(c, at("sha256"), r.sha256)
      mode(c, at("mode"), r.mode)
      if (r.onConflict !== "refuse") c.add(at("onConflict"), "invalid_value", "conflicting files are always refused, never overwritten")
      break
    case "merge-config":
      ref("path")
      oneOf(c, at("format"), r.format, ["json", "jsonc", "toml"] as const)
      oneOf(c, at("owner"), r.owner, CONFIG_OWNERS)
      checkPrecondition(c, at("precondition"), r.precondition)
      if (r.preserveUnknown !== true) c.add(at("preserveUnknown"), "invalid_value", "merges are always lossless")
      checkConfigSets(c, at("set"), r.set)
      break
    case "register-mcp-server":
      oneOf(c, at("harness"), r.harness, HARNESS_ORDER)
      ref("path")
      text(c, at("name"), r.name, 32, MCP_NAME)
      checkPrecondition(c, at("precondition"), r.precondition)
      break
    case "install-service": {
      oneOf(c, at("service"), r.service, SERVICE_IDS)
      oneOf(c, at("manager"), r.manager, ["launchd", "systemd-user"] as const)
      ref("path")
      digest(c, at("sha256"), r.sha256)
      const asset = typeof r.asset === "string" ? EMBEDDED_ASSETS[r.asset] : undefined
      if (!asset) c.add(at("asset"), "invalid_value", "expected an embedded service template")
      else if (asset.service !== r.service || asset.manager !== r.manager) c.add(at("asset"), "inconsistent", "the template is for another service or manager")
      checkServiceUnitPath(c, at, r)
      break
    }
    case "deactivate-service":
      oneOf(c, at("service"), r.service, SERVICE_IDS)
      oneOf(c, at("manager"), r.manager, ["launchd", "systemd-user"] as const)
      break
    case "remove-service":
      oneOf(c, at("service"), r.service, SERVICE_IDS)
      oneOf(c, at("manager"), r.manager, ["launchd", "systemd-user"] as const)
      ref("path")
      digest(c, at("sha256"), r.sha256)
      checkServiceUnitPath(c, at, r)
      break
    case "activate-service":
      oneOf(c, at("service"), r.service, SERVICE_IDS)
      oneOf(c, at("manager"), r.manager, ["launchd", "systemd-user"] as const)
      if (r.confirm !== "explicit") c.add(at("confirm"), "invalid_value", "services are only activated on explicit confirmation")
      break
    case "enroll-machine":
      hubURL(c, at("server"), r.server)
      text(c, at("machineName"), r.machineName, 64, MACHINE_NAME)
      break
    case "verify-harness":
      oneOf(c, at("harness"), r.harness, HARNESS_ORDER)
      if (Array.isArray(r.probes) && r.probes.length === 0) c.add(at("probes"), "invalid_value", "verification runs at least one real probe")
      subset(c, at("probes"), r.probes, REAL_PROBES)
      break
    case "verify-runtime":
      oneOf(c, at("runtime"), r.runtime, RUNTIME_IDS)
      break
    case "launch-session":
      oneOf(c, at("harness"), r.harness, HARNESS_ORDER)
      ref("workspace")
      int(c, at("maxDurationS"), r.maxDurationS, 1, 86_400)
      break
  }
  // Escalation is explicit and exact: elevated iff the action touches an elevated root.
  const touchesElevated = refs.some((p) => isRecord(p) && (ELEVATED_ROOTS as readonly unknown[]).includes(p.root))
  if (r.escalation === "user" && touchesElevated) c.add(at("escalation"), "inconsistent", "writing a system location needs escalation: elevated")
  if (r.escalation === "elevated" && !touchesElevated) c.add(at("escalation"), "inconsistent", "only actions on system locations are elevated")
  for (const p of findSecrets(value, path)) c.add(p, "secret", "actions never carry credentials")
}

export function validateAction(value: unknown): Result<Action> {
  const c = new Checker()
  checkAction(c, "", value)
  return c.result(value)
}
