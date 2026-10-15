// Composer state machine (web/src/lib/composer.ts): Send while idle, Steer while the tree runs, Stop while it
// runs, no double submit before a turn starts, and a rejected submit puts its text back into the draft.
import { describe, expect, test } from "bun:test"
import { composerReducer, composerView, initialComposer, type ComposerState } from "../web/src/lib/composer"

const run = (state: ComposerState, ...actions: Parameters<typeof composerReducer>[1][]) => actions.reduce(composerReducer, state)

describe("composerView", () => {
  test("idle with text: Send; empty: disabled; no Stop", () => {
    const typed = run(initialComposer(), { type: "input", text: "hello" })
    expect(composerView(typed, { running: false, offline: false })).toMatchObject({ primary: "send", canSubmit: true, showStop: false })
    expect(composerView(initialComposer(), { running: false, offline: false })).toMatchObject({ primary: "send", canSubmit: false })
    expect(composerView(run(initialComposer(), { type: "input", text: "   " }), { running: false, offline: false }).canSubmit).toBe(false)
  })

  test("running tree: Steer and Stop", () => {
    const typed = run(initialComposer(), { type: "input", text: "also do x" })
    expect(composerView(typed, { running: true, offline: false })).toMatchObject({ primary: "steer", canSubmit: true, showStop: true, canStop: true })
    expect(composerView(initialComposer(), { running: true, offline: false })).toMatchObject({ primary: "steer", canSubmit: false, showStop: true })
  })

  test("offline machine: nothing can be sent or stopped, with a reason", () => {
    const typed = run(initialComposer(), { type: "input", text: "hi" })
    const view = composerView(typed, { running: true, offline: true })
    expect(view).toMatchObject({ canSubmit: false, canStop: false })
    expect(view.hint).toMatch(/disconnected/i)
  })

  test("a turn waiting to start blocks a second Send, but steering is fine once the tree runs", () => {
    const sent = run(initialComposer(), { type: "input", text: "first" }, { type: "submit", id: 1 }, { type: "input", text: "second" })
    expect(composerView(sent, { running: false, offline: false }).canSubmit).toBe(false)
    expect(composerView(sent, { running: true, offline: false })).toMatchObject({ primary: "steer", canSubmit: true })
  })

  test("Stop is disabled while a stop is in flight", () => {
    const stopping = run(initialComposer(), { type: "stop" })
    expect(composerView(stopping, { running: true, offline: false })).toMatchObject({ showStop: true, canStop: false })
    expect(composerView(run(stopping, { type: "stopped" }), { running: true, offline: false }).canStop).toBe(true)
  })
})

describe("composerReducer", () => {
  test("submit clears the draft at once and remembers the text", () => {
    const s = run(initialComposer(), { type: "input", text: "  do it  " }, { type: "submit", id: 7 })
    expect(s.draft).toBe("")
    expect(s.pending).toEqual([{ id: 7, text: "do it" }])
  })

  test("accepted drops the pending entry; rejected restores its text before anything typed since", () => {
    const sent = run(initialComposer(), { type: "input", text: "steer this" }, { type: "submit", id: 1 })
    expect(run(sent, { type: "accepted", id: 1 })).toMatchObject({ draft: "", pending: [], error: undefined })
    const rejected = run(sent, { type: "input", text: "more" }, { type: "rejected", id: 1, message: "No OpenCode process" })
    expect(rejected).toMatchObject({ draft: "steer this\nmore", pending: [], error: "No OpenCode process" })
  })

  test("submitting an empty draft does nothing; typing clears an old error", () => {
    expect(run(initialComposer(), { type: "submit", id: 1 }).pending).toEqual([])
    const failed = run(initialComposer(), { type: "input", text: "x" }, { type: "submit", id: 1 }, { type: "rejected", id: 1, message: "nope" })
    expect(run(failed, { type: "input", text: "x!" }).error).toBeUndefined()
  })

  test("unknown ids are ignored", () => {
    const s = run(initialComposer(), { type: "input", text: "a" }, { type: "submit", id: 1 })
    expect(run(s, { type: "rejected", id: 99, message: "x" })).toEqual(s)
  })
})
