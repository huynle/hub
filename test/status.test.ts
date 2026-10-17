import { describe, expect, test } from "bun:test"
import { StatusBoard } from "../src/status"

const ev = (type: string, data: Record<string, unknown>) => ({ type, data })

describe("StatusBoard", () => {
  test("tracks the root session and marks it working, then idle", () => {
    const board = new StatusBoard("ses_root", "Main")
    expect(board.snapshot().sessions).toEqual([{ id: "ses_root", title: "Main", state: "idle", blockers: [] }])
    expect(board.observe(ev("session.execution.started", { sessionID: "ses_root" }))).toBe(true)
    expect(board.get("ses_root")?.state).toBe("working")
    board.observe(ev("session.execution.succeeded", { sessionID: "ses_root" }))
    expect(board.get("ses_root")?.state).toBe("idle")
  })

  test("adds child sessions created under a tracked session", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("session.created", { sessionID: "ses_child", parentID: "ses_root", slug: "x", title: "explore" }))
    board.observe(ev("session.created", { sessionID: "ses_grandchild", parentID: "ses_child", slug: "y" }))
    board.observe(ev("session.created", { sessionID: "ses_other", slug: "z" }))
    expect(board.snapshot().sessions.map((s) => s.id)).toEqual(["ses_root", "ses_child", "ses_grandchild"])
    expect(board.get("ses_child")?.parentID).toBe("ses_root")
  })

  test("ignores events for untracked sessions", () => {
    const board = new StatusBoard("ses_root", "Main")
    expect(board.observe(ev("session.execution.started", { sessionID: "ses_other" }))).toBe(false)
  })

  test("a pending permission makes the session blocked until replied", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("session.execution.started", { sessionID: "ses_root" }))
    board.observe(
      ev("permission.asked", { id: "per_1", sessionID: "ses_root", action: "shell", resources: ["rm -rf build"] }),
    )
    expect(board.get("ses_root")).toMatchObject({
      state: "blocked",
      blockers: [{ kind: "permission", id: "per_1", summary: "shell: rm -rf build" }],
    })
    board.observe(ev("permission.replied", { sessionID: "ses_root", requestID: "per_1", reply: "once" }))
    expect(board.get("ses_root")).toMatchObject({ state: "working", blockers: [] })
  })

  test("a pending form (question) blocks until replied or cancelled", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("form.created", { form: { id: "frm_1", sessionID: "ses_root", title: "Pick one", fields: [] } }))
    expect(board.get("ses_root")?.state).toBe("blocked")
    board.observe(ev("form.cancelled", { id: "frm_1", sessionID: "ses_root" }))
    expect(board.get("ses_root")?.state).toBe("idle")
  })

  test("a form blocker carries its fields (bounded) so a phone can answer it; duplicates are ignored", () => {
    const board = new StatusBoard("ses_root", "Main")
    const form = {
      id: "frm_1",
      sessionID: "ses_root",
      title: "Questions",
      metadata: { kind: "question", tool: { id: "x" } },
      fields: [
        { key: "q0", type: "string", title: "Color", description: "Pick a color", options: [{ value: "red", label: "Red", description: "warm" }], custom: true, extra: "dropped" },
        { key: "q1", type: "multiselect", title: "Sizes", options: [{ value: "S", label: "S" }], minItems: 1 },
        { key: "q2", type: "boolean", title: "Sure?", required: true, default: false },
        { key: "q3", type: "integer", minimum: 1, maximum: 5 },
        { key: "q4", type: "external", url: "https://example.com/x", title: "Sign in" },
        { key: "bad", type: "mystery" },
        { title: "no key", type: "string" },
        { key: "long", type: "string", description: "x".repeat(5000) },
      ],
    }
    board.observe(ev("form.created", { form }))
    board.observe(ev("form.created", { form }))
    const blockers = board.get("ses_root")!.blockers
    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toMatchObject({ kind: "form", id: "frm_1", summary: "Questions", question: true })
    const fields = blockers[0]!.fields!
    expect(fields.map((f) => f.key)).toEqual(["q0", "q1", "q2", "q3", "q4", "long"])
    expect(fields[0]).toEqual({ key: "q0", type: "string", title: "Color", description: "Pick a color", options: [{ value: "red", label: "Red", description: "warm" }], custom: true })
    expect(fields[1]).toEqual({ key: "q1", type: "multiselect", title: "Sizes", options: [{ value: "S", label: "S" }], minItems: 1 })
    expect(fields[2]).toEqual({ key: "q2", type: "boolean", title: "Sure?", required: true, default: false })
    expect(fields[3]).toEqual({ key: "q3", type: "integer", minimum: 1, maximum: 5 })
    expect(fields[4]).toEqual({ key: "q4", type: "external", url: "https://example.com/x", title: "Sign in" })
    expect(fields[5]!.description!.length).toBeLessThanOrEqual(2000)
  })

  test("failed executions are reported as error until the next start", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("session.execution.failed", { sessionID: "ses_root", error: { type: "x", message: "boom" } }))
    expect(board.get("ses_root")).toMatchObject({ state: "error", detail: "boom" })
    board.observe(ev("session.execution.started", { sessionID: "ses_root" }))
    expect(board.get("ses_root")?.state).toBe("working")
  })

  test("renames and deletions are reflected", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("session.created", { sessionID: "ses_child", parentID: "ses_root", slug: "x" }))
    board.observe(ev("session.renamed", { sessionID: "ses_child", title: "Reviewer" }))
    expect(board.get("ses_child")?.title).toBe("Reviewer")
    board.observe(ev("session.deleted", { sessionID: "ses_child" }))
    expect(board.get("ses_child")).toBeUndefined()
  })
})
