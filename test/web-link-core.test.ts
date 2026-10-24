import { describe, expect, test } from "bun:test"
import { linkCountdown, linkDeadline, linkedDevice } from "../web/src/core/link-core"

describe("linkCountdown", () => {
  test("m:ss, rounding up partial seconds, 0:00 once expired", () => {
    expect(linkCountdown(300_000, 0)).toBe("5:00")
    expect(linkCountdown(300_000, 1)).toBe("5:00")
    expect(linkCountdown(300_000, 1000)).toBe("4:59")
    expect(linkCountdown(300_000, 291_000)).toBe("0:09")
    expect(linkCountdown(300_000, 300_000)).toBe("0:00")
    expect(linkCountdown(300_000, 400_000)).toBe("0:00")
  })
})

describe("linkedDevice", () => {
  test("the first device not known when the dialog opened", () => {
    const known = new Set(["a", "b"])
    expect(linkedDevice(known, [{ id: "a" }, { id: "b" }])).toBeUndefined()
    expect(linkedDevice(known, [{ id: "a" }, { id: "c", name: "Pixel" }])).toEqual({ id: "c", name: "Pixel" })
    expect(linkedDevice(known, [])).toBeUndefined()
  })
})

describe("linkDeadline", () => {
  const at = Date.parse("2026-10-24T12:00:00Z")
  test("shifts the server's expiry onto this device's clock (a second early: the header has no milliseconds)", () => {
    // This device runs 10 minutes ahead of the server.
    expect(linkDeadline(at + 300_000, new Date(at).toUTCString(), at + 600_000)).toBe(at + 899_000)
    // ...or 10 minutes behind.
    expect(linkDeadline(at + 300_000, new Date(at).toUTCString(), at - 600_000)).toBe(at - 301_000)
  })

  test("without a usable Date header, the server's expiry as is", () => {
    expect(linkDeadline(at + 300_000, null, at + 600_000)).toBe(at + 300_000)
    expect(linkDeadline(at + 300_000, "nonsense", at)).toBe(at + 300_000)
  })
})
