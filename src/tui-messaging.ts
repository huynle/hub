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

/** What /who and /msg need from the TUI (src/tui.ts): the current session, the RPC calls and the UI. */
export interface MessagingDeps {
  /** The session the TUI shows; undefined on the home screen. */
  sessionID(): string | undefined
  who(input: { sessionID: string; project?: string; role?: string }): Promise<{ sessions: WhoRow[] }>
  msg(input: { sessionID: string; to: string; text: string }): Promise<{ id: string; to: string; delivery?: string }>
  prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | null | undefined>
  alert(options: { title: string; message: string }): Promise<unknown>
  toast(message: string, variant?: "info" | "success" | "warning" | "error"): unknown
}

const NO_SESSION = (what: string) => `Open a session first: ${what} acts as the current session.`

/**
 * /msg: sends as the current session. Without arguments (palette, bare /msg) it asks for "@name text"; RPC failures
 * are thrown (the command registry shows them as a toast).
 */
export async function runMsg(deps: MessagingDeps, input?: string): Promise<void> {
  const sessionID = deps.sessionID()
  if (!sessionID) return void deps.toast(NO_SESSION("/msg"), "warning")
  let parsed = parseMsgInput(input)
  if (!parsed) {
    const typed = await deps.prompt({ title: "Message a session", description: `Sent as this session. ${MSG_USAGE}`, placeholder: "@name text" })
    if (typeof typed !== "string") return
    parsed = parseMsgInput(typed)
    if (!parsed) return
  }
  if ("error" in parsed) return void deps.toast(parsed.error, "error")
  const sent = await deps.msg({ sessionID, to: parsed.to, text: parsed.text })
  deps.toast(formatSent(sent), "success")
}

/** /who [project | @@role]: the hub's named and role-holding sessions in a dialog, asked as the current session. */
export async function runWho(deps: MessagingDeps, input?: string): Promise<void> {
  const sessionID = deps.sessionID()
  if (!sessionID) return void deps.toast(NO_SESSION("/who"), "warning")
  const filter = parseWhoInput(input)
  const { sessions } = await deps.who({ sessionID, ...filter })
  if (!sessions.length) return void deps.toast(formatWho(sessions), "info")
  const scope = filter.role ? ` · @@${filter.role}` : filter.project ? ` · ${filter.project}` : ""
  await deps.alert({ title: `Hub · who${scope}`, message: formatWho(sessions) })
}
