// /who and /msg in the TUI (src/tui-messaging.ts): argument parsing and what the TUI shows.
import { describe, expect, test } from "bun:test"
import { formatSent, formatWho, parseMsgInput, parseWhoInput, runMsg, runWho, type MessagingDeps, type WhoRow } from "../src/tui-messaging"

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

function deps(over: Partial<MessagingDeps> & { session?: string | undefined; answer?: string | null | undefined } = {}) {
  const log = { who: [] as unknown[], msg: [] as unknown[], toasts: [] as Array<[string, string]>, prompts: [] as unknown[], alerts: [] as Array<{ title: string; message: string }> }
  const session = "session" in over ? over.session : "ses_me"
  const d: MessagingDeps = {
    sessionID: () => session,
    who: async (input) => {
      log.who.push(input)
      return { sessions: [{ sessionID: "ses_bob", name: "bob", online: true, roles: [] }] }
    },
    msg: async (input) => {
      log.msg.push(input)
      return { id: "m_1", to: "@bob", delivery: "queued" }
    },
    prompt: async (options) => {
      log.prompts.push(options)
      return over.answer
    },
    alert: async (options) => void log.alerts.push(options),
    toast: (message, variant = "info") => void log.toasts.push([variant, message]),
    ...over,
  }
  return { d, log }
}

describe("runMsg", () => {
  test("sends the arguments word for word as the current session and says where it went", async () => {
    const { d, log } = deps()
    await runMsg(d, '@bob  hi  "you"')
    expect(log.msg).toEqual([{ sessionID: "ses_me", to: "@bob", text: 'hi  "you"' }])
    expect(log.toasts).toEqual([["success", "Sent to @bob (queued)"]])
  })

  test("without a session: a clear toast and nothing is sent", async () => {
    const { d, log } = deps({ session: undefined })
    await runMsg(d, "@bob hi")
    expect(log.msg).toEqual([])
    expect(log.prompts).toEqual([])
    expect(log.toasts).toEqual([["warning", expect.stringMatching(/open a session/i)]])
  })

  test("without arguments it asks for the message; cancelling sends nothing", async () => {
    const asked = deps({ answer: "@bob from the dialog" })
    await runMsg(asked.d, undefined)
    expect(asked.log.prompts).toHaveLength(1)
    expect(asked.log.msg).toEqual([{ sessionID: "ses_me", to: "@bob", text: "from the dialog" }])
    const cancelled = deps({ answer: undefined })
    await runMsg(cancelled.d, "")
    expect(cancelled.log.prompts).toHaveLength(1)
    expect(cancelled.log.msg).toEqual([])
    expect(cancelled.log.toasts).toEqual([])
  })

  test("a usage error is a toast; nothing is sent", async () => {
    const { d, log } = deps()
    await runMsg(d, "@bob")
    expect(log.msg).toEqual([])
    expect(log.toasts).toEqual([["error", expect.stringMatching(/usage/i)]])
  })
})

describe("runWho", () => {
  test("lists the directory in a dialog, asked as the current session, with the filter", async () => {
    const { d, log } = deps()
    await runWho(d, "@@reviewer")
    expect(log.who).toEqual([{ sessionID: "ses_me", role: "reviewer" }])
    expect(log.alerts).toEqual([{ title: expect.stringMatching(/who/i), message: "@bob · online" }])
  })

  test("an empty directory is a toast", async () => {
    const { d, log } = deps({ who: async () => ({ sessions: [] }) })
    await runWho(d, undefined)
    expect(log.alerts).toEqual([])
    expect(log.toasts).toEqual([["info", expect.stringMatching(/no named/i)]])
  })

  test("without a session: a clear toast and no request", async () => {
    const { d, log } = deps({ session: undefined })
    await runWho(d, "")
    expect(log.who).toEqual([])
    expect(log.toasts).toEqual([["warning", expect.stringMatching(/open a session/i)]])
  })
})
