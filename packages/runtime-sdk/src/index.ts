// The Runtime interface (design §6.4): what `hub node` drives for each launch, prepare → (start) → collect →
// cleanup. A runtime keeps no state of its own between ops: prepare returns the Workspace and collect and cleanup
// get it back with the launch ID (a RunHandle; the hub stores it), so a restarted node can still collect and clean
// up what an earlier run prepared. A runtime must not trust a handle: it re-checks the workspace on every op.
//
// The `host` runtime has no start/stop: the session runs in the machine's long-running harness service, which the
// hub asks to create it. Sandbox runtimes (openshell) will implement start/stop.
import type {
  CleanupPolicy,
  LaunchArtifacts,
  LaunchRuntime,
  LaunchWorkspace,
  NodeRuntimeInfo,
  PreparedWorkspace,
} from "../../protocol/src/index.ts"

/** A prepared workspace: the session's directory and how it was made. */
export type Workspace = PreparedWorkspace
/** What collect found in a workspace (branch, head, commits since base, dirty). */
export type Artifacts = LaunchArtifacts

/** What prepare gets: the launch, its harness and runtime, and the workspace it asked for. */
export interface PrepareInput {
  readonly launchID: string
  readonly harness: string
  readonly runtime: LaunchRuntime
  readonly workspace: LaunchWorkspace
}

/** What start gets: the launch, its harness, how its spoke connects back to the hub, and extra environment. */
export interface StartInput {
  readonly launchID: string
  readonly harness: string
  /** The hub URL as the node knows it, and a token bound to this launch (secret: never in errors or argv). */
  readonly hub: { readonly url: string; readonly token: string }
  /** Extra non-secret environment for the harness (upper-case names). */
  readonly env?: Readonly<Record<string, string>>
}

/** Per-op context: cancellation, and a short human progress line ("cloning …"). */
export interface RuntimeContext {
  readonly signal?: AbortSignal
  readonly progress?: (message: string) => void
}

/** A launch's prepared (or started) workspace, as collect, cleanup and stop get it. */
export interface RunHandle {
  readonly launchID: string
  readonly workspace: Workspace
}

/** `removed: false` with a reason when the workspace was kept (policy keep, reused, uncommitted work). */
export interface CleanupResult {
  readonly removed: boolean
  readonly reason?: string
}

/** What start did: `started: false` with a reason when the harness had been started already (a repeated start). */
export interface StartResult extends RunHandle {
  readonly started: boolean
  readonly reason?: string
}

/** What stop did: `stopped: false` with a reason when nothing was running. */
export interface StopResult {
  readonly stopped: boolean
  readonly reason?: string
}

export type StopMode = "graceful" | "kill"

export interface Runtime {
  readonly kind: string
  /** What the node's hello reports for this runtime (kind, harnesses, profiles, backends). */
  info(): NodeRuntimeInfo
  prepare(input: PrepareInput, ctx?: RuntimeContext): Promise<Workspace>
  start?(workspace: Workspace, input: StartInput, ctx?: RuntimeContext): Promise<StartResult>
  stop?(handle: RunHandle, mode: StopMode): Promise<StopResult>
  collect(handle: RunHandle, ctx?: RuntimeContext): Promise<Artifacts>
  /** Keep, or remove without force: uncommitted or unpushed work, a reused workspace or another launch's keeps it. */
  cleanup(handle: RunHandle, policy: CleanupPolicy, ctx?: RuntimeContext): Promise<CleanupResult>
}

/** A runtime error with a message fit for the hub (and the launch's reason): no stack, no secrets. */
export class RuntimeError extends Error {
  override readonly name = "RuntimeError"
}
