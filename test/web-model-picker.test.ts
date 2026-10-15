// Voice/Worker model menu logic (web/src/core/model-picker-core.ts): a big catalog (hundreds of models across
// providers), search, keyboard (arrows + Enter; number keys only outside the search box), variants (effort),
// and the PUT /model-prefs body.
import { describe, expect, test } from "bun:test"
import { ModelCatalog, type ModelItem } from "../web/src/core/timeline-core"
import { initialModelPicker, modelPickerKey, modelPickerPick, modelPickerQuery, modelPickerView, modelPrefsBody, type ModelPickerState } from "../web/src/core/model-picker-core"

/** ~300 models: a gateway with hundreds, plus a few native providers; some with variants. */
function bigCatalog(): ModelItem[] {
  const out: ModelItem[] = []
  for (let i = 0; i < 280; i++) out.push({ providerID: "omniroute", modelID: `vendor${i % 7}/model-${i}`, name: `Model ${i}`, enabled: true, variants: i % 10 === 0 ? ["low", "high"] : [] })
  out.push({ providerID: "omniroute", modelID: "claude-opus-5-5", name: "Claude Opus 5.5", enabled: true, variants: ["default", "high", "max"] })
  out.push({ providerID: "openai", modelID: "gpt-6-sol", name: "GPT-6 Sol", enabled: true, variants: ["none", "low", "high"] })
  out.push({ providerID: "anthropic", modelID: "claude-haiku-5-5", name: "Claude Haiku 5.5", enabled: true, variants: [] })
  out.push({ providerID: "anthropic", modelID: "claude-old", name: "Claude Old", enabled: false, variants: [] })
  return out
}

const view = (state: ModelPickerState, catalog = new ModelCatalog(bigCatalog())) => modelPickerView(catalog, state)

describe("modelPickerView", () => {
  test("a big catalog renders a bounded number of rows and says how many more match", () => {
    const v = view(initialModelPicker())
    expect(v.mode).toBe("models")
    if (v.mode !== "models") return
    expect(v.total).toBe(283)
    expect(v.rows.length).toBe(100)
    expect(v.more).toBe(183)
    expect(v.rows[0]!.group).toBe("anthropic")
  })

  test("search narrows by name, id or provider, case-insensitively", () => {
    const v = view({ ...initialModelPicker(), query: "OPUS" })
    expect(v.mode === "models" && v.rows.map((r) => r.modelID)).toEqual(["claude-opus-5-5"])
    const byProvider = view({ ...initialModelPicker(), query: "openai" })
    expect(byProvider.mode === "models" && byProvider.rows.map((r) => r.modelID)).toEqual(["gpt-6-sol"])
  })

  test("a catalog where every model reports disabled still lists them (nothing hidden)", () => {
    const catalog = new ModelCatalog([{ providerID: "p", modelID: "a", enabled: false }, { providerID: "p", modelID: "b", enabled: false }])
    const v = modelPickerView(catalog, initialModelPicker())
    expect(v.mode === "models" && v.rows.map((r) => r.modelID)).toEqual(["a", "b"])
  })

  test("after picking a model with variants: Default first, then its variants (\"default\" not repeated)", () => {
    const catalog = new ModelCatalog(bigCatalog())
    const { state } = modelPickerPick(catalog, { ...initialModelPicker(), query: "opus" }, 0)
    const v = modelPickerView(catalog, state)
    expect(v).toEqual({ mode: "variants", model: expect.objectContaining({ modelID: "claude-opus-5-5" }), rows: [undefined, "high", "max"] })
  })
})

describe("modelPickerPick and keys", () => {
  const catalog = new ModelCatalog(bigCatalog())

  test("a model without variants is picked at once with the PUT selection", () => {
    const r = modelPickerPick(catalog, { ...initialModelPicker(), query: "haiku" }, 0)
    expect(r.pick).toEqual({ providerID: "anthropic", modelID: "claude-haiku-5-5" })
  })

  test("a variant pick carries the variant; Default carries none", () => {
    const chosen = modelPickerPick(catalog, { ...initialModelPicker(), query: "gpt-6" }, 0).state
    expect(modelPickerPick(catalog, chosen, 2).pick).toEqual({ providerID: "openai", modelID: "gpt-6-sol", variant: "low" })
    expect(modelPickerPick(catalog, chosen, 0).pick).toEqual({ providerID: "openai", modelID: "gpt-6-sol" })
  })

  test("arrows move the active row (wrapping) and Enter picks it", () => {
    let state: ModelPickerState = { ...initialModelPicker(), query: "claude" }
    state = modelPickerKey(catalog, state, "ArrowDown", { inSearch: true }).state
    expect(state.active).toBe(1)
    state = modelPickerKey(catalog, state, "ArrowUp", { inSearch: true }).state
    state = modelPickerKey(catalog, state, "ArrowUp", { inSearch: true }).state
    expect(state.active).toBe(1)
    // Row 1 is Claude Opus (with variants): Enter opens its variant step, then arrows + Enter pick a variant.
    const enter = modelPickerKey(catalog, state, "Enter", { inSearch: true })
    expect(enter.handled).toBe(true)
    expect(enter.pick).toBeUndefined()
    expect(enter.state.chosen?.modelID).toBe("claude-opus-5-5")
    const down = modelPickerKey(catalog, enter.state, "ArrowDown", { inSearch: false })
    expect(modelPickerKey(catalog, down.state, "Enter", { inSearch: false }).pick).toEqual({ providerID: "omniroute", modelID: "claude-opus-5-5", variant: "high" })
    // Row 0 (no variants) is picked at once.
    expect(modelPickerKey(catalog, { ...state, active: 0 }, "Enter", { inSearch: true }).pick).toEqual({ providerID: "anthropic", modelID: "claude-haiku-5-5" })
  })

  test("number keys typed into the search box are text, not picks; outside it they pick", () => {
    const typing = modelPickerKey(catalog, initialModelPicker(), "4", { inSearch: true })
    expect(typing).toMatchObject({ handled: false })
    expect(typing.pick).toBeUndefined()
    const outside = modelPickerKey(catalog, { ...initialModelPicker(), query: "haiku" }, "1", { inSearch: false })
    expect(outside.pick).toEqual({ providerID: "anthropic", modelID: "claude-haiku-5-5" })
  })

  test("in the variant list, number keys pick and Backspace goes back", () => {
    const chosen = modelPickerPick(catalog, { ...initialModelPicker(), query: "opus" }, 0).state
    expect(modelPickerKey(catalog, chosen, "3", { inSearch: false }).pick).toEqual({ providerID: "omniroute", modelID: "claude-opus-5-5", variant: "max" })
    expect(modelPickerKey(catalog, chosen, "Backspace", { inSearch: false }).state.chosen).toBeUndefined()
  })

  test("typing resets the active row", () => {
    const moved = modelPickerKey(catalog, initialModelPicker(), "ArrowDown", { inSearch: true }).state
    expect(moved.active).toBe(1)
    expect(modelPickerQuery(moved, "gpt")).toEqual({ query: "gpt", active: 0 })
  })
})

describe("modelPrefsBody", () => {
  test("PUT /model-prefs body: only the chosen kind; null resets to the default", () => {
    expect(modelPrefsBody("voice", { providerID: "omniroute", modelID: "claude-haiku-5-5" })).toEqual({ voice: { providerID: "omniroute", modelID: "claude-haiku-5-5" } })
    expect(modelPrefsBody("worker", { providerID: "openai", modelID: "gpt-6-sol", variant: "high" })).toEqual({ worker: { providerID: "openai", modelID: "gpt-6-sol", variant: "high" } })
    expect(modelPrefsBody("voice", null)).toEqual({ voice: null })
  })
})
