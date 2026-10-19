// The voice agent's task board: its background workers (child sessions) with state, last activity and how
// long, built from OpenCode events in the spoke and added to each voice turn by the context hook.
import { describe, expect, test } from "bun:test"
import { renderTaskBoard, TASK_BOARD_MAX, TASK_LINE_MAX, TaskBoard } from "../src/spoke/taskboard"

const ROOT = "ses_root"
const ev = (type: string, data: Record<string, unknown>) => ({ type, data })
const created = (id: string, title: string, parentID = ROOT) => ev("session.created", { sessionID: id, parentID, title })
const started = (id: string) => ev("session.execution.started", { sessionID: id })

describe("TaskBoard", () => {
  test("tracks the children of a session: working → done with the result, failed with the reason, stopped", () => {
    const board = new TaskBoard()
    board.observe(ev("session.created", { sessionID: ROOT, title: "Voice" }), 0)
    board.observe(created("ses_a", "Deploy check"), 1000)
    board.observe(started("ses_a"), 1000)
    board.observe(created("ses_b", "Changelog"), 2000)
    board.observe(started("ses_b"), 2000)
    board.observe(created("ses_c", "Lint"), 2500)
    board.observe(started("ses_c"), 2500)
    board.observe(created("ses_other", "Not mine", "ses_elsewhere"), 2500)
    expect(board.children(ROOT).map((t) => [t.id, t.state])).toEqual([
      ["ses_c", "working"],
      ["ses_b", "working"],
      ["ses_a", "working"],
    ])
    board.observe(ev("session.text.ended", { sessionID: "ses_b", assistantMessageID: "m1", ordinal: 0, text: "Updated the changelog." }), 5000)
    board.observe(ev("session.execution.succeeded", { sessionID: "ses_b" }), 5000)
    board.observe(ev("session.execution.failed", { sessionID: "ses_c", error: { type: "x", message: "rate limited" } }), 6000)
    board.observe(ev("session.execution.interrupted", { sessionID: "ses_a" }), 7000)
    const tasks = Object.fromEntries(board.children(ROOT).map((t) => [t.id, t]))
    expect(tasks.ses_b).toMatchObject({ title: "Changelog", state: "done", result: "Updated the changelog.", started: 2000, ended: 5000 })
    expect(tasks.ses_c).toMatchObject({ state: "failed", error: "rate limited" })
    expect(tasks.ses_a).toMatchObject({ state: "stopped" })
    expect(board.children("ses_elsewhere").map((t) => t.id)).toEqual(["ses_other"])
  })

  test("permissions and questions block a worker until answered; tools are its last activity", () => {
    const board = new TaskBoard()
    board.observe(created("ses_a", "Cleanup"), 0)
    board.observe(started("ses_a"), 0)
    board.observe(ev("session.tool.input.started", { sessionID: "ses_a", id: "call_1", name: "shell" }), 100)
    board.observe(ev("session.tool.called", { sessionID: "ses_a", id: "call_1", input: { command: "rm -rf dist" } }), 100)
    expect(board.children(ROOT)[0]).toMatchObject({ state: "working", activity: "shell · rm -rf dist" })
    board.observe(ev("permission.asked", { sessionID: "ses_a", id: "per_1", action: "shell", resources: ["rm -rf dist"] }), 200)
    expect(board.children(ROOT)[0]).toMatchObject({ state: "blocked", blocker: "needs permission: shell: rm -rf dist" })
    board.observe(ev("permission.replied", { sessionID: "ses_a", requestID: "per_1" }), 300)
    expect(board.children(ROOT)[0]!.state).toBe("working")
    board.observe(ev("form.created", { form: { id: "frm_1", sessionID: "ses_a", title: "Which branch?" } }), 400)
    expect(board.children(ROOT)[0]).toMatchObject({ state: "blocked", blocker: "has a question: Which branch?" })
    board.observe(ev("form.replied", { sessionID: "ses_a", id: "frm_1" }), 500)
    expect(board.children(ROOT)[0]!.state).toBe("working")
  })

  test("a continued worker runs again; renames and deletes apply; a parent's own events are not tasks", () => {
    const board = new TaskBoard()
    board.observe(created("ses_a", "Deploy check"), 0)
    board.observe(started("ses_a"), 0)
    board.observe(ev("session.execution.succeeded", { sessionID: "ses_a" }), 1000)
    board.observe(started("ses_a"), 5000)
    expect(board.children(ROOT)[0]).toMatchObject({ state: "working", started: 5000 })
    expect(board.children(ROOT)[0]!.ended).toBeUndefined()
    board.observe(ev("session.renamed", { sessionID: "ses_a", title: "Deploy + staging" }), 5100)
    expect(board.children(ROOT)[0]!.title).toBe("Deploy + staging")
    board.observe(started(ROOT), 5200)
    expect(board.children(ROOT)).toHaveLength(1)
    board.observe(ev("session.deleted", { sessionID: "ses_a" }), 6000)
    expect(board.children(ROOT)).toEqual([])
    expect(board.parentOf("ses_a")).toBeUndefined()
  })

  test("parentOf answers for known workers (the stop tool checks ownership with it)", () => {
    const board = new TaskBoard()
    board.observe(created("ses_a", "A"), 0)
    expect(board.parentOf("ses_a")).toBe(ROOT)
    expect(board.parentOf("ses_unknown")).toBeUndefined()
  })

  test("memory is bounded: old finished tasks are forgotten first", () => {
    const board = new TaskBoard({ limit: 5 })
    for (let i = 0; i < 8; i++) {
      board.observe(created(`ses_${i}`, `T${i}`), i)
      board.observe(started(`ses_${i}`), i)
      if (i < 6) board.observe(ev("session.execution.succeeded", { sessionID: `ses_${i}` }), i + 0.5)
    }
    const ids = board.children(ROOT).map((t) => t.id)
    expect(ids).toHaveLength(5)
    expect(ids).toContain("ses_6")
    expect(ids).toContain("ses_7")
    expect(ids).not.toContain("ses_0")
  })
})

describe("renderTaskBoard", () => {
  test("one line per task with title, sessionID, state, how long and the last activity or result", () => {
    const board = new TaskBoard()
    board.observe(created("ses_a", "Deploy check"), 0)
    board.observe(started("ses_a"), 0)
    board.observe(ev("session.tool.input.started", { sessionID: "ses_a", id: "c1", name: "shell" }), 1000)
    board.observe(ev("session.tool.called", { sessionID: "ses_a", id: "c1", input: { command: "kubectl rollout status" } }), 1000)
    board.observe(created("ses_b", "Changelog"), 10_000)
    board.observe(started("ses_b"), 10_000)
    board.observe(ev("session.text.ended", { sessionID: "ses_b", assistantMessageID: "m", ordinal: 0, text: "Updated the changelog." }), 75_000)
    board.observe(ev("session.execution.succeeded", { sessionID: "ses_b" }), 75_000)
    board.observe(created("ses_c", "Lint"), 20_000)
    board.observe(started("ses_c"), 20_000)
    board.observe(ev("permission.asked", { sessionID: "ses_c", id: "p", action: "shell", resources: ["npm run lint -- --fix"] }), 100_000)
    board.observe(created("ses_d", "Tests"), 30_000)
    board.observe(started("ses_d"), 30_000)
    board.observe(ev("session.execution.failed", { sessionID: "ses_d", error: { message: "model overloaded" } }), 90_000)
    const text = renderTaskBoard(board.children(ROOT), 130_000)!
    const lines = text.split("\n")
    expect(lines[0]).toContain("Task board")
    expect(lines.slice(1)).toEqual([
      '- "Lint" (sessionID ses_c): blocked 30s, needs permission: shell: npm run lint -- --fix',
      '- "Deploy check" (sessionID ses_a): working 2m 10s, last: shell · kubectl rollout status',
      '- "Tests" (sessionID ses_d): failed 40s ago: model overloaded',
      '- "Changelog" (sessionID ses_b): done 55s ago (took 1m 5s): Updated the changelog.',
    ])
  })

  test("nothing to show without tasks", () => {
    expect(renderTaskBoard([], 0)).toBeUndefined()
  })

  test("bounded: at most TASK_BOARD_MAX tasks (live ones first) and TASK_LINE_MAX characters per line", () => {
    const board = new TaskBoard()
    for (let i = 0; i < 12; i++) {
      board.observe(created(`ses_${i}`, `Task ${i} ${"x".repeat(300)}`), i * 1000)
      board.observe(started(`ses_${i}`), i * 1000)
      if (i % 2 === 0) {
        board.observe(ev("session.text.ended", { sessionID: `ses_${i}`, assistantMessageID: "m", ordinal: 0, text: "y".repeat(1000) }), i * 1000 + 500)
        board.observe(ev("session.execution.succeeded", { sessionID: `ses_${i}` }), i * 1000 + 500)
      }
    }
    const lines = renderTaskBoard(board.children(ROOT), 20_000)!.split("\n")
    const tasks = lines.filter((l) => l.startsWith("- "))
    expect(tasks).toHaveLength(TASK_BOARD_MAX)
    for (const line of tasks) expect(line.length).toBeLessThanOrEqual(TASK_LINE_MAX)
    // All six working tasks come before finished ones.
    expect(tasks.slice(0, 6).every((l) => l.includes(": working"))).toBe(true)
    expect(lines.at(-1)).toBe("(4 older tasks not shown)")
  })
})
