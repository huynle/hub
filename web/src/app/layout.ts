// Viewport and layout state shared by the shell (phone breakpoint, sidebar collapsed, rail open, panel widths).
import { createSignal } from "solid-js"
import { fitWidths, limits, loadWidths, saveWidth, type Limits, type Panel, type Widths } from "../core/panel-size"

const query = window.matchMedia("(max-width: 760px)")
const [phone, setPhone] = createSignal(query.matches)
query.addEventListener("change", () => {
  setPhone(query.matches)
  setRailOpenRaw(!query.matches && localStorage.getItem(RAIL) !== "0")
})
export const isPhone = phone

const COLLAPSED = "hub.sidebar.collapsed"
const RAIL = "hub.rail.open"
export const [sidebarCollapsed, setSidebarCollapsedRaw] = createSignal(localStorage.getItem(COLLAPSED) === "1")
export const [drawerOpen, setDrawerOpen] = createSignal(false)
/** The right rail: remembered on desktop; on phones a bottom sheet that starts closed. */
export const [railOpen, setRailOpenRaw] = createSignal(!query.matches && localStorage.getItem(RAIL) !== "0")

export function setSidebarCollapsed(on: boolean): void {
  setSidebarCollapsedRaw(on)
  localStorage.setItem(COLLAPSED, on ? "1" : "0")
}
export function setRailOpen(on: boolean): void {
  setRailOpenRaw(on)
  if (!phone()) localStorage.setItem(RAIL, on ? "1" : "0")
}
/** ⌘B / the sidebar button: collapse on desktop, drawer on phones. */
export function toggleSidebar(): void {
  if (phone()) setDrawerOpen(!drawerOpen())
  else setSidebarCollapsed(!sidebarCollapsed())
}

// Resizable sidebar and rail (desktop). The preferred widths are remembered per device; the shown ones are fitted
// to the window (center column ≥ CENTER_MIN) and re-fitted when it resizes. See web/src/core/panel-size.ts.
const [viewport, setViewport] = createSignal(window.innerWidth)
window.addEventListener("resize", () => setViewport(window.innerWidth))
const [preferred, setPreferred] = createSignal(loadWidths(localStorage))
/** The rail's separator is mounted (a session with Details open on desktop). */
export const [railShown, setRailShown] = createSignal(false)
/** The panel being dragged, if any. */
export const [resizing, setResizing] = createSignal<Panel | undefined>()

export const shownWidths = (): Widths => fitWidths(preferred(), viewport(), { side: !sidebarCollapsed() && !phone(), rail: railShown() })
export function panelLimits(panel: Panel): Limits {
  const shown = shownWidths()
  const other = panel === "side" ? (railShown() ? shown.rail : 0) : !sidebarCollapsed() && !phone() ? shown.side : 0
  return limits(panel, viewport(), other)
}
/** Sets a panel's preferred width (during a drag without `persist`, saved on release). */
export function setPanelWidth(panel: Panel, width: number, persist = true): void {
  setPreferred((w) => ({ ...w, [panel]: width }))
  if (persist) saveWidth(localStorage, panel, width)
}
