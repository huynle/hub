// Voice and Worker model + variant menus of a session (GET/PUT /api/sessions/:id/model-prefs, models from
// GET …/models). A searchable dialog over a catalog of hundreds of models: arrows + Enter, number keys 1–9
// outside the search box, a variant (effort) step with Back.
import { For, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import { initialModelPicker, modelPickerKey, modelPickerPick, modelPickerQuery, modelPickerView, modelPrefsBody, type ModelPickerState, type ModelPickerView } from "../core/model-picker-core"
import { ModelCatalog, type ModelItem, type ModelSelection } from "../core/timeline-core"
import { api, errorText, getJSON, sessionPath } from "./api"
import { toast } from "./toast"
import { Dialog } from "./ui"

export interface ModelPrefs {
  prefs: { voice?: ModelSelection; worker?: ModelSelection }
  defaults: { voice?: ModelSelection; worker?: ModelSelection }
}

export type { ModelKind } from "../core/model-picker-core"
import type { ModelKind } from "../core/model-picker-core"

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
      setPrefs(await (await api(`${sessionPath(sessionID())}/model-prefs`, { method: "PUT", json: modelPrefsBody(kind, value) })).json())
      toast(`${kind === "voice" ? "Voice" : "Worker"} model applies to the next ${kind === "voice" ? "turn" : "task"}.`)
    } catch (e) {
      toast(`Couldn't set the ${kind === "voice" ? "Voice" : "Worker"} model: ${errorText(e)}`, "err")
    }
  }
  return { prefs, error, load, loadCatalog, save }
}

export function ModelPicker(props: { kind: ModelKind | undefined; models: ReturnType<typeof createModels>; onClose: () => void }) {
  const [state, setState] = createSignal<ModelPickerState>(initialModelPicker())
  const [catalog, setCatalog] = createSignal<ModelCatalog | undefined>()
  const [error, setError] = createSignal("")
  const open = () => props.kind !== undefined
  const current = () => (props.kind ? (props.models.prefs()?.prefs[props.kind] ?? props.models.prefs()?.defaults[props.kind]) : undefined)
  const isCurrent = (m: ModelSelection) => current()?.providerID === m.providerID && current()?.modelID === m.modelID
  const start = () => {
    setState(initialModelPicker())
    setError("")
    props.models.loadCatalog().then(setCatalog, (e) => setError(errorText(e)))
  }
  const view = createMemo(() => (catalog() ? modelPickerView(catalog()!, state()) : undefined))
  const apply = (result: { state: ModelPickerState; pick?: ModelSelection }) => {
    setState(result.state)
    if (!result.pick || !props.kind) return
    const kind = props.kind
    props.onClose()
    void props.models.save(kind, result.pick)
  }
  const pick = (index: number) => catalog() && apply(modelPickerPick(catalog()!, state(), index))
  const onKey = (e: KeyboardEvent) => {
    if (!catalog() || e.altKey || e.ctrlKey || e.metaKey) return
    const result = modelPickerKey(catalog()!, state(), e.key, { inSearch: e.target instanceof HTMLInputElement })
    if (!result.handled) return
    e.preventDefault()
    apply(result)
    const dialog = e.currentTarget as HTMLElement
    queueMicrotask(() => dialog.querySelector(".picker-opt.active")?.scrollIntoView({ block: "nearest" }))
  }
  createEffect(on(open, (o) => o && start()))
  return (
    <Dialog open={open()} title={`${props.kind === "voice" ? "Voice" : "Worker"} model`} onClose={props.onClose} class="picker">
      <div onKeyDown={onKey}>
        <Show when={!error()} fallback={<p class="error small" role="alert">Couldn't load models: {error()}</p>}>
          <Show when={view()} fallback={<p class="muted small">Loading models…</p>}>
            {(v) => (
              <Show
                when={v().mode === "models" && (v() as Extract<ModelPickerView, { mode: "models" }>)}
                fallback={
                  <VariantList
                    view={v() as Extract<ModelPickerView, { mode: "variants" }>}
                    active={state().active}
                    current={current()}
                    onPick={pick}
                    onBack={() => setState((s) => ({ ...s, chosen: undefined, active: 0 }))}
                  />
                }
              >
                {(m) => (
                  <>
                    <input
                      type="search"
                      class="picker-search"
                      placeholder="Search models"
                      aria-label="Search models"
                      value={state().query}
                      onInput={(e) => setState((s) => modelPickerQuery(s, e.currentTarget.value))}
                      autofocus
                    />
                    <p class="muted small" role="status">
                      {m().total === 1 ? "1 model" : `${m().total} models`}
                      {m().more ? ` · showing ${m().rows.length}, search to narrow` : ""}
                    </p>
                    <ul class="picker-list" role="listbox" aria-label="Models">
                      <For each={m().rows} fallback={<li class="muted small">No models match.</li>}>
                        {(row, i) => (
                          <li>
                            <Show when={i() === 0 || m().rows[i() - 1]!.group !== row.group}>
                              <div class="picker-group muted small">{row.group}</div>
                            </Show>
                            <button
                              type="button"
                              class={`picker-opt${state().active === i() ? " active" : ""}`}
                              role="option"
                              aria-selected={isCurrent(row)}
                              onClick={() => pick(i())}
                            >
                              <span class="po-name">{row.name || row.modelID}</span>
                              <span class="po-id muted">{row.modelID}</span>
                              <Show when={(row.variants ?? []).some((x) => x !== "default")}>
                                <span class="po-id muted">variants ›</span>
                              </Show>
                              <Show when={isCurrent(row)}>
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
                  </>
                )}
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}

function VariantList(props: { view: Extract<ModelPickerView, { mode: "variants" }>; active: number; current: ModelSelection | undefined; onPick: (index: number) => void; onBack: () => void }) {
  let first: HTMLButtonElement | undefined
  onMount(() => first?.focus())
  const same = () => props.current?.providerID === props.view.model.providerID && props.current?.modelID === props.view.model.modelID
  return (
    <div class="stack">
      <div class="row">
        <button type="button" class="btn small" onClick={props.onBack} aria-label="Back to models">
          ‹ Back
        </button>
        <p class="muted small">Variant of {props.view.model.name || props.view.model.modelID}</p>
      </div>
      <ul class="picker-list" role="listbox" aria-label="Variants">
        <For each={props.view.rows}>
          {(v, i) => (
            <li>
              <button
                ref={(el) => i() === 0 && (first = el)}
                type="button"
                class={`picker-opt${props.active === i() ? " active" : ""}`}
                role="option"
                aria-selected={same() && props.current?.variant === v}
                onClick={() => props.onPick(i())}
              >
                <span class="po-name">{v ?? "Default"}</span>
                <Show when={same() && props.current?.variant === v}>
                  <span class="po-mark">✓</span>
                </Show>
                <kbd>{i() + 1}</kbd>
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
