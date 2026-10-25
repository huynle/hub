// OpenCode keeps pending permission requests per location (the directory a session runs in), and the
// plugin's ctx.permission only sees its own location. One plugin instance per location joins the
// process (see singleton.ts), but only the first runs the spoke. So a reply has to go through the
// instance of the location that holds the request.
import type { PermissionDecision } from "../protocol"

/** ctx.permission of one plugin instance, with its location's directory. */
export interface PermissionLocation {
  readonly directory: string
  get(input: { sessionID: string; requestID: string }): Promise<unknown>
  /** `message`: a reject's reason (OpenCode's reply message). */
  reply(input: { sessionID: string; requestID: string; decision: PermissionDecision; message?: string }): Promise<unknown>
}

/**
 * Replies to a pending permission through the location that holds it (the session's directory first).
 * "gone" when no location has it pending (already answered, expired, or asked in another process).
 */
export async function replyPermission(
  locations: readonly PermissionLocation[],
  input: { sessionID: string; requestID: string; decision: PermissionDecision; message?: string },
  directory?: string,
): Promise<"replied" | "gone"> {
  const ordered = [...locations.filter((l) => l.directory === directory), ...locations.filter((l) => l.directory !== directory)]
  for (const location of ordered) {
    try {
      await location.get({ sessionID: input.sessionID, requestID: input.requestID })
    } catch {
      continue // not pending in this location
    }
    await location.reply(input)
    return "replied"
  }
  return "gone"
}
