// Hub ↔ node protocol (design §6.3). `hub node` is a daemon per machine: it connects out to /spoke/ws with the
// machine's token (spoke and node share one machine record) and a hello with role "node", never a spoke hello, so
// a node never appears as a process. It reports runtimes, labels, capacity and the launches it carries, and serves
// the hub's prepare → collect → cleanup ops (plus cancel) for each launch; with the "sandbox" feature also start and
// stop (it runs the launch's harness itself, e.g. in an OpenShell sandbox, whose spoke connects back with a launch
// token). It reports only launch progress and capacity; session state always comes from the session's own spoke.
// There is no remote exec channel.
//
// Compatibility: a hub that predates nodes rejects the node hello (it lacks the spoke hello fields) and so never
// sees a node frame. A node treats a welcome without the "nodes" feature (hubServesNodes) as an old hub and backs
// off. Frames share the spoke protocol's `t` discriminator, `req`/`res` envelope, MAX_FRAME and `bye`.
import type { Bye, Req, Res, Welcome } from "./index.ts"
import {
  isAbsolutePath,
  labelsProblem,
  launchWorkspaceProblem,
  isRefName,
  CLEANUP_POLICIES,
  RUNTIME_KINDS,
  WORKSPACE_MODES,
  type CleanupPolicy,
  type LaunchArtifacts,
  type LaunchRuntime,
  type LaunchWorkspace,
  type RuntimeKind,
  type WorkspaceMode,
} from "./launch.ts"
import { featureList, ID, isByeFrame, isHubURL, isObj, isResFrame, isWelcomeFrame, nonEmpty, num, parseFrame, str, token, UNSAFE_CHARS } from "./wire.ts"

export const NODE_ROLE = "node"
/** The role a hello announces: "node", or "spoke" (a hello without `role`, or with role "spoke"). */
export type HelloRole = typeof NODE_ROLE | "spoke"

/** A runtime the node offers: its kind, and the harnesses, profiles or backends it has. */
export interface NodeRuntimeInfo {
  readonly kind: string
  readonly harnesses?: readonly string[]
  readonly profiles?: readonly string[]
  readonly backends?: readonly string[]
}

/** Slots (concurrent launches) and memory. */
export interface NodeCapacity {
  readonly slots: number
  readonly memoryMB?: number
}

/** Where the node is with one launch (starting … stopped: a harness the node runs, e.g. in a sandbox; see "sandbox"). */
export const NODE_LAUNCH_PHASES = ["preparing", "prepared", "starting", "running", "stopping", "stopped", "collecting", "collected", "cleaning", "cleaned", "cancelled", "failed"] as const
export type NodeLaunchPhase = (typeof NODE_LAUNCH_PHASES)[number]

/** A launch the node carries (in its hello, so a reconnecting node tells the hub what survived). */
export interface NodeLaunchReport {
  readonly launchID: string
  readonly phase: NodeLaunchPhase
  readonly directory?: string
  /** The launch's OpenShell sandbox, when it has one. */
  readonly sandbox?: string
}

/**
 * Optional node features (announced in the node hello). "sandbox": the node serves start and stop (it runs a
 * launch's harness itself, e.g. in an OpenShell sandbox) and reports prepared workspaces with their runtime.
 */
export const KNOWN_NODE_FEATURES = ["sandbox"] as const
export type NodeFeature = (typeof KNOWN_NODE_FEATURES)[number]
/** What this package's `hub node` announces; "sandbox" joins once the node serves start and stop. */
export const NODE_FEATURES: readonly NodeFeature[] = []

/** The features a node announced in its hello. */
export function nodeFeatures(hello: Pick<NodeHello, "features">): ReadonlySet<string> {
  return new Set(hello.features ?? [])
}

// ---------- node → hub ----------

export interface NodeHello {
  readonly t: "hello"
  readonly v: number
  readonly role: typeof NODE_ROLE
  /** This daemon run (a new one per start), so the hub can tell a reconnect from a second node. */
  readonly instanceID: string
  readonly nodeVersion: string
  /** Optional node features (see KNOWN_NODE_FEATURES); phase 4 nodes send none. */
  readonly features?: readonly string[]
  readonly runtimes: readonly NodeRuntimeInfo[]
  readonly labels: Readonly<Record<string, string>>
  readonly capacity: NodeCapacity
  readonly used: NodeCapacity
  /** Workspaces must be under one of these (node.json roots). */
  readonly workspaceRoots: readonly string[]
  /** A draining node takes no new launches. */
  readonly draining: boolean
  readonly launches: readonly NodeLaunchReport[]
}

/** The node's capacity, use, draining flag and (when given) labels now; replaces what its hello said. */
export interface NodeCapacityFrame {
  readonly t: "capacity"
  readonly capacity: NodeCapacity
  readonly used: NodeCapacity
  readonly draining: boolean
  readonly labels?: Readonly<Record<string, string>>
}

/** A launch's progress on the node: its phase and a short human message (e.g. "cloning …"). */
export interface NodeProgress {
  readonly t: "progress"
  readonly launchID: string
  readonly phase: NodeLaunchPhase
  readonly message?: string
}

export type NodeMessage = NodeHello | NodeCapacityFrame | NodeProgress | Res | Bye

// ---------- hub → node ----------

/** Where a prepared workspace lives: on the host, or in an OpenShell sandbox (named by the node at prepare). */
export interface PreparedRuntime {
  readonly kind: RuntimeKind
  /** The OpenShell sandbox (a lowercase DNS label, see isSandboxName); only for kind "openshell". */
  readonly sandbox?: string
  /** The hub profile the sandbox was prepared with. */
  readonly profile?: string
}

/** A workspace the node prepared; collect and cleanup carry it back, so the node needs no state of its own. */
export interface PreparedWorkspace {
  readonly repo: string
  /** The session's directory: the worktree, the checkout or the clone. */
  readonly directory: string
  readonly mode: WorkspaceMode
  readonly branch?: string
  readonly base?: string
  readonly head?: string
  /** The worktree or clone existed before this launch; cleanup never removes a reused workspace. */
  readonly reused: boolean
  /** Where the workspace lives; absent (phase 4 nodes) means the host. */
  readonly runtime?: PreparedRuntime
}

/** A prepared workspace's runtime: its `runtime`, or the host when it has none. */
export function preparedWorkspaceRuntime(workspace: PreparedWorkspace): PreparedRuntime {
  return workspace.runtime ?? { kind: "host" }
}

/** OpenShell sandbox names are lowercase DNS labels: 1–63 letters, digits and `-`, not starting or ending with `-`. */
const SANDBOX_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Whether `v` is an acceptable OpenShell sandbox name. */
export function isSandboxName(v: unknown): v is string {
  return typeof v === "string" && SANDBOX_NAME.test(v)
}

export type NodeRequest =
  /** Prepare the launch's workspace (worktree, checkout or clone) under the node's roots. */
  | { readonly op: "prepare"; readonly launchID: string; readonly runtime: LaunchRuntime; readonly harness: string; readonly workspace: LaunchWorkspace }
  /** Collect artifacts (branch, head, commits since base, dirty) from a prepared workspace. */
  | { readonly op: "collect"; readonly launchID: string; readonly workspace: PreparedWorkspace }
  /** Keep or remove a prepared workspace; removal never forces (uncommitted work keeps it, with a reason). */
  | { readonly op: "cleanup"; readonly launchID: string; readonly workspace: PreparedWorkspace; readonly policy: CleanupPolicy }
  /** Stop whatever the node is doing for the launch (a running prepare). */
  | { readonly op: "cancel"; readonly launchID: string }
  /** Start the launch's harness in its prepared workspace (feature "sandbox"); it connects back to `hub`. */
  | StartRequest
  /** Stop the launch's harness (feature "sandbox"); `graceful` (the default) lets it finish its turn first. */
  | { readonly op: "stop"; readonly launchID: string; readonly workspace: PreparedWorkspace; readonly mode?: StopMode }

export type NodeOp = NodeRequest["op"]

export const STOP_MODES = ["graceful", "kill"] as const
export type StopMode = (typeof STOP_MODES)[number]

/** Most environment variables a start op sets. */
export const START_ENV_MAX = 64
/** Longest environment value, and longest launch token, a start op carries. */
export const START_VALUE_MAX = 4096

export interface StartRequest {
  readonly op: "start"
  readonly launchID: string
  readonly workspace: PreparedWorkspace
  readonly harness: string
  /** Where and how the harness's spoke connects back: the hub URL it can reach and a token bound to this launch. */
  readonly hub: { readonly url: string; readonly token: string }
  /** Extra environment for the harness (upper-case names); never secrets the node holds itself. */
  readonly env?: Readonly<Record<string, string>>
}

/** The node feature a request needs, or undefined for the phase 4 ops every node serves. */
export function nodeRequestFeature(req: Pick<NodeRequest, "op">): NodeFeature | undefined {
  return req.op === "start" || req.op === "stop" ? "sandbox" : undefined
}

/** Result payloads, keyed by node op. */
export interface NodeResultFor {
  prepare: { readonly workspace: PreparedWorkspace }
  collect: { readonly artifacts: LaunchArtifacts }
  /** `removed: false` with a `reason` when the workspace was kept (policy keep, reused, uncommitted work). */
  cleanup: { readonly removed: boolean; readonly reason?: string }
  /** `cancelled: false` when the node had nothing running for the launch. */
  cancel: { readonly cancelled: boolean }
  /** `started: false` with a `reason` when the harness was already running (a repeated start). */
  start: { readonly started: boolean; readonly reason?: string }
  /** `stopped: false` with a `reason` when nothing was running for the launch. */
  stop: { readonly stopped: boolean; readonly reason?: string }
}

export type NodeServerMessage = Welcome | Req<NodeRequest> | Res | Bye

/** Whether a hub's welcome announces nodes (an older hub never does; a node then backs off). */
export function hubServesNodes(welcome: Welcome): boolean {
  return welcome.features?.includes("nodes") === true
}

// ---------- validation ----------

/** Longest progress message or cleanup reason. */
export const NODE_MESSAGE_MAX = 500
export const NODE_RUNTIMES_MAX = 8
export const NODE_ROOTS_MAX = 32
export const NODE_LAUNCHES_MAX = 1000
export const NODE_SLOTS_MAX = 10_000
const LIST_MAX = 32

const launchID = (v: unknown): v is string => str(v) && ID.test(v)
const whole = (v: unknown, max: number): v is number => num(v) && Number.isInteger(v) && v >= 0 && v <= max
const tokenList = (v: unknown): boolean => Array.isArray(v) && v.length <= LIST_MAX && v.every((t) => token(t, 64))
const message = (v: unknown): v is string => nonEmpty(v) && v.length <= NODE_MESSAGE_MAX && !UNSAFE_CHARS.test(v)
const phase = (v: unknown): v is NodeLaunchPhase => (NODE_LAUNCH_PHASES as readonly unknown[]).includes(v)
const COMMIT = /^[0-9a-f]{7,64}$/

const isCapacity = (v: unknown): v is NodeCapacity => isObj(v) && whole(v.slots, NODE_SLOTS_MAX) && (v.memoryMB === undefined || whole(v.memoryMB, 2 ** 31))

const isRuntimeInfo = (v: unknown): v is NodeRuntimeInfo =>
  isObj(v) &&
  token(v.kind, 64) &&
  (v.harnesses === undefined || tokenList(v.harnesses)) &&
  (v.profiles === undefined || tokenList(v.profiles)) &&
  (v.backends === undefined || tokenList(v.backends))

const isLaunchReport = (v: unknown): v is NodeLaunchReport =>
  isObj(v) && launchID(v.launchID) && phase(v.phase) && (v.directory === undefined || isAbsolutePath(v.directory)) && (v.sandbox === undefined || isSandboxName(v.sandbox))

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const TOKEN_TEXT = new RegExp(`^[\\x21-\\x7e]{1,${START_VALUE_MAX}}$`)

const isStartEnv = (v: unknown): boolean =>
  isObj(v) &&
  Object.keys(v).length <= START_ENV_MAX &&
  Object.entries(v).every(([name, value]) => ENV_NAME.test(name) && str(value) && value.length <= START_VALUE_MAX && !UNSAFE_CHARS.test(value))

const isHubConnection = (v: unknown): boolean => isObj(v) && isHubURL(v.url) && str(v.token) && TOKEN_TEXT.test(v.token)

function isNodeHello(m: Record<string, unknown>): boolean {
  return (
    m.role === NODE_ROLE &&
    num(m.v) &&
    launchID(m.instanceID) &&
    str(m.nodeVersion) &&
    m.nodeVersion.length <= 100 &&
    (m.features === undefined || featureList(m.features)) &&
    Array.isArray(m.runtimes) &&
    m.runtimes.length <= NODE_RUNTIMES_MAX &&
    m.runtimes.every(isRuntimeInfo) &&
    labelsProblem(m.labels) === undefined &&
    isCapacity(m.capacity) &&
    isCapacity(m.used) &&
    Array.isArray(m.workspaceRoots) &&
    m.workspaceRoots.length <= NODE_ROOTS_MAX &&
    m.workspaceRoots.every(isAbsolutePath) &&
    typeof m.draining === "boolean" &&
    Array.isArray(m.launches) &&
    m.launches.length <= NODE_LAUNCHES_MAX &&
    m.launches.every(isLaunchReport)
  )
}

/** Why `v` is not an acceptable prepared workspace, or undefined when it is. */
export function preparedWorkspaceProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "workspace must be an object"
  if (!isAbsolutePath(v.repo)) return "workspace.repo must be an absolute path"
  if (!isAbsolutePath(v.directory)) return "workspace.directory must be an absolute path"
  if (!(WORKSPACE_MODES as readonly unknown[]).includes(v.mode)) return `workspace.mode must be one of ${WORKSPACE_MODES.join(", ")}`
  if (v.branch !== undefined && !isRefName(v.branch)) return "workspace.branch must be a valid branch name"
  if (v.base !== undefined && !isRefName(v.base)) return "workspace.base must be a valid branch name"
  if (v.head !== undefined && !(str(v.head) && COMMIT.test(v.head))) return "workspace.head must be a commit id (7–64 hex digits)"
  if (typeof v.reused !== "boolean") return "workspace.reused must be true or false"
  if (v.runtime !== undefined) return preparedRuntimeProblem(v.runtime)
  return undefined
}

function preparedRuntimeProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "workspace.runtime must be an object"
  if (!(RUNTIME_KINDS as readonly unknown[]).includes(v.kind)) return `workspace.runtime.kind must be one of ${RUNTIME_KINDS.join(", ")}`
  if (v.profile !== undefined && !token(v.profile, 64)) return "workspace.runtime.profile must be a short lowercase name"
  if (v.sandbox === undefined) return undefined
  if (v.kind !== "openshell") return "workspace.runtime.sandbox is only for an openshell workspace"
  return isSandboxName(v.sandbox) ? undefined : "workspace.runtime.sandbox must be a lowercase DNS label (1–63 letters, digits and -)"
}

function artifactsProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "artifacts must be an object"
  if (v.branch !== undefined && !isRefName(v.branch)) return "artifacts.branch must be a valid branch name"
  if (v.base !== undefined && !isRefName(v.base)) return "artifacts.base must be a valid branch name"
  if (v.head !== undefined && !(str(v.head) && COMMIT.test(v.head))) return "artifacts.head must be a commit id (7–64 hex digits)"
  if (v.commits !== undefined && !whole(v.commits, Number.MAX_SAFE_INTEGER)) return "artifacts.commits must be a whole number"
  if (v.dirty !== undefined && typeof v.dirty !== "boolean") return "artifacts.dirty must be true or false"
  return undefined
}

function isNodeRequest(v: unknown): v is NodeRequest {
  if (!isObj(v) || !launchID(v.launchID)) return false
  switch (v.op) {
    case "prepare":
      return (
        isObj(v.runtime) &&
        (RUNTIME_KINDS as readonly unknown[]).includes(v.runtime.kind) &&
        (v.runtime.profile === undefined || token(v.runtime.profile, 64)) &&
        token(v.harness, 64) &&
        launchWorkspaceProblem(v.workspace) === undefined
      )
    case "collect":
      return preparedWorkspaceProblem(v.workspace) === undefined
    case "cleanup":
      return preparedWorkspaceProblem(v.workspace) === undefined && (CLEANUP_POLICIES as readonly unknown[]).includes(v.policy)
    case "cancel":
      return true
    case "start":
      return preparedWorkspaceProblem(v.workspace) === undefined && token(v.harness, 64) && isHubConnection(v.hub) && (v.env === undefined || isStartEnv(v.env))
    case "stop":
      return preparedWorkspaceProblem(v.workspace) === undefined && (v.mode === undefined || (STOP_MODES as readonly unknown[]).includes(v.mode))
    default:
      return false
  }
}

/** Why `v` is not an acceptable result of node op `op`, or undefined when it is (the hub checks every result). */
export function nodeResultProblem(op: NodeOp, v: unknown): string | undefined {
  if (!isObj(v)) return "result must be an object"
  switch (op) {
    case "prepare":
      return preparedWorkspaceProblem(v.workspace)
    case "collect":
      return artifactsProblem(v.artifacts)
    case "cleanup":
      return flagProblem(v, "removed")
    case "cancel":
      return typeof v.cancelled === "boolean" ? undefined : "cancelled must be true or false"
    case "start":
      return flagProblem(v, "started")
    case "stop":
      return flagProblem(v, "stopped")
  }
}

/** A `{flag: boolean, reason?: message}` result's problem. */
function flagProblem(v: Record<string, unknown>, flag: string): string | undefined {
  if (typeof v[flag] !== "boolean") return `${flag} must be true or false`
  return v.reason === undefined || message(v.reason) ? undefined : `reason must be 1–${NODE_MESSAGE_MAX} printable characters`
}

/** The role of a frame's hello ("node" or "spoke"), or undefined when the frame is no hello. Does not validate the hello. */
export function helloRole(raw: string | Buffer): HelloRole | undefined {
  const m = parseFrame(raw)
  if (!m || m.t !== "hello") return undefined
  return m.role === NODE_ROLE ? NODE_ROLE : "spoke"
}

/** Parses a frame the hub received from a node. Returns undefined for anything invalid. */
export function parseNodeMessage(raw: string | Buffer): NodeMessage | undefined {
  const m = parseFrame(raw)
  if (!m) return undefined
  switch (m.t) {
    case "hello":
      return isNodeHello(m) ? (m as unknown as NodeHello) : undefined
    case "capacity":
      return isCapacity(m.capacity) && isCapacity(m.used) && typeof m.draining === "boolean" && (m.labels === undefined || labelsProblem(m.labels) === undefined)
        ? (m as unknown as NodeCapacityFrame)
        : undefined
    case "progress":
      return launchID(m.launchID) && phase(m.phase) && (m.message === undefined || message(m.message)) ? (m as unknown as NodeProgress) : undefined
    case "res":
      return isResFrame(m) ? (m as unknown as Res) : undefined
    case "bye":
      return isByeFrame(m) ? (m as unknown as Bye) : undefined
    default:
      return undefined
  }
}

/** Parses a frame a node received from the hub. Returns undefined for anything invalid. */
export function parseNodeServerMessage(raw: string | Buffer): NodeServerMessage | undefined {
  const m = parseFrame(raw)
  if (!m) return undefined
  switch (m.t) {
    case "welcome":
      return isWelcomeFrame(m) ? (m as unknown as Welcome) : undefined
    case "req":
      return nonEmpty(m.id) && isNodeRequest(m.req) ? (m as unknown as Req<NodeRequest>) : undefined
    case "res":
      return isResFrame(m) ? (m as unknown as Res) : undefined
    case "bye":
      return isByeFrame(m) ? (m as unknown as Bye) : undefined
    default:
      return undefined
  }
}
