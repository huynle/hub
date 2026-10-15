// Conversation mode transcript helpers: deduping spoken "say" text against streamed deltas, and subagent notes.
import { describe, expect, test } from "bun:test"
import { reconcileSay, statusNotes } from "../web/src/core/conversation-core"

describe("reconcileSay", () => {
  test("no agent bubble yet: a new bubble", () => {
    expect(reconcileSay("", "Sure, starting now.")).toEqual({ mode: "new", text: "Sure, starting now." })
  })

  test("already streamed in full (whitespace differences ignored): keep", () => {
    expect(reconcileSay("Sure,\n starting now.", "Sure, starting now.")).toEqual({ mode: "keep", text: "Sure,\n starting now." })
    expect(reconcileSay("First part. Second part.", "Second part.")).toMatchObject({ mode: "keep" })
  })

  test("partially streamed: the bubble is updated to the final text", () => {
    expect(reconcileSay("Sure, star", "Sure, starting now.")).toEqual({ mode: "update", text: "Sure, starting now." })
  })

  test("an earlier part plus the start of this one: the tail is completed", () => {
    expect(reconcileSay("On it. I will run the full test", "I will run the full test suite now.")).toEqual({
      mode: "update",
      text: "On it. I will run the full test suite now.",
    })
  })

  test("unrelated text (or a tiny accidental overlap): a new bubble", () => {
    expect(reconcileSay("All done.", "Next, the build.")).toEqual({ mode: "new", text: "Next, the build." })
    expect(reconcileSay("Ends with a", "a different reply.")).toMatchObject({ mode: "new" })
  })
})

describe("statusNotes", () => {
  const root = { id: "ses_root", title: "Main", state: "working", blockers: [] }
  const child = (state: string, extra = {}) => ({ id: "ses_child", parentID: "ses_root", title: "Fix tests", state, blockers: [], ...extra })

  test("a subagent starting, finishing, failing and blocking", () => {
    expect(statusNotes([root], [root, child("working")], "ses_root")).toEqual(["Subagent “Fix tests” is working"])
    expect(statusNotes([root, child("working")], [root, child("idle")], "ses_root")).toEqual(["Subagent “Fix tests” finished"])
    expect(statusNotes([root, child("working")], [root, child("error", { detail: "boom" })], "ses_root")).toEqual(["Subagent “Fix tests” failed: boom"])
    expect(statusNotes([root, child("working")], [root, child("blocked")], "ses_root")).toEqual(["Subagent “Fix tests” needs you"])
  })

  test("a working subagent that disappears counts as finished", () => {
    expect(statusNotes([root, child("working")], [root], "ses_root")).toEqual(["Subagent “Fix tests” finished"])
  })

  test("no notes for unchanged states or the root session", () => {
    expect(statusNotes([root, child("working")], [root, child("working")], "ses_root")).toEqual([])
    expect(statusNotes([{ ...root, state: "idle" }], [root], "ses_root")).toEqual([])
    expect(statusNotes(undefined, [root, child("idle")], "ses_root")).toEqual([])
  })
})
