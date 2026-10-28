// Rollback history, derived only from the contract's transaction journals (and, when available, the plans they
// record by digest). Each record lists what one apply on this host owned: per entry its class, path and before/
// after digests and modes, never contents and never credentials. Harness installs are annotated with the pinned
// version they installed and the version they replaced, so "what is installed" and "what a rollback restores" come
// from the history rather than a guess.
//
// rollbackTo plans undoing every transaction after a target, newest first, with the contract's recovery rules
// (recoveryDecision) per entry. It simulates the file states as it goes: undoing a newer change to a file yields
// the state the older change left, so chained changes resolve correctly. A user edit is kept and reported as a
// conflict (so are older changes to that file). A cleared credential's next state cannot be predicted, so older
// changes to that file are kept as conflicts too. The plan itself writes nothing.
import {
  Checker,
  fail,
  ok,
  planDigest,
  recoveryDecision,
  validateJournal,
  validateSetupPlan,
  type ActionKind,
  type EntryClass,
  type FileState,
  type HarnessID,
  type InstallHarness,
  type JournalEntry,
  type PathRef,
  type RecoveryDecision,
  type Result,
  type SetupPlan,
  type TransactionJournal,
} from "../contracts/index.ts"

/** One owned change, as the journal records it (digests and modes only). */
export interface OwnedChange {
  readonly seq: number
  readonly actionID: string
  readonly kind: ActionKind
  readonly class: EntryClass
  readonly path?: PathRef
  readonly before: FileState
  readonly after?: FileState
  /** Whether a backup of `before` exists (credentials never have one). */
  readonly backup: boolean
  readonly status: JournalEntry["status"]
}

export interface HarnessInstallRecord {
  readonly harness: HarnessID
  readonly version: string
  /** The pinned artifact digest. */
  readonly sha256: string
  /** The version it replaced (what a rollback restores). */
  readonly previous?: { readonly version: string; readonly sha256: string }
  readonly status: JournalEntry["status"]
}

export type TransactionOutcome = "committed" | "rolled-back" | "failed" | "interrupted"

export interface TransactionRecord {
  readonly txID: string
  readonly planDigest: string
  readonly outcome: TransactionOutcome
  readonly startedAt: number
  readonly updatedAt: number
  readonly changes: readonly OwnedChange[]
  /** Harness installs whose plan is known (an install without its plan has no version to report). */
  readonly harnesses: readonly HarnessInstallRecord[]
}

export interface HistoryContext {
  /** This host's fingerprint: other hosts' journals (a shared home) are refused. */
  readonly hostFingerprint: string
  /** Plans the journals applied, matched by digest. */
  readonly plans?: readonly SetupPlan[]
}

const OUTCOME: Readonly<Record<TransactionJournal["state"], TransactionOutcome>> = {
  committed: "committed",
  "rolled-back": "rolled-back",
  failed: "failed",
  prepared: "interrupted",
  applying: "interrupted",
  "rolling-back": "interrupted",
}

const byTime = (a: TransactionJournal, b: TransactionJournal) => a.startedAt - b.startedAt || (a.txID < b.txID ? -1 : a.txID > b.txID ? 1 : 0)

/** Validates the journals (and plans) and returns them oldest first. */
function checkedJournals(journals: readonly unknown[], context: HistoryContext): Result<{ journals: TransactionJournal[]; plans: Map<string, SetupPlan> }> {
  const c = new Checker()
  journals.forEach((j, i) => c.merge(`/journals/${i}`, validateJournal(j)))
  ;(context.plans ?? []).forEach((p, i) => c.merge(`/plans/${i}`, validateSetupPlan(p)))
  if (c.issues.length > 0) return c.result(undefined)
  const valid = journals as TransactionJournal[]
  const seen = new Set<string>()
  valid.forEach((j, i) => {
    if (j.hostFingerprint !== context.hostFingerprint) c.add(`/journals/${i}/hostFingerprint`, "inconsistent", "that journal is another host's")
    if (seen.has(j.txID)) c.add(`/journals/${i}/txID`, "duplicate", `duplicate transaction ${j.txID}`)
    seen.add(j.txID)
  })
  if (c.issues.length > 0) return c.result(undefined)
  const plans = new Map((context.plans ?? []).map((p) => [planDigest(p), p]))
  return ok({ journals: [...valid].sort(byTime), plans })
}

function installAction(plan: SetupPlan | undefined, actionID: string): InstallHarness | undefined {
  return plan?.actions.find((a): a is InstallHarness => a.kind === "install-harness" && a.id === actionID)
}

function record(journal: TransactionJournal, plan: SetupPlan | undefined): TransactionRecord {
  const harnesses = journal.entries.flatMap((e): HarnessInstallRecord[] => {
    const action = e.kind === "install-harness" ? installAction(plan, e.actionID) : undefined
    if (!action) return []
    return [{ harness: action.harness, version: action.version, sha256: action.sha256, ...(action.previous ? { previous: action.previous } : {}), status: e.status }]
  })
  return {
    txID: journal.txID,
    planDigest: journal.planDigest,
    outcome: OUTCOME[journal.state],
    startedAt: journal.startedAt,
    updatedAt: journal.updatedAt,
    changes: journal.entries.map((e) => ({
      seq: e.seq,
      actionID: e.actionID,
      kind: e.kind,
      class: e.class,
      ...(e.path ? { path: e.path } : {}),
      before: e.before,
      ...(e.after ? { after: e.after } : {}),
      backup: e.backup !== undefined,
      status: e.status,
    })),
    harnesses,
  }
}

/** This host's transactions, oldest first. */
export function rollbackHistory(journals: readonly unknown[], context: HistoryContext): Result<TransactionRecord[]> {
  const checked = checkedJournals(journals, context)
  if (!checked.ok) return checked
  return ok(checked.value.journals.map((j) => record(j, checked.value.plans.get(j.planDigest))))
}

export interface InstalledHarness {
  readonly version: string
  readonly sha256: string
  /** The transaction that installed it. */
  readonly txID: string
}

/** The pinned version hub last installed of each harness, from committed transactions only. */
export function installedHarnesses(history: readonly TransactionRecord[]): Partial<Record<HarnessID, InstalledHarness>> {
  const installed: Partial<Record<HarnessID, InstalledHarness>> = {}
  for (const tx of history) {
    if (tx.outcome !== "committed") continue
    for (const h of tx.harnesses) if (h.status === "done") installed[h.harness] = { version: h.version, sha256: h.sha256, txID: tx.txID }
  }
  return installed
}

export interface RollbackStep {
  readonly txID: string
  readonly seq: number
  readonly actionID: string
  readonly class: EntryClass
  readonly path?: PathRef
  readonly decision: RecoveryDecision
  /** For a harness restored from its backup: the version that comes back. */
  readonly restores?: { readonly harness: HarnessID; readonly version: string; readonly sha256: string }
}

export interface RollbackPlan {
  /** Newest transaction first; each transaction's entries newest first. */
  readonly steps: readonly RollbackStep[]
  /** Steps that keep a user edit (reported, never overwritten). */
  readonly conflicts: readonly RollbackStep[]
  /** True when nothing had to be kept: the target state is fully restored. */
  readonly complete: boolean
  /** Always zero: this is a plan. */
  readonly writes: 0
}

const pathKey = (p: PathRef) => `${p.root}:${p.rel}`

/**
 * Plans rolling this host back to just after `target` (a committed transaction), or to before every recorded
 * transaction when `target` is undefined. `stateOf` reports each entry's file as it is now.
 */
export function rollbackTo(journals: readonly unknown[], target: string | undefined, stateOf: (entry: JournalEntry) => FileState, context: HistoryContext): Result<RollbackPlan> {
  const checked = checkedJournals(journals, context)
  if (!checked.ok) return checked
  const ordered = checked.value.journals
  let start = 0
  if (target !== undefined) {
    const at = ordered.findIndex((j) => j.txID === target)
    if (at < 0) return fail("/target", "invalid_value", `no transaction ${target} on this host`)
    if (ordered[at]!.state !== "committed") return fail("/target", "invalid_value", `${target} did not commit; roll back to a committed transaction`)
    start = at + 1
  }

  // Simulated state per path; null: unpredictable (a credential was cleared).
  const predicted = new Map<string, FileState | null>()
  const steps: RollbackStep[] = []
  for (const journal of ordered.slice(start).reverse()) {
    if (journal.state === "rolled-back") continue
    const plan = checked.value.plans.get(journal.planDigest)
    for (const entry of [...journal.entries].reverse()) {
      const key = entry.path ? pathKey(entry.path) : undefined
      const known = key !== undefined && predicted.has(key) ? predicted.get(key)! : stateOf(entry)
      const decision: RecoveryDecision = known === null && entry.class !== "external" ? "keep-user-edit" : recoveryDecision(entry, known ?? { exists: false })
      if (key !== undefined) {
        if (decision === "restore-backup") predicted.set(key, entry.before)
        else if (decision === "remove-created") predicted.set(key, { exists: false })
        else if (decision === "clear-credential") predicted.set(key, null)
      }
      const action = decision === "restore-backup" && entry.kind === "install-harness" ? installAction(plan, entry.actionID) : undefined
      steps.push({
        txID: journal.txID,
        seq: entry.seq,
        actionID: entry.actionID,
        class: entry.class,
        ...(entry.path ? { path: entry.path } : {}),
        decision,
        ...(action?.previous ? { restores: { harness: action.harness, ...action.previous } } : {}),
      })
    }
  }
  const conflicts = steps.filter((s) => s.decision === "keep-user-edit")
  return ok({ steps, conflicts, complete: conflicts.length === 0, writes: 0 })
}
