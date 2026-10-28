// Decision cards in the web console (P2-T10b): the open Decisions list kept from GET /api/decisions and SSE
// 'decision' events, which cards a session shows, the deadline countdown, the asker, the tier note, and the answer.
import { describe, expect, test } from "bun:test"
import {
  answerBody,
  applyDecision,
  askerLabel,
  countdown,
  deadlineText,
  decisionsFor,
  openDecisions,
  parseDecision,
  tierNote,
  type DecisionView,
} from "../web/src/core/decision-core"

const T0 = 1_700_000_000_000
const MIN = 60_000

const decision = (patch: Partial<DecisionView> = {}): DecisionView => ({
  id: "dec_1",
  messageID: "msg_1",
  from: { kind: "session", sessionID: "ses_a", name: "api" },
  about: ["ses_a"],
  sessionID: "ses_a",
  question: "Drop column legacy_id?",
  options: [
    { id: "go", label: "Proceed" },
    { id: "hold", label: "Hold", safe: true },
  ],
  recommendation: { option: "hold", why: "still read" },
  urgency: "normal",
  tier: "confirm",
  state: "open",
  at: T0,
  expiresAt: T0 + 24 * 60 * MIN,
  ...patch,
})

describe("parseDecision", () => {
  test("accepts the hub's Decision; rejects what is not one", () => {
    const d = decision()
    expect(parseDecision(d)).toEqual(d)
    for (const bad of [undefined, null, "x", {}, { ...d, id: 3 }, { ...d, id: "msg_1" }, { ...d, question: undefined }, { ...d, options: "go" }, { ...d, state: "weird" }, { ...d, about: "ses_a" }]) {
      expect(parseDecision(bad)).toBeUndefined()
    }
  })

  test("a Decision closed elsewhere (P3-T8) parses and leaves the open list", () => {
    const closed = { ...decision(), state: "closed", closed: { at: T0 + 1, reason: "The request was answered elsewhere or ended" } }
    expect(parseDecision(closed)?.state).toBe("closed")
    expect(applyDecision([decision()], parseDecision(closed)!)).toEqual([])
  })

  test("drops malformed options", () => {
    const parsed = parseDecision({ ...decision(), options: [{ id: "go", label: "Proceed" }, { id: 1, label: "x" }, null, { id: "hold" }] })
    expect(parsed?.options).toEqual([{ id: "go", label: "Proceed" }])
  })
})

describe("the open list", () => {
  test("openDecisions keeps the open ones, newest first", () => {
    const a = decision({ id: "dec_a", at: T0 })
    const b = decision({ id: "dec_b", at: T0 + 1 })
    const c = decision({ id: "dec_c", at: T0 + 2, state: "answered" })
    expect(openDecisions([a, c, b]).map((d) => d.id)).toEqual(["dec_b", "dec_a"])
  })

  test("applyDecision adds or replaces an open Decision and removes a closed one", () => {
    const a = decision({ id: "dec_a", at: T0 })
    const b = decision({ id: "dec_b", at: T0 + 1 })
    let list = applyDecision([], a)
    list = applyDecision(list, b)
    expect(list.map((d) => d.id)).toEqual(["dec_b", "dec_a"])
    list = applyDecision(list, { ...a, escalatedAt: T0 + 5 })
    expect(list.find((d) => d.id === "dec_a")?.escalatedAt).toBe(T0 + 5)
    expect(list).toHaveLength(2)
    list = applyDecision(list, { ...a, state: "answered" })
    expect(list.map((d) => d.id)).toEqual(["dec_b"])
    expect(applyDecision(list, { ...b, state: "expired" })).toEqual([])
    // A closed Decision never seen changes nothing.
    expect(applyDecision([], decision({ id: "dec_x", state: "answered" }))).toEqual([])
  })

  test("decisionsFor: the session asked it or it is about the session", () => {
    const asked = decision({ id: "dec_asked", from: { kind: "session", sessionID: "ses_a" }, about: ["ses_b"], sessionID: "ses_b" })
    const about = decision({ id: "dec_about", from: { kind: "app", tokenID: "tok_1", label: "assistant-app" }, about: ["ses_c", "ses_a"], sessionID: "ses_c" })
    const other = decision({ id: "dec_other", from: { kind: "session", sessionID: "ses_z" }, about: ["ses_z"], sessionID: "ses_z" })
    expect(decisionsFor([asked, about, other], "ses_a").map((d) => d.id)).toEqual(["dec_asked", "dec_about"])
    expect(decisionsFor([asked, about, other], "ses_q")).toEqual([])
  })
})

describe("labels", () => {
  test("askerLabel: @name, the session ID, an app's label", () => {
    expect(askerLabel(decision())).toBe("@api")
    expect(askerLabel(decision({ from: { kind: "session", sessionID: "ses_a" } }))).toBe("ses_a")
    expect(askerLabel(decision({ from: { kind: "app", tokenID: "tok_1", label: "assistant-app" } }))).toBe("app assistant-app")
    expect(askerLabel(decision({ from: { kind: "app", tokenID: "tok_1" } }))).toBe("app tok_1")
  })

  test("tierNote: tap Decisions say they are answered here; confirm ones say nothing", () => {
    expect(tierNote(decision({ tier: "tap" }))).toBe("Answer here (tap): only a signed-in console can answer this one.")
    expect(tierNote(decision())).toBe("")
  })

  test("countdown: hours and minutes, minutes and seconds, seconds; past due", () => {
    expect(countdown(T0 + 2 * 60 * MIN + 5 * MIN + 30_000, T0)).toBe("2h 5m")
    expect(countdown(T0 + 4 * MIN + 10_000, T0)).toBe("4m 10s")
    expect(countdown(T0 + 12_400, T0)).toBe("12s")
    expect(countdown(T0 + 26 * 60 * MIN, T0)).toBe("1d 2h")
    expect(countdown(T0, T0)).toBe("0s")
    expect(countdown(T0 - 1, T0)).toBe("")
  })

  test("deadlineText: the countdown and what happens then", () => {
    expect(deadlineText(decision(), T0)).toBe("")
    expect(deadlineText(decision({ deadline: T0 + 4 * MIN + 10_000, onTimeout: "hold" }), T0)).toBe("Deadline in 4m 10s · then Hold")
    expect(deadlineText(decision({ deadline: T0 + 4 * MIN + 10_000 }), T0)).toBe("Deadline in 4m 10s")
    expect(deadlineText(decision({ deadline: T0 - 1 }), T0)).toBe("Past its deadline")
  })
})

describe("answerBody", () => {
  test("an option (with an optional note) for Decisions with options", () => {
    expect(answerBody(decision(), "go", "")).toEqual({ ok: true, body: { option: "go" } })
    expect(answerBody(decision(), "hold", "  until Friday ")).toEqual({ ok: true, body: { option: "hold", text: "until Friday" } })
    expect(answerBody(decision(), "nope", "")).toEqual({ ok: false, problem: "Pick one of the options" })
    expect(answerBody(decision(), undefined, "hi")).toEqual({ ok: false, problem: "Pick one of the options" })
  })

  test("text for Decisions without options", () => {
    const free = decision({ options: [], recommendation: undefined })
    expect(answerBody(free, undefined, " main ")).toEqual({ ok: true, body: { text: "main" } })
    expect(answerBody(free, undefined, "  ")).toEqual({ ok: false, problem: "Type an answer" })
  })
})
