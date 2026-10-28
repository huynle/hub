// The apply lock (contract: journal.ts ApplyLock, lockState, LOCK_PATH). One apply or recovery at a time per
// state directory. The lock is created atomically with complete content: the document is written to a private
// temporary file and hard-linked into place, which fails if a lock exists (the O_EXCL guarantee without a window
// where another process could read a half-written lock).
//
//   held     a live apply on this host: refuse (exit locked).
//   foreign  another host's lock on a shared home: never broken automatically.
//   stale    this host, holder dead or overran: the caller recovers its journal first, then breaks it.
//   corrupt  unreadable: never broken automatically (the user removes it after checking).
import { canonicalJSON, LOCK_MAX_MS, LOCK_SCHEMA, lockState, validateApplyLock, type ApplyLock } from "../contracts/index.ts"
import type { TxFs } from "./fs.ts"

export interface LockIO {
  readonly fs: TxFs
  /** Absolute path of the lock (LOCK_PATH resolved). */
  readonly path: string
  readonly hostFingerprint: string
  readonly pid: number
  readonly now: () => number
  readonly isAlive: (pid: number) => boolean
}

export type LockAttempt =
  | { readonly state: "acquired"; readonly lock: ApplyLock }
  | { readonly state: "held" | "foreign" | "stale"; readonly lock: ApplyLock }
  | { readonly state: "corrupt" }

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

function removeQuietly(fs: TxFs, path: string) {
  try {
    if (fs.lstat(path)) fs.unlink(path)
  } catch {}
}

/** The lock on disk: undefined when there is none, "corrupt" when it cannot be read as a valid lock. */
export function readLock(io: LockIO): ApplyLock | "corrupt" | undefined {
  if (!io.fs.lstat(io.path)) return undefined
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(io.fs.readFile(io.path)))
    const checked = validateApplyLock(parsed)
    return checked.ok ? checked.value : "corrupt"
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined
    return "corrupt"
  }
}

function newLock(io: LockIO, txID: string): ApplyLock {
  const now = io.now()
  return { schema: LOCK_SCHEMA, version: 1, pid: io.pid, hostFingerprint: io.hostFingerprint, txID, acquiredAt: now, expiresAt: now + LOCK_MAX_MS }
}

function writeTemp(io: LockIO, lock: ApplyLock): string {
  const tmp = `${io.path}.${lock.txID}.tmp`
  removeQuietly(io.fs, tmp)
  io.fs.writeExclusive(tmp, `${canonicalJSON(lock)}\n`, 0o600)
  return tmp
}

export function tryAcquireLock(io: LockIO, txID: string): LockAttempt {
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock = newLock(io, txID)
    const tmp = writeTemp(io, lock)
    try {
      io.fs.link(tmp, io.path)
      return { state: "acquired", lock }
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error
    } finally {
      removeQuietly(io.fs, tmp)
    }
    const existing = readLock(io)
    if (existing === undefined) continue // released between our attempt and the read
    if (existing === "corrupt") return { state: "corrupt" }
    const state = lockState(existing, { now: io.now(), hostFingerprint: io.hostFingerprint, isAlive: io.isAlive })
    if (state === "free") continue
    return { state, lock: existing }
  }
  const existing = readLock(io)
  return existing && existing !== "corrupt" ? { state: "held", lock: existing } : { state: "corrupt" }
}

/**
 * Removes a lock judged stale, but only if it is still exactly the lock that was judged: it is moved aside first
 * (atomic), compared, and put back if another process replaced it meanwhile. True when the lock is gone.
 */
export function breakStaleLock(io: LockIO, observed: ApplyLock): boolean {
  const aside = `${io.path}.broken-${observed.txID}-${io.pid}`
  removeQuietly(io.fs, aside)
  try {
    io.fs.rename(io.path, aside)
  } catch (error) {
    if (errno(error) === "ENOENT") return true
    throw error
  }
  let same = false
  try {
    same = canonicalJSON(JSON.parse(new TextDecoder().decode(io.fs.readFile(aside)))) === canonicalJSON(observed)
  } catch {}
  if (!same) {
    try {
      io.fs.link(aside, io.path)
    } catch {}
  }
  removeQuietly(io.fs, aside)
  return same
}

/** Extends our lock by LOCK_MAX_MS from now (atomic replace); refuses if the lock is no longer ours. */
export function renewLock(io: LockIO, lock: ApplyLock): ApplyLock {
  const current = readLock(io)
  if (!current || current === "corrupt" || current.txID !== lock.txID || current.pid !== lock.pid) throw new Error("the apply lock is no longer held by this transaction")
  const renewed = newLock(io, lock.txID)
  const tmp = writeTemp(io, renewed)
  io.fs.rename(tmp, io.path)
  return renewed
}

/** Removes the lock if it is ours. */
export function releaseLock(io: LockIO, txID: string): void {
  const current = readLock(io)
  if (current && current !== "corrupt" && current.txID === txID) io.fs.unlink(io.path)
}
