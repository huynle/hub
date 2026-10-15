// Pure logic of the Voice/Worker model menu (no DOM): the rows for a search over a big catalog (bounded, with
// a "more" count), the variant (effort) step, keyboard handling and the PUT /api/sessions/:id/model-prefs body.
import { stepActive } from "./picker-core"
import type { ModelCatalog, ModelItem, ModelSelection } from "./timeline-core"

export type ModelKind = "voice" | "worker"

export interface ModelPickerState {
  readonly query: string
  /** Highlighted row (arrow keys, Enter). */
  readonly active: number
  /** The model whose variant is being chosen. */
  readonly chosen?: ModelItem
}

export type ModelPickerView =
  | { mode: "models"; rows: Array<ModelItem & { group: string }>; total: number; more: number }
  | { mode: "variants"; model: ModelItem; rows: Array<string | undefined> }

/** Rows rendered at most; the rest are reached by searching. */
export const MODEL_ROWS_MAX = 100

export const initialModelPicker = (): ModelPickerState => ({ query: "", active: 0 })

/** Default (no variant) first, then the model's variants ("default" is the same as Default). */
export const variantRows = (model: ModelItem): Array<string | undefined> => [undefined, ...(model.variants ?? []).filter((v) => v !== "default")]

export function modelPickerView(catalog: ModelCatalog, state: ModelPickerState, limit = MODEL_ROWS_MAX): ModelPickerView {
  if (state.chosen) return { mode: "variants", model: state.chosen, rows: variantRows(state.chosen) }
  const all = catalog.groups(state.query).flatMap((g) => g.items.map((m) => ({ ...m, group: g.providerID })))
  return { mode: "models", rows: all.slice(0, limit), total: all.length, more: Math.max(0, all.length - limit) }
}

export const modelPickerQuery = (state: ModelPickerState, query: string): ModelPickerState => ({ ...state, query, active: 0 })

const selection = (model: ModelItem, variant?: string): ModelSelection => ({ providerID: model.providerID, modelID: model.modelID, ...(variant ? { variant } : {}) })

/** Picks row `index`: a model without variants (or a variant) gives the selection; a model with variants opens its variant step. */
export function modelPickerPick(catalog: ModelCatalog, state: ModelPickerState, index: number): { state: ModelPickerState; pick?: ModelSelection } {
  const view = modelPickerView(catalog, state)
  if (view.mode === "variants") {
    if (index < 0 || index >= view.rows.length) return { state }
    return { state, pick: selection(view.model, view.rows[index]) }
  }
  const model = view.rows[index]
  if (!model) return { state }
  if (variantRows(model).length > 1) return { state: { ...state, chosen: model, active: 0 } }
  return { state, pick: selection(model) }
}

/**
 * A key in the menu. Arrows move, Enter picks the highlighted row; number keys 1–9 pick a visible row, but
 * not while typing in the search box (they are text there); Backspace in the variant step goes back.
 */
export function modelPickerKey(
  catalog: ModelCatalog,
  state: ModelPickerState,
  key: string,
  { inSearch }: { inSearch: boolean },
): { state: ModelPickerState; pick?: ModelSelection; handled: boolean } {
  const view = modelPickerView(catalog, state)
  const count = view.rows.length
  if (key === "ArrowDown" || key === "ArrowUp") return { state: { ...state, active: Math.max(0, stepActive(state.active, key === "ArrowDown" ? 1 : -1, count)) }, handled: true }
  if (key === "Enter") return { ...modelPickerPick(catalog, state, state.active), handled: true }
  if (key === "Backspace" && state.chosen && !inSearch) return { state: { ...state, chosen: undefined, active: 0 }, handled: true }
  if (/^[1-9]$/.test(key) && !inSearch) {
    const index = Number(key) - 1
    if (index >= count) return { state, handled: false }
    return { ...modelPickerPick(catalog, state, index), handled: true }
  }
  return { state, handled: false }
}

/** PUT /api/sessions/:id/model-prefs body for one kind (`null`: back to the default). */
export const modelPrefsBody = (kind: ModelKind, value: ModelSelection | null): { voice?: ModelSelection | null; worker?: ModelSelection | null } => ({ [kind]: value })
