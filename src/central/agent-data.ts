// Per-user agent control plane data stored on UserRecord.agent in state.json: session names, roles, session
// records and app/agent tokens (hashes only). Storage only: validation, normalisation and merging. Unknown
// fields (on the object and on each entry) are kept, so data written by a newer hub survives this one.
// It lives inside `users`, which older hubs persist as-is, so a downgrade keeps it.
// Lifecycle rules (release, alias expiry, offline role loss) are evaluated lazily by agent/directory.ts.
import { withSuffix } from "./agent/names"

/** `@name` → session. Unique per user by name (current names and aliases share one namespace). */
export interface AgentName {
  name: string
  sessionID: string
  /** When it was set (ms). */
  created?: number
  /** Set on an alias (the name before a rename): it is released at this time (ms). */
  expiresAt?: number
  [field: string]: unknown
}

/** `@@role` holder. Unique per user by (role, project, sessionID). */
export interface AgentRole {
  role: string
  sessionID: string
  /** Project scope (`role.project`); absent for an unscoped claim. */
  project?: string
  /** Holder generation: every new holder of (role, project) gets the next one. */
  generation?: number
  /** Claimed with --exclusive: nobody else may hold (role, project) while this holder is live. */
  exclusive?: boolean
  claimedAt?: number
  [field: string]: unknown
}

/** A session the control plane knows about. Unique per user by sessionID. */
export interface AgentSession {
  sessionID: string
  machineID?: string
  parentID?: string
  /** Project name (lowercased) used by `.project` scopes. */
  project?: string
  title?: string
  firstSeen?: number
  /** Last time a spoke reported it (ms; persisted at minute granularity while it stays online). */
  lastSeen?: number
  /** When the hub saw it archived (the console's Archive, viewPrefs.hiddenSessions). */
  archivedAt?: number
  deletedAt?: number
  /** Name derivation already happened (derived once, from the first non-placeholder title). */
  named?: boolean
  [field: string]: unknown
}

/** A user-created app/agent token: only the sha256 hash is stored. Unique per user by id. */
export interface AppToken {
  id: string
  tokenHash: string
  label?: string
  scopes?: string[]
  created?: number
  [field: string]: unknown
}

export interface AgentData {
  names?: AgentName[]
  roles?: AgentRole[]
  sessions?: AgentSession[]
  appTokens?: AppToken[]
  /** Last holder generation handed out per roleKey(role, project). */
  generations?: Record<string, number>
  [field: string]: unknown
}

/** Key of a role and its project scope (for generations and exclusivity). */
export const roleKey = (role: string, project?: string): string => `${role}\u0000${project ?? ""}`

type Entry = Record<string, unknown>

/** Each list: the string fields an entry needs, and its identity (entries with the same one are duplicates). */
const LISTS: Record<"names" | "roles" | "sessions" | "appTokens", { required: readonly string[]; identity: (e: Entry) => string }> = {
  names: { required: ["name", "sessionID"], identity: (e) => e.name as string },
  roles: { required: ["role", "sessionID"], identity: (e) => `${roleKey(e.role as string, typeof e.project === "string" ? e.project : undefined)}\u0000${e.sessionID}` },
  sessions: { required: ["sessionID"], identity: (e) => e.sessionID as string },
  appTokens: { required: ["id", "tokenHash"], identity: (e) => e.id as string },
}

const isPlain = (v: unknown): v is Entry => typeof v === "object" && v !== null && !Array.isArray(v)
const isList = (key: string): key is keyof typeof LISTS => Object.hasOwn(LISTS, key)

/** Valid entries of a list, first of each identity kept. */
function normaliseList(key: keyof typeof LISTS, value: readonly unknown[]): Entry[] {
  const { required, identity } = LISTS[key]
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const entry of value) {
    if (!isPlain(entry) || !required.every((field) => typeof entry[field] === "string" && entry[field] !== "")) continue
    const id = identity(entry)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(entry)
  }
  return out
}

/** Generation counters: non-negative safe integers only. */
function normaliseGenerations(value: Entry): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, n] of Object.entries(value)) if (validEpoch(n)) out[key] = n
  return out
}

/**
 * Agent data from a stored or updated value: undefined when it is not an object; a known list that is not an
 * array is dropped; invalid and duplicate entries are dropped. Idempotent; key order is kept.
 */
export function normaliseAgentData(value: unknown): AgentData | undefined {
  if (!isPlain(value)) return undefined
  const out: Entry = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === "generations") {
      if (isPlain(item)) out[key] = normaliseGenerations(item)
    } else if (!isList(key)) out[key] = item
    else if (Array.isArray(item)) out[key] = normaliseList(key, item)
  }
  return out as AgentData
}

/** `from`'s names after `have`: a name `have` holds for another session gets a suffix (-2, -3, …). */
function mergeNames(have: Entry[], from: readonly unknown[]): Entry[] {
  const out = normaliseList("names", have)
  const owner = new Map(out.map((e) => [e.name as string, e.sessionID as string]))
  for (const entry of normaliseList("names", from)) {
    const held = owner.get(entry.name as string)
    if (held === entry.sessionID) continue
    const name = held === undefined ? (entry.name as string) : withSuffix(entry.name as string, (n) => owner.has(n))
    owner.set(name, entry.sessionID as string)
    out.push({ ...entry, name })
  }
  return out
}

/**
 * `into` plus what `from` adds: list entries with a new identity, other fields `into` lacks. A name of
 * `from` that `into` holds for a different session is kept with a suffix; generations take the higher counter.
 */
export function mergeAgentData(into: AgentData, from: AgentData): AgentData {
  const out: Entry = { ...into }
  for (const [key, item] of Object.entries(from)) {
    if (key === "names" && Array.isArray(item)) {
      out[key] = mergeNames(Array.isArray(out[key]) ? (out[key] as Entry[]) : [], item)
    } else if (key === "generations" && isPlain(item)) {
      const merged = normaliseGenerations(isPlain(out[key]) ? (out[key] as Entry) : {})
      for (const [k, n] of Object.entries(normaliseGenerations(item))) merged[k] = Math.max(merged[k] ?? 0, n)
      out[key] = merged
    } else if (isList(key) && Array.isArray(item)) {
      const have = Array.isArray(out[key]) ? (out[key] as Entry[]) : []
      out[key] = normaliseList(key, [...have, ...item])
    } else if (!(key in out)) out[key] = item
  }
  return out as AgentData
}

/** A stored token epoch: a non-negative safe integer, else absent (read as 0). */
export const validEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
