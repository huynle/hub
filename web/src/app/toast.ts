// One toast at a time (bottom center), with an optional action button.
import { createSignal } from "solid-js"

export interface Toast {
  id: number
  text: string
  kind: "" | "err" | "warn"
  action?: { label: string; run: () => void }
}

const [current, setCurrent] = createSignal<Toast | undefined>()
export const currentToast = current
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined

export function toast(text: string, kind: Toast["kind"] = "", action?: Toast["action"]): void {
  const id = ++seq
  setCurrent({ id, text, kind, action })
  clearTimeout(timer)
  timer = setTimeout(() => current()?.id === id && setCurrent(undefined), action || kind ? 8000 : 4000)
}

export const dismissToast = () => setCurrent(undefined)
