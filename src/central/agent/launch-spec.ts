// The launch spec (design §6.1, §6.4; decision znbg8xa5): validates a POST /api/agent/launches body into a
// LaunchSpec with the defaults filled in. Pure: no state, no I/O; tenancy, grants, caps and placement are the
// launch engine's. Malformed input is AgentError invalid.
// - Git-facing fields are strict because the node hands them to git (argv only, never a shell): branch and base
//   follow `git check-ref-format --branch` with no option-like (`-`) component; remotes are https or ssh only
//   (no credentials in the URL, no `ext::`, `file://`, local paths or option-like hosts); repo is an absolute path.
// - `grant` is not supported in phase 4 (a launched session gets no powers beyond its launcher's).
// - labels are free-form and never interpreted by the hub, but bounded (LABELS_MAX entries, short keys and values).
// - Defaults: harness opencode, workspace mode worktree, runtime host, placement mode require, end when idle,
//   cleanup keep, no timeout.
// LaunchSpec is defined here until packages/protocol carries it (P4-T1); keep the two in step.

import { AgentError } from "./errors"
import { isReservedName, parseAddress, validName } from "./names"
import { canonicalProject, parseDuration } from "./policy"

export type WorkspaceMode = "worktree" | "checkout" | "clone"
export type RuntimeKind = "host" | "openshell"
export type PlacementMode = "require" | "prefer"
export type EndWhen = "idle" | "asked" | "never"
export type CleanupPolicy = "keep" | "remove"

export interface LaunchWorkspace {
  /** Canonical absolute path of the repository on the node. */
  readonly repo: string
  readonly mode: WorkspaceMode
  /** The branch to create or check out (required for worktree). */
  readonly branch?: string
  /** What a new branch starts from. */
  readonly base?: string
  /** https or ssh remote (required for clone). */
  readonly remote?: string
}

export interface LaunchRuntime {
  readonly kind: RuntimeKind
  /** An openshell sandbox profile of the user's. */
  readonly profile?: string
}

export interface LaunchPlacement {
  /** Node labels to match. */
  readonly labels: Readonly<Record<string, string>>
  /** A machine ID or name. */
  readonly machine?: string
  readonly mode: PlacementMode
}

export interface LaunchEnd {
  readonly when: EndWhen
  readonly timeoutMs?: number
  readonly cleanup: CleanupPolicy
}

export interface LaunchSpec {
  /** App-chosen idempotency key: the same key (and body) returns the same launch. */
  readonly key?: string
  /** The session's @name (without the @). */
  readonly name?: string
  readonly roles: readonly string[]
  readonly harness: string
  readonly agent?: string
  /** `provider/model`. */
  readonly model?: string
  readonly workspace: LaunchWorkspace
  readonly runtime: LaunchRuntime
  readonly placement: LaunchPlacement
  readonly prompt?: string
  /** Free-form app labels (never interpreted by the hub). */
  readonly labels: Readonly<Record<string, string>>
  readonly end: LaunchEnd
}

export const KEY_MAX = 200
export const ROLES_MAX = 10
export const PROMPT_MAX = 10_000
export const LABELS_MAX = 32
export const LABEL_KEY_MAX = 63
export const LABEL_VALUE_MAX = 256
export const BRANCH_MAX = 200
export const REMOTE_MAX = 500
export const MODEL_MAX = 200
export const LAUNCH_TIMEOUT_MIN_MS = 60_000
export const LAUNCH_TIMEOUT_MAX_MS = 30 * 86_400_000

const FIELDS = ["key", "name", "roles", "harness", "agent", "model", "workspace", "runtime", "placement", "prompt", "labels", "end"]
const WORKSPACE_FIELDS = ["repo", "mode", "branch", "base", "remote"]
const RUNTIME_FIELDS = ["kind", "profile"]
const PLACEMENT_FIELDS = ["labels", "machine", "mode"]
const END_FIELDS = ["when", "timeout", "cleanup"]

const KEY = /^[!-~]{1,200}$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const AGENT = /^[A-Za-z0-9_.-]{1,80}$/
const MODEL = /^[A-Za-z0-9._-]{1,80}\/[!-~]+$/
const MACHINE = /^[A-Za-z0-9._-]{1,80}$/
const LABEL_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/
/** Control characters (C0, DEL, C1). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** Control characters other than tab, newline and carriage return. */
const PROMPT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const invalid = (message: string, hint?: string) => new AgentError("invalid", message, hint ? { hint } : {})
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function onlyFields(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`Unknown ${what} field ${key}`)
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T, what: string): T {
  if (value === undefined) return fallback
  if (!options.includes(value as T)) throw invalid(`${what} is ${options.join(", ")}`)
  return value as T
}

function matching(value: unknown, pattern: RegExp, what: string, max = Infinity): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > max || !pattern.test(value)) throw invalid(`${what} is malformed`)
  return value
}

// ---------- git ----------

/** A branch name `git check-ref-format --branch` accepts, printable ASCII, with no component starting with `-`. */
export function validBranch(name: unknown): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > BRANCH_MAX) return false
  if (!/^[!-~]+$/.test(name) || /[~^:?*[\\]/.test(name)) return false
  if (name === "@" || name === "HEAD" || name.includes("@{") || name.includes("..")) return false
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.includes("//")) return false
  return name.split("/").every((part) => !part.startsWith(".") && !part.startsWith("-") && !part.endsWith(".lock"))
}

const HOST = "[A-Za-z0-9][A-Za-z0-9.-]*"
const USER = "[A-Za-z0-9_][A-Za-z0-9._-]*"
const PORT = "(?::\\d{1,5})?"
const REMOTES = [
  new RegExp(`^https://${HOST}${PORT}/[!-~]+$`),
  new RegExp(`^ssh://(?:${USER}@)?${HOST}${PORT}/[!-~]+$`),
  new RegExp(`^${USER}@${HOST}:(?![-/])[!-~]+$`),
]

/** An https or ssh git remote (URL or scp-like `user@host:path`), without credentials or option-like parts. */
export function validRemote(remote: unknown): boolean {
  if (typeof remote !== "string" || remote.length === 0 || remote.length > REMOTE_MAX) return false
  return REMOTES.some((pattern) => pattern.test(remote))
}

// ---------- parts ----------

function validLabels(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isObject(value)) throw invalid(`${what} is an object of string values`)
  const entries = Object.entries(value)
  if (entries.length > LABELS_MAX) throw invalid(`${what} has at most ${LABELS_MAX} entries`)
  const out: Record<string, string> = {}
  for (const [key, text] of entries) {
    if (key.length > LABEL_KEY_MAX || !LABEL_KEY.test(key)) throw invalid(`${what}: ${key.slice(0, LABEL_KEY_MAX)} is not a label key (letters, digits, . _ / -; up to ${LABEL_KEY_MAX})`)
    if (typeof text !== "string" || text.length > LABEL_VALUE_MAX || CONTROL.test(text)) throw invalid(`${what}.${key} is a string of up to ${LABEL_VALUE_MAX} characters`)
    out[key] = text
  }
  return out
}

function validRoles(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ROLES_MAX) throw invalid(`roles lists up to ${ROLES_MAX} role names`)
  const roles: string[] = []
  for (const role of value) {
    if (typeof role !== "string" || parseAddress(`@@${role}`)?.kind !== "role") throw invalid(`roles: ${String(role)} is not a role name (such as reviewer or reviewer.hub)`)
    if (!roles.includes(role)) roles.push(role)
  }
  return roles
}

function validWorkspace(value: unknown): LaunchWorkspace {
  if (!isObject(value)) throw invalid("workspace is {repo, mode?, branch?, base?, remote?}")
  onlyFields(value, WORKSPACE_FIELDS, "workspace")
  // canonicalProject rejects relative, `~` and root paths.
  const repo = typeof value.repo === "string" ? canonicalProject(value.repo) : undefined
  if (repo === undefined) throw invalid("workspace.repo is an absolute repository path")
  const mode = oneOf<WorkspaceMode>(value.mode, ["worktree", "checkout", "clone"], "worktree", "workspace.mode")
  for (const field of ["branch", "base"] as const) {
    if (value[field] !== undefined && !validBranch(value[field])) throw invalid(`workspace.${field} is not a safe git branch name`, "Branch names follow git check-ref-format and never start with -")
  }
  if (value.remote !== undefined && !validRemote(value.remote)) throw invalid("workspace.remote is an https or ssh git remote", "Use https://host/path or git@host:path, without credentials")
  if (mode === "worktree" && value.branch === undefined) throw invalid("A worktree workspace needs workspace.branch")
  if (mode === "clone" && value.remote === undefined) throw invalid("A clone workspace needs workspace.remote")
  return {
    repo,
    mode,
    ...(value.branch !== undefined ? { branch: value.branch as string } : {}),
    ...(value.base !== undefined ? { base: value.base as string } : {}),
    ...(value.remote !== undefined ? { remote: value.remote as string } : {}),
  }
}

function validRuntime(value: unknown, workspace: LaunchWorkspace): LaunchRuntime {
  if (value === undefined) return { kind: "host" }
  if (!isObject(value)) throw invalid("runtime is {kind, profile?}")
  onlyFields(value, RUNTIME_FIELDS, "runtime")
  const kind = oneOf<RuntimeKind>(value.kind, ["host", "openshell"], "host", "runtime.kind")
  const profile = matching(value.profile, SLUG, "runtime.profile")
  if (kind === "host" && profile !== undefined) throw invalid("runtime.profile applies to the openshell runtime only")
  if (kind === "openshell" && workspace.mode !== "clone") throw invalid("The openshell runtime runs clone workspaces only")
  return { kind, ...(profile !== undefined ? { profile } : {}) }
}

function validPlacement(value: unknown): LaunchPlacement {
  if (value === undefined) return { labels: {}, mode: "require" }
  if (!isObject(value)) throw invalid("placement is {labels?, machine?, mode?}")
  onlyFields(value, PLACEMENT_FIELDS, "placement")
  const labels = validLabels(value.labels, "placement.labels")
  const machine = matching(value.machine, MACHINE, "placement.machine")
  const mode = oneOf<PlacementMode>(value.mode, ["require", "prefer"], "require", "placement.mode")
  return { labels, ...(machine !== undefined ? { machine } : {}), mode }
}

function validEnd(value: unknown): LaunchEnd {
  if (value === undefined) return { when: "idle", cleanup: "keep" }
  if (!isObject(value)) throw invalid("end is {when?, timeout?, cleanup?}")
  onlyFields(value, END_FIELDS, "end")
  const when = oneOf<EndWhen>(value.when, ["idle", "asked", "never"], "idle", "end.when")
  let timeoutMs: number | undefined
  if (value.timeout !== undefined) {
    timeoutMs = parseDuration(value.timeout)
    if (timeoutMs === undefined || timeoutMs < LAUNCH_TIMEOUT_MIN_MS || timeoutMs > LAUNCH_TIMEOUT_MAX_MS) throw invalid("end.timeout is 1 minute to 30 days (seconds, or 30m, 4h, 2d)")
  }
  const cleanup = oneOf<CleanupPolicy>(value.cleanup, ["keep", "remove"], "keep", "end.cleanup")
  return { when, ...(timeoutMs !== undefined ? { timeoutMs } : {}), cleanup }
}

// ---------- spec ----------

/** Validates a launch body into a LaunchSpec (a fresh copy, defaults filled in); throws AgentError invalid. */
export function validateLaunchSpec(input: unknown): LaunchSpec {
  if (!isObject(input)) throw invalid("A launch is an object")
  if ("grant" in input) throw invalid("grant is not supported yet: a launched session has its launcher's powers only")
  onlyFields(input, FIELDS, "launch")
  const key = matching(input.key, KEY, `key (1–${KEY_MAX} visible characters)`)
  let name: string | undefined
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !validName(input.name) || isReservedName(input.name)) throw invalid("name is a session name (lowercase letters, digits, dashes; 2–40), without the @")
    name = input.name
  }
  const roles = validRoles(input.roles)
  const harness = matching(input.harness, SLUG, "harness") ?? "opencode"
  const agent = matching(input.agent, AGENT, "agent")
  const model = matching(input.model, MODEL, "model (provider/model)", MODEL_MAX)
  const workspace = validWorkspace(input.workspace)
  const runtime = validRuntime(input.runtime, workspace)
  const placement = validPlacement(input.placement)
  let prompt: string | undefined
  if (input.prompt !== undefined) {
    if (typeof input.prompt !== "string" || input.prompt.length > PROMPT_MAX || PROMPT_CONTROL.test(input.prompt)) throw invalid(`prompt is text of up to ${PROMPT_MAX} characters`)
    prompt = input.prompt
  }
  const labels = validLabels(input.labels, "labels")
  const end = validEnd(input.end)
  return {
    ...(key !== undefined ? { key } : {}),
    ...(name !== undefined ? { name } : {}),
    roles,
    harness,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    workspace,
    runtime,
    placement,
    ...(prompt !== undefined ? { prompt } : {}),
    labels,
    end,
  }
}

/** JSON with object keys sorted (stable for equal values). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** What idempotency compares: the validated spec without its key, as stable JSON (equal for equivalent bodies). */
export function launchBodyKey(spec: LaunchSpec): string {
  const { key: _key, ...body } = spec
  return stable(body)
}
