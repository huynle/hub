// StateStore in files under <stateDir>/agent/ (the single-process hub's durable agent data; a cluster uses
// Postgres). One JSON file per user and collection (users/<user>/<collection>.json) and one per claim namespace
// (claims/<namespace>.json), loaded on first use and then served from memory. Changed files are written once
// `debounceMs` after the first change, or at once by flush() (the hub flushes on stop).
// Files are written atomically (temp file + rename) with mode 0600, folders 0700. Ids and names become path
// segments only when they are short lowercase [a-z0-9_-] (case-insensitive file systems), otherwise their
// SHA-256; each file repeats the ids it belongs to, so a file is never read for the wrong one. Hubs from before
// this store ignore the folder.
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { realTimers } from "./memory-bus"
import type { Claim, ClaimResult, Clock, Data, Entry, StateStore, Timers, Versioned, WriteOptions, WriteResult } from "./types"

/** The folder under the state directory. */
export const AGENT_STATE_DIR = "agent"
/** Default delay between a change and its write. */
export const FILE_STATE_DEBOUNCE_MS = 250

export interface FileStateStoreOptions {
  /** The hub's state directory; data goes to <stateDir>/agent/. */
  readonly stateDir: string
  readonly now?: Clock
  /** Timers for the debounced writes (default real, unref'd timers). */
  readonly timers?: Timers
  /** Delay between a change and its write (default FILE_STATE_DEBOUNCE_MS). */
  readonly debounceMs?: number
  /** Reports a failed debounced write (default console.warn); the change is kept for the next write. */
  readonly warn?: (message: string) => void
}

interface Stored {
  value: Data
  version: number
}

interface StoredClaim {
  owner: string
  at: number
}

/** A loaded file: the ids it belongs to and its items by key. */
interface Doc<T> {
  readonly file: string
  readonly ids: Readonly<Record<string, string>>
  readonly items: Map<string, T>
}

const SAFE_SEGMENT = /^[a-z0-9_-]{1,64}$/

/** A file-system-safe, case-insensitive-safe path segment for an id or name. */
const segment = (name: string): string => (SAFE_SEGMENT.test(name) ? name : `~${createHash("sha256").update(name).digest("hex")}`)

export class FileStateStore implements StateStore {
  private readonly now: Clock
  private readonly root: string
  private readonly timers: Timers
  private readonly debounceMs: number
  private readonly warn: (message: string) => void
  /** The pending debounced write. */
  private timer: unknown
  /** file → loaded document. */
  private readonly docs = new Map<string, Doc<unknown>>()
  private readonly dirty = new Set<Doc<unknown>>()
  /** Folders already created and restricted. */
  private readonly folders = new Set<string>()

  constructor(options: FileStateStoreOptions) {
    this.now = options.now ?? Date.now
    this.root = path.join(options.stateDir, AGENT_STATE_DIR)
    this.timers = options.timers ?? realTimers
    this.debounceMs = options.debounceMs ?? FILE_STATE_DEBOUNCE_MS
    this.warn = options.warn ?? console.warn
  }

  async get<T = Data>(userID: string, collection: string, key: string): Promise<Versioned<T> | undefined> {
    const stored = this.entries(userID, collection).items.get(key)
    return stored && { value: structuredClone(stored.value) as T, version: stored.version }
  }

  async put<T = Data>(userID: string, collection: string, key: string, value: T, options: WriteOptions = {}): Promise<WriteResult> {
    const doc = this.entries(userID, collection)
    const current = doc.items.get(key)?.version ?? 0
    if (options.ifVersion !== undefined && options.ifVersion !== current) return { ok: false, version: current }
    const version = current + 1
    doc.items.set(key, { value: structuredClone(value), version })
    this.changed(doc)
    return { ok: true, version }
  }

  async delete(userID: string, collection: string, key: string, options: WriteOptions = {}): Promise<WriteResult> {
    const doc = this.entries(userID, collection)
    const current = doc.items.get(key)?.version ?? 0
    if (options.ifVersion !== undefined && options.ifVersion !== current) return { ok: false, version: current }
    if (doc.items.delete(key)) this.changed(doc)
    return { ok: true, version: 0 }
  }

  async list<T = Data>(userID: string, collection: string): Promise<Entry<T>[]> {
    return [...this.entries(userID, collection).items.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, stored]) => ({ key, value: structuredClone(stored.value) as T, version: stored.version }))
  }

  async claim(namespace: string, key: string, owner: string): Promise<ClaimResult> {
    const doc = this.claims(namespace)
    const held = doc.items.get(key)
    if (held) return held.owner === owner ? { ok: true, claim: { namespace, key, ...held } } : { ok: false, conflict: { namespace, key, ...held } }
    const claim: Claim = { namespace, key, owner, at: this.now() }
    doc.items.set(key, { owner, at: claim.at })
    this.changed(doc)
    return { ok: true, claim }
  }

  async release(namespace: string, key: string, owner: string): Promise<boolean> {
    const doc = this.claims(namespace)
    if (doc.items.get(key)?.owner !== owner) return false
    doc.items.delete(key)
    this.changed(doc)
    return true
  }

  async claimOf(namespace: string, key: string): Promise<Claim | undefined> {
    const held = this.claims(namespace).items.get(key)
    return held && { namespace, key, ...held }
  }

  /** Writes every changed file now (rejects when one cannot be written; it stays changed). */
  async flush(): Promise<void> {
    this.writeChanged()
  }

  private writeChanged(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
    for (const doc of [...this.dirty]) {
      this.write(doc)
      this.dirty.delete(doc)
    }
  }

  private entries(userID: string, collection: string): Doc<Stored> {
    const file = path.join(this.root, "users", segment(userID), `${segment(collection)}.json`)
    return this.doc<Stored>(file, { userID, collection }, (item) => {
      const { value, version } = item
      if (!Number.isSafeInteger(version) || (version as number) < 1) return undefined
      return { value, version: version as number }
    })
  }

  private claims(namespace: string): Doc<StoredClaim> {
    const file = path.join(this.root, "claims", `${segment(namespace)}.json`)
    return this.doc<StoredClaim>(file, { namespace }, (item) => {
      const { owner, at } = item
      if (typeof owner !== "string" || typeof at !== "number") return undefined
      return { owner, at }
    })
  }

  /** The loaded document for a file, reading it on first use. */
  private doc<T>(file: string, ids: Record<string, string>, parse: (item: Record<string, unknown>) => T | undefined): Doc<T> {
    const loaded = this.docs.get(file) as Doc<T> | undefined
    if (loaded) {
      for (const [name, id] of Object.entries(ids)) if (loaded.ids[name] !== id) throw new Error(`${file} belongs to another ${name}`)
      return loaded
    }
    const doc: Doc<T> = { file, ids, items: read(file, ids, parse) }
    this.docs.set(file, doc as Doc<unknown>)
    return doc
  }

  private changed(doc: Doc<unknown>): void {
    this.dirty.add(doc)
    if (this.timer !== undefined) return
    this.timer = this.timers.set(() => {
      this.timer = undefined
      try {
        this.writeChanged()
      } catch (cause) {
        this.warn(`[hub] cannot write agent state under ${this.root}: ${(cause as Error).message}; retrying on the next change`)
      }
    }, this.debounceMs)
  }

  private write(doc: Doc<unknown>): void {
    if (doc.items.size === 0) {
      rmSync(doc.file, { force: true })
      return
    }
    this.folder(path.dirname(doc.file))
    const items = [...doc.items.entries()].map(([key, item]) => ({ key, ...(item as object) }))
    const tmp = `${doc.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ ...doc.ids, items })}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, doc.file)
  }

  /** Creates a folder under the root (and the root) restricted to the owner. */
  private folder(dir: string): void {
    if (this.folders.has(dir)) return
    if (dir !== this.root) this.folder(path.dirname(dir))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    this.folders.add(dir)
  }
}

/** A file's items, or none when it does not exist; throws (naming the file, never its content) when invalid. */
function read<T>(file: string, ids: Record<string, string>, parse: (item: Record<string, unknown>) => T | undefined): Map<string, T> {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return new Map()
    throw cause
  }
  const fail = (why: string): never => {
    throw new Error(`Invalid ${file}: ${why}. Fix or move it away.`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail("not valid JSON")
  }
  if (typeof raw !== "object" || raw === null) return fail("not an object")
  const record = raw as Record<string, unknown>
  for (const [name, id] of Object.entries(ids)) if (record[name] !== id) fail(`${name} does not match`)
  if (!Array.isArray(record.items)) return fail("no items")
  const items = new Map<string, T>()
  for (const entry of record.items as unknown[]) {
    if (typeof entry !== "object" || entry === null) return fail("an item is not an object")
    const { key, ...rest } = entry as Record<string, unknown>
    if (typeof key !== "string") return fail("an item has no key")
    const item = parse(rest)
    if (item === undefined) return fail("an item is malformed")
    items.set(key, item)
  }
  return items
}
