// Per-user agent control plane data stored on UserRecord.agent in state.json: session names, roles, session
// records and app/agent tokens (hashes only). Storage only: validation, normalisation and merging. Unknown
// fields (on the object and on each entry) are kept, so data written by a newer hub survives this one.
// It lives inside `users`, which older hubs persist as-is, so a downgrade keeps it.

/** `@name` → session. Unique per user by name. */
export interface AgentName {
  name: string
  sessionID: string
  [field: string]: unknown
}

/** `@@role` holder. Unique per user by (role, sessionID). */
export interface AgentRole {
  role: string
  sessionID: string
  [field: string]: unknown
}

/** A session the control plane knows about. Unique per user by sessionID. */
export interface AgentSession {
  sessionID: string
  machineID?: string
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
  [field: string]: unknown
}

type Entry = Record<string, unknown>

/** Each list: the string fields an entry needs, and its identity (entries with the same one are duplicates). */
const LISTS: Record<"names" | "roles" | "sessions" | "appTokens", { required: readonly string[]; identity: (e: Entry) => string }> = {
  names: { required: ["name", "sessionID"], identity: (e) => e.name as string },
  roles: { required: ["role", "sessionID"], identity: (e) => `${e.role}\u0000${e.sessionID}` },
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

/**
 * Agent data from a stored or updated value: undefined when it is not an object; a known list that is not an
 * array is dropped; invalid and duplicate entries are dropped. Idempotent; key order is kept.
 */
export function normaliseAgentData(value: unknown): AgentData | undefined {
  if (!isPlain(value)) return undefined
  const out: Entry = {}
  for (const [key, item] of Object.entries(value)) {
    if (!isList(key)) out[key] = item
    else if (Array.isArray(item)) out[key] = normaliseList(key, item)
  }
  return out as AgentData
}

/** `into` plus what `from` adds: list entries with a new identity, other fields `into` lacks. */
export function mergeAgentData(into: AgentData, from: AgentData): AgentData {
  const out: Entry = { ...into }
  for (const [key, item] of Object.entries(from)) {
    if (isList(key) && Array.isArray(item)) {
      const have = Array.isArray(out[key]) ? (out[key] as Entry[]) : []
      out[key] = normaliseList(key, [...have, ...item])
    } else if (!(key in out)) out[key] = item
  }
  return out as AgentData
}

/** A stored token epoch: a non-negative safe integer, else absent (read as 0). */
export const validEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
