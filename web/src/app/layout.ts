// Viewport and layout state shared by the shell (phone breakpoint, sidebar collapsed, rail open).
import { createSignal } from "solid-js"

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
