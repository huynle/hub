// Launch vocabulary (design §6.1, §6.4), shared by the launch API, the hub's launch engine, `hub node` and the
// spoke. Wire-level checks only: the launch API's own rules (idempotency, grants, placement) live in the hub.
//
// Git hardening starts here: refs that `git check-ref-format` would accept and that never read as an option,
// https/ssh remotes only, absolute normal repo paths. Nodes and the hub still run git with execFile argv and `--`.

/** A launch's state; each change carries a reason. */
export const LAUNCH_STATES = ["queued", "placing", "provisioning", "running", "ended"] as const
export type LaunchState = (typeof LAUNCH_STATES)[number]

/** How an ended launch ended. */
export const LAUNCH_OUTCOMES = ["idle", "needs_user", "failed", "timeout", "stopped", "lost"] as const
export type LaunchOutcome = (typeof LAUNCH_OUTCOMES)[number]

/** `worktree`: `<repo>/.worktrees/<branch>` (reused when present); `checkout`: the repo itself; `clone`: a fresh clone at `repo`. */
export const WORKSPACE_MODES = ["worktree", "checkout", "clone"] as const
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]

export const RUNTIME_KINDS = ["host", "openshell"] as const
export type RuntimeKind = (typeof RUNTIME_KINDS)[number]

export const PLACEMENT_MODES = ["require", "prefer"] as const
export type PlacementMode = (typeof PLACEMENT_MODES)[number]

/** `idle`: idle by real evidence with nothing open for 30 s; `asked`: ended with a question open (needs_user); `never`: ended by the app or user. */
export const LAUNCH_END_WHEN = ["idle", "asked", "never"] as const
export type LaunchEndWhen = (typeof LAUNCH_END_WHEN)[number]

export const CLEANUP_POLICIES = ["keep", "remove"] as const
export type CleanupPolicy = (typeof CLEANUP_POLICIES)[number]

export interface LaunchWorkspace {
  /** Absolute path: the repository (worktree, checkout) or where the clone goes (clone). */
  readonly repo: string
  readonly mode: WorkspaceMode
  readonly branch?: string
  readonly base?: string
  /** Required for clone: an https or ssh remote. */
  readonly remote?: string
}

export interface LaunchRuntime {
  readonly kind: RuntimeKind
  readonly profile?: string
}

export interface LaunchPlacement {
  readonly labels?: Readonly<Record<string, string>>
  /** A machine name or ID. */
  readonly machine?: string
  readonly mode?: PlacementMode
}

export interface LaunchEnd {
  readonly when?: LaunchEndWhen
  /** A duration such as "4h" or "90m". */
  readonly timeout?: string
  readonly cleanup?: CleanupPolicy
}

/** A launch request body (POST /api/agent/launches). Phase 4 has no `grant` field: a launch gets no powers beyond its launcher's. */
export interface LaunchSpec {
  /** Idempotency key: the same key and body return the same launch. */
  readonly key?: string
  readonly name?: string
  readonly roles?: readonly string[]
  readonly harness?: string
  readonly agent?: string
  /** "provider/model" as the launcher wrote it. */
  readonly model?: string
  readonly workspace: LaunchWorkspace
  readonly runtime?: LaunchRuntime
  readonly placement?: LaunchPlacement
  readonly prompt?: string
  /** Free-form; never interpreted by the hub. */
  readonly labels?: Readonly<Record<string, string>>
  readonly end?: LaunchEnd
}

/** What a node collected from a launch's workspace. */
export interface LaunchArtifacts {
  readonly branch?: string
  readonly base?: string
  /** The workspace's HEAD commit. */
  readonly head?: string
  /** Commits on `branch` since `base`. */
  readonly commits?: number
  /** Uncommitted changes were left in the workspace. */
  readonly dirty?: boolean
}

/** A launch as the API reports it. */
export interface LaunchInfo {
  readonly id: string
  readonly state: LaunchState
  readonly reason: string
  readonly spec: LaunchSpec
  /** ms epoch */
  readonly created: number
  readonly updated: number
  readonly machineID?: string
  readonly directory?: string
  readonly sessionID?: string
  readonly name?: string
  readonly outcome?: LaunchOutcome
  readonly artifacts?: LaunchArtifacts
}

// ---------- checks ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
/** Control (C0, C1), format (bidi, zero-width, BOM) and line/paragraph separator characters. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u

export const PATH_MAX = 4096
export const REF_MAX = 200
export const REMOTE_MAX = 2048
export const LABELS_MAX = 32
export const LABEL_VALUE_MAX = 256
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/

/** An absolute path of at most PATH_MAX characters without `.`/`..` segments, empty segments or unsafe characters. */
export function isAbsolutePath(v: unknown): v is string {
  if (typeof v !== "string" || !v.startsWith("/") || v.length > PATH_MAX || UNSAFE_CHARS.test(v)) return false
  if (v === "/") return true
  return v
    .slice(1)
    .replace(/\/$/, "")
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..")
}

/** A branch name `git check-ref-format --branch` accepts, from a conservative character set, never starting with `-`. */
export function isRefName(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > REF_MAX) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(v) || v.startsWith("-") || v.endsWith(".") || v.includes("..")) return false
  return v.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
}

/** An https or ssh URL, or scp-style `user@host:path`, of at most REMOTE_MAX characters; never an option. */
export function isGitRemote(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > REMOTE_MAX || v.startsWith("-") || /[\s\p{Cc}\p{Cf}]/u.test(v)) return false
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^-:][^:]*$/.test(v)) return true
  try {
    const url = new URL(v)
    return (url.protocol === "https:" || url.protocol === "ssh:") && url.hostname.length > 0 && !url.hostname.startsWith("-") && url.pathname.length > 1
  } catch {
    return false
  }
}

/** Why `v` is not an acceptable launch workspace, or undefined when it is. */
export function launchWorkspaceProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "workspace must be an object"
  if (!isAbsolutePath(v.repo)) return `workspace.repo must be an absolute path of at most ${PATH_MAX} characters without . or .. segments`
  if (!(WORKSPACE_MODES as readonly unknown[]).includes(v.mode)) return `workspace.mode must be one of ${WORKSPACE_MODES.join(", ")}`
  if (v.branch !== undefined && !isRefName(v.branch)) return "workspace.branch must be a valid branch name (letters, digits, . _ / -; not starting with -)"
  if (v.base !== undefined && !isRefName(v.base)) return "workspace.base must be a valid branch name (letters, digits, . _ / -; not starting with -)"
  if (v.remote !== undefined && !isGitRemote(v.remote)) return "workspace.remote must be an https or ssh git remote"
  if (v.mode === "clone" && v.remote === undefined) return "workspace.remote is required for a clone"
  return undefined
}

/** Why `v` is not an acceptable label map, or undefined when it is. */
export function labelsProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "labels must be an object"
  const entries = Object.entries(v)
  if (entries.length > LABELS_MAX) return `at most ${LABELS_MAX} labels`
  for (const [key, value] of entries) {
    if (!LABEL_KEY.test(key)) return `label key ${JSON.stringify(key.slice(0, 80))} must be 1–63 letters, digits, . _ / - (starting with a letter or digit)`
    if (typeof value !== "string" || value.length > LABEL_VALUE_MAX || UNSAFE_CHARS.test(value)) return `label ${key} must be text of at most ${LABEL_VALUE_MAX} printable characters`
  }
  return undefined
}
