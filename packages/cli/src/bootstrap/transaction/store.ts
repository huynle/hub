// Where the applier keeps its own state, under the state root next to the lock (contract LOCK_PATH):
//
//   state:hub/bootstrap/apply.lock               the apply lock
//   state:hub/bootstrap/journal/<txID>.json      the transaction journal (digests and modes only)
//   state:hub/bootstrap/journal/<txID>.plan.json the plan it applies (secret-free by contract), for resume/rollback
//   state:hub/bootstrap/backups/<txID>/<bk_id>   owner-only copies of files before they changed (never credentials)
//
// Every document is validated before it is written and after it is read, written atomically (temporary file,
// fsync, rename) with owner-only permissions, and reached only through symlink-checked paths.
import {
  canonicalJSON,
  LOCK_PATH,
  planDigest,
  validateJournal,
  validateSetupPlan,
  type ExecutionContext,
  type RootMapping,
  type SetupPlan,
  type TransactionJournal,
} from "../contracts/index.ts"
import type { TxFs } from "./fs.ts"
import { resolveTarget } from "./resolve.ts"
import { errnoOf, TxError } from "./result.ts"

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const STALE_TEMP = /\.tmp$|\.broken-/

export class TxStore {
  readonly base: string
  readonly lockPath: string
  private readonly journalDir: string
  private readonly backupDir: string

  constructor(
    private readonly fs: TxFs,
    roots: readonly RootMapping[],
    context: ExecutionContext = "host",
  ) {
    const lock = resolveTarget(LOCK_PATH, roots, fs, { context })
    if (!lock.ok) throw new TxError(lock.code === "conflict" ? "conflict" : "invalid", `the bootstrap state directory is unusable: ${lock.message}`)
    this.lockPath = lock.value
    this.base = lock.value.slice(0, lock.value.lastIndexOf("/"))
    this.journalDir = `${this.base}/journal`
    this.backupDir = `${this.base}/backups`
  }

  /** Creates the state directories (owner-only) and refuses if any of them is not a plain directory. */
  init(): void {
    for (const dir of [this.base, this.journalDir, this.backupDir]) {
      const info = this.fs.lstat(dir)
      if (!info) this.fs.mkdirp(dir, 0o700)
      else if (info.kind !== "directory") throw new TxError("conflict", `${dir} is not a directory`)
    }
  }

  /** Removes temporary files an interrupted writer left behind (only while holding the lock). */
  sweep(): void {
    for (const dir of [this.base, this.journalDir]) {
      for (const name of this.list(dir)) if (STALE_TEMP.test(name)) this.removeQuietly(`${dir}/${name}`)
    }
  }

  journals(): TransactionJournal[] {
    const out: TransactionJournal[] = []
    for (const name of this.list(this.journalDir).sort()) {
      if (!name.endsWith(".json") || name.endsWith(".plan.json")) continue
      const path = `${this.journalDir}/${name}`
      let parsed: unknown
      try {
        parsed = JSON.parse(decode(this.fs.readFile(path)))
      } catch {
        throw new TxError("recovery_required", `the journal ${path} cannot be read; inspect it before applying again`)
      }
      const checked = validateJournal(parsed)
      if (!checked.ok) throw new TxError("recovery_required", `the journal ${path} is not valid (${checked.issues[0]!.message}); inspect it before applying again`)
      out.push(checked.value)
    }
    return out
  }

  writeJournal(journal: TransactionJournal): void {
    const checked = validateJournal(journal)
    if (!checked.ok) throw new TxError("internal", `refusing to write an invalid journal: ${checked.issues[0]!.path} ${checked.issues[0]!.message}`)
    this.writeAtomic(`${this.journalDir}/${journal.txID}.json`, `${canonicalJSON(journal)}\n`)
  }

  writePlan(txID: string, plan: SetupPlan): void {
    const checked = validateSetupPlan(plan)
    if (!checked.ok) throw new TxError("invalid", `refusing to store an invalid plan: ${checked.issues[0]!.message}`)
    this.writeAtomic(`${this.journalDir}/${txID}.plan.json`, `${canonicalJSON(plan)}\n`)
  }

  /** The stored plan of a transaction, if it is valid and is the one the journal pins. */
  readPlan(journal: TransactionJournal): SetupPlan | undefined {
    const path = `${this.journalDir}/${journal.txID}.plan.json`
    if (!this.fs.lstat(path)) return undefined
    try {
      const checked = validateSetupPlan(JSON.parse(decode(this.fs.readFile(path))))
      return checked.ok && planDigest(checked.value) === journal.planDigest ? checked.value : undefined
    } catch {
      return undefined
    }
  }

  writeBackup(txID: string, id: string, bytes: Uint8Array | string): void {
    const dir = `${this.backupDir}/${txID}`
    if (!this.fs.lstat(dir)) this.fs.mkdir(dir, 0o700)
    const path = `${dir}/${id}`
    this.removeQuietly(path)
    this.fs.writeExclusive(path, bytes, 0o600)
  }

  readBackup(txID: string, id: string): Uint8Array | undefined {
    const path = `${this.backupDir}/${txID}/${id}`
    const info = this.fs.lstat(path)
    return info?.kind === "file" ? this.fs.readFile(path) : undefined
  }

  dropBackups(txID: string): void {
    const dir = `${this.backupDir}/${txID}`
    if (!this.fs.lstat(dir)) return
    for (const name of this.list(dir)) this.fs.unlink(`${dir}/${name}`)
    this.fs.rmdir(dir)
  }

  private writeAtomic(path: string, text: string): void {
    const tmp = `${path}.tmp`
    this.removeQuietly(tmp)
    try {
      this.fs.writeExclusive(tmp, text, 0o600)
      this.fs.rename(tmp, path)
    } catch (error) {
      this.removeQuietly(tmp)
      throw error
    }
    this.fs.fsyncDir(this.journalDir)
  }

  private list(dir: string): string[] {
    return this.fs.lstat(dir)?.kind === "directory" ? this.fs.readdir(dir) : []
  }

  private removeQuietly(path: string): void {
    try {
      if (this.fs.lstat(path)) this.fs.unlink(path)
    } catch (error) {
      if (!errnoOf(error)) throw error
    }
  }
}
