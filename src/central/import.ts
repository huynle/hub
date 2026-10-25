// `hub-server import --state <dir>` (design §10, decision vkxkqiuf): moves a single-process hub's state into the
// shared StateStore a cluster reads (Postgres), idempotently.
//
// - state.json is read through the Store's own load/upgrade code (Store.read: older formats are upgraded, nothing is
//   written back) and stored as the rows Store.shared reads (stateRows in ./store-shared: records, settings, audit,
//   token-hash and email index rows). Token hashes are copied, so machines and devices need no re-enrolment.
// - agent/** (the FileStateStore: per-user collections and claim namespaces) becomes the same rows and claims.
// - token-keys.json is never stored: the report names its key ids, and tokenKeysMaterial() returns it as the
//   HUB_TOKEN_KEYS Secret value for the operator (`--print-token-keys`).
// Every row is inserted with ifVersion 0. A row already there is left alone: unchanged when equal (JSON with keys in
// any order: Postgres jsonb reorders them), a conflict otherwise, overwritten only with `force`. A dry run reads the
// target and counts, but writes nothing. The source directory is only read; stop the single-process hub first, so
// its files are complete.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { AGENT_STATE_DIR, FileStateStore } from "./backend/file-state"
import type { StateStore } from "./backend/types"
import { HUB_ROWS, Store, type AuditEntry } from "./store"
import { nextAuditKey, stateRows } from "./store-shared"
import { TOKEN_KEYS_ENV, TOKEN_KEYS_FILE, TokenKeys } from "./token-keys"

export interface ImportOptions {
  /** The single-process hub's state directory (state.json, agent/, token-keys.json). */
  readonly stateDir: string
  /** Where the rows go (Postgres in a cluster). */
  readonly state: StateStore
  /** Count only; write nothing. */
  readonly dryRun?: boolean
  /** Overwrite rows (and claims) that exist with different contents. */
  readonly force?: boolean
  /**
   * The clock of the state.json upgrade (default: state.json's modification time, so records the upgrade adds, like
   * the local owner, come out the same on every run).
   */
  readonly now?: () => number
}

/** Per collection: rows read from the source and what happened to them (in a dry run: would happen). */
export interface CollectionCounts {
  rows: number
  /** Not there yet: written. */
  created: number
  /** Already there with the same contents. */
  unchanged: number
  /** Already there with other contents (skipped unless forced). */
  conflicts: number
  /** Conflicts written over (force). */
  overwritten: number
  failed: number
}

export interface ImportReport {
  readonly stateDir: string
  readonly dryRun: boolean
  readonly force: boolean
  /** Whether state.json was there. */
  readonly stateFile: boolean
  /** Agent StateStore files read (collections and claim namespaces). */
  readonly agentFiles: number
  /** By collection: the Store's ("users", …), agent ones as "agent:<collection>", claims as "claims:<namespace>". */
  readonly collections: Record<string, CollectionCounts>
  /** The rows that differ: "<collection> <user>/<key>". */
  readonly conflicts: string[]
  /** Rows that could not be written, with the reason (never a value). */
  readonly failures: { readonly row: string; readonly error: string }[]
  readonly failed: number
  /** The signing keys found (ids only), or undefined without token-keys.json. */
  readonly tokenKeys?: { readonly active: string; readonly kids: string[] }
}

/** One row (or claim) to import. */
interface Item {
  readonly collection: string
  readonly label: string
  /** What the target holds: absent, equal or different (with what to compare-and-set against). */
  inspect(): Promise<{ readonly state: "absent" } | { readonly state: "same" } | { readonly state: "differs"; readonly version: number; readonly owner?: string }>
  /** Inserts it; false when someone else wrote it meanwhile. */
  create(): Promise<boolean>
  /** Writes it over the differing row seen by inspect; false when it changed meanwhile. */
  overwrite(seen: { readonly version: number; readonly owner?: string }): Promise<boolean>
}

/** Imports the state directory into `options.state`; see the file comment. */
export async function importState(options: ImportOptions): Promise<ImportReport> {
  const { stateDir, state: target } = options
  const dryRun = options.dryRun === true
  const force = options.force === true
  const agentRoot = path.join(stateDir, AGENT_STATE_DIR)
  const stateFile = existsSync(path.join(stateDir, "state.json"))
  if (!stateFile && !existsSync(agentRoot)) throw new Error(`No hub state in ${stateDir} (neither state.json nor ${AGENT_STATE_DIR}/)`)

  const items: Item[] = []
  // Store rows: state.json upgraded by the Store's own code, mapped by the shared Store's own row layout.
  const stateMtime = stateFile ? Math.floor(statSync(path.join(stateDir, "state.json")).mtimeMs) : 0
  const data = Store.read(stateDir, options.now ?? (() => stateMtime))
  if (data) {
    const keys = auditKeys(data.audit)
    for (const row of stateRows(data, (entry) => keys.get(entry)!)) items.push(rowItem(target, row.collection, HUB_ROWS, row.collection, row.key, row.value))
  }
  // Agent rows and claims, read through the FileStateStore (it checks each file belongs to its ids).
  const source = new FileStateStore({ stateDir })
  const files = agentFiles(agentRoot)
  for (const { userID, collection } of files.collections) {
    for (const entry of await source.list(userID, collection)) items.push(rowItem(target, `agent:${collection}`, userID, collection, entry.key, entry.value))
  }
  for (const { namespace, keys } of files.claims) {
    for (const key of keys) {
      const claim = await source.claimOf(namespace, key)
      if (claim) items.push(claimItem(target, namespace, key, claim.owner))
    }
  }

  const collections: Record<string, CollectionCounts> = {}
  const conflicts: string[] = []
  const failures: { row: string; error: string }[] = []
  for (const item of items) {
    const counts = (collections[item.collection] ??= { rows: 0, created: 0, unchanged: 0, conflicts: 0, overwritten: 0, failed: 0 })
    counts.rows++
    try {
      const seen = await item.inspect()
      if (seen.state === "same") counts.unchanged++
      else if (seen.state === "absent") {
        if (dryRun || (await item.create())) counts.created++
        else {
          counts.failed++
          failures.push({ row: item.label, error: "written by someone else during the import" })
        }
      } else {
        counts.conflicts++
        conflicts.push(item.label)
        if (!force) continue
        if (dryRun || (await item.overwrite(seen))) counts.overwritten++
        else {
          counts.failed++
          failures.push({ row: item.label, error: "changed by someone else during the import" })
        }
      }
    } catch (error) {
      counts.failed++
      failures.push({ row: item.label, error: (error as Error)?.message ?? String(error) })
    }
  }

  const keys = readTokenKeys(stateDir)
  return {
    stateDir,
    dryRun,
    force,
    stateFile,
    agentFiles: files.collections.length + files.claims.length,
    collections,
    conflicts,
    failures,
    failed: failures.length,
    ...(keys ? { tokenKeys: { active: keys.active, kids: keys.kids } } : {}),
  }
}

/**
 * The signing keys of the state directory as the HUB_TOKEN_KEYS Secret value (one JSON line), validated; undefined
 * without token-keys.json. Secret material: print it only when asked, never log or store it.
 */
export function tokenKeysMaterial(stateDir: string): string | undefined {
  return readTokenKeys(stateDir)?.material
}

function readTokenKeys(stateDir: string): { material: string; active: string; kids: string[] } | undefined {
  const file = path.join(stateDir, TOKEN_KEYS_FILE)
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, "utf8")
  // Validated by TokenKeys itself (given as the override, so it never touches the file); errors name no secret.
  const keys = TokenKeys.open(stateDir, { env: { [TOKEN_KEYS_ENV]: text } })
  let kids: string[]
  try {
    kids = keys.kids()
  } catch (error) {
    throw new Error(((error as Error).message ?? "").replace(TOKEN_KEYS_ENV, file))
  }
  return { material: JSON.stringify(JSON.parse(text)), active: keys.toJSON().active, kids }
}

/**
 * Stable row keys for the audit entries (in order): the shared Store's key layout, with a suffix derived from the
 * entry and its position instead of a random one, so a second import finds the same rows.
 */
function auditKeys(audit: readonly AuditEntry[]): Map<AuditEntry, string> {
  const keys = new Map<AuditEntry, string>()
  let last: string | undefined
  audit.forEach((entry, index) => {
    const suffix = createHash("sha256").update(`${index}\n${JSON.stringify(entry)}`).digest("hex").slice(0, 8)
    last = nextAuditKey(last, entry.at, suffix)
    keys.set(entry, last)
  })
  return keys
}

/** The agent StateStore files: per-user collections and claim namespaces, from the ids each file repeats. */
function agentFiles(root: string): { collections: { userID: string; collection: string }[]; claims: { namespace: string; keys: string[] }[] } {
  const collections: { userID: string; collection: string }[] = []
  const claims: { namespace: string; keys: string[] }[] = []
  const json = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => path.join(dir, name)) : [])
  const users = path.join(root, "users")
  const userDirs = existsSync(users) ? readdirSync(users, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []
  for (const dir of userDirs) {
    for (const file of json(path.join(users, dir))) {
      const { userID, collection } = header(file)
      if (typeof userID !== "string" || typeof collection !== "string") throw new Error(`Invalid ${file}: no userID or collection. Fix or move it away.`)
      collections.push({ userID, collection })
    }
  }
  for (const file of json(path.join(root, "claims"))) {
    const { namespace, items } = header(file)
    if (typeof namespace !== "string" || !Array.isArray(items)) throw new Error(`Invalid ${file}: no namespace or items. Fix or move it away.`)
    claims.push({ namespace, keys: items.map((item) => (item as { key?: unknown })?.key).filter((key): key is string => typeof key === "string") })
  }
  return { collections, claims }
}

function header(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>
  } catch {
    // Reported below without the content.
  }
  throw new Error(`Invalid ${file}: not a JSON object. Fix or move it away.`)
}

function rowItem(target: StateStore, label: string, userID: string, collection: string, key: string, value: unknown): Item {
  return {
    collection: label,
    label: `${label} ${userID}/${key}`,
    async inspect() {
      const current = await target.get(userID, collection, key)
      if (!current) return { state: "absent" }
      return canonical(current.value) === canonical(value) ? { state: "same" } : { state: "differs", version: current.version }
    },
    async create() {
      return (await target.put(userID, collection, key, value, { ifVersion: 0 })).ok
    },
    async overwrite(seen) {
      return (await target.put(userID, collection, key, value, { ifVersion: seen.version })).ok
    },
  }
}

function claimItem(target: StateStore, namespace: string, key: string, owner: string): Item {
  return {
    collection: `claims:${namespace}`,
    label: `claims:${namespace} ${key}`,
    async inspect() {
      const current = await target.claimOf(namespace, key)
      if (!current) return { state: "absent" }
      return current.owner === owner ? { state: "same" } : { state: "differs", version: 0, owner: current.owner }
    },
    async create() {
      return (await target.claim(namespace, key, owner)).ok
    },
    async overwrite(seen) {
      if (!(await target.release(namespace, key, seen.owner!))) return false
      return (await target.claim(namespace, key, owner)).ok
    },
  }
}

/** JSON with object keys sorted (Postgres jsonb does not keep their order). */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value ?? null))))
}

/** The report as lines for the terminal (no secrets: key ids only). */
export function formatImportReport(report: ImportReport): string[] {
  const lines = [
    `Import from ${report.stateDir}${report.dryRun ? " (dry run: nothing written)" : ""}${report.force ? " with --force" : ""}`,
    `  state.json: ${report.stateFile ? "read" : "none"}; agent files: ${report.agentFiles}`,
  ]
  const columns = ["rows", "new", "same", "conflict", "overwritten", "failed"] as const
  const names = Object.keys(report.collections)
  const width = Math.max(10, ...names.map((name) => name.length))
  const row = (name: string, cells: readonly (string | number)[]) => `  ${name.padEnd(width)}  ${cells.map((cell) => String(cell).padStart(12)).join("")}`
  lines.push(row("collection", columns))
  const totals = [0, 0, 0, 0, 0, 0]
  for (const name of names) {
    const c = report.collections[name]!
    const cells = [c.rows, c.created, c.unchanged, c.conflicts, c.overwritten, c.failed]
    cells.forEach((n, i) => (totals[i]! += n))
    lines.push(row(name, cells))
  }
  lines.push(row("total", totals))
  if (report.conflicts.length) {
    lines.push(`Conflicts (rows already there with other contents; ${report.force ? "overwritten" : "skipped, rerun with --force to overwrite"}):`)
    for (const conflict of report.conflicts) lines.push(`  ${conflict}`)
  }
  if (report.failures.length) {
    lines.push("Failed:")
    for (const failure of report.failures) lines.push(`  ${failure.row}: ${failure.error}`)
  }
  if (report.tokenKeys) {
    lines.push(
      `Signing keys (token-keys.json): ${report.tokenKeys.kids.join(", ")} (active ${report.tokenKeys.active}); not stored. Put them in the HUB_TOKEN_KEYS Secret so signed-in sessions stay valid: rerun with --print-token-keys to print the value.`,
    )
  } else {
    lines.push("Signing keys: no token-keys.json; set a new HUB_TOKEN_KEYS (browsers and apps sign in again; machines and devices keep their tokens).")
  }
  return lines
}
