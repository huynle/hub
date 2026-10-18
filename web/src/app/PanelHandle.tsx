// The drag handle on the sidebar's right edge and the rail's left edge (desktop only): a focusable vertical
// separator. Drag (pointer capture, rAF-throttled), Arrow keys (16px, Shift 64px), Home/End (min/max), double-click
// (default width). Dragging the sidebar well past its minimum collapses it, as ⌘B does.
import { onCleanup, onMount } from "solid-js"
import { PANELS, dragWidth, keyWidth, type Panel } from "../core/panel-size"
import { panelLimits, resizing, setPanelWidth, setRailShown, setResizing, setSidebarCollapsed, shownWidths } from "./layout"

export function PanelHandle(props: { panel: Panel; label: string }) {
  let start = 0
  let startX = 0
  let frame = 0
  let pending: number | undefined
  const width = () => shownWidths()[props.panel]
  const lim = () => panelLimits(props.panel)
  const apply = () => {
    frame = 0
    if (pending !== undefined) setPanelWidth(props.panel, pending, false)
  }
  const stop = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    pending = undefined
    setResizing(undefined)
    document.documentElement.classList.remove("resizing")
  }
  const finish = (el: HTMLElement, pointer: number, width: number) => {
    if (el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer)
    stop()
    setPanelWidth(props.panel, width)
  }
  onMount(() => props.panel === "rail" && setRailShown(true))
  onCleanup(() => {
    if (props.panel === "rail") setRailShown(false)
    if (resizing() === props.panel) stop()
  })
  return (
    <div
      class={`panel-handle${resizing() === props.panel ? " dragging" : ""}`}
      data-panel={props.panel}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={width()}
      aria-valuemin={lim().min}
      aria-valuemax={lim().max}
      tabindex="0"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start = width()
        startX = e.clientX
        setResizing(props.panel)
        document.documentElement.classList.add("resizing")
      }}
      onPointerMove={(e) => {
        if (resizing() !== props.panel) return
        const next = dragWidth(props.panel, start, e.clientX - startX, lim())
        if ("collapse" in next) {
          // The sidebar keeps its width from before the drag: expanding it again restores that.
          finish(e.currentTarget, e.pointerId, start)
          setSidebarCollapsed(true)
          return
        }
        pending = next.width
        if (!frame) frame = requestAnimationFrame(apply)
      }}
      onPointerUp={(e) => resizing() === props.panel && finish(e.currentTarget, e.pointerId, pending ?? width())}
      onPointerCancel={(e) => resizing() === props.panel && finish(e.currentTarget, e.pointerId, pending ?? width())}
      onDblClick={() => setPanelWidth(props.panel, PANELS[props.panel].default)}
      onKeyDown={(e) => {
        const next = keyWidth(props.panel, width(), e.key, e.shiftKey, lim())
        if (next === undefined) return
        e.preventDefault()
        setPanelWidth(props.panel, next)
      }}
    />
  )
}
