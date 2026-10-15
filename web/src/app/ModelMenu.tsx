// Voice and Worker model + variant menus of a session (GET/PUT /api/sessions/:id/model-prefs, models from
// GET …/models). A searchable dialog; number keys 1–9 pick the visible entries.
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { ModelCatalog, type ModelItem, type ModelSelection } from "../core/timeline-core"
import { api, errorText, getJSON, sessionPath } from "./api"
import { toast } from "./toast"
import { Dialog } from "./ui"

export interface ModelPrefs {
  prefs: { voice?: ModelSelection; worker?: ModelSelection }
  defaults: { voice?: ModelSelection; worker?: ModelSelection }
}

export type ModelKind = "voice" | "worker"

export function modelLabel(prefs: ModelPrefs | undefined, kind: ModelKind): string {
  const value = prefs?.prefs[kind] ?? prefs?.defaults[kind]
  if (!value) return "default"
  return `${value.modelID}${value.variant ? ` · ${value.variant}` : ""}`
}

export function createModels(sessionID: () => string) {
  const [prefs, setPrefs] = createSignal<ModelPrefs | undefined>()
  const [error, setError] = createSignal("")
  const [catalog, setCatalog] = createSignal<ModelCatalog | undefined>()
  const load = async () => {
    try {
      setPrefs(await getJSON<ModelPrefs>(`${sessionPath(sessionID())}/model-prefs`))
      setError("")
    } catch (e) {
      setError(errorText(e))
    }
  }
  const loadCatalog = async () => {
    if (catalog()) return catalog()!
    const { models } = await getJSON<{ models: ModelItem[] }>(`${sessionPath(sessionID())}/models`)
    const c = new ModelCatalog(models)
    setCatalog(c)
    return c
  }
  const save = async (kind: ModelKind, value: ModelSelection) => {
    try {
      setPrefs(await (await api(`${sessionPath(sessionID())}/model-prefs`, { method: "PUT", json: { [kind]: value } })).json())
      toast(`${kind === "voice" ? "Voice" : "Worker"} model applies to the next ${kind === "voice" ? "turn" : "task"}.`)
    } catch (e) {
      toast(errorText(e), "err")
    }
  }
  return { prefs, error, load, loadCatalog, save }
}

export function ModelPicker(props: { kind: ModelKind | undefined; models: ReturnType<typeof createModels>; onClose: () => void }) {
  const [query, setQuery] = createSignal("")
  const [catalog, setCatalog] = createSignal<ModelCatalog | undefined>()
  const [error, setError] = createSignal("")
  const [chosen, setChosen] = createSignal<ModelItem | undefined>()
  const open = () => props.kind !== undefined
  const current = () => (props.kind ? (props.models.prefs()?.prefs[props.kind] ?? props.models.prefs()?.defaults[props.kind]) : undefined)
  const start = () => {
    setQuery("")
    setChosen(undefined)
    setError("")
    props.models.loadCatalog().then(setCatalog, (e) => setError(errorText(e)))
  }
  const items = createMemo(() => (catalog()?.groups(query()) ?? []).flatMap((g) => g.items.map((m) => ({ ...m, group: g.providerID }))))
  const pick = (m: ModelItem) => {
    const variants = (m.variants ?? []).filter((v) => v !== "default")
    if (variants.length) return setChosen(m)
    void props.models.save(props.kind!, { providerID: m.providerID, modelID: m.modelID })
    props.onClose()
  }
  const pickVariant = (variant: string | undefined) => {
    const m = chosen()!
    void props.models.save(props.kind!, { providerID: m.providerID, modelID: m.modelID, ...(variant ? { variant } : {}) })
    props.onClose()
  }
  const onKey = (e: KeyboardEvent) => {
    if (!/^[1-9]$/.test(e.key) || (e.target instanceof HTMLInputElement && query())) return
    const i = Number(e.key) - 1
    if (chosen()) {
      const list = [undefined, ...(chosen()!.variants ?? []).filter((v) => v !== "default")]
      if (i < list.length) {
        e.preventDefault()
        pickVariant(list[i])
      }
    } else if (items()[i]) {
      e.preventDefault()
      pick(items()[i]!)
    }
  }
  createEffect(on(open, (o) => o && start()))
  return (
    <Dialog open={open()} title={`${props.kind === "voice" ? "Voice" : "Worker"} model`} onClose={props.onClose} class="picker">
      <div onKeyDown={onKey}>
        <Show
          when={!chosen()}
          fallback={
            <div class="stack">
              <p class="muted small">Variant of {chosen()!.name || chosen()!.modelID}</p>
              <ul class="picker-list" role="listbox">
                <For each={[undefined, ...(chosen()!.variants ?? []).filter((v) => v !== "default")]}>
                  {(v, i) => (
                    <li>
                      <button type="button" class="picker-opt" onClick={() => pickVariant(v)}>
                        <span>{v ?? "Default"}</span>
                        <kbd>{i() + 1}</kbd>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          }
        >
          <input type="search" class="picker-search" placeholder="Search models" aria-label="Search models" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} autofocus />
          <Show when={!error()} fallback={<p class="error small">Couldn't load models: {error()}</p>}>
            <Show when={catalog()} fallback={<p class="muted small">Loading models…</p>}>
              <ul class="picker-list" role="listbox">
                <For each={items()} fallback={<li class="muted small">No models match.</li>}>
                  {(m, i) => (
                    <li>
                      <button type="button" class="picker-opt" aria-selected={current()?.providerID === m.providerID && current()?.modelID === m.modelID} onClick={() => pick(m)}>
                        <span class="po-name">{m.name || m.modelID}</span>
                        <span class="po-id muted">{m.group}</span>
                        <Show when={current()?.providerID === m.providerID && current()?.modelID === m.modelID}>
                          <span class="po-mark">✓</span>
                        </Show>
                        <Show when={i() < 9}>
                          <kbd>{i() + 1}</kbd>
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
