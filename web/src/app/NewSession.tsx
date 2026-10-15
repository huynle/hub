// /new: start a session on a machine's background service, in a Herdr workspace or a known folder, optionally
// opening it in a new Herdr tab. ?machine=&key=&dir= preselect (the sidebar group "+").
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { createBody, newSessionTargets, type NewSessionTarget } from "../core/view-core"
import { api, enc, errorText, HttpError } from "./api"
import { hub } from "./hub"
import { isPhone, toggleSidebar } from "./layout"
import { navigate, sessionHref } from "./router"
import { toast } from "./toast"
import { IconButton, basename } from "./ui"

export function NewSession(props: { machine?: string; dir?: string; key?: string }) {
  const online = () => (hub.machines ?? []).filter((m) => m.online)
  const [machineID, setMachineID] = createSignal(props.machine ?? "")
  const machine = () => online().find((m) => m.id === machineID()) ?? online()[0]
  const targets = createMemo(() => {
    const m = machine()
    if (!m) return { herdr: false, targets: [] as NewSessionTarget[] }
    const t = newSessionTargets(m)
    if (props.key && props.dir && !t.targets.some((x) => x.key === props.key) && m.id === props.machine) {
      t.targets.push({ kind: "folder", key: props.key, label: basename(props.dir), directories: [props.dir] })
    }
    return t
  })
  const [targetKey, setTargetKey] = createSignal(props.key ?? "")
  const target = () => targets().targets.find((t) => t.key === targetKey()) ?? targets().targets[0]
  const dirs = () => {
    const t = target()
    if (!t) return []
    return t.directories.length ? t.directories : targets().targets.filter((x) => x.kind === "folder").flatMap((x) => x.directories)
  }
  const [dir, setDir] = createSignal(props.dir ?? "")
  createEffect(on(target, () => !dirs().includes(dir()) && setDir(dirs()[0] ?? "")))
  const [title, setTitle] = createSignal("")
  const [herdr, setHerdr] = createSignal(true)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const submit = async (e: Event) => {
    e.preventDefault()
    const m = machine()
    const t = target()
    if (!m || !t || !dir()) return
    setBusy(true)
    setError("")
    try {
      const body = createBody({ target: t, directory: dir(), title: title(), openInHerdr: targets().herdr && herdr() })
      const res = await (await api(`/api/machines/${enc(m.id)}/sessions`, { method: "POST", json: body })).json()
      navigate(sessionHref(res.sessionID), { replace: true })
      if (res.warning) toast(`Session created, but Herdr didn't open it: ${res.warning}`, "warn")
      else if (res.openedIn === "herdr") toast(`Opened in Herdr · ${t.label}`)
    } catch (err) {
      setError(err instanceof HttpError && err.status === 409 ? `The background service on ${m.name} isn't connected. Start it, then try again.` : `Could not create the session: ${errorText(err)}`)
      setBusy(false)
    }
  }

  return (
    <div class="new-session">
      <header class="topbar">
        <Show when={isPhone()}>
          <IconButton icon="menu" label="Open sidebar" onClick={toggleSidebar} />
        </Show>
        <h1 class="title">New session</h1>
      </header>
      <div class="column narrow">
        <p class="display greeting">What should we work on?</p>
        <Show when={online().length} fallback={<p class="muted">No machine is online to start a session on.</p>}>
          <form class="card stack" onSubmit={submit} novalidate>
            <Show when={online().length > 1}>
              <div class="field">
                <label for="new-machine">Server</label>
                <select id="new-machine" value={machine()?.id} onChange={(e) => (setMachineID(e.currentTarget.value), setTargetKey(""))}>
                  <For each={online()}>{(m) => <option value={m.id}>{m.name}</option>}</For>
                </select>
              </div>
            </Show>
            <div class="field">
              <label for="new-target">Workspace</label>
              <select id="new-target" value={target()?.key} onChange={(e) => setTargetKey(e.currentTarget.value)}>
                <Show when={targets().targets.some((t) => t.kind === "herdr")}>
                  <optgroup label="Herdr workspaces">
                    <For each={targets().targets.filter((t) => t.kind === "herdr")}>{(t) => <option value={t.key}>{t.label}</option>}</For>
                  </optgroup>
                </Show>
                <optgroup label="Folders">
                  <For each={targets().targets.filter((t) => t.kind === "folder")}>{(t) => <option value={t.key}>{t.label}</option>}</For>
                </optgroup>
              </select>
            </div>
            <Show when={dirs().length > 1} fallback={<p class="small muted mono">{dirs()[0] ?? (target() ? "No known folder for this workspace yet." : "")}</p>}>
              <div class="field">
                <label for="new-dir">Folder</label>
                <select id="new-dir" value={dir()} onChange={(e) => setDir(e.currentTarget.value)}>
                  <For each={dirs()}>{(d) => <option value={d}>{d}</option>}</For>
                </select>
              </div>
            </Show>
            <div class="field">
              <label for="new-title">Title</label>
              <input id="new-title" type="text" maxlength="200" placeholder="Optional" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
            </div>
            <Show when={targets().herdr}>
              <label class="switch">
                <span>
                  Open in Herdr
                  <span class="small muted"> {target()?.kind === "herdr" ? `· a new tab in ${target()!.label}` : "· pick a Herdr workspace"}</span>
                </span>
                <input type="checkbox" disabled={target()?.kind !== "herdr"} checked={target()?.kind === "herdr" && herdr()} onChange={(e) => setHerdr(e.currentTarget.checked)} />
              </label>
            </Show>
            <Show when={error()}>
              <p class="error" role="alert">
                {error()}
              </p>
            </Show>
            <div class="row">
              <button type="submit" class="btn primary" disabled={busy() || !dir()}>
                Create session
              </button>
              <a class="btn" href="/">
                Cancel
              </a>
            </div>
          </form>
        </Show>
      </div>
    </div>
  )
}
