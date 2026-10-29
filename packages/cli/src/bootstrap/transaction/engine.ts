// The transactional apply engine. It applies a contract SetupPlan on this host, one typed action at a time,
// through per-action executors (executor.ts), and guarantees:
//
//   - one apply at a time: the O_EXCL apply lock (lock.ts); a live holder is refused (locked), another host's lock
//     is never broken, a stale one is only broken once no interrupted transaction is waiting for recovery;
//   - nothing runs on a stale preview: apply re-plans through the caller's hook and revalidates the token
//     (revalidatePreview: host, expiry, clock skew, single-use nonce, snapshot and plan digests), then refuses
//     blockers and failed evidence (previewApplicable);
//   - explicit consent: an elevated action needs `escalate`, a service activation `confirmActivation`;
//   - preflight before any change: a valid plan for exactly this host's target, an executor for every action,
//     every target path resolved without symlinks, and every executor's read-only check (preconditions, pinned
//     artifacts, versions);
//   - write-ahead ownership journal: each change is journaled ("pending", with the state before, the state it will
//     leave and the backup) before it happens, and "done" after; contents and credentials never enter it;
//   - atomic replacement: new content is staged beside the target and renamed over it;
//   - rollback on any failure and recovery after a crash (recover): newest entry first, undo only what is still
//     exactly as we left it, keep anything changed since (reported as a conflict), clear (never restore) a
//     credential, refuse a backup that does not match what it backed up;
//   - resume after a crash: continue the stored plan from the interrupted step, when the host still agrees.
//
// The engine performs only the TxFs operations; it never spawns processes or runs commands.
import { randomBytes } from "node:crypto"
import {
  isSecretValue,
  JOURNAL_SCHEMA,
  LOCK_MAX_MS,
  planDigest,
  previewApplicable,
  recoveryDecision,
  revalidatePreview,
  SETUP_PREVIEW_SCHEMA,
  snapshotDigest,
  validateSetupPlan,
  type Action,
  type ApplyLock,
  type DiscoverySnapshot,
  type ExecutionContext,
  type ErrorCode,
  type EvidenceResult,
  type FileState,
  type JournalEntry,
  type JournalHooks,
  type JournalState,
  type PathRef,
  type PlanBlocker,
  type PreviewEvidence,
  type RecoveryStep,
  type RootMapping,
  type SetupPlan,
  type TransactionJournal,
} from "../contracts/index.ts"
import type { ActionExecutor, Change, ExecutorMap, HostInfo, StepContext, StepPlan, TreeFile } from "./executor.ts"
import { nodeFs, type TxFs } from "./fs.ts"
import { breakStaleLock, releaseLock, renewLock, tryAcquireLock, type LockIO } from "./lock.ts"
import { resolveTarget, rootDir, type ResolveOptions } from "./resolve.ts"
import { errnoOf, fromResult, TxError, txFail, txOk, type TxFailure, type TxResult } from "./result.ts"
import { fileState, sameState, sha256Of, treeDigestOfFiles } from "./state.ts"
import { TxStore } from "./store.ts"

export interface ApplierConfig {
  /** The roots discovery mapped on this host. */
  readonly roots: readonly RootMapping[]
  /**
   * v1.1: where this apply runs. "container": inside the container discovery found itself in, so every root
   * resolves to containerPath ?? path (contract rootPathIn); "host" (default): to path.
   */
  readonly context?: ExecutionContext
  /** This host, computed fresh (hostFingerprint, targetOf). */
  readonly host: HostInfo
  readonly executors: ExecutorMap
  readonly fs?: TxFs
  readonly now?: () => number
  readonly pid?: number
  /** Whether a process on this host is alive (default: signal 0). */
  readonly isAlive?: (pid: number) => boolean
  /** Transaction IDs (default: random). */
  readonly newID?: () => string
  /** Observers (logging, progress); they cannot change actions. */
  readonly hooks?: JournalHooks
  /**
   * Keep a committed transaction's backups (`hubctl setup rollback` restores from them later). Default false: a
   * commit drops them, so only an interrupted or failed transaction can be undone exactly.
   */
  readonly keepBackups?: boolean
}

/** Explicit consent flags (--escalate, --confirm-activation). Never defaults. */
export interface Consent {
  readonly escalate?: boolean
  readonly confirmActivation?: boolean
}

/** What a fresh discovery + plan produced: apply compares it against the token and refuses blockers. */
export interface FreshPlan {
  readonly plan: SetupPlan
  /** v1.1: the fresh snapshot the plan was made from; when given, its canonical digest must be the plan's. */
  readonly snapshot?: DiscoverySnapshot
  readonly blockers?: readonly PlanBlocker[]
  readonly evidence?: readonly PreviewEvidence[]
}

export interface ApplyRequest {
  /** The preview token (unknown: it is validated here). */
  readonly token: unknown
  /**
   * The revalidation hook: rediscover and re-plan now. Must only read: apply calls it once before taking the lock
   * (so a refused apply writes nothing) and again under the lock.
   */
  readonly replan: () => Promise<FreshPlan>
  readonly consent?: Consent
}

export interface RecoverRequest {
  /** rollback: undo the interrupted transaction. resume: finish its stored plan (needs the same consent again). */
  readonly mode: "rollback" | "resume"
  readonly consent?: Consent
}

/** `hubctl setup rollback`: undo committed transactions, newest first, back to just after `to` (or all of them). */
export interface RollbackRequest {
  readonly to?: string
}

export interface Conflict {
  readonly seq: number
  readonly actionID: string
  readonly path?: string
  readonly reason: string
}

export interface StepOutcome {
  readonly actionID: string
  readonly kind: Action["kind"]
  readonly outcome: "applied" | "skipped" | "failed" | "resumed"
}

export interface TxReport {
  readonly txID: string
  readonly state: JournalState
  readonly steps: readonly StepOutcome[]
  /** Files recovery left alone because they changed since hub wrote them (or could not be restored safely). */
  readonly conflicts: readonly Conflict[]
  /** Upstream evidence recorded for harness installs (never part of the journal). */
  readonly evidence: readonly { readonly actionID: string; readonly results: readonly EvidenceResult[] }[]
}

export type TxOutcome = { readonly ok: true; readonly report: TxReport } | (TxFailure & { readonly report?: TxReport })

export interface Applier {
  apply(request: ApplyRequest): Promise<TxOutcome>
  /** Recovers an interrupted transaction; ok without a report when there was nothing to recover. */
  recover(request: RecoverRequest): Promise<TxOutcome | { readonly ok: true; readonly report?: undefined }>
  /**
   * Undoes committed transactions of this host, newest first, with the recovery rules (restore backups, remove what
   * hub created, clear a credential, keep anything changed since as a conflict). Ok without a report when there is
   * nothing to undo. The report is the oldest transaction undone, with every transaction's steps and conflicts.
   */
  rollback(request: RollbackRequest): Promise<TxOutcome | { readonly ok: true; readonly report?: undefined }>
}

const FINISHED: readonly JournalState[] = ["committed", "rolled-back"]
const PARENT_MODE = 0o700

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errnoOf(error) === "EPERM"
  }
}

/** Hooks observe: they get copies, so nothing they do reaches the journal or the plan. */
const copy = <T>(value: T): T => structuredClone(value)

/** Strings in anything the engine returns that look like a credential are withheld (defense in depth). */
function redact<T>(value: T): T {
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (!isSecretValue(v)) return v
      const words = v.split(/(\s+)/).map((w) => (isSecretValue(w) ? "[redacted]" : w)).join("")
      return isSecretValue(words) ? "(details withheld: the message looked like it carried a credential)" : words
    }
    if (Array.isArray(v)) return v.map(scrub)
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, scrub(item)]))
    return v
  }
  return scrub(value) as T
}

const randomTxID = () => `tx_${randomBytes(12).toString("hex")}`
const samePath = (a?: PathRef, b?: PathRef) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.root === b.root && a.rel === b.rel)
const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/"
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1)

/** Converts anything thrown inside a step into a failure; filesystem errors name their errno, never contents. */
function failureOf(error: unknown): TxFailure {
  if (error instanceof TxError) return error.failure
  const code = errnoOf(error)
  if (code === "EACCES" || code === "EPERM") return txFail("forbidden", `permission denied: ${(error as Error).message}`)
  return txFail("internal", code ? `filesystem error ${code}: ${(error as Error).message}` : `unexpected error: ${error instanceof Error ? error.message : String(error)}`)
}

export function createApplier(config: ApplierConfig): Applier {
  const fs = config.fs ?? nodeFs
  const now = config.now ?? Date.now
  const pid = config.pid ?? process.pid
  const isAlive = config.isAlive ?? defaultIsAlive
  const newID = config.newID ?? randomTxID
  const hooks = config.hooks ?? {}
  const context: ExecutionContext = config.context ?? "host"

  const lockIO = (store: TxStore): LockIO => ({ fs, path: store.lockPath, hostFingerprint: config.host.fingerprint, pid, now, isAlive })

  /** Interrupted transactions of this host. Another host's (a shared home) are reported, never touched here. */
  const unfinished = (store: TxStore) => {
    const all = store.journals().filter((j) => !FINISHED.includes(j.state))
    const foreign = all.find((j) => j.hostFingerprint !== config.host.fingerprint)
    if (foreign) throw new TxError("recovery_required", `transaction ${foreign.txID} of another host was interrupted on this shared home; recover it on that host`)
    return all
  }

  /** Runs `body` holding the apply lock. */
  async function locked<T extends { ok: boolean }>(txID: string, forRecovery: boolean, body: (store: TxStore, lock: { current: ApplyLock }) => Promise<T | TxFailure>): Promise<T | TxFailure> {
    let store: TxStore
    try {
      store = new TxStore(fs, config.roots, context)
      store.init()
    } catch (error) {
      return failureOf(error)
    }
    const io = lockIO(store)
    let attempt
    try {
      attempt = tryAcquireLock(io, txID)
      if (attempt.state === "stale") {
        if (!forRecovery && unfinished(store).length > 0)
          return txFail("recovery_required", `apply ${attempt.lock.txID} was interrupted (its process is gone); run \`hubctl setup recover\` first`)
        if (!breakStaleLock(io, attempt.lock)) return txFail("locked", "another apply took the lock")
        attempt = tryAcquireLock(io, txID)
      }
    } catch (error) {
      return failureOf(error)
    }
    if (attempt.state !== "acquired") {
      const why =
        attempt.state === "foreign"
          ? "another host holds the apply lock on this shared home; it is never broken automatically"
          : attempt.state === "corrupt"
            ? `the apply lock ${io.path} is unreadable; remove it once no apply is running`
            : `another apply (pid ${attempt.state === "held" || attempt.state === "stale" ? attempt.lock.pid : "?"}) is running`
      return txFail("locked", why)
    }
    const lock = { current: attempt.lock }
    try {
      store.sweep()
      return await body(store, lock)
    } catch (error) {
      return failureOf(error)
    } finally {
      try {
        releaseLock(io, txID)
      } catch {}
    }
  }

  function consentProblem(plan: SetupPlan, consent: Consent = {}): TxFailure | undefined {
    if (plan.requiresEscalation && !consent.escalate) return txFail("escalation_required", "this plan writes system locations; pass --escalate to allow it")
    if (plan.activatesServices && !consent.confirmActivation) return txFail("needs_user", "this plan activates a background service; pass --confirm-activation to allow it")
    if (plan.target !== config.host.target) return txFail("wrong_platform", `the plan is for ${plan.target}, but this host is ${config.host.target}`)
    return undefined
  }

  /**
   * Re-plans and revalidates the preview, with `store`'s journals as the used nonces: the plan to apply and the
   * token's nonce, or why it is refused. Reads only; nothing is written.
   */
  async function admit(store: TxStore, request: ApplyRequest): Promise<{ ok: true; plan: SetupPlan; nonce: string } | TxFailure> {
    const fresh = await request.replan()
    const checked = fromResult(validateSetupPlan(fresh.plan), "the fresh plan is invalid")
    if (!checked.ok) return checked
    const plan = checked.value
    if (fresh.snapshot && snapshotDigest(fresh.snapshot) !== plan.snapshotDigest) return txFail("preview_stale", "the fresh plan was not made from the fresh snapshot; run the preview again")
    const usedNonces = new Set(store.journals().map((j) => j.nonce))
    const token = revalidatePreview(request.token, { now: now(), hostFingerprint: config.host.fingerprint, plan, usedNonces })
    if (!token.ok) {
      const issue = token.issues[0]!
      return txFail(issue.code.startsWith("preview_") ? (issue.code as ErrorCode) : "preview_invalid", issue.message)
    }
    const applicable = fromResult(
      previewApplicable({ schema: SETUP_PREVIEW_SCHEMA, version: 1, plan, planDigest: planDigest(plan), token: token.value, blockers: fresh.blockers ?? [], evidence: fresh.evidence ?? [] }),
    )
    if (!applicable.ok) return applicable
    const problem = consentProblem(plan, request.consent)
    if (problem) return problem
    return { ok: true, plan, nonce: token.value.nonce }
  }

  /**
   * The admission check before the lock is taken, so a refused apply (expired, stale, replayed or invalid preview,
   * missing consent) writes nothing: not even the state directories the lock lives in. Undefined when it passes
   * or cannot decide (an interrupted transaction, an unusable state directory): the locked path decides then, and
   * re-runs the whole check under the lock either way.
   */
  async function refusedBeforeLock(request: ApplyRequest): Promise<TxFailure | undefined> {
    let store: TxStore
    try {
      store = new TxStore(fs, config.roots, context)
      if (unfinished(store).length > 0) return undefined
    } catch {
      return undefined
    }
    try {
      const admitted = await admit(store, request)
      return admitted.ok ? undefined : admitted
    } catch (error) {
      return failureOf(error)
    }
  }

  async function apply(request: ApplyRequest): Promise<TxOutcome> {
    const refused = await refusedBeforeLock(request)
    if (refused) return refused
    const txID = newID()
    return locked<TxOutcome>(txID, false, async (store, lock) => {
      if (unfinished(store).length > 0) return txFail("recovery_required", "an interrupted apply must be recovered first (`hubctl setup recover`)")
      const admitted = await admit(store, request)
      if (!admitted.ok) return admitted
      const { plan } = admitted
      const run = new Run(store, lock, plan, newJournal(txID, plan, admitted.nonce))
      const pre = await run.preflight()
      if (!pre.ok) return pre
      store.writePlan(txID, plan)
      run.persist()
      return run.forward()
    })
  }

  function newJournal(txID: string, plan: SetupPlan, nonce: string): TransactionJournal {
    const t = now()
    return { schema: JOURNAL_SCHEMA, version: 1, txID, planDigest: planDigest(plan), hostFingerprint: config.host.fingerprint, nonce, state: "applying", startedAt: t, updatedAt: t, entries: [] }
  }

  async function recover(request: RecoverRequest): Promise<TxOutcome | { readonly ok: true; readonly report?: undefined }> {
    return locked<TxOutcome | { ok: true; report?: undefined }>(newID(), true, async (store, lock) => {
      const pending = unfinished(store)
      if (pending.length === 0) return { ok: true }
      let last: TxOutcome | undefined
      for (const journal of pending) {
        const plan = store.readPlan(journal)
        const run = new Run(store, lock, plan, journal)
        if (request.mode === "resume") {
          if (!plan) return txFail("recovery_required", `the plan of ${journal.txID} is missing or does not match its journal; roll it back instead`)
          if (journal.state !== "applying" && journal.state !== "prepared") return txFail("recovery_required", `${journal.txID} was already rolling back; it can only be rolled back`)
          const problem = consentProblem(plan, request.consent)
          if (problem) return problem
          last = await run.resume()
        } else last = await run.rollbackAll()
        if (!last.ok) return last
      }
      return last!
    })
  }

  async function rollback(request: RollbackRequest): Promise<TxOutcome | { readonly ok: true; readonly report?: undefined }> {
    return locked<TxOutcome | { ok: true; report?: undefined }>(newID(), true, async (store, lock) => {
      if (unfinished(store).length > 0) return txFail("recovery_required", "an interrupted apply must be recovered first (`hubctl setup recover`)")
      const mine = store
        .journals()
        .filter((j) => j.hostFingerprint === config.host.fingerprint)
        .sort((a, b) => a.startedAt - b.startedAt || (a.txID < b.txID ? -1 : a.txID > b.txID ? 1 : 0))
      let start = 0
      if (request.to !== undefined) {
        const at = mine.findIndex((j) => j.txID === request.to)
        if (at < 0) return txFail("invalid", `no transaction ${request.to} on this host`)
        if (mine[at]!.state !== "committed") return txFail("invalid", `${request.to} did not commit; roll back to a committed transaction`)
        start = at + 1
      }
      const undo = mine.slice(start).filter((j) => j.state === "committed").reverse()
      if (undo.length === 0) return { ok: true }
      const steps: StepOutcome[] = []
      const conflicts: Conflict[] = []
      let last: TxReport | undefined
      for (const journal of undo) {
        const r = await new Run(store, lock, store.readPlan(journal), journal).rollbackAll()
        if (!r.ok) return r
        last = r.report
        steps.push(...r.report.steps)
        conflicts.push(...r.report.conflicts)
      }
      return { ok: true, report: { ...last!, steps, conflicts } }
    })
  }

  /** One transaction: its journal, the plan it applies, and its report. */
  class Run {
    private journal: TransactionJournal
    private readonly steps: StepOutcome[] = []
    private readonly conflicts: Conflict[] = []
    private readonly evidence: { actionID: string; results: readonly EvidenceResult[] }[] = []

    constructor(
      private readonly store: TxStore,
      private readonly lock: { current: ApplyLock },
      private readonly plan: SetupPlan | undefined,
      journal: TransactionJournal,
    ) {
      this.journal = journal
    }

    get txID() {
      return this.journal.txID
    }

    report(): TxReport {
      return { txID: this.txID, state: this.journal.state, steps: [...this.steps], conflicts: [...this.conflicts], evidence: [...this.evidence] }
    }

    persist(patch: Partial<Pick<TransactionJournal, "state" | "entries">> = {}): void {
      const next: TransactionJournal = { ...this.journal, ...patch, updatedAt: Math.max(now(), this.journal.startedAt) }
      this.store.writeJournal(next)
      this.journal = next
    }

    private executor(action: Action): ActionExecutor | undefined {
      return config.executors[action.kind] as ActionExecutor | undefined
    }

    private resolve(ref: PathRef, options?: ResolveOptions): TxResult<string> {
      return resolveTarget(ref, config.roots, fs, { ...options, context })
    }

    // ---------- preflight ----------

    async preflight(): Promise<TxResult<void>> {
      for (const action of this.plan!.actions) {
        const exec = this.executor(action)
        if (!exec) return txFail("internal", `this hubctl cannot apply ${action.kind} steps`)
        const step = exec.plan(action)
        const ctx = this.context(action, step)
        if (!ctx.ok) return ctx
        if (exec.check) {
          const r = await exec.check(action, ctx.value)
          if (!r.ok) return txFail(r.code, `${action.id}: ${r.message}`)
        }
      }
      return txOk(undefined)
    }

    private context(action: Action, step: StepPlan): TxResult<StepContext> {
      let target: string | undefined
      let current: FileState = { exists: false }
      if (step.path) {
        const r = this.resolve(step.path, step.resolve)
        if (!r.ok) return txFail(r.code, `${action.id}: ${r.message}`)
        target = r.value
        current = fileState(fs, target, { tree: step.class === "harness" })
      } else if (step.class !== "external") return txFail("internal", `${action.id}: a ${step.class} step names its path`)
      return txOk({
        fs,
        roots: config.roots,
        context,
        host: config.host,
        now,
        target,
        current,
        original: this.original(step.path, current),
        resolve: (ref, options) => this.resolve(ref, options),
        recordEvidence: (results) => this.evidence.push({ actionID: action.id, results }),
      })
    }

    /** The path's state before this transaction, if our own earlier steps are all that changed it. */
    private original(path: PathRef | undefined, current: FileState): FileState {
      if (!path) return current
      const mine = this.journal.entries.filter((e) => samePath(e.path, path))
      const latest = mine[mine.length - 1]
      if (!latest || latest.status !== "done" || !latest.after || !sameState(current, latest.after)) return current
      return mine[0]!.before
    }

    // ---------- forward ----------

    async forward(): Promise<TxOutcome> {
      let failure: TxFailure | undefined
      try {
        for (const action of this.plan!.actions) {
          if (this.complete(action)) {
            this.steps.push({ actionID: action.id, kind: action.kind, outcome: "resumed" })
            continue
          }
          const r = await this.step(action)
          if (!r.ok) {
            this.steps.push({ actionID: action.id, kind: action.kind, outcome: "failed" })
            failure = r
            break
          }
        }
        if (!failure) this.persist({ state: "committed" })
      } catch (error) {
        failure = failureOf(error)
      }
      if (!failure) {
        if (!config.keepBackups) this.cleanup()
        return { ok: true, report: this.report() }
      }
      const rolled = await this.rollbackAll()
      if (!rolled.ok) return { ...rolled, message: `${failure.message}; then ${rolled.message}`, report: this.report() }
      return { ...failure, report: this.report() }
    }

    /** Whether a step of the plan already finished in this transaction (resume). */
    private complete(action: Action): boolean {
      const exec = this.executor(action)
      if (!exec) return false
      const path = exec.plan(action).path
      return this.journal.entries.some((e) => e.actionID === action.id && samePath(e.path, path) && (e.status === "done" || e.status === "skipped"))
    }

    /** Keeps the lock from looking overrun during a long apply (renewed once a quarter of its lifetime is used). */
    private renew(): void {
      if (now() - this.lock.current.acquiredAt < LOCK_MAX_MS / 4) return
      this.lock.current = renewLock(lockIO(this.store), this.lock.current)
    }

    private async step(action: Action): Promise<TxResult<void>> {
      this.renew()
      const exec = this.executor(action)
      if (!exec) return txFail("internal", `this hubctl cannot apply ${action.kind} steps`)
      const step = exec.plan(action)
      const ctx = this.context(action, step)
      if (!ctx.ok) return ctx
      if (exec.check) {
        const r = await exec.check(action, ctx.value)
        if (!r.ok) return txFail(r.code, `${action.id}: ${r.message}`)
      }
      const change = await exec.change(action, ctx.value)
      if (!change.ok) return txFail(change.code, `${action.id}: ${change.message}`)
      const r = await this.perform(action, step, ctx.value, change.value)
      if (r.ok) this.steps.push({ actionID: action.id, kind: action.kind, outcome: r.value })
      return r.ok ? txOk(undefined) : r
    }

    private async append(entry: Omit<JournalEntry, "seq">): Promise<JournalEntry> {
      const full: JournalEntry = { ...entry, seq: this.journal.entries.length + 1 }
      this.persist({ entries: [...this.journal.entries, full] })
      await hooks.beforeAction?.(copy(full), copy(this.journal))
      return full
    }

    private async settle(entry: JournalEntry, patch: Partial<Pick<JournalEntry, "status" | "after">>, observe = true): Promise<JournalEntry> {
      const next: JournalEntry = { ...entry, ...patch }
      this.persist({ entries: this.journal.entries.map((e) => (e.seq === entry.seq ? next : e)) })
      if (observe) await hooks.afterAction?.(copy(next), copy(this.journal))
      return next
    }

    private stagingPath(target: string, seq: number): string {
      return `${dirname(target)}/.${basename(target)}.hub-${this.txID}-${seq}.tmp`
    }

    /**
     * A step that is already exactly as wanted changes nothing, so it gets no journal entry: there is nothing to
     * own or undo, and a resume simply finds it unchanged again.
     */
    private skip(): TxResult<"skipped"> {
      return txOk("skipped")
    }

    /** Re-checks the target right before it is written: a symlink planted since the step began is refused. */
    private recheck(action: Action, step: StepPlan): void {
      const r = this.resolve(step.path!, step.resolve)
      if (!r.ok) throw new TxError(r.code, `${action.id}: ${r.message}`)
    }

    /** Creates the missing directories above `ref`, each journaled as its own owned change. */
    private async parents(action: Action, ref: PathRef): Promise<void> {
      const parts = ref.rel.split("/").slice(0, -1)
      const root = rootDir(ref.root, config.roots, context)!
      if (!fs.lstat(root)) fs.mkdirp(root, PARENT_MODE)
      for (let i = 1; i <= parts.length; i++) {
        const rel = parts.slice(0, i).join("/")
        const abs = `${root === "/" ? "" : root}/${rel}`
        const info = fs.lstat(abs)
        if (info?.kind === "directory") continue
        if (info) throw new TxError("conflict", `${abs} is not a directory`)
        const entry = await this.append({ actionID: action.id, kind: action.kind, class: "directory", path: { root: ref.root, rel }, before: { exists: false }, after: { exists: true, mode: PARENT_MODE }, status: "pending" })
        const again = this.resolve({ root: ref.root, rel })
        if (!again.ok) throw new TxError(again.code, `${action.id}: ${again.message}`)
        fs.mkdir(abs, PARENT_MODE)
        fs.chmod(abs, PARENT_MODE)
        await this.settle(entry, { status: "done", after: fileState(fs, abs) })
      }
    }

    private backup(seq: number, target: string, current: FileState): { id: string } | undefined {
      if (!current.exists) return undefined
      const id = `bk_${seq}`
      this.store.writeBackup(this.txID, id, current.symlink ? fs.readlink(target) : fs.readFile(target))
      return { id }
    }

    private async perform(action: Action, step: StepPlan, ctx: StepContext, change: Change): Promise<TxResult<"applied" | "skipped">> {
      const { target, current } = ctx
      const path = step.path
      const conflict = (why: string) => txFail("conflict", `${action.id}: ${target} ${why}; nothing was overwritten`)
      const kind = target ? fs.lstat(target)?.kind : undefined
      switch (change.type) {
        case "none":
          return this.skip()
        case "remove": {
          if (!current.exists) return this.skip()
          if (kind !== "file") return conflict("is not a file")
          const seq = this.journal.entries.length + 1
          const backup = this.backup(seq, target!, current)
          const entry = await this.append({ actionID: action.id, kind: action.kind, class: step.class, path: path!, before: current, after: { exists: false }, ...(backup ? { backup } : {}), status: "pending" })
          this.recheck(action, step)
          fs.unlink(target!)
          fs.fsyncDir(dirname(target!))
          await this.settle(entry, { status: "done", after: fileState(fs, target!) })
          return txOk("applied")
        }
        case "effect": {
          const entry = await this.append({ actionID: action.id, kind: action.kind, class: step.class, ...(path ? { path } : {}), before: current, status: "pending" })
          if (path) this.recheck(action, step)
          const r = await change.perform()
          if (!r.ok) return txFail(r.code, `${action.id}: ${r.message}`)
          await this.settle(entry, { status: "done", ...(target ? { after: fileState(fs, target) } : {}) })
          return txOk("applied")
        }
        case "directory": {
          if (current.exists) return kind === "directory" ? this.skip() : conflict("exists and is not a directory")
          await this.parents(action, path!)
          const entry = await this.append({ actionID: action.id, kind: action.kind, class: step.class, path: path!, before: current, after: { exists: true, mode: change.mode }, status: "pending" })
          this.recheck(action, step)
          fs.mkdir(target!, change.mode)
          fs.chmod(target!, change.mode)
          await this.settle(entry, { status: "done", after: fileState(fs, target!) })
          return txOk("applied")
        }
        case "file":
        case "symlink": {
          const desired: FileState =
            change.type === "file" ? { exists: true, sha256: sha256Of(change.bytes), mode: change.mode } : { exists: true, symlink: true, sha256: sha256Of(change.target) }
          if (current.exists) {
            if (sameState(current, desired) && (change.type === "symlink" || kind === "file")) return this.skip()
            if (change.replace === "refuse") return conflict("already exists with other content")
            if (kind !== "file" && kind !== "symlink") return conflict("exists and is not a file")
          }
          await this.parents(action, path!)
          const seq = this.journal.entries.length + 1
          const backup = this.backup(seq, target!, current)
          const entry = await this.append({ actionID: action.id, kind: action.kind, class: step.class, path: path!, before: current, after: desired, ...(backup ? { backup } : {}), status: "pending" })
          this.recheck(action, step)
          const staged = this.stagingPath(target!, entry.seq)
          if (change.type === "file") fs.writeExclusive(staged, change.bytes, change.mode)
          else fs.symlink(change.target, staged)
          fs.rename(staged, target!)
          fs.fsyncDir(dirname(target!))
          const after = fileState(fs, target!)
          if (!sameState(after, desired)) throw new TxError("conflict", `${action.id}: ${target} changed while it was being written`)
          await this.settle(entry, { status: "done", after })
          return txOk("applied")
        }
        case "tree": {
          const desired: FileState = { exists: true, sha256: treeDigestOfFiles(change.files, change.mode), mode: change.mode }
          if (current.exists) return sameState(current, desired) ? this.skip() : conflict("already exists with other content (install roots are never overwritten)")
          await this.parents(action, path!)
          const entry = await this.append({ actionID: action.id, kind: action.kind, class: step.class, path: path!, before: current, after: desired, status: "pending" })
          this.recheck(action, step)
          const staged = this.stagingPath(target!, entry.seq)
          this.stageTree(staged, change.files, change.mode)
          fs.rename(staged, target!)
          fs.fsyncDir(dirname(target!))
          const after = fileState(fs, target!, { tree: true })
          if (!sameState(after, desired)) throw new TxError("conflict", `${action.id}: ${target} changed while it was being installed`)
          await this.settle(entry, { status: "done", after })
          return txOk("applied")
        }
      }
    }

    private stageTree(dir: string, files: readonly TreeFile[], mode: number): void {
      fs.mkdir(dir, mode)
      fs.chmod(dir, mode)
      const dirs = new Set<string>()
      for (const f of files) {
        const parts = f.rel.split("/")
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"))
      }
      for (const d of [...dirs].sort()) {
        fs.mkdir(`${dir}/${d}`, mode)
        fs.chmod(`${dir}/${d}`, mode)
      }
      for (const f of files) fs.writeExclusive(`${dir}/${f.rel}`, f.bytes, f.mode)
    }

    private cleanup(): void {
      try {
        this.store.dropBackups(this.txID)
      } catch (error) {
        if (!errnoOf(error)) throw error
      }
    }

    // ---------- resume ----------

    async resume(): Promise<TxOutcome> {
      const last = this.journal.entries[this.journal.entries.length - 1]
      if (last?.status === "pending") {
        const r = this.settlePending(last)
        if (!r.ok) return { ...r, report: this.report() }
      }
      if (this.journal.state === "prepared") this.persist({ state: "applying" })
      return this.forward()
    }

    /** Decides an interrupted (pending) last entry before resuming: finished, never started, or changed by someone. */
    private settlePending(entry: JournalEntry): TxResult<void> {
      const truncate = () => this.persist({ entries: this.journal.entries.slice(0, -1) })
      if (!entry.path) {
        truncate() // an external step: run it again
        return txOk(undefined)
      }
      const target = this.resolve(entry.path, this.resolveOptions(entry))
      if (!target.ok) return txFail("recovery_required", `${entry.actionID}: ${target.message}; roll back instead`)
      const current = fileState(fs, target.value, { tree: entry.class === "harness" })
      if (entry.after && sameState(current, entry.after)) {
        this.persist({ entries: this.journal.entries.map((e) => (e.seq === entry.seq ? { ...e, status: "done" } : e)) })
        return txOk(undefined)
      }
      if (sameState(current, entry.before)) {
        this.removeStaging(target.value, entry.seq)
        truncate()
        return txOk(undefined)
      }
      if (entry.class === "credential" && !entry.after) {
        // The credential store writes atomically: the interrupted enrollment stored its credential.
        this.persist({ entries: this.journal.entries.map((e) => (e.seq === entry.seq ? { ...e, status: "done", after: current } : e)) })
        return txOk(undefined)
      }
      return txFail("recovery_required", `${entry.actionID}: ${target.value} changed during the interruption; roll back instead`)
    }

    private resolveOptions(entry: JournalEntry): ResolveOptions {
      return entry.class === "link" ? { finalMayBeSymlink: true } : {}
    }

    // ---------- rollback ----------

    async rollbackAll(): Promise<TxOutcome> {
      const decided: RecoveryStep[] = []
      try {
        if (this.journal.state !== "rolling-back") this.persist({ state: "rolling-back" })
        for (const entry of [...this.journal.entries].reverse()) {
          if (entry.status === "undone" || entry.status === "skipped") {
            // An interrupted earlier rollback may have left this entry's staging (or a tree moved aside) behind.
            const r = entry.path ? this.resolve(entry.path, this.resolveOptions(entry)) : undefined
            if (r?.ok) this.removeStaging(r.value, entry.seq)
            continue
          }
          decided.push({ seq: entry.seq, actionID: entry.actionID, decision: await this.undo(entry) })
        }
        this.persist({ state: "rolled-back" })
        this.cleanup()
        await hooks.onRecover?.(copy(this.journal), copy(decided))
        return { ok: true, report: this.report() }
      } catch (error) {
        const f = failureOf(error)
        try {
          this.persist({ state: "failed" })
        } catch {}
        return txFail("recovery_required", `rollback of ${this.txID} did not finish (${f.message}); run \`hubctl setup recover\` again`)
      }
    }

    private async conflict(entry: JournalEntry, path: string | undefined, reason: string, current: FileState = { exists: false }) {
      this.conflicts.push({ seq: entry.seq, actionID: entry.actionID, ...(path ? { path } : {}), reason })
      await hooks.onConflict?.(copy(entry), copy(current))
    }

    private async mark(entry: JournalEntry, status: "undone" | "skipped"): Promise<void> {
      await this.settle(entry, { status }, false)
    }

    private actionOf(entry: JournalEntry): Action | undefined {
      return this.plan?.actions.find((a) => a.id === entry.actionID)
    }

    private async undo(entry: JournalEntry): Promise<RecoveryStep["decision"]> {
      const action = this.actionOf(entry)
      const exec = action ? this.executor(action) : undefined
      if (entry.class === "external") {
        if (entry.status === "done" && action && exec?.undo) {
          const r = await exec.undo(action as never, { fs, roots: config.roots, context, host: config.host, now, reason: "revert-external" })
          if (!r.ok) await this.conflict(entry, undefined, `could not be reverted: ${r.message}`)
        }
        await this.mark(entry, "undone")
        return "nothing-to-do"
      }
      const resolved = this.resolve(entry.path!, this.resolveOptions(entry))
      if (!resolved.ok) {
        await this.conflict(entry, undefined, `left alone: ${resolved.message}`)
        return "keep-user-edit"
      }
      const target = resolved.value
      this.removeStaging(target, entry.seq)
      const current = fileState(fs, target, { tree: entry.class === "harness" })
      if (sameState(current, entry.before)) {
        await this.mark(entry, entry.after ? "undone" : "skipped")
        return "nothing-to-do"
      }
      // An enrollment interrupted before it was journaled done stored a credential we never recorded: the contract
      // clears it (recoveryDecision, v1.1).
      const decision = recoveryDecision(entry, current)
      switch (decision) {
        case "nothing-to-do":
          await this.mark(entry, entry.after ? "undone" : "skipped")
          break
        case "keep-user-edit":
          await this.conflict(entry, target, "changed since hub wrote it; kept as it is", current)
          break
        case "restore-backup": {
          const bytes = entry.backup ? this.store.readBackup(this.txID, entry.backup.id) : undefined
          const backupDigest = bytes ? sha256Of(entry.before.symlink ? new TextDecoder().decode(bytes) : bytes) : undefined
          if (!bytes || backupDigest !== entry.before.sha256) {
            await this.conflict(entry, target, "its backup is missing or does not match what was backed up; left as hub wrote it", current)
            return "keep-user-edit"
          }
          const staged = this.stagingPath(target, entry.seq)
          if (entry.before.symlink) fs.symlink(new TextDecoder().decode(bytes), staged)
          else fs.writeExclusive(staged, bytes, entry.before.mode ?? 0o600)
          fs.rename(staged, target)
          fs.fsyncDir(dirname(target))
          await this.mark(entry, "undone")
          break
        }
        case "remove-created": {
          const kind = fs.lstat(target)?.kind
          if (kind === "directory" && entry.class === "harness") {
            // Move the tree aside atomically, then delete it: an interrupted delete never leaves half a tree.
            const trash = this.stagingPath(target, entry.seq)
            fs.rename(target, trash)
            await this.mark(entry, "undone")
            this.removeTree(trash)
          } else if (kind === "directory") {
            try {
              fs.rmdir(target)
            } catch (error) {
              if (errnoOf(error) !== "ENOTEMPTY" && errnoOf(error) !== "EEXIST") throw error
              await this.conflict(entry, target, "is not empty (it holds files hub did not create); kept", current)
              return "keep-user-edit"
            }
            await this.mark(entry, "undone")
          } else {
            fs.unlink(target)
            await this.mark(entry, "undone")
          }
          break
        }
        case "clear-credential": {
          if (!action || !exec?.undo) {
            await this.conflict(entry, target, "holds a credential this hubctl cannot clear; remove it with `hubctl machine` commands", current)
            return "keep-user-edit"
          }
          const r = await exec.undo(action as never, { fs, roots: config.roots, context, host: config.host, now, target, reason: "clear-credential" })
          if (!r.ok) {
            await this.conflict(entry, target, `the credential could not be cleared: ${r.message}`, current)
            return "keep-user-edit"
          }
          // An interrupted enrollment recorded no "after"; the journal records what it cleared.
          await this.settle(entry, { status: "undone", after: entry.after ?? current }, false)
          break
        }
      }
      return decision
    }

    private removeStaging(target: string, seq: number): void {
      const staged = this.stagingPath(target, seq)
      const info = fs.lstat(staged)
      if (!info) return
      if (info.kind === "directory") this.removeTree(staged)
      else fs.unlink(staged)
    }

    private removeTree(dir: string): void {
      for (const name of fs.readdir(dir)) {
        const p = `${dir}/${name}`
        if (fs.lstat(p)?.kind === "directory") this.removeTree(p)
        else fs.unlink(p)
      }
      fs.rmdir(dir)
    }
  }

  return {
    apply: async (request) => redact(await apply(request)),
    recover: async (request) => redact(await recover(request)),
    rollback: async (request) => redact(await rollback(request)),
  }
}
