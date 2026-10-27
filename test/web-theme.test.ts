import { describe, expect, test } from "bun:test"
import { parseTheme, themeAttribute } from "../web/src/core/theme"

describe("appearance theme", () => {
  test("accepts the three supported choices and defaults junk to system", () => {
    expect(parseTheme("light")).toBe("light")
    expect(parseTheme("dark")).toBe("dark")
    expect(parseTheme("system")).toBe("system")
    expect(parseTheme("sepia")).toBe("system")
    expect(parseTheme(null)).toBe("system")
  })

  test("system delegates to CSS while explicit choices set an attribute", () => {
    expect(themeAttribute("system")).toBeUndefined()
    expect(themeAttribute("light")).toBe("light")
    expect(themeAttribute("dark")).toBe("dark")
  })
})
