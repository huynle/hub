// The ⋯ menu of a session (sidebar rows, table rows, the session title menu).
import type { SessionRow } from "../lib/sessions"
import { changePref, setVoice, stopTree } from "./hub"
import { mutedSessions, setSessionMuted } from "./push"
import { navigate, sessionHref } from "./router"
import type { MenuEntry } from "./ui"

export function sessionMenu(r: SessionRow, { open = true }: { open?: boolean } = {}): MenuEntry[] {
  return [
    ...(open ? [{ label: "Open", run: () => navigate(sessionHref(r.id)) }] : []),
    { label: r.pinned ? "Unpin" : "Pin", run: () => changePref("pinnedSessions", r.id, !r.pinned) },
    {
      label: r.hidden ? "Unhide" : "Hide",
      run: () => changePref("hiddenSessions", r.id, !r.hidden, { message: r.hidden ? `Unhid “${r.title}”` : `Hid “${r.title}”`, undo: true }),
    },
    ...(r.running ? [{ label: "Stop", run: () => void stopTree(r.id), danger: true }] : []),
    "sep",
    { label: r.exposed ? "Turn Voice off" : "Turn Voice on", run: () => void setVoice(r.id, !r.exposed) },
    mutedSessions().has(r.id)
      ? { label: "Unmute notifications", run: () => void setSessionMuted(r.id, false) }
      : { label: "Mute notifications", run: () => void setSessionMuted(r.id, true) },
  ]
}
