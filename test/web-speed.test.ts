// Voice speed: playback rate chosen on the phone (0.75×–2.0×, 0.05 steps), stored as a string in localStorage.
import { describe, expect, test } from "bun:test"
import { SPEED_DEFAULT, SPEED_MAX, SPEED_MIN, SPEED_STEP, clampSpeed, formatSpeed } from "../web/src/core/feedback-core"

describe("clampSpeed", () => {
  test("range constants", () => {
    expect([SPEED_MIN, SPEED_MAX, SPEED_STEP, SPEED_DEFAULT]).toEqual([0.75, 2, 0.05, 1])
  })

  test("keeps in-range values on the 0.05 grid", () => {
    expect(clampSpeed(1)).toBe(1)
    expect(clampSpeed(1.25)).toBe(1.25)
    expect(clampSpeed(0.75)).toBe(0.75)
    expect(clampSpeed(2)).toBe(2)
  })

  test("rounds to the nearest step without float noise", () => {
    expect(clampSpeed(1.12)).toBe(1.1)
    expect(clampSpeed(1.13)).toBe(1.15)
    expect(clampSpeed(0.1 + 0.2 + 0.85)).toBe(1.15)
  })

  test("clamps out-of-range values", () => {
    expect(clampSpeed(0.5)).toBe(0.75)
    expect(clampSpeed(3)).toBe(2)
    expect(clampSpeed(-1)).toBe(0.75)
  })

  test("parses strings (localStorage) and falls back to the default on junk", () => {
    expect(clampSpeed("1.5")).toBe(1.5)
    expect(clampSpeed(null)).toBe(1)
    expect(clampSpeed(undefined)).toBe(1)
    expect(clampSpeed("fast")).toBe(1)
    expect(clampSpeed(Number.NaN)).toBe(1)
    expect(clampSpeed("")).toBe(1)
  })
})

describe("formatSpeed", () => {
  test("shows up to two decimals with a multiplication sign", () => {
    expect(formatSpeed(1)).toBe("1.0×")
    expect(formatSpeed(1.25)).toBe("1.25×")
    expect(formatSpeed(1.5)).toBe("1.5×")
    expect(formatSpeed(0.75)).toBe("0.75×")
    expect(formatSpeed(2)).toBe("2.0×")
  })
})
