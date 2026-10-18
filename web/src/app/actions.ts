// The ⋯ menu of a session (sidebar rows, table rows, the session title menu), and inline renaming.
import { createSignal } from "solid-js"
import type { SessionRow } from "../lib/sessions"
import { changePref, setVoice, stopTree } from "./hub"
import { mutedSessions, setSessionMuted } from "./push"
import { navigate, sessionHref } from "./router"
import type { MenuEntry } from "./ui"

/** Where a session title is shown; the inline rename field opens in that place only. */
export type RenamePlace = "table" | "phone" | "sidebar" | "topbar"

/** The session title being renamed inline, and where (one at a time). */
export const [renaming, setRenaming] = createSignal<{ readonly id: string; readonly place: RenamePlace }>()
export const isRenaming = (id: string, place: RenamePlace) => renaming()?.id === id && renaming()?.place === place

export function sessionMenu(r: SessionRow, { open = true, place }: { open?: boolean; place?: RenamePlace } = {}): MenuEntry[] {
  return [
    ...(open ? [{ label: "Open", run: () => navigate(sessionHref(r.id)) }] : []),
    ...(place ? [{ label: "Rename…", run: () => setRenaming({ id: r.id, place }) }] : []),
    { label: r.pinned ? "Unpin" : "Pin", run: () => changePref("pinnedSessions", r.id, !r.pinned) },
    {
      label: r.hidden ? "Unhide" : "Hide",
      run: () => changePref("hiddenSessions", r.id, !r.hidden, { message: r.hidden ? `Unhid “${r.title}”` : `Hid “${r.title}”`, undo: true }),
    },
    ...(r.running ? [{ label: "Stop", run: () => void stopTree(r.id), danger: true }] : []),
    "sep",
    { label: r.exposed ? "Disallow Voice" : "Allow Voice", run: () => void setVoice(r.id, !r.exposed) },
    mutedSessions().has(r.id)
      ? { label: "Unmute notifications", run: () => void setSessionMuted(r.id, false) }
      : { label: "Mute notifications", run: () => void setSessionMuted(r.id, true) },
  ]
}
