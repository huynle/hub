// /who and /msg in the TUI (src/tui-messaging.ts): argument parsing and what the TUI shows.
import { describe, expect, test } from "bun:test"
import { formatSent, formatWho, parseMsgInput, parseWhoInput, type WhoRow } from "../src/tui-messaging"

describe("parseMsgInput", () => {
  test("no arguments (palette, bare /msg, only spaces) is undefined", () => {
    expect(parseMsgInput(undefined)).toBeUndefined()
    expect(parseMsgInput("")).toBeUndefined()
    expect(parseMsgInput("   ")).toBeUndefined()
  })

  test("the first word is the address; the rest is the text, word for word", () => {
    expect(parseMsgInput("@bob hello")).toEqual({ to: "@bob", text: "hello" })
    expect(parseMsgInput('@bob  hello   "quoted"  world ')).toEqual({ to: "@bob", text: 'hello   "quoted"  world ' })
    expect(parseMsgInput("@@reviewer please look\nat line 2")).toEqual({ to: "@@reviewer", text: "please look\nat line 2" })
    expect(parseMsgInput("  @bob.web hi")).toEqual({ to: "@bob.web", text: "hi" })
    expect(parseMsgInput("ses_abc123 hi")).toEqual({ to: "ses_abc123", text: "hi" })
    expect(parseMsgInput("@me done")).toEqual({ to: "@me", text: "done" })
  })

  test("an address without text, or text without an address, is a usage error", () => {
    expect(parseMsgInput("@bob")).toEqual({ error: expect.stringMatching(/usage: \/msg @name text/i) })
    expect(parseMsgInput("@bob    ")).toEqual({ error: expect.stringMatching(/usage/i) })
    expect(parseMsgInput("hello there")).toEqual({ error: expect.stringMatching(/address/i) })
    expect(parseMsgInput("@ hi")).toEqual({ error: expect.stringMatching(/address/i) })
  })
})

describe("parseWhoInput", () => {
  test("nothing, a project, or a @@role", () => {
    expect(parseWhoInput(undefined)).toEqual({})
    expect(parseWhoInput("  ")).toEqual({})
    expect(parseWhoInput(" hub ")).toEqual({ project: "hub" })
    expect(parseWhoInput("@@reviewer")).toEqual({ role: "reviewer" })
  })
})

describe("formatWho", () => {
  const row = (over: Partial<WhoRow> = {}): WhoRow => ({ sessionID: "ses_1", online: true, roles: [], ...over })

  test("one line per session: name (or id), project, state, online, roles", () => {
    const text = formatWho([
      row({ name: "bob", project: "hub", state: "idle", roles: ["reviewer"] }),
      row({ sessionID: "ses_2", online: false }),
    ])
    expect(text.split("\n")).toEqual(["@bob · hub · idle · online · @@reviewer", "ses_2 · offline"])
  })

  test("an empty directory says so", () => {
    expect(formatWho([])).toMatch(/no named or role-holding sessions/i)
  })
})

describe("formatSent", () => {
  test("names the recipient and how it was delivered", () => {
    expect(formatSent({ id: "m_1", to: "@bob", delivery: "queued" })).toBe("Sent to @bob (queued)")
    expect(formatSent({ id: "m_1", to: "the user" })).toBe("Sent to the user (stored)")
  })
})
