// Resizable sidebar and rail widths: bounds, fitting against the window, keyboard, drag (with collapse) and
// per-device persistence (web/src/core/panel-size.ts).
import { describe, expect, test } from "bun:test"
import { CENTER_MIN, PANELS, PANEL_WIDTHS_KEY, dragWidth, fitWidths, keyWidth, limits, loadWidths, saveWidth } from "../web/src/core/panel-size"

function memory(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

describe("bounds", () => {
  test("defaults and limits", () => {
    expect(PANELS.side).toEqual({ min: 180, max: 480, default: 235 })
    expect(PANELS.rail).toEqual({ min: 220, max: 640, default: 260 })
    expect(CENTER_MIN).toBe(420)
  })
  test("a wide window allows the panel's own maximum", () => {
    expect(limits("side", 2000, 260)).toEqual({ min: 180, max: 480 })
    expect(limits("rail", 2000, 235)).toEqual({ min: 220, max: 640 })
  })
  test("the center column keeps 420px: max shrinks with the window and the other panel", () => {
    expect(limits("rail", 1200, 300)).toEqual({ min: 220, max: 1200 - 420 - 300 })
    expect(limits("side", 1000, 260)).toEqual({ min: 180, max: 1000 - 420 - 260 })
  })
  test("a tiny window never pushes max below min", () => {
    expect(limits("side", 700, 260)).toEqual({ min: 180, max: 180 })
  })
})

describe("fitWidths", () => {
  test("keeps preferred widths that fit", () => {
    expect(fitWidths({ side: 300, rail: 400 }, 1440, { side: true, rail: true })).toEqual({ side: 300, rail: 400 })
  })
  test("clamps to each panel's bounds", () => {
    expect(fitWidths({ side: 50, rail: 9999 }, 3000, { side: true, rail: true })).toEqual({ side: 180, rail: 640 })
  })
  test("a narrow window shrinks the rail first, then the sidebar, keeping the center ≥ 420", () => {
    const w = fitWidths({ side: 480, rail: 640 }, 1200, { side: true, rail: true })
    expect(w.side).toBe(480)
    expect(w.rail).toBe(1200 - 420 - 480)
    const narrow = fitWidths({ side: 480, rail: 640 }, 900, { side: true, rail: true })
    expect(narrow.rail).toBe(220)
    expect(narrow.side).toBe(900 - 420 - 220)
  })
  test("a hidden panel takes no room from the other", () => {
    expect(fitWidths({ side: 480, rail: 640 }, 1200, { side: false, rail: true }).rail).toBe(640)
    expect(fitWidths({ side: 480, rail: 640 }, 1000, { side: true, rail: false }).side).toBe(480)
  })
})

describe("keyWidth", () => {
  const lim = { min: 180, max: 480 }
  test("sidebar (handle on its right edge): ArrowRight grows, ArrowLeft shrinks, 16px; Shift 64px", () => {
    expect(keyWidth("side", 235, "ArrowRight", false, lim)).toBe(251)
    expect(keyWidth("side", 235, "ArrowLeft", false, lim)).toBe(219)
    expect(keyWidth("side", 235, "ArrowRight", true, lim)).toBe(299)
    expect(keyWidth("side", 235, "ArrowLeft", true, lim)).toBe(180)
  })
  test("rail (handle on its left edge): ArrowLeft grows, ArrowRight shrinks", () => {
    const r = { min: 220, max: 640 }
    expect(keyWidth("rail", 260, "ArrowLeft", false, r)).toBe(276)
    expect(keyWidth("rail", 260, "ArrowRight", false, r)).toBe(244)
    expect(keyWidth("rail", 630, "ArrowLeft", true, r)).toBe(640)
  })
  test("Home / End jump to min / max; other keys are ignored", () => {
    expect(keyWidth("side", 300, "Home", false, lim)).toBe(180)
    expect(keyWidth("side", 300, "End", false, lim)).toBe(480)
    expect(keyWidth("side", 300, "Enter", false, lim)).toBeUndefined()
    expect(keyWidth("side", 300, "a", false, lim)).toBeUndefined()
  })
})

describe("dragWidth", () => {
  const side = { min: 180, max: 480 }
  test("sidebar follows the pointer, clamped", () => {
    expect(dragWidth("side", 235, 100, side)).toEqual({ width: 335 })
    expect(dragWidth("side", 235, 1000, side)).toEqual({ width: 480 })
    expect(dragWidth("side", 235, -80, side)).toEqual({ width: 180 })
  })
  test("dragging the sidebar past min − 48px collapses it", () => {
    expect(dragWidth("side", 235, -(235 - 180 + 48), side)).toEqual({ width: 180 })
    expect(dragWidth("side", 235, -(235 - 180 + 49), side)).toEqual({ collapse: true })
  })
  test("rail grows when dragged left and never collapses", () => {
    const r = { min: 220, max: 640 }
    expect(dragWidth("rail", 260, -100, r)).toEqual({ width: 360 })
    expect(dragWidth("rail", 260, 500, r)).toEqual({ width: 220 })
  })
})

describe("persistence", () => {
  test("defaults when nothing is stored", () => {
    expect(loadWidths(memory())).toEqual({ side: 235, rail: 260 })
  })
  test("saves and loads each panel", () => {
    const s = memory()
    saveWidth(s, "side", 320)
    saveWidth(s, "rail", 410.6)
    expect(loadWidths(s)).toEqual({ side: 320, rail: 411 })
  })
  test("clamps stored values to the panel bounds", () => {
    const s = memory()
    s.setItem(PANEL_WIDTHS_KEY, JSON.stringify({ side: 5000, rail: 10 }))
    expect(loadWidths(s)).toEqual({ side: 480, rail: 220 })
  })
  test("ignores garbage", () => {
    for (const raw of ["not json", "null", "[]", '"x"', JSON.stringify({ side: "wide", rail: null }), JSON.stringify({ side: Number.NaN })]) {
      const s = memory()
      s.setItem(PANEL_WIDTHS_KEY, raw)
      expect(loadWidths(s)).toEqual({ side: 235, rail: 260 })
    }
  })
  test("storage failures are silent", () => {
    const broken = { ...memory(), getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("full") } } as Storage
    expect(loadWidths(broken)).toEqual({ side: 235, rail: 260 })
    expect(() => saveWidth(broken, "side", 300)).not.toThrow()
  })
})
