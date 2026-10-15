// Small shared UI pieces: icons, status icon, popover menu, modal dialog, relative times.
import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX, splitProps } from "solid-js"
import { Portal } from "solid-js/web"
import type { SessionState } from "../core/browser-core"

export const ICONS = {
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  sidebar: ["M4 5h16v14H4z", "M9 5v14"],
  rail: ["M4 5h16v14H4z", "M15 5v14"],
  plus: ["M12 5v14", "M5 12h14"],
  file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z", "M20 20l-4-4"],
  mic: ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"],
  wave: ["M3 12h2", "M7 8v8", "M11 5v14", "M15 8v8", "M19 11v2"],
  stop: ["M7 7h10v10H7z"],
  send: ["M12 19V5", "M5 12l7-7 7 7"],
  chevron: ["M9 6l6 6-6 6"],
  down: ["M6 9l6 6 6-6"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  back: ["M15 5l-7 7 7 7"],
  settings: ["M4 7h10M18 7h2M4 17h4M12 17h8", "M16 5v4", "M10 15v4"],
  branch: ["M6 3v12", "M18 9a3 3 0 1 0 0-6a3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6a3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9"],
  server: ["M4 5h16v6H4z", "M4 13h16v6H4z", "M8 8h.01", "M8 16h.01"],
  diff: ["M12 3v6", "M9 6h6", "M9 18h6", "M5 3h14v18H5z"],
  pin: ["M12 17v5", "M8 3h8l-1 6 3 3H6l3-3z"],
  muted: ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5 11a7 7 0 0 0 14 0", "M4 4l16 16"],
  home: ["M4 11l8-7 8 7", "M6 10v10h12V10"],
  cloud: ["M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.1A4.5 4.5 0 0 0 7 18z"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
} as const

export type IconName = keyof typeof ICONS

export function Icon(props: { name: IconName; class?: string; title?: string }) {
  return (
    <svg class={`icon ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
      <For each={[...ICONS[props.name]]}>{(d) => <path d={d} />}</For>
    </svg>
  )
}

export const STATE_LABEL: Record<SessionState, string> = { idle: "Idle", working: "Running", blocked: "Needs you", error: "Error" }

export function StatusIcon(props: { state: SessionState; class?: string }) {
  return (
    <span class={`status ${props.state} ${props.class ?? ""}`} role="img" aria-label={STATE_LABEL[props.state]} title={STATE_LABEL[props.state]}>
      <Show when={props.state === "working"} fallback={<span class="status-dot" />}>
        <span class="spinner" />
      </Show>
    </span>
  )
}

export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  const [local, rest] = splitProps(props, ["icon", "label", "class"])
  return (
    <button type="button" class={`icon-btn ${local.class ?? ""}`} aria-label={local.label} title={local.label} {...rest}>
      <Icon name={local.icon} />
    </button>
  )
}

// ---------- popover menu ----------

export interface MenuItem {
  label: string
  run: () => void
  danger?: boolean
  checked?: boolean
  hint?: string
  disabled?: boolean
}

export type MenuEntry = MenuItem | { section: string } | "sep"

/** A button that opens a menu below it; Escape or a click outside closes it. Number keys 1–9 pick items. */
export function Menu(props: { label: string; icon?: IconName; class?: string; text?: JSX.Element; items: () => MenuEntry[]; align?: "left" | "right"; up?: boolean }) {
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let panel: HTMLDivElement | undefined
  const [pos, setPos] = createSignal({ top: 0, left: 0, right: 0, bottom: 0 })
  const place = () => {
    const r = button.getBoundingClientRect()
    setPos({ top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 4 })
  }
  const close = () => setOpen(false)
  const onDoc = (e: MouseEvent) => {
    if (!open()) return
    const t = e.target as Node
    if (!button.contains(t) && !panel?.contains(t)) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (!open()) return
    if (e.key === "Escape") {
      close()
      button.focus()
    } else if (/^[1-9]$/.test(e.key) && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      const items = props.items().filter((x): x is MenuItem => typeof x === "object" && "run" in x && !x.disabled)
      const item = items[Number(e.key) - 1]
      if (item) {
        e.preventDefault()
        close()
        item.run()
      }
    }
  }
  onMount(() => {
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
  })
  onCleanup(() => {
    document.removeEventListener("mousedown", onDoc)
    document.removeEventListener("keydown", onKey)
  })
  const numbered = () => {
    let n = 0
    return props.items().map((item) => ({ item, index: typeof item === "object" && "run" in item && !item.disabled ? ++n : 0 }))
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        class={props.class ?? "icon-btn"}
        aria-label={props.label}
        title={props.label}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          place()
          setOpen(!open())
        }}
      >
        {props.text ?? <Icon name={props.icon ?? "more"} />}
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panel}
            class="menu"
            role="menu"
            style={{
              ...(props.up ? { bottom: `${pos().bottom}px` } : { top: `${pos().top}px` }),
              ...(props.align === "left" ? { left: `${pos().left}px` } : { right: `${pos().right}px` }),
            }}
          >
            <For each={numbered()}>
              {({ item, index }) => {
                if (item === "sep") return <div class="menu-sep" role="separator" />
                if ("section" in item) return <div class="menu-section">{item.section}</div>
                return (
                  <button
                    type="button"
                    role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                    aria-checked={item.checked}
                    class={`menu-item${item.danger ? " danger" : ""}`}
                    disabled={item.disabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      close()
                      item.run()
                    }}
                  >
                    <span class="menu-check">{item.checked ? "✓" : ""}</span>
                    <span class="menu-label">{item.label}</span>
                    <Show when={item.hint}>
                      <span class="menu-hint">{item.hint}</span>
                    </Show>
                    <Show when={index > 0 && index < 10}>
                      <kbd class="menu-key">{index}</kbd>
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  )
}

// ---------- modal dialog ----------

export function Dialog(props: { open: boolean; title: string; onClose: () => void; children: JSX.Element; wide?: boolean; class?: string }) {
  let el: HTMLDialogElement | undefined
  createEffect(() => {
    const open = props.open
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  })
  return (
    <dialog
      ref={el}
      class={`dialog${props.wide ? " wide" : ""} ${props.class ?? ""}`}
      aria-label={props.title}
      onClose={() => props.onClose()}
      onClick={(e) => e.target === el && props.onClose()}
    >
      <Show when={props.open}>
        <div class="dialog-head">
          <h2>{props.title}</h2>
          <IconButton icon="close" label="Close" onClick={() => props.onClose()} />
        </div>
        <div class="dialog-body">{props.children}</div>
      </Show>
    </dialog>
  )
}

// ---------- time ----------

const [clock, setClock] = createSignal(Date.now())
setInterval(() => setClock(Date.now()), 30_000)
/** Reactive "now" (30 s resolution) for relative times. */
export const now = clock

export function ago(ms: number | undefined, at = clock()): string {
  if (!ms) return ""
  const s = Math.max(0, Math.round((at - ms) / 1000))
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export const basename = (dir: string | undefined) => String(dir ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir || ""
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
export const SOURCE_LABEL = { herdr: "Herdr", tui: "TUI", background: "Background" } as const
