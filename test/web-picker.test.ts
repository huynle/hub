// Option picker for Settings → Speech (model and voice): option normalization, search, ranking, custom values.
import { describe, expect, test } from "bun:test"
import { filterPicker, pickerOptions, stepActive } from "../web/picker-core.js"

const MODELS = pickerOptions([
  { id: "openai/gpt-4o-mini-tts", name: "OpenAI: GPT-4o mini TTS" },
  { id: "openai/tts-1", name: "OpenAI: TTS 1" },
  { id: "openai/tts-1-hd", name: "OpenAI: TTS 1 HD" },
  { id: "elevenlabs/eleven-v3", name: "ElevenLabs Eleven v3" },
  { id: "kokoro", name: "Kokoro (Café edition)" },
])
const ids = (r: { items: Array<{ id: string }> }) => r.items.map((x) => x.id)

describe("pickerOptions", () => {
  test("accepts {id, name} objects and plain strings, drops junk and duplicate ids, trims", () => {
    expect(pickerOptions([{ id: " a ", name: "A" }, "b", { id: "a", name: "again" }, { name: "no id" }, null, 5, { id: "" }, { id: "c", name: "c" }])).toEqual([
      { id: "a", name: "A" },
      { id: "b" },
      { id: "c" },
    ])
    expect(pickerOptions(undefined)).toEqual([])
    expect(pickerOptions({ models: [{ id: "x" }] })).toEqual([{ id: "x" }])
  })
})

describe("filterPicker", () => {
  test("no query: every option in order, the current one first and marked", () => {
    const r = filterPicker(MODELS, "", { current: "openai/tts-1" })
    expect(ids(r)).toEqual(["openai/tts-1", "openai/gpt-4o-mini-tts", "openai/tts-1-hd", "elevenlabs/eleven-v3", "kokoro"])
    expect(r.items.filter((x) => x.current).map((x) => x.id)).toEqual(["openai/tts-1"])
    expect(r.custom).toBeUndefined()
    expect(r.total).toBe(5)
  })

  test("a current value that is not in the list is shown first, marked as custom", () => {
    const r = filterPicker(MODELS, "", { current: "my/finetune" })
    expect(r.items[0]).toEqual({ id: "my/finetune", current: true, custom: true })
    expect(r.total).toBe(6)
  })

  test("search matches id or name, every word, case- and diacritic-insensitive", () => {
    expect(ids(filterPicker(MODELS, "TTS hd"))).toEqual(["openai/tts-1-hd"])
    expect(ids(filterPicker(MODELS, "cafe"))).toEqual(["kokoro"])
    expect(ids(filterPicker(MODELS, "eleven labs"))).toEqual(["elevenlabs/eleven-v3"])
    expect(ids(filterPicker(MODELS, "zzz"))).toEqual([])
  })

  test("exact id first, then ids starting with the query, then other matches", () => {
    const r = filterPicker(MODELS, "openai/tts-1")
    expect(ids(r)).toEqual(["openai/tts-1", "openai/tts-1-hd"])
    expect(ids(filterPicker(MODELS, "tts"))).toEqual(["openai/gpt-4o-mini-tts", "openai/tts-1", "openai/tts-1-hd"])
    expect(ids(filterPicker(pickerOptions(["xtts", "tts-1", "a-tts"]), "tts"))).toEqual(["tts-1", "xtts", "a-tts"])
  })

  test("offers the typed text as a custom value unless an option has exactly that id", () => {
    expect(filterPicker(MODELS, "  my/model ").custom).toBe("my/model")
    expect(filterPicker(MODELS, "tts").custom).toBe("tts")
    expect(filterPicker(MODELS, "kokoro").custom).toBeUndefined()
    expect(filterPicker(MODELS, "   ").custom).toBeUndefined()
  })

  test("caps rendered items and reports how many more matched", () => {
    const many = pickerOptions(Array.from({ length: 250 }, (_, i) => `model-${i}`))
    const r = filterPicker(many, "model", { limit: 100 })
    expect(r.items).toHaveLength(100)
    expect(r.total).toBe(250)
    expect(r.more).toBe(150)
    expect(filterPicker(MODELS, "").more).toBe(0)
  })
})

describe("stepActive", () => {
  test("moves through the list, wrapping at both ends; -1 when empty", () => {
    expect(stepActive(-1, 1, 3)).toBe(0)
    expect(stepActive(0, 1, 3)).toBe(1)
    expect(stepActive(2, 1, 3)).toBe(0)
    expect(stepActive(0, -1, 3)).toBe(2)
    expect(stepActive(-1, -1, 3)).toBe(2)
    expect(stepActive(1, "home", 3)).toBe(0)
    expect(stepActive(1, "end", 3)).toBe(2)
    expect(stepActive(0, 1, 0)).toBe(-1)
  })
})
