// The per-action executor interface. The engine (engine.ts) owns everything transactional: the lock, preview
// revalidation, consent, path resolution and symlink refusal, the journal, backups, staging, atomic replacement,
// rollback and resume. An executor only says, for one action kind:
//
//   plan     which journal class the step is and which path it changes (pure, from the action alone);
//   check    whether the step may run on this host now (read-only: preconditions, pins, versions);
//   change   what the target should become (read-only: bytes for a file, a symlink target, a directory tree,
//            or an `effect` for steps with no file of their own to stage: enrollment, verification, activation,
//            launch). Large content (a harness, hubctl) is never passed as bytes: it is streamed into the step's
//            StagingArea (stream.ts) and named as a StagedFile, which the engine moves or copies into place;
//   undo     how to reverse a done effect that has no backup (clear a stored credential, unload a service).
//
// Executors never write files themselves (except an effect, through its own typed client such as the
// CredentialStore), never receive a shell, and never see the journal's internals. Adapter tasks supply the
// harness, MCP-registration, service-activation, enrollment and verification executors through this interface.
import type { Action, ActionKind, EntryClass, EvidenceResult, ExecutionContext, FileState, PathRef, RootMapping } from "../contracts/index.ts"
import type { TxFs } from "./fs.ts"
import type { StagedFile, StagingArea } from "./stream.ts"
import type { ResolveOptions } from "./resolve.ts"
import type { TxResult } from "./result.ts"

export type ActionOf<K extends ActionKind> = Extract<Action, { kind: K }>

/** The host apply runs on (computed fresh by the caller: hostFingerprint() and targetOf()). */
export interface HostInfo {
  readonly fingerprint: string
  readonly target: string
}

/**
 * One file of a directory tree an executor wants staged (a harness unpacked from its verified archive): small
 * content as bytes, large content as a file of the step's staging area.
 */
export type TreeFile = {
  /** Relative, "/"-separated, inside the tree (isSafeRel). */
  readonly rel: string
  readonly mode: number
} & ({ readonly bytes: Uint8Array } | { readonly staged: StagedFile })

export type Change =
  /**
   * Write these bytes (or this staged file: one the step's staging area wrote is moved, any other is copied, its
   * digest checked while it is copied). `refuse`: an existing different file is a conflict. `backup`: it is backed
   * up and replaced.
   */
  | ({ readonly type: "file"; readonly mode: number; readonly replace: "refuse" | "backup" } & ({ readonly bytes: Uint8Array } | { readonly staged: StagedFile }))
  | { readonly type: "directory"; readonly mode: number }
  | { readonly type: "symlink"; readonly target: string; readonly replace: "refuse" | "backup" }
  /** A fresh, immutable tree (a versioned install root). An existing different tree is a conflict. */
  | { readonly type: "tree"; readonly files: readonly TreeFile[]; readonly mode: number }
  /**
   * v1.1: remove the target file (a service unit of a removed component). The engine backs it up, journals it and
   * unlinks it; a rollback restores the backup. A missing target is skipped.
   */
  | { readonly type: "remove" }
  /** A step without a file to stage. The engine journals the target's state before and after `perform`. */
  | { readonly type: "effect"; readonly perform: () => Promise<TxResult<void>> }
  /** Already exactly as wanted: journaled as skipped. */
  | { readonly type: "none"; readonly reason: string }

export interface StepPlan {
  readonly class: EntryClass
  /** The path the step changes; required for every class except external. */
  readonly path?: PathRef
  readonly resolve?: ResolveOptions
}

export interface StepContext {
  readonly fs: TxFs
  readonly roots: readonly RootMapping[]
  /** v1.1: where apply runs; paths resolve for it. */
  readonly context: ExecutionContext
  readonly host: HostInfo
  readonly now: () => number
  /** The resolved, symlink-checked absolute path of the step's target (when it has one). */
  readonly target?: string
  /** The target's state now. */
  readonly current: FileState
  /**
   * The target's state before this transaction touched it: `current`, unless an earlier step of this transaction
   * changed the same path and left it exactly so. Preconditions are checked against this.
   */
  readonly original: FileState
  /** Resolves another PathRef with the same symlink rules. */
  readonly resolve: (ref: PathRef, options?: ResolveOptions) => TxResult<string>
  /** Records upstream evidence for the apply report (never into the journal). */
  readonly recordEvidence: (results: readonly EvidenceResult[]) => void
  /** The step's private scratch space for large downloads and what they unpack to (removed after the step). */
  readonly staging: StagingArea
}

export interface UndoContext {
  readonly fs: TxFs
  readonly roots: readonly RootMapping[]
  readonly context: ExecutionContext
  readonly host: HostInfo
  readonly now: () => number
  readonly target?: string
  /** Why the engine undoes: a credential to clear, or a done external step to reverse. */
  readonly reason: "clear-credential" | "revert-external"
}

export interface ActionExecutor<K extends ActionKind = ActionKind> {
  readonly kind: K
  plan(action: ActionOf<K>): StepPlan
  check?(action: ActionOf<K>, ctx: StepContext): Promise<TxResult<void>>
  change(action: ActionOf<K>, ctx: StepContext): Promise<TxResult<Change>>
  /** Required for class credential (clear it; a stale credential is never restored). Optional for external. */
  undo?(action: ActionOf<K>, ctx: UndoContext): Promise<TxResult<void>>
}

export type ExecutorMap = { readonly [K in ActionKind]?: ActionExecutor<K> }
