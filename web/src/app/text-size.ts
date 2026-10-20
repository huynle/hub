// Text size for this device (core/font-scale): the --font-scale variable on <html>, Settings → Appearance, and
// pinch-to-zoom on the transcript and the sessions list.
//
// A pinch inside `.scroller` (the session transcript) or `.home-scroll` (the sessions table/list) changes the text
// size instead of zooming the page; everywhere else the browser's own zoom is left alone, as are ⌘+/⌘−.
// Inputs: two-finger touch (pointer events; `touch-action: pan-x pan-y` in styles.css keeps the browser from
// taking the pinch), a trackpad pinch (ctrl+wheel in Chromium and Firefox, gesture events in Safari).
import { createSignal } from "solid-js"
import { FONT_SCALE_DEFAULT, clampScale, pinchScale, readScale, wheelScale, writeScale } from "../core/font-scale"

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage)

const [scale, setScaleSignal] = createSignal(storage() ? readScale(storage()!) : FONT_SCALE_DEFAULT)
export const textScale = scale

function apply(value: number): void {
  document.documentElement.style.setProperty("--font-scale", String(value))
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
/** Sets the text size now; it is stored (snapped to the 0.05 grid) once changes settle. */
export function setTextScale(value: number, options: { settle?: boolean } = {}): void {
  const next = options.settle === false ? value : clampScale(value)
  setScaleSignal(next)
  apply(next)
  clearTimeout(saveTimer)
  const save = () => {
    const s = storage()
    if (!s) return
    const snapped = writeScale(s, next)
    if (snapped !== scale()) {
      setScaleSignal(snapped)
      apply(snapped)
    }
  }
  if (options.settle === false) saveTimer = setTimeout(save, 250)
  else save()
}

const PINCH_AREAS = ".scroller, .home-scroll"
const inArea = (target: EventTarget | null) => target instanceof Element && target.closest(PINCH_AREAS) !== null

/** Installs the pinch handlers on the document; returns their removal. */
export function installPinchZoom(doc: Document = document): () => void {
  apply(scale())
  const touches = new Map<number, { x: number; y: number }>()
  let start: { scale: number; distance: number } | undefined
  const distance = () => {
    const [a, b] = [...touches.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  const down = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !inArea(e.target)) return
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (touches.size === 2) start = { scale: scale(), distance: distance() }
  }
  const move = (e: PointerEvent) => {
    if (!touches.has(e.pointerId)) return
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (start && touches.size === 2) {
      const next = pinchScale(start.scale, start.distance, distance())
      if (next !== scale()) setTextScale(next, { settle: false })
    }
  }
  const up = (e: PointerEvent) => {
    if (!touches.delete(e.pointerId)) return
    if (touches.size < 2 && start) {
      start = undefined
      setTextScale(scale())
    }
  }
  // iOS Safari zooms the page on a two-finger touchmove unless it is cancelled (touch-action is not enough there).
  const touchMove = (e: TouchEvent) => {
    if (e.touches.length >= 2 && inArea(e.target)) e.preventDefault()
  }
  const wheel = (e: WheelEvent) => {
    if (!e.ctrlKey || !inArea(e.target)) return
    e.preventDefault()
    setTextScale(wheelScale(scale(), e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY), { settle: false })
  }
  // Safari (macOS trackpad, iOS): gesturestart/change with a cumulative `scale`.
  let gestureStart: number | undefined
  const gesture = (e: Event & { scale?: number }) => {
    if (!inArea(e.target)) return
    e.preventDefault()
    if (e.type === "gesturestart") gestureStart = scale()
    else if (e.type === "gesturechange" && gestureStart !== undefined && e.scale) setTextScale(pinchScale(gestureStart, 1, e.scale), { settle: false })
    else if (e.type === "gestureend") {
      gestureStart = undefined
      setTextScale(scale())
    }
  }
  const listeners: Array<[string, EventListener, AddEventListenerOptions]> = [
    ["pointerdown", down as EventListener, { capture: true, passive: true }],
    ["pointermove", move as EventListener, { capture: true, passive: true }],
    ["pointerup", up as EventListener, { capture: true, passive: true }],
    ["pointercancel", up as EventListener, { capture: true, passive: true }],
    ["touchmove", touchMove as EventListener, { capture: true, passive: false }],
    ["wheel", wheel as EventListener, { capture: true, passive: false }],
    ["gesturestart", gesture as EventListener, { capture: true, passive: false }],
    ["gesturechange", gesture as EventListener, { capture: true, passive: false }],
    ["gestureend", gesture as EventListener, { capture: true, passive: false }],
  ]
  for (const [type, fn, opts] of listeners) doc.addEventListener(type, fn, opts)
  return () => {
    for (const [type, fn, opts] of listeners) doc.removeEventListener(type, fn, opts)
  }
}
