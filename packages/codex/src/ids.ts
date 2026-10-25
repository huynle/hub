// Hub IDs for Codex's native IDs (decision fx04e42c point 2). A thread ID (UUIDv7) maps to the reversible
// ses_cx<32 hex> (spoke-sdk hubSessionID, namespace "cx"). Other IDs the hub sees (approval requests, items, turns,
// inbox entries) are plain IDs (protocol wire.ts ID).
import { randomBytes } from "node:crypto"
import { hubSessionID, nativeSessionID } from "../../spoke-sdk/src/index.ts"

/** The session namespace of Codex in hub session IDs. */
export const CODEX_NAMESPACE = "cx"

const PLAIN_MAX = 300

/** The hub session ID of a Codex thread. */
export const codexSessionID = (threadID: string): string => hubSessionID(CODEX_NAMESPACE, threadID)

/** The Codex thread a hub session ID stands for; undefined when it is not a Codex one. */
export const codexThreadID = (sessionID: string): string | undefined => nativeSessionID(CODEX_NAMESPACE, sessionID)

/** `raw` as a plain hub ID (letters, digits and _.:@/+~- only, at most 300 characters); a fresh one when empty. */
export function plainID(raw: string, prefix = "id"): string {
  const clean = (typeof raw === "string" ? raw : "").replace(/[^A-Za-z0-9_.:@/+~-]/g, "_").slice(0, PLAIN_MAX)
  return clean || `${prefix}_${randomBytes(8).toString("hex")}`
}

/**
 * The hub's ID for an app-server request to clients (an approval): the connection's name and the JSON-RPC id, typed
 * (n: number, s: string) so 0 and "0" stay apart. JSON-RPC ids are per connection.
 */
export const requestKey = (connection: string, id: number | string): string => plainID(`per_${connection}_${typeof id === "number" ? "n" : "s"}${id}`)
