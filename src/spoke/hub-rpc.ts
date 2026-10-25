// The TUI's /who and /msg, server side (RPC hubWho and hubMsg, registered in src/index.ts): the hub's agent API as
// the TUI's CURRENT session, through the shared SDK with that session's own token (Spoke.shellIdentity), the same
// identity the hub tool uses (src/spoke/hub-tool.ts). The token is only sent to the hub; it never appears in a
// result or an error (redacted should the hub echo it). Labels are sanitised here, so the TUI shows them as is.
import { HubClient, HubError, HubTransportError, type AgentMessage, type DirectoryEntry } from "../../packages/sdk/src/index.ts"
import { sanitizeLabel } from "../central/agent/envelope"
import type { HubToolSpoke } from "./hub-tool"

/** The RPC error a failure answers with (src/rpc.ts lists them). */
export type HubRpcErrorCode = "invalid" | "not_connected" | "unsupported" | "unreachable" | "server_error"

export class HubRpcError extends Error {
  constructor(
    readonly code: HubRpcErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** One session in /who (labels sanitised; roles by bare name). */
export interface WhoRow {
  readonly sessionID: string
  readonly name?: string
  readonly project?: string
  readonly state?: string
  readonly online: boolean
  readonly roles: string[]
}

export interface MsgResult {
  readonly id: string
  /** Who it reached: @name, a session ID, or "the user". */
  readonly to: string
  readonly delivery?: string
}

/** An RPC call waits at most this long for the hub. */
const TIMEOUT_MS = 15_000

type Input = Record<string, unknown>

const inputOf = (value: unknown): Input => (value && typeof value === "object" ? (value as Input) : {})
const optStr = (input: Input, key: string) => (typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string).trim() : undefined)

/** /msg: sends `text` word for word to `to` as session `sessionID`. */
export async function hubMsg(spoke: HubToolSpoke, value: unknown): Promise<MsgResult> {
  const input = inputOf(value)
  const sessionID = optStr(input, "sessionID")
  if (!sessionID) throw new HubRpcError("invalid", "Open a session first: /msg sends as the current session.")
  const to = optStr(input, "to")
  if (!to) throw new HubRpcError("invalid", "Who should get it? Usage: /msg @name text")
  const text = input.text
  if (typeof text !== "string" || !text.trim()) throw new HubRpcError("invalid", "What should the message say? Usage: /msg @name text")
  return withClient(spoke, sessionID, "messaging", async (client, signal) => {
    const { message, delivery } = await client.msg(to, text, { signal })
    return { id: message.id, to: recipientText(message), ...(delivery ? { delivery } : {}) }
  })
}

/** /who: the named and role-holding sessions (optionally one project or one role), as session `sessionID`. */
export async function hubWho(spoke: HubToolSpoke, value: unknown): Promise<{ sessions: WhoRow[] }> {
  const input = inputOf(value)
  const sessionID = optStr(input, "sessionID")
  if (!sessionID) throw new HubRpcError("invalid", "Open a session first: /who asks the hub as the current session.")
  const project = optStr(input, "project")
  const role = optStr(input, "role")
  return withClient(spoke, sessionID, undefined, async (client, signal) => {
    const { sessions } = await client.who({ ...(project ? { project } : {}), ...(role ? { role } : {}), signal })
    return { sessions: sessions.map(whoRow) }
  })
}

/** Runs `action` with a client holding the session's token; every failure becomes a HubRpcError without the token. */
async function withClient<T>(
  spoke: HubToolSpoke,
  sessionID: string,
  feature: string | undefined,
  action: (client: HubClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const identity = spoke.shellIdentity(sessionID)
  if (!identity) throw new HubRpcError("not_connected", "This session has no hub token yet: share it with the hub (/hub) and wait until it is connected.")
  if (!identity.url) throw new HubRpcError("not_connected", "The hub's URL is not known yet; try again shortly.")
  if (feature && !spoke.hubSupports(feature)) throw new HubRpcError("unsupported", `The hub this machine is connected to does not support ${feature}; it needs a newer hub.`)
  const scrub = (text: string) => (identity.token ? text.split(identity.token).join("[redacted]") : text)
  try {
    return await action(new HubClient({ url: identity.url, token: identity.token }), AbortSignal.timeout(TIMEOUT_MS))
  } catch (cause) {
    if (cause instanceof HubError) {
      throw new HubRpcError("server_error", scrub(`${cause.message} (${cause.code})${cause.hint ? `. Hint: ${cause.hint}` : ""}`))
    }
    if (cause instanceof HubTransportError) throw new HubRpcError("unreachable", scrub(cause.message))
    throw new HubRpcError("server_error", scrub(cause instanceof Error ? cause.message : String(cause)))
  }
}

function whoRow(entry: DirectoryEntry): WhoRow {
  const name = entry.name ? sanitizeLabel(entry.name) : ""
  const project = entry.project ? sanitizeLabel(entry.project) : ""
  const state = entry.state ? sanitizeLabel(entry.state) : ""
  return {
    sessionID: sanitizeLabel(entry.sessionID),
    ...(name ? { name } : {}),
    ...(project ? { project } : {}),
    ...(state ? { state } : {}),
    online: entry.online === true,
    roles: (entry.roles ?? []).map((r) => sanitizeLabel(r.role)).filter(Boolean),
  }
}

function recipientText(message: AgentMessage): string {
  const r = message.recipient
  if (r?.kind === "session") return r.name ? `@${sanitizeLabel(r.name)}` : sanitizeLabel(r.sessionID)
  if (r?.kind === "user") return "the user"
  return sanitizeLabel(message.to)
}
