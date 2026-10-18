// Resizable left sidebar and right rail (desktop): per-panel bounds, fitting both against the window so the
// center column keeps CENTER_MIN, keyboard steps, pointer drags (the sidebar collapses when dragged well past its
// minimum) and per-device persistence. Pure logic (bun tests in test/web-panel-size.test.ts); storage is passed in.

/** "side" is the left sidebar (handle on its right edge), "rail" the session's Details rail (handle on its left edge). */
export type Panel = "side" | "rail"
export interface Limits {
  readonly min: number
  readonly max: number
}
export interface Widths {
  readonly side: number
  readonly rail: number
}

export const PANELS: Record<Panel, { min: number; max: number; default: number }> = {
  side: { min: 180, max: 480, default: 235 },
  rail: { min: 220, max: 640, default: 260 },
}
/** The transcript column never gets narrower than this because of the panels. */
export const CENTER_MIN = 420
/** Dragging the sidebar this far below its minimum collapses it (as ⌘B does). */
export const COLLAPSE_SLOP = 48
export const STEP = 16
export const BIG_STEP = 64
export const PANEL_WIDTHS_KEY = "hub.panels"

const clamp = (n: number, { min, max }: Limits) => Math.min(max, Math.max(min, n))

/** The width range of a panel in a window `viewport` px wide next to the other panel (`other` px, 0 when hidden). */
export function limits(panel: Panel, viewport: number, other: number): Limits {
  const { min, max } = PANELS[panel]
  return { min, max: Math.max(min, Math.min(max, Math.floor(viewport - CENTER_MIN - other))) }
}

/** The widths to show for the preferred ones: the rail gives way first, then the sidebar. */
export function fitWidths(preferred: Widths, viewport: number, visible: { side: boolean; rail: boolean }): Widths {
  const side = clamp(preferred.side, limits("side", viewport, visible.rail ? PANELS.rail.min : 0))
  const rail = clamp(preferred.rail, limits("rail", viewport, visible.side ? side : 0))
  return { side, rail }
}

/** The new width for a key on the panel's separator, or undefined for keys it does not handle. */
export function keyWidth(panel: Panel, width: number, key: string, shift: boolean, lim: Limits): number | undefined {
  const step = shift ? BIG_STEP : STEP
  // Arrows move the separator: right widens the sidebar and narrows the rail.
  const grow = panel === "side" ? "ArrowRight" : "ArrowLeft"
  const shrink = panel === "side" ? "ArrowLeft" : "ArrowRight"
  if (key === grow) return clamp(width + step, lim)
  if (key === shrink) return clamp(width - step, lim)
  if (key === "Home") return lim.min
  if (key === "End") return lim.max
  return undefined
}

/** The width after the pointer moved `dx` px from where a drag started at `start` px wide. */
export function dragWidth(panel: Panel, start: number, dx: number, lim: Limits): { width: number } | { collapse: true } {
  const raw = panel === "side" ? start + dx : start - dx
  if (panel === "side" && raw < lim.min - COLLAPSE_SLOP) return { collapse: true }
  return { width: clamp(Math.round(raw), lim) }
}

const valid = (panel: Panel, v: unknown) => {
  const { min, max, default: d } = PANELS[panel]
  return typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), { min, max }) : d
}

/** The preferred widths on this device (defaults for anything missing or broken). */
export function loadWidths(storage: Storage): Widths {
  let raw: unknown
  try {
    raw = JSON.parse(storage.getItem(PANEL_WIDTHS_KEY) ?? "null")
  } catch {
    raw = null
  }
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return { side: valid("side", o.side), rail: valid("rail", o.rail) }
}

export function saveWidth(storage: Storage, panel: Panel, width: number): void {
  try {
    storage.setItem(PANEL_WIDTHS_KEY, JSON.stringify({ ...loadWidths(storage), [panel]: valid(panel, width) }))
  } catch {
    // storage full or disabled
  }
}
