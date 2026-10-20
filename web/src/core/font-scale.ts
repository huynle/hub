// Text size: one number, --font-scale on <html>, that every text size in the console is a multiple of (rem).
// Set from Settings → Appearance, a pinch on the transcript or the sessions table (two fingers, or a trackpad
// pinch, which browsers report as ctrl+wheel), and kept per device in localStorage. index.html applies the stored
// value before the first paint (it reads the same key; keep the two in step).

export const FONT_SCALE_MIN = 0.8
export const FONT_SCALE_MAX = 1.8
export const FONT_SCALE_STEP = 0.05
export const FONT_SCALE_DEFAULT = 1
export const FONT_SCALE_KEY = "hub.fontScale"

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

const clamp = (x: number) => Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, x))
const round = (x: number, step: number) => Number((Math.round(x / step) * step).toFixed(2))

/** Within 0.8–1.8, on the 0.05 grid; anything not a finite number is the default. */
export function clampScale(x: number): number {
  if (!Number.isFinite(x)) return FONT_SCALE_DEFAULT
  return round(clamp(x), FONT_SCALE_STEP)
}

export function parseScale(stored: string | null | undefined): number {
  if (!stored) return FONT_SCALE_DEFAULT
  return clampScale(Number(stored))
}

/** A two-finger pinch: the scale when it started times how far the fingers moved apart (or together). */
export function pinchScale(start: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return clampScale(start)
  return clampScale(start * (distance / startDistance))
}

/**
 * One ctrl+wheel event (a trackpad pinch): exponential in the wheel delta, so a pinch feels the same at any size.
 * Not snapped to the 0.05 grid: a trackpad sends many tiny deltas, which rounding would swallow.
 */
export function wheelScale(current: number, deltaY: number): number {
  const next = clamp((Number.isFinite(current) ? current : FONT_SCALE_DEFAULT) * Math.exp(-deltaY * 0.01))
  return Number(next.toFixed(3))
}

export const formatScale = (scale: number) => `${Math.round(scale * 100)}%`

export function readScale(storage: Store): number {
  try {
    return parseScale(storage.getItem(FONT_SCALE_KEY))
  } catch {
    return FONT_SCALE_DEFAULT
  }
}

/** Stores the scale (snapped); the default is stored as nothing. Returns the snapped scale. */
export function writeScale(storage: Store, scale: number): number {
  const value = clampScale(scale)
  try {
    if (value === FONT_SCALE_DEFAULT) storage.removeItem(FONT_SCALE_KEY)
    else storage.setItem(FONT_SCALE_KEY, String(value))
  } catch {}
  return value
}
