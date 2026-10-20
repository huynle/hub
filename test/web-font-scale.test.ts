// Text size (web/src/core/font-scale.ts): one --font-scale for the console, from Settings, pinch or ctrl+wheel.
import { describe, expect, test } from "bun:test"
import {
  FONT_SCALE_DEFAULT,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  clampScale,
  formatScale,
  parseScale,
  pinchScale,
  readScale,
  wheelScale,
  writeScale,
} from "../web/src/core/font-scale"

describe("font scale", () => {
  test("range and step", () => {
    expect([FONT_SCALE_MIN, FONT_SCALE_DEFAULT, FONT_SCALE_MAX, FONT_SCALE_STEP]).toEqual([0.8, 1, 1.8, 0.05])
  })

  test("clampScale keeps 0.8–1.8 in 0.05 steps; junk is the default", () => {
    expect(clampScale(0.5)).toBe(0.8)
    expect(clampScale(3)).toBe(1.8)
    expect(clampScale(1.23)).toBe(1.25)
    expect(clampScale(1.22)).toBe(1.2)
    expect(clampScale(1.1500000001)).toBe(1.15)
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(Infinity)).toBe(1)
  })

  test("parseScale reads what writeScale stores", () => {
    expect(parseScale(null)).toBe(1)
    expect(parseScale("")).toBe(1)
    expect(parseScale("abc")).toBe(1)
    expect(parseScale("1.4")).toBe(1.4)
    expect(parseScale("9")).toBe(1.8)
  })

  test("pinch scales with the finger distance from where it started", () => {
    expect(pinchScale(1, 100, 100)).toBe(1)
    expect(pinchScale(1, 100, 150)).toBe(1.5)
    expect(pinchScale(1.2, 100, 50)).toBe(0.8)
    expect(pinchScale(1, 100, 1000)).toBe(1.8)
    expect(pinchScale(1.3, 0, 50)).toBe(1.3)
  })

  test("ctrl+wheel (trackpad pinch): up grows, down shrinks, smoothly", () => {
    const up = wheelScale(1, -10)
    const down = wheelScale(1, 10)
    expect(up).toBeGreaterThan(1)
    expect(down).toBeLessThan(1)
    expect(up).toBeLessThanOrEqual(1.15)
    expect(wheelScale(1.8, -100)).toBe(1.8)
    expect(wheelScale(0.8, 100)).toBe(0.8)
    expect(wheelScale(1, 0)).toBe(1)
  })

  test("formatScale is a percentage", () => {
    expect(formatScale(1)).toBe("100%")
    expect(formatScale(1.25)).toBe("125%")
    expect(formatScale(0.8)).toBe("80%")
  })

  test("read and write through a storage; the default is removed", () => {
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
    expect(readScale(storage)).toBe(1)
    expect(writeScale(storage, 1.43)).toBe(1.45)
    expect(map.get("hub.fontScale")).toBe("1.45")
    expect(readScale(storage)).toBe(1.45)
    writeScale(storage, 1)
    expect(map.has("hub.fontScale")).toBe(false)
    const broken = { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("denied") }, removeItem: () => {} }
    expect(readScale(broken)).toBe(1)
    expect(writeScale(broken, 1.2)).toBe(1.2)
  })
})
