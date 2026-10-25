// /who and /msg in the TUI: what the user typed after the slash name, and what the TUI shows back. The server side
// (src/spoke/hub-rpc.ts) talks to the hub as the TUI's current session; labels arrive sanitised from there.
import type { WhoRow } from "./spoke/hub-rpc"

/** One session in /who, as the server's hubWho RPC returns it (type only: the TUI never loads the SDK). */
export type { WhoRow }

export const MSG_USAGE = "Usage: /msg @name text (or @@role, @name.project, ses_…, @me)"

/** @name, @@role, @name.project, @me, or a session ID. */
const ADDRESS = /^(@@?[^\s@]\S*|ses_\S+)$/

/**
 * `/msg` arguments: the first word is the address, everything after the whitespace that follows it is the text,
 * word for word (spacing, quotes and new lines kept). Undefined when there are no arguments at all.
 */
export function parseMsgInput(input?: string): { to: string; text: string } | { error: string } | undefined {
  if (input === undefined || !input.trim()) return undefined
  const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(input)
  const to = match?.[1] ?? ""
  const text = match?.[2] ?? ""
  if (!ADDRESS.test(to)) return { error: `Start with the address. ${MSG_USAGE}` }
  if (!text.trim()) return { error: `What should the message say? ${MSG_USAGE}` }
  return { to, text }
}

/** `/who` arguments: nothing (everyone), a project, or a @@role. */
export function parseWhoInput(input?: string): { project?: string; role?: string } {
  const value = input?.trim() ?? ""
  if (!value) return {}
  if (value.startsWith("@@") && value.length > 2) return { role: value.slice(2) }
  return { project: value }
}

/** One line per session: name (else ID) · project · state · online/offline · roles. */
export function formatWho(rows: readonly WhoRow[]): string {
  if (!rows.length) return "No named or role-holding sessions."
  return rows
    .map((s) =>
      [s.name ? `@${s.name}` : s.sessionID, s.project ?? "", s.state ?? "", s.online ? "online" : "offline", s.roles.map((r) => `@@${r}`).join(" ")]
        .filter(Boolean)
        .join(" · "),
    )
    .join("\n")
}

/** The toast after /msg: who it reached and how ("stored" when the hub only stored it). */
export function formatSent(sent: { id: string; to: string; delivery?: string }): string {
  return `Sent to ${sent.to} (${sent.delivery ?? "stored"})`
}
