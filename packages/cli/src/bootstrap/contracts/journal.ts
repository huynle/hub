// The transaction journal, ownership records, recovery rules and the apply lock.
//
// apply takes the lock (O_EXCL create of state:hub/bootstrap/apply.lock), writes the journal before each action
// ("pending", with the file's state before and a backup reference), performs the action, then marks it "done"
// with the state after. The journal holds digests and modes, never contents (backups are separate owner-only
// files) and never credentials. After a crash, recovery walks the entries newest first and decides per entry
// (recoveryDecision): undo what is still exactly as we left it, keep anything the user changed since, and never
// restore a stale credential (a rolled-back enrollment is cleared, not reverted to the previous token).
import { ACTION_KINDS, type ActionKind } from "./actions.ts"
import { checkPathRef, type PathRef } from "./paths.ts"
import { findSecrets } from "./secrets.ts"
import { bool, Checker, digest, header, instant, int, isRecord, list, oneOf, pointer, shape, text, type Result } from "./validate.ts"

export const JOURNAL_SCHEMA = "hub.transaction-journal"
export const JOURNAL_STATES = ["prepared", "applying", "committed", "rolling-back", "rolled-back", "failed"] as const
export type JournalState = (typeof JOURNAL_STATES)[number]
export const ENTRY_CLASSES = ["file", "config", "credential", "service", "artifact", "harness", "link", "directory", "external"] as const
/** harness: an installed harness binary/version (rollback restores the previous one). external: a step with no local file (verify, launch, service activation); nothing to undo on disk. */
export type EntryClass = (typeof ENTRY_CLASSES)[number]

export interface FileState {
  readonly exists: boolean
  readonly sha256?: string
  readonly mode?: number
  readonly symlink?: boolean
}

/** One owned change. `before`/`after` are what the file was and what we made it; ownership is "we wrote `after`". */
export interface JournalEntry {
  readonly seq: number
  readonly actionID: string
  readonly kind: ActionKind
  readonly class: EntryClass
  readonly path?: PathRef
  readonly before: FileState
  readonly after?: FileState
  /** The owner-only copy of `before` (never for credentials). */
  readonly backup?: { readonly id: string }
  readonly status: "pending" | "done" | "undone" | "skipped"
}

export interface TransactionJournal {
  readonly schema: typeof JOURNAL_SCHEMA
  readonly version: 1
  readonly txID: string
  readonly planDigest: string
  readonly hostFingerprint: string
  /** The preview nonce this apply consumed (replays are refused). */
  readonly nonce: string
  readonly state: JournalState
  readonly startedAt: number
  readonly updatedAt: number
  readonly entries: readonly JournalEntry[]
}

/** Classes whose previous content must be backed up before they are changed. */
const BACKED_UP: readonly EntryClass[] = ["file", "config", "service", "artifact", "harness", "link"]
const TX_ID = /^tx_[A-Za-z0-9]{1,64}$/
const BACKUP_ID = /^bk_[A-Za-z0-9]{1,64}$/
const NONCE = /^[A-Za-z0-9_-]{16,128}$/

function checkFileState(c: Checker, path: string, v: unknown) {
  const r = shape(c, path, v, ["exists"], ["sha256", "mode", "symlink"])
  if (!r) return
  bool(c, pointer(path, "exists"), r.exists)
  if (r.sha256 !== undefined) digest(c, pointer(path, "sha256"), r.sha256)
  if (r.mode !== undefined) int(c, pointer(path, "mode"), r.mode, 0, 0o7777)
  if (r.symlink !== undefined) bool(c, pointer(path, "symlink"), r.symlink)
  if (r.exists === false && (r.sha256 !== undefined || r.mode !== undefined)) c.add(path, "inconsistent", "a missing file has no digest or mode")
}

export function validateJournal(value: unknown): Result<TransactionJournal> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "txID", "planDigest", "hostFingerprint", "nonce", "state", "startedAt", "updatedAt", "entries"])
  if (!r) return c.result(value)
  header(c, "", r, JOURNAL_SCHEMA, 1)
  text(c, "/txID", r.txID, 67, TX_ID)
  digest(c, "/planDigest", r.planDigest)
  digest(c, "/hostFingerprint", r.hostFingerprint)
  text(c, "/nonce", r.nonce, 128, NONCE)
  oneOf(c, "/state", r.state, JOURNAL_STATES)
  if (instant(c, "/startedAt", r.startedAt) && instant(c, "/updatedAt", r.updatedAt) && (r.updatedAt as number) < (r.startedAt as number))
    c.add("/updatedAt", "inconsistent", "updated before it started")
  list(c, "/entries", r.entries, 256, (p, v) => {
    const e = shape(c, p, v, ["seq", "actionID", "kind", "class", "before", "status"], ["path", "after", "backup"])
    if (!e) return
    const index = Number(p.slice(p.lastIndexOf("/") + 1))
    if (int(c, pointer(p, "seq"), e.seq, 1, 256) && e.seq !== index + 1) c.add(pointer(p, "seq"), "inconsistent", "entries are numbered 1, 2, 3, … in order")
    text(c, pointer(p, "actionID"), e.actionID, 64, /^[a-z0-9][a-z0-9-]{0,63}$/)
    oneOf(c, pointer(p, "kind"), e.kind, ACTION_KINDS)
    oneOf(c, pointer(p, "class"), e.class, ENTRY_CLASSES)
    oneOf(c, pointer(p, "status"), e.status, ["pending", "done", "undone", "skipped"] as const)
    if (e.path !== undefined) checkPathRef(c, pointer(p, "path"), e.path)
    else if (e.class !== "external") c.add(pointer(p, "path"), "missing_field", "a local change names its path")
    checkFileState(c, pointer(p, "before"), e.before)
    if (e.after !== undefined) checkFileState(c, pointer(p, "after"), e.after)
    if (e.backup !== undefined) {
      const b = shape(c, pointer(p, "backup"), e.backup, ["id"])
      if (b) text(c, pointer(pointer(p, "backup"), "id"), b.id, 67, BACKUP_ID)
    }
    const before = isRecord(e.before) ? e.before : {}
    if (e.class === "credential" && e.backup !== undefined) c.add(pointer(p, "backup"), "inconsistent", "credentials are never backed up (a stale credential is never restored)")
    if (BACKED_UP.includes(e.class as EntryClass) && before.exists === true && e.backup === undefined) c.add(pointer(p, "backup"), "inconsistent", "an existing file is backed up before it is changed")
    if ((e.status === "done" || e.status === "undone") && e.after === undefined && e.class !== "external") c.add(pointer(p, "after"), "inconsistent", "a done entry records the state it left")
  })
  for (const p of findSecrets(value)) c.add(p, "secret", "journals never carry credentials")
  return c.result(value)
}

export type RecoveryDecision = "nothing-to-do" | "remove-created" | "restore-backup" | "clear-credential" | "keep-user-edit"

const sameState = (a: FileState, b: FileState) =>
  a.exists === b.exists && (a.sha256 ?? null) === (b.sha256 ?? null) && (a.mode === undefined || b.mode === undefined || a.mode === b.mode) && Boolean(a.symlink) === Boolean(b.symlink)

/**
 * What recovery does for one entry, given the file's state now. Anything not exactly as we left it is a user edit
 * and is kept (reported as a conflict), never overwritten.
 */
export function recoveryDecision(entry: JournalEntry, current: FileState): RecoveryDecision {
  if (entry.status === "undone" || entry.status === "skipped" || entry.class === "external") return "nothing-to-do"
  const ours = entry.after !== undefined && sameState(current, entry.after)
  if (entry.status === "pending" && sameState(current, entry.before)) return "nothing-to-do"
  if (!ours) return "keep-user-edit"
  if (entry.class === "credential") return "clear-credential"
  if (entry.before.exists) return entry.backup ? "restore-backup" : "keep-user-edit"
  return "remove-created"
}

export interface RecoveryStep {
  readonly seq: number
  readonly actionID: string
  readonly decision: RecoveryDecision
}

/** Recovery for an interrupted transaction, newest entry first; finished transactions need none. */
export function recoveryPlan(journal: TransactionJournal, stateOf: (entry: JournalEntry) => FileState): RecoveryStep[] {
  if (journal.state === "committed" || journal.state === "rolled-back") return []
  return [...journal.entries].reverse().map((entry) => ({ seq: entry.seq, actionID: entry.actionID, decision: recoveryDecision(entry, stateOf(entry)) }))
}

/** Hooks the applier calls around each step (logging, progress, tests). They observe; they cannot change actions. */
export interface JournalHooks {
  beforeAction?(entry: JournalEntry, journal: TransactionJournal): void | Promise<void>
  afterAction?(entry: JournalEntry, journal: TransactionJournal): void | Promise<void>
  onConflict?(entry: JournalEntry, current: FileState): void | Promise<void>
  onRecover?(journal: TransactionJournal, steps: readonly RecoveryStep[]): void | Promise<void>
}

// ---------- apply lock ----------

export const LOCK_SCHEMA = "hub.apply-lock"
/** The longest an apply may hold the lock before it is considered stale. */
export const LOCK_MAX_MS = 60 * 60_000
/** Where the lock lives (state root). */
export const LOCK_PATH: PathRef = { root: "state", rel: "hub/bootstrap/apply.lock" }

export interface ApplyLock {
  readonly schema: typeof LOCK_SCHEMA
  readonly version: 1
  readonly pid: number
  readonly hostFingerprint: string
  readonly txID: string
  readonly acquiredAt: number
  readonly expiresAt: number
}

export function validateApplyLock(value: unknown): Result<ApplyLock> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "pid", "hostFingerprint", "txID", "acquiredAt", "expiresAt"])
  if (!r) return c.result(value)
  header(c, "", r, LOCK_SCHEMA, 1)
  int(c, "/pid", r.pid, 1, 2 ** 31)
  digest(c, "/hostFingerprint", r.hostFingerprint)
  text(c, "/txID", r.txID, 67, TX_ID)
  if (instant(c, "/acquiredAt", r.acquiredAt) && instant(c, "/expiresAt", r.expiresAt)) {
    const span = (r.expiresAt as number) - (r.acquiredAt as number)
    if (span <= 0 || span > LOCK_MAX_MS) c.add("/expiresAt", "invalid_value", `a lock is held for 1 ms..${LOCK_MAX_MS / 60_000} minutes`)
  }
  return c.result(value)
}

export type LockState = "free" | "held" | "stale" | "foreign"

/**
 * free: take it. held: another apply runs (refuse: exit locked). stale: same host, the holder died or overran
 * (recover its journal, then take it). foreign: another host's lock (a shared home): never broken automatically.
 */
export function lockState(lock: ApplyLock | undefined, context: { readonly now: number; readonly hostFingerprint: string; readonly isAlive: (pid: number) => boolean }): LockState {
  if (!lock) return "free"
  if (lock.hostFingerprint !== context.hostFingerprint) return "foreign"
  if (context.now >= lock.expiresAt || !context.isAlive(lock.pid)) return "stale"
  return "held"
}
