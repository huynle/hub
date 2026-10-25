// Hub IDs for Claude Code's native IDs (decision fx04e42c point 2). A session's UUID maps to the reversible
// ses_cc<32 hex> (spoke-sdk hubSessionID, namespace "cc"); a subagent (SubagentStart's agent_id inside a session)
// gets a child session of its own, stable for (session, agent). Other IDs the hub sees (tool calls, requests) are
// plain IDs (protocol wire.ts ID).
import { createHash, randomBytes } from "node:crypto"
import { MAX_NATIVE_BYTES, hubSessionID } from "../../spoke-sdk/src/index.ts"

/** The session namespace of Claude Code in hub session IDs. */
export const CLAUDE_NAMESPACE = "cc"

const PLAIN_MAX = 300

/** The hub session ID of a Claude Code session. */
export const claudeSessionID = (sessionID: string): string => hubSessionID(CLAUDE_NAMESPACE, sessionID)

/** The hub session ID of a subagent of a Claude Code session: `<session>/<agent>`, hashed when that is too long. */
export function childSessionID(sessionID: string, agentID: string): string {
  const native = `${sessionID.toLowerCase()}/${agentID}`
  if (Buffer.byteLength(native, "utf8") <= MAX_NATIVE_BYTES) return hubSessionID(CLAUDE_NAMESPACE, native)
  return hubSessionID(CLAUDE_NAMESPACE, `${sessionID.toLowerCase()}/#${createHash("sha256").update(agentID).digest("hex").slice(0, 32)}`)
}

/** `raw` as a plain hub ID (letters, digits and _.:@/+~- only, at most 300 characters); a fresh one when empty. */
export function plainID(raw: string, prefix = "id"): string {
  const clean = (typeof raw === "string" ? raw : "").replace(/[^A-Za-z0-9_.:@/+~-]/g, "_").slice(0, PLAIN_MAX)
  return clean || `${prefix}_${randomBytes(8).toString("hex")}`
}
