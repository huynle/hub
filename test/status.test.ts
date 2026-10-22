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

describe("StatusBoard: session status, retries and background jobs", () => {
  const shell = (id: string, sessionID: string, status = "running", extra: Record<string, unknown> = {}) => ({ sessionID, id, kind: "shell", command: "sleep 60", status, at: 1000, ...extra })

  test("session.status busy is working, idle is idle again", () => {
    const board = new StatusBoard("ses_root", "Main")
    expect(board.observe(ev("session.status", { sessionID: "ses_root", status: { type: "busy" } }))).toBe(true)
    expect(board.get("ses_root")?.state).toBe("working")
    board.observe(ev("session.status", { sessionID: "ses_root", status: { type: "idle" } }))
    expect(board.get("ses_root")?.state).toBe("idle")
  })

  test("retry is working, carries the attempt and reason, and clears on the next status", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("session.status", { sessionID: "ses_root", status: { type: "retry", attempt: 2, message: "Rate limited" } }))
    expect(board.get("ses_root")).toMatchObject({ state: "working", retry: { attempt: 2, message: "Rate limited" }, detail: "Retrying: Rate limited" })
    board.observe(ev("session.status", { sessionID: "ses_root", status: { type: "busy" } }))
    expect(board.get("ses_root")?.retry).toBeUndefined()
    expect(board.get("ses_root")?.detail).toBeUndefined()
  })

  test("a running background shell keeps the session working after its run ended", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("session.execution.started", { sessionID: "ses_root" }))
    board.observe(ev("shell.created", shell("sh_1", "ses_root")))
    board.observe(ev("session.execution.succeeded", { sessionID: "ses_root" }))
    expect(board.get("ses_root")).toMatchObject({ state: "working", jobs: [{ id: "sh_1", kind: "shell", command: "sleep 60", status: "running", started: 1000 }] })
  })

  test("an exited shell stops counting as work but stays listed with its exit code; deleted drops it", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("shell.created", shell("sh_1", "ses_root")))
    expect(board.observe(ev("shell.exited", { sessionID: "ses_root", id: "sh_1", status: "exited", exit: 0, at: 5000 }))).toBe(true)
    expect(board.get("ses_root")).toMatchObject({ state: "idle", jobs: [{ id: "sh_1", status: "exited", exit: 0, ended: 5000 }] })
    board.observe(ev("shell.deleted", { sessionID: "ses_root", id: "sh_1" }))
    expect(board.get("ses_root")?.jobs).toBeUndefined()
  })

  test("session.shell.started/ended and pty events track jobs of subagent sessions too", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("session.created", { sessionID: "ses_child", parentID: "ses_root", title: "build" }))
    board.observe(ev("session.shell.started", shell("sh_2", "ses_child")))
    board.observe(ev("pty.created", { ...shell("pty_1", "ses_root"), kind: "pty", command: "htop" }))
    expect(board.get("ses_child")?.state).toBe("working")
    expect(board.get("ses_root")?.jobs?.[0]).toMatchObject({ id: "pty_1", kind: "pty", command: "htop" })
    board.observe(ev("session.shell.ended", { sessionID: "ses_child", id: "sh_2", status: "killed", at: 2000 }))
    board.observe(ev("pty.exited", { sessionID: "ses_root", id: "pty_1", status: "exited", exit: 1, at: 3000 }))
    expect(board.get("ses_child")).toMatchObject({ state: "idle", jobs: [{ id: "sh_2", status: "killed" }] })
    expect(board.get("ses_root")).toMatchObject({ state: "idle", jobs: [{ id: "pty_1", status: "exited", exit: 1 }] })
  })

  test("keeps at most a few finished jobs per session, the newest", () => {
    const board = new StatusBoard("ses_root", "Main")
    for (let i = 0; i < 12; i++) {
      board.observe(ev("shell.created", shell(`sh_${i}`, "ses_root")))
      board.observe(ev("shell.exited", { sessionID: "ses_root", id: `sh_${i}`, status: "exited", exit: 0, at: 2000 + i }))
    }
    const jobs = board.get("ses_root")!.jobs!
    expect(jobs.length).toBe(5)
    expect(jobs.at(-1)!.id).toBe("sh_11")
  })

  test("seed sets status and running jobs from a snapshot (spoke startup), replacing earlier running jobs", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("shell.created", shell("old", "ses_root")))
    expect(board.observe(ev("session.seed", { sessionID: "ses_root", status: { type: "busy" }, jobs: [{ id: "sh_9", kind: "shell", command: "make", status: "running", started: 50 }] }))).toBe(true)
    expect(board.get("ses_root")).toMatchObject({ state: "working", jobs: [{ id: "sh_9", command: "make" }] })
    board.observe(ev("session.seed", { sessionID: "ses_root", status: { type: "idle" }, jobs: [] }))
    expect(board.get("ses_root")).toMatchObject({ state: "idle" })
    expect(board.get("ses_root")?.jobs).toBeUndefined()
  })
})

describe("StatusBoard: a seeded busy session goes idle when its run ends", () => {
  test("execution end clears busy/retry (OpenCode v2 sends no idle status)", () => {
    const board = new StatusBoard("ses_root", "Main")
    board.observe(ev("session.seed", { sessionID: "ses_root", status: { type: "busy" }, jobs: [] }))
    board.observe(ev("session.execution.succeeded", { sessionID: "ses_root" }))
    expect(board.get("ses_root")?.state).toBe("idle")
  })

  test("settled: nothing in the tree runs, waits for an answer or has a running background shell (terminals do not count)", () => {
    const board = new StatusBoard("ses_root", "Main")
    expect(board.settled()).toBe(true)
    board.observe(ev("session.created", { sessionID: "ses_a", parentID: "ses_root", title: "S1" }))
    board.observe(ev("session.execution.started", { sessionID: "ses_a" }))
    expect(board.settled()).toBe(false)
    board.observe(ev("session.execution.succeeded", { sessionID: "ses_a" }))
    expect(board.settled()).toBe(true)
    board.observe(ev("form.created", { form: { id: "frm_1", sessionID: "ses_a", title: "Which?" } }))
    expect(board.settled()).toBe(false)
    board.observe(ev("form.replied", { sessionID: "ses_a", id: "frm_1" }))
    expect(board.settled()).toBe(true)
    board.observe(ev("shell.created", { sessionID: "ses_root", id: "sh_1", status: "running", command: "make", background: true }))
    expect(board.settled()).toBe(false)
    board.observe(ev("shell.exited", { sessionID: "ses_root", id: "sh_1", status: "exited", exit: 0 }))
    expect(board.settled()).toBe(true)
    board.observe(ev("pty.created", { sessionID: "ses_root", id: "pty_1", kind: "pty", status: "running" }))
    expect(board.settled()).toBe(true)
    board.observe(ev("session.status", { sessionID: "ses_root", status: { type: "retry", attempt: 2 } }))
    expect(board.settled()).toBe(false)
  })
})
