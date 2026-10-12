import { describe, expect, test } from "bun:test"
import { PresenceBook, TUI_PRESENCE_WINDOW_MS } from "../src/spoke/presence"

const T0 = 1_700_000_000_000

describe("PresenceBook (TUI presence on the spoke)", () => {
  test("a session is open while a TUI reported it within 45 s", () => {
    const book = new PresenceBook()
    expect(TUI_PRESENCE_WINDOW_MS).toBe(45_000)
    book.report(["ses_a", "ses_b"], T0, "tui_1")
    expect([...book.open(T0 + 44_999)].sort()).toEqual(["ses_a", "ses_b"])
    expect([...book.open(T0 + 45_000)]).toEqual([])
  })

  test("each TUI's report replaces its previous one; other TUIs keep theirs", () => {
    const book = new PresenceBook()
    book.report(["ses_a", "ses_b"], T0, "tui_1")
    book.report(["ses_c"], T0, "tui_2")
    book.report(["ses_b"], T0 + 10, "tui_1")
    expect([...book.open(T0 + 10)].sort()).toEqual(["ses_b", "ses_c"])
    book.report([], T0 + 20, "tui_2")
    expect([...book.open(T0 + 20)]).toEqual(["ses_b"])
  })

  test("reports without a reporter accumulate per session", () => {
    const book = new PresenceBook()
    book.report(["ses_a"], T0)
    book.report(["ses_b"], T0 + 30_000)
    expect([...book.open(T0 + 40_000)].sort()).toEqual(["ses_a", "ses_b"])
    expect([...book.open(T0 + 50_000)]).toEqual(["ses_b"])
  })

  test("only session IDs, bounded", () => {
    const book = new PresenceBook()
    book.report(["ses_a", "nope", "", "ses_" + "x".repeat(300), ...Array.from({ length: 500 }, (_, i) => `ses_${i}`)], T0, "tui_1")
    const open = book.open(T0)
    expect(open.has("nope")).toBe(false)
    expect(open.has("ses_a")).toBe(true)
    expect(open.size).toBeLessThanOrEqual(200)
    for (let i = 0; i < 300; i++) book.report(["ses_z"], T0, `tui_${i}`)
    expect(book.reporters()).toBeLessThanOrEqual(100)
  })
})
