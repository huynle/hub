// /new, composer first (like Claude Code on the web): describe the task, then pick where it runs in the row
// under the composer — Environment (one of your machines), Project (a Herdr workspace folder or a known
// folder, searchable), the folder's branch, and "Open in Herdr tab". Submitting creates the session on that
// machine's background service and sends the prompt (with images) as its first turn from the session view.
// The last environment + folder are remembered per device; ?machine=&key=&dir= preselect (sidebar group "+").
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { environments, filterTargets, loadNewSessionChoice, pickEnvironment, pickTarget, saveNewSessionChoice, type EnvMachine } from "../core/environment-core"
import { createBody, newSessionTargets, type NewSessionTarget, type ViewSession } from "../core/view-core"
import type { ComposerImage } from "../lib/composer"
import { IMAGE_LIMITS, IMAGE_TYPES } from "../lib/images"
import { api, enc, errorText, getJSON, HttpError, sessionPath } from "./api"
import { imageFiles, prepareImage } from "./attach"
import { setFirstTurn } from "./first-turn"
import { hub } from "./hub"
import { isPhone, toggleSidebar } from "./layout"
import { navigate, sessionHref } from "./router"
import { toast } from "./toast"
import { Icon, IconButton, Menu, basename, type MenuEntry } from "./ui"

export function NewSession(props: { machine?: string; dir?: string; key?: string }) {
  const remembered = loadNewSessionChoice(localStorage)
  const machines = () => (hub.machines ?? []) as unknown as EnvMachine[]
  const envs = createMemo(() => environments(machines()))
  const [chosenEnv, setChosenEnv] = createSignal<string>()
  const envID = () => {
    const chosen = chosenEnv()
    return chosen && envs().some((e) => e.id === chosen && e.online) ? chosen : pickEnvironment(envs(), props.machine, remembered?.machine)
  }
  const env = () => envs().find((e) => e.id === envID())
  const machine = () => machines().find((m) => m.id === envID())

  const targets = createMemo(() => {
    const m = machine()
    if (!m) return [] as NewSessionTarget[]
    const t = newSessionTargets(m).targets
    if (props.key && props.dir && m.id === props.machine && !t.some((x) => x.key === props.key)) {
      t.push({ kind: "folder", key: props.key, label: basename(props.dir), directories: [props.dir] })
    }
    return t
  })
  const [chosenTarget, setChosenTarget] = createSignal<{ machine: string; key: string; dir: string }>()
  const place = () => {
    const chosen = chosenTarget()
    if (chosen && chosen.machine === envID() && targets().some((t) => t.key === chosen.key)) return { key: chosen.key, dir: chosen.dir }
    const linked = envID() === props.machine ? { key: props.key, dir: props.dir } : {}
    return pickTarget(targets(), linked, remembered?.machine === envID() ? remembered : undefined)
  }
  const target = () => targets().find((t) => t.key === place()?.key)
  /** A Herdr workspace without pane folders yet can use any known folder of the machine. */
  const foldersOf = (t: NewSessionTarget) => (t.directories.length ? t.directories : targets().filter((x) => x.kind === "folder").flatMap((x) => x.directories))
  const dir = () => {
    const p = place()
    const t = target()
    if (!p || !t) return ""
    return p.dir && foldersOf(t).includes(p.dir) ? p.dir : (foldersOf(t)[0] ?? "")
  }

  // The folder's branch, from the summary of the latest session in that folder (when there is one).
  const latestIn = (m: EnvMachine | undefined, folder: string): ViewSession | undefined =>
    m?.processes
      .flatMap((p) => p.sessions)
      .filter((s) => !s.parentID && s.directory === folder)
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0]
  const [branch] = createResource(
    () => {
      const s = latestIn(machine(), dir())
      return s ? s.id : undefined
    },
    async (id) => ((await getJSON<{ branch?: string }>(`${sessionPath(id)}/summary`).catch(() => ({}))) as { branch?: string }).branch,
  )

  const [herdr, setHerdr] = createSignal(true)
  const openInHerdr = () => !!env()?.herdr && target()?.kind === "herdr" && herdr()

  const [text, setText] = createSignal("")
  const [images, setImages] = createSignal<ComposerImage[]>([])
  const [attaching, setAttaching] = createSignal(false)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  let attachQueue = Promise.resolve()
  const attach = (files: File[]) => {
    attachQueue = attachQueue.then(async () => {
      setAttaching(true)
      try {
        for (const file of files) {
          try {
            const image = await prepareImage(file, images())
            setImages((list) => [...list, image])
          } catch (e) {
            setError(errorText(e))
          }
        }
      } finally {
        setAttaching(false)
      }
    })
  }
  const canSubmit = () => !busy() && !attaching() && !!env()?.canCreate && !!dir() && (!!text().trim() || images().length > 0)

  const submit = async () => {
    const m = env()
    const t = target()
    const folder = dir()
    if (!canSubmit() || !m || !t) return
    setBusy(true)
    setError("")
    try {
      const body = createBody({ target: t, directory: folder, openInHerdr: openInHerdr() })
      const res = await (await api(`/api/machines/${enc(m.id)}/sessions`, { method: "POST", json: body })).json()
      saveNewSessionChoice(localStorage, { machine: m.id, key: t.key, dir: folder })
      setFirstTurn(res.sessionID, { text: text().trim(), images: images() })
      navigate(sessionHref(res.sessionID), { replace: true })
      if (res.warning) toast(`Session created, but Herdr didn't open it: ${res.warning}`, "warn")
      else if (res.openedIn === "herdr") toast(`Opened in Herdr · ${t.label}`)
    } catch (err) {
      setError(err instanceof HttpError && err.status === 409 ? `The background service on ${m.name} isn't connected. Start it, then try again.` : `Could not create the session: ${errorText(err)}`)
      setBusy(false)
    }
  }

  const envItems = (): MenuEntry[] => [
    { section: "Choose environment" },
    ...envs().map((e) => ({
      label: e.name,
      hint: e.online ? (e.canCreate ? e.detail : `${e.detail} · no background service`) : "offline",
      checked: e.id === envID(),
      disabled: e.disabled,
      run: () => setChosenEnv(e.id),
    })),
  ]

  let area!: HTMLTextAreaElement
  let picker!: HTMLInputElement
  onMount(() => area?.focus())
  const fit = () => {
    area.style.height = "auto"
    area.style.height = `${Math.min(area.scrollHeight, 320)}px`
  }

  return (
    <div class="new-session">
      <header class="topbar">
        <Show when={isPhone()}>
          <IconButton icon="menu" label="Open sidebar" onClick={toggleSidebar} />
        </Show>
        <h1 class="title">New session</h1>
      </header>
      <div class="column narrow new-column">
        <p class="display greeting">What should we work on?</p>
        <Show when={envs().length} fallback={<p class="muted">No machine is connected to this hub yet.</p>}>
          <form
            class="composer new-composer"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
            onDragOver={(e) => [...(e.dataTransfer?.types ?? [])].includes("Files") && e.preventDefault()}
            onDrop={(e) => {
              const files = imageFiles(e.dataTransfer)
              if (!files.length) return
              e.preventDefault()
              attach(files)
            }}
          >
            <div class="composer-box">
              <Show when={images().length || attaching()}>
                <ul class="attachments" aria-label="Attached images">
                  <For each={images()}>
                    {(image) => (
                      <li class="attachment">
                        <img src={image.preview} alt={image.name} title={image.name} />
                        <button type="button" class="attachment-remove" aria-label={`Remove ${image.name}`} onClick={() => setImages((l) => l.filter((x) => x.id !== image.id))}>
                          <Icon name="close" />
                        </button>
                      </li>
                    )}
                  </For>
                  <Show when={attaching()}>
                    <li class="attachment busy" aria-label="Preparing image">
                      <span class="spinner small" />
                    </li>
                  </Show>
                </ul>
              </Show>
              <textarea
                ref={area}
                rows={3}
                aria-label="Describe a task or ask a question"
                placeholder="Describe a task or ask a question"
                value={text()}
                onInput={(e) => {
                  setText(e.currentTarget.value)
                  fit()
                }}
                onPaste={(e) => {
                  const files = imageFiles(e.clipboardData)
                  if (!files.length) return
                  e.preventDefault()
                  attach(files)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !(matchMedia("(max-width: 760px)").matches && "ontouchstart" in window)) {
                    e.preventDefault()
                    void submit()
                  }
                }}
              />
              <input
                ref={picker}
                type="file"
                class="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                data-testid="new-attach-input"
                accept={IMAGE_TYPES.join(",")}
                multiple
                onChange={(e) => {
                  const files = [...(e.currentTarget.files ?? [])]
                  e.currentTarget.value = ""
                  if (files.length) attach(files)
                }}
              />
              <div class="composer-actions">
                <button type="button" class="icon-btn" aria-label="Attach images" disabled={images().length >= IMAGE_LIMITS.maxImages || attaching()} onClick={() => picker.click()}>
                  <Icon name="plus" />
                </button>
                <span class="grow" />
                <button type="submit" class="send icon-send" aria-label="Start session" title="Start session" disabled={!canSubmit()}>
                  <Show when={busy()} fallback={<Icon name="send" />}>
                    <span class="spinner small" />
                  </Show>
                </button>
              </div>
            </div>
          </form>
          <div class="env-meta" role="group" aria-label="Where the session runs">
            <Menu
              label="Choose environment"
              class="meta-chip env-chip"
              align="left"
              items={envItems}
              text={
                <>
                  <Icon name="cloud" />
                  <span class={`online-dot${env()?.online ? " on" : ""}`} aria-hidden="true" />
                  <span class="chip-text">{env()?.name ?? "No environment"}</span>
                  <Icon name="down" class="chip-caret" />
                </>
              }
            />
            <FolderPicker targets={targets()} current={place()} dir={dir()} disabled={!env()} foldersOf={foldersOf} onPick={(key, d) => setChosenTarget({ machine: envID()!, key, dir: d })} />
            <Show when={branch()}>
              <span class="meta-chip readonly" title="Branch of this folder">
                <Icon name="branch" />
                <span class="chip-text mono">{branch()}</span>
              </span>
            </Show>
            <Show when={env()?.herdr && target()?.kind === "herdr"}>
              <label class="meta-chip toggle-chip" title={`Open the new session in a new tab of the Herdr workspace ${target()!.label}`}>
                <input type="checkbox" checked={herdr()} onChange={(e) => setHerdr(e.currentTarget.checked)} />
                <span class="chip-text">Open in Herdr tab</span>
              </label>
            </Show>
          </div>
          <Show when={env() && !env()!.canCreate}>
            <p class="small warn">{env()!.name} has no background service connected; start `opencode serve --service` there to create sessions.</p>
          </Show>
          <Show when={error()}>
            <p class="error" role="alert">
              {error()}
            </p>
          </Show>
        </Show>
      </div>
    </div>
  )
}

/** The Project chip: a popover with search over Herdr workspaces (with their folders) and known folders. */
function FolderPicker(props: {
  targets: NewSessionTarget[]
  current: { key: string; dir: string } | undefined
  dir: string
  disabled: boolean
  foldersOf: (t: NewSessionTarget) => string[]
  onPick: (key: string, dir: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [pos, setPos] = createSignal({ top: 0, left: 0 })
  let button!: HTMLButtonElement
  let panel: HTMLDivElement | undefined
  let search: HTMLInputElement | undefined
  const shown = () => filterTargets(props.targets, query())
  const label = () => {
    const t = props.targets.find((x) => x.key === props.current?.key)
    if (!t) return "No folder"
    return t.kind === "herdr" && props.dir ? `${t.label} · ${basename(props.dir)}` : t.label
  }
  const toggle = () => {
    const r = button.getBoundingClientRect()
    setPos({ top: r.bottom + 4, left: r.left })
    setQuery("")
    setOpen(!open())
    if (open()) queueMicrotask(() => search?.focus())
  }
  const onDoc = (e: MouseEvent) => {
    if (open() && !button.contains(e.target as Node) && !panel?.contains(e.target as Node)) setOpen(false)
  }
  const onKey = (e: KeyboardEvent) => {
    if (open() && e.key === "Escape") {
      setOpen(false)
      button.focus()
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
  const pick = (key: string, dir: string) => {
    props.onPick(key, dir)
    setOpen(false)
  }
  return (
    <>
      <button ref={button} type="button" class="meta-chip folder-chip" aria-haspopup="dialog" aria-expanded={open()} aria-label="Choose project folder" title={props.dir || "Choose a folder"} disabled={props.disabled} onClick={toggle}>
        <Icon name="folder" />
        <span class="chip-text">{label()}</span>
        <Icon name="down" class="chip-caret" />
      </button>
      <Show when={open()}>
        <Portal>
          <div ref={panel} class="menu folder-menu" role="dialog" aria-label="Choose project folder" style={{ top: `${pos().top}px`, left: `${pos().left}px` }}>
            <input
              ref={search}
              class="folder-search"
              type="search"
              placeholder="Search folders"
              aria-label="Search folders"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                const first = shown()[0]
                if (e.key === "Enter" && first) {
                  e.preventDefault()
                  pick(first.key, props.foldersOf(first)[0] ?? "")
                }
              }}
            />
            <div class="folder-list" role="listbox" aria-label="Folders">
              <Show when={shown().length} fallback={<p class="muted small pad">No folder matches.</p>}>
                <For each={shown()}>
                  {(t) => (
                    <Show
                      when={t.kind === "herdr" && props.foldersOf(t).length > 1}
                      fallback={
                        <button type="button" role="option" class="menu-item" aria-selected={props.current?.key === t.key} title={props.foldersOf(t)[0]} onClick={() => pick(t.key, props.foldersOf(t)[0] ?? "")}>
                          <span class="menu-check">{props.current?.key === t.key ? "✓" : ""}</span>
                          <span class="menu-label">{t.label}</span>
                          <span class="menu-hint">{t.kind === "herdr" ? "Herdr" : basename(props.foldersOf(t)[0] ?? "")}</span>
                        </button>
                      }
                    >
                      <div class="menu-section">{t.label} · Herdr</div>
                      <For each={props.foldersOf(t)}>
                        {(d) => (
                          <button type="button" role="option" class="menu-item" aria-selected={props.current?.key === t.key && props.dir === d} title={d} onClick={() => pick(t.key, d)}>
                            <span class="menu-check">{props.current?.key === t.key && props.dir === d ? "✓" : ""}</span>
                            <span class="menu-label">{basename(d)}</span>
                            <span class="menu-hint mono">{d}</span>
                          </button>
                        )}
                      </For>
                    </Show>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
