// Which notification each OpenCode event raises (registry alerts), and the "all done" detector: one notification
// when a root session and its whole tree settle, not on every root turn (background subagents finishing start
// synthetic continuation turns, which used to send "finished" while other subagents still ran).
import { beforeEach, describe, expect, test } from "bun:test"
import { DONE_SETTLE_MS } from "../src/central/done"
import { LONG_TOOL_MS, Registry, type Alert } from "../src/central/registry"
import type { Hello, SessionInfo } from "../src/protocol"

const hello = (processID: string): Hello => ({
  t: "hello",
  v: 1,
  processID,
  kind: "standalone",
  directory: "/work",
  pid: 42,
  mode: "always",
  opencodeVersion: "2.0.0",
  pluginVersion: "0.0.1",
})
const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: `title ${id}`, directory: "/work", updated: 1, owned: false, ...extra })
const ev = (type: string, data: Record<string, unknown>) => ({ type, data })

let t: number
let queue: Array<{ fn: () => void; due: number }>
const timers = {
  set: (fn: () => void, ms: number) => {
    const task = { fn, due: t + ms }
    queue.push(task)
    return task
  },
  clear: (task: unknown) => {
    queue = queue.filter((x) => x !== task)
  },
}
/** Moves the clock forward by `ms`, running due timers in order. */
const advance = (ms: number) => {
  const to = t + ms
  for (;;) {
    const next = [...queue].sort((a, b) => a.due - b.due)[0]
    if (!next || next.due > to) break
    queue = queue.filter((x) => x !== next)
    t = Math.max(t, next.due)
    next.fn()
  }
  t = to
}

let registry: Registry
let alerts: Alert[]
const kinds = () => alerts.map((a) => a.kind).filter((k) => k !== "activity")
const of = (kind: string) => alerts.filter((a) => a.kind === kind)
/** Sends an event as two processes forward it (the hub sees duplicates). */
const both = (type: string, data: Record<string, unknown>) => {
  registry.observe("c1", ev(type, data))
  registry.observe("c2", ev(type, data))
}

beforeEach(() => {
  t = 1_000_000
  queue = []
  registry = new Registry(() => t, timers)
  registry.connect("c1", { id: "mch_a", name: "laptop" }, hello("p1"))
  registry.setSessions("c1", [session("ses_root", { owned: true, title: "KVM Rewrite" })])
  registry.connect("c2", { id: "mch_a", name: "laptop" }, hello("p2"))
  registry.setSessions("c2", [session("ses_root", { title: "KVM Rewrite" })])
  alerts = []
  registry.subscribeAlerts((alert) => alerts.push(alert))
})

const spawn = (id: string, title: string) => {
  both("session.created", { sessionID: id, parentID: "ses_root", title })
  both("session.execution.started", { sessionID: id })
}
/** A root turn: started, then succeeded `ms` later. */
const rootTurn = (ms = 1000) => {
  both("session.execution.started", { sessionID: "ses_root" })
  advance(ms)
  both("session.execution.succeeded", { sessionID: "ses_root" })
}

describe("all done", () => {
  test("parallel background subagents finishing one by one with continuation turns → exactly one 'all done', after the last settles", () => {
    expect(DONE_SETTLE_MS).toBe(15_000)
    both("session.execution.started", { sessionID: "ses_root" })
    spawn("ses_s1", "S1 EDID")
    spawn("ses_s2", "S2 USB")
    spawn("ses_s3", "S3 macros")
    advance(2000)
    both("session.execution.succeeded", { sessionID: "ses_root" })
    advance(60_000)
    expect(of("done")).toEqual([])
    // Each completion injects a synthetic message: the root runs a short turn (old behaviour: "finished" each time).
    for (const id of ["ses_s1", "ses_s2"]) {
      both("session.execution.succeeded", { sessionID: id })
      advance(200)
      rootTurn(3000)
      advance(60_000)
      expect(of("done")).toEqual([])
    }
    both("session.execution.succeeded", { sessionID: "ses_s3" })
    advance(200)
    rootTurn(3000)
    advance(DONE_SETTLE_MS - 1)
    expect(of("done")).toEqual([])
    advance(1)
    expect(of("done")).toEqual([{ kind: "done", sessionID: "ses_root", title: "KVM Rewrite" }])
    advance(10 * 60_000)
    expect(of("done")).toHaveLength(1)
    // Every root turn is still its own (opt-in) kind.
    expect(of("turn")).toHaveLength(4)
  })

  test("a continuation turn within the settle time postpones it; a new run later gets its own", () => {
    rootTurn()
    advance(DONE_SETTLE_MS - 1000)
    rootTurn(3000)
    advance(DONE_SETTLE_MS - 1)
    expect(of("done")).toEqual([])
    advance(1)
    expect(of("done")).toHaveLength(1)
    rootTurn()
    advance(DONE_SETTLE_MS)
    expect(of("done")).toHaveLength(2)
  })

  test("a pending question suppresses it until answered and the run ends", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    spawn("ses_s1", "S1")
    both("form.created", { form: { id: "frm_1", sessionID: "ses_s1", title: "Which board?" } })
    both("session.execution.succeeded", { sessionID: "ses_root" })
    advance(10 * 60_000)
    expect(of("done")).toEqual([])
    expect(of("question")).toEqual([{ kind: "question", sessionID: "ses_root", title: "KVM Rewrite" }])
    both("form.replied", { sessionID: "ses_s1", id: "frm_1" })
    both("session.execution.succeeded", { sessionID: "ses_s1" })
    rootTurn()
    advance(DONE_SETTLE_MS)
    expect(of("done")).toHaveLength(1)
  })

  test("a running background job suppresses it; the job ending lets it through", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    both("shell.created", { sessionID: "ses_root", id: "sh_1", status: "running", command: "make flash", background: true })
    both("session.execution.succeeded", { sessionID: "ses_root" })
    advance(10 * 60_000)
    expect(of("done")).toEqual([])
    both("shell.exited", { sessionID: "ses_root", id: "sh_1", status: "exited", exit: 0 })
    advance(DONE_SETTLE_MS)
    expect(of("done")).toHaveLength(1)
  })

  test("an open terminal (pty) does not hold it back", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    both("pty.created", { sessionID: "ses_root", id: "pty_1", kind: "pty", status: "running" })
    both("session.execution.succeeded", { sessionID: "ses_root" })
    advance(DONE_SETTLE_MS)
    expect(of("done")).toHaveLength(1)
  })

  test("a run that ended failed or stopped is not 'all done'", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    both("session.execution.failed", { sessionID: "ses_root", error: { type: "provider.internal", message: "HTTP 503: no available server" } })
    advance(DONE_SETTLE_MS * 2)
    both("session.execution.started", { sessionID: "ses_root" })
    both("session.execution.interrupted", { sessionID: "ses_root", reason: "user" })
    advance(DONE_SETTLE_MS * 2)
    expect(of("done")).toEqual([])
  })

  test("not while a hub turn holds the session; after it is released", () => {
    const release = registry.beginTurn("ses_root")
    rootTurn()
    advance(DONE_SETTLE_MS * 2)
    expect(of("done")).toEqual([])
    release()
    advance(DONE_SETTLE_MS)
    expect(of("done")).toHaveLength(1)
  })

  test("not while a device shows the session (and the run counts as seen)", () => {
    registry.setPresence("dev_1", "ses_root", true)
    rootTurn()
    advance(DONE_SETTLE_MS)
    expect(of("done")).toEqual([])
    expect(of("turn")).toEqual([])
  })
})

describe("root run outcomes", () => {
  test("failed carries the reason; a user stop is silent; shutdown and inactivity are 'stopped'", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    registry.observe("c1", ev("session.execution.failed", { sessionID: "ses_root", error: { type: "provider.content-filter", message: "Provider blocked the response" } }))
    expect(of("failed")).toEqual([{ kind: "failed", sessionID: "ses_root", title: "KVM Rewrite", text: "Provider blocked the response" }])
    for (const reason of ["user", "superseded"]) registry.observe("c1", ev("session.execution.interrupted", { sessionID: "ses_root", reason }))
    expect(of("stopped")).toEqual([])
    registry.observe("c1", ev("session.execution.interrupted", { sessionID: "ses_root", reason: "inactivity" }))
    expect(of("stopped")).toEqual([{ kind: "stopped", sessionID: "ses_root", title: "KVM Rewrite", text: "Stopped after inactivity" }])
  })

  test("turn: each root turn, not a subagent's, not one the hub runs", () => {
    both("session.created", { sessionID: "ses_s1", parentID: "ses_root", title: "S1" })
    both("session.execution.started", { sessionID: "ses_s1" })
    both("session.execution.succeeded", { sessionID: "ses_s1" })
    expect(of("turn")).toEqual([])
    rootTurn()
    expect(of("turn")).toEqual([{ kind: "turn", sessionID: "ses_root", title: "KVM Rewrite" }])
    const release = registry.beginTurn("ses_root")
    rootTurn()
    release()
    expect(of("turn")).toHaveLength(1)
  })

  test("retry: once per retry streak of the root", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    both("session.status", { sessionID: "ses_root", status: { type: "retry", attempt: 1, message: "rate limited" } })
    both("session.status", { sessionID: "ses_root", status: { type: "retry", attempt: 2, message: "rate limited" } })
    expect(of("retry")).toEqual([{ kind: "retry", sessionID: "ses_root", title: "KVM Rewrite", text: "Attempt 1: rate limited" }])
    both("session.status", { sessionID: "ses_root", status: { type: "busy" } })
    both("session.status", { sessionID: "ses_root", status: { type: "retry", attempt: 1 } })
    expect(of("retry")).toHaveLength(2)
  })
})

describe("subagents, scripts and long tools", () => {
  test("a subagent finishing or failing: its title as subject, the parent session in the body, once (not a root finish)", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    spawn("ses_s1", "S3 macros")
    spawn("ses_s2", "S4 HID")
    both("session.execution.succeeded", { sessionID: "ses_s1" })
    both("session.execution.failed", { sessionID: "ses_s2", error: { message: "HTTP 413: request body too large" } })
    expect(of("subagentDone")).toEqual([{ kind: "subagentDone", sessionID: "ses_root", title: "KVM Rewrite", subject: "S3 macros", text: "In KVM Rewrite", key: "ses_s1" }])
    expect(of("subagentFailed")).toEqual([{ kind: "subagentFailed", sessionID: "ses_root", title: "KVM Rewrite", subject: "S4 HID", text: "HTTP 413: request body too large", key: "ses_s2" }])
    expect(kinds().filter((k) => k === "turn" || k === "failed" || k === "done")).toEqual([])
  })

  test("background jobs: exit 0 → script finished; non-zero, killed or timed out → script failed; once each", () => {
    both("shell.created", { sessionID: "ses_root", id: "sh_1", status: "running", command: "bun run build", background: true })
    both("shell.created", { sessionID: "ses_root", id: "sh_2", status: "running", command: "make flash", background: true })
    both("shell.created", { sessionID: "ses_root", id: "sh_3", status: "running", command: "sleep 999", background: true })
    both("shell.exited", { sessionID: "ses_root", id: "sh_1", status: "exited", exit: 0 })
    both("shell.exited", { sessionID: "ses_root", id: "sh_2", status: "exited", exit: 1 })
    both("shell.exited", { sessionID: "ses_root", id: "sh_3", status: "killed" })
    expect(of("jobDone")).toEqual([{ kind: "jobDone", sessionID: "ses_root", title: "KVM Rewrite", subject: "exited 0", text: "bun run build", key: "sh_1" }])
    expect(of("jobFailed").map((a) => [a.subject, a.text, a.key])).toEqual([
      ["exited 1", "make flash", "sh_2"],
      ["was killed", "sleep 999", "sh_3"],
    ])
  })

  test("a tool call of at least 30 s → long tool (subagent calls are subagents, not long tools)", () => {
    const tool = (type: string, id: string, extra: Record<string, unknown> = {}) => both(`session.tool.${type}`, { sessionID: "ses_root", assistantMessageID: "msg_1", id, ...extra })
    tool("called", "tl_short", { summary: "ls" })
    advance(1000)
    tool("success", "tl_short")
    tool("called", "tl_long", { summary: "bun test" })
    tool("called", "tl_task", { summary: "explore", childSessionID: "ses_s1" })
    advance(LONG_TOOL_MS + 15_000)
    tool("success", "tl_long")
    tool("success", "tl_task")
    expect(of("longTool")).toEqual([{ kind: "longTool", sessionID: "ses_root", title: "KVM Rewrite", subject: "45s", text: "bun test done", key: "tl_long" }])
  })

  test("nothing but questions and permissions while a device shows the session", () => {
    registry.setPresence("dev_1", "ses_root", true)
    both("session.execution.started", { sessionID: "ses_root" })
    spawn("ses_s1", "S1")
    both("permission.asked", { sessionID: "ses_s1", id: "per_1", action: "bash" })
    both("session.execution.failed", { sessionID: "ses_s1", error: { message: "x" } })
    both("session.execution.failed", { sessionID: "ses_root", error: { message: "x" } })
    expect(kinds()).toEqual(["permission"])
  })
})

describe("model provider errors (providerError)", () => {
  const fail = (sessionID: string, type: string, message: string, status?: number) =>
    both("session.execution.failed", { sessionID, error: { type, message, ...(status !== undefined ? { status } : {}) } })
  const retry = (sessionID: string, attempt: number, errorType: string, message: string) =>
    both("session.status", { sessionID, status: { type: "retry", attempt, message, errorType, errorStatus: 429, next: t + 5000 } })

  test("a root quota failure: providerError once (both processes forward it); 'failed' only for devices without providerError", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    fail("ses_root", "provider.quota", "You exceeded your current quota", 429)
    expect(of("providerError")).toEqual([{ kind: "providerError", sessionID: "ses_root", title: "KVM Rewrite", text: "KVM Rewrite: You exceeded your current quota", key: "ses_root" }])
    expect(of("failed").length).toBeGreaterThan(0)
    expect(of("failed").every((a: any) => a.unlessPref === "providerError")).toBe(true)
  })

  for (const type of ["provider.quota", "provider.free-limit", "provider.auth", "provider.no-route", "provider.unknown", "provider.budget-limit", "provider.spend-limit"]) {
    test(`a root failure of type ${type} raises providerError instead of failed`, () => {
      both("session.execution.started", { sessionID: "ses_root" })
      fail("ses_root", type, "nope")
      expect(of("providerError")).toHaveLength(1)
      expect(of("failed").every((a: any) => a.unlessPref === "providerError")).toBe(true)
    })
  }

  for (const type of ["provider.internal", "provider.rate-limit", "provider.transport", "provider.content-filter", "tool.execution", "unknown"]) {
    test(`a root failure of type ${type} stays 'failed'`, () => {
      both("session.execution.started", { sessionID: "ses_root" })
      fail("ses_root", type, "boom")
      expect(of("providerError")).toEqual([])
      expect(of("failed")).toHaveLength(2)
      expect(of("failed").some((a: any) => a.unlessPref)).toBe(false)
    })
  }

  test("a subagent's auth failure: providerError with the subagent's title, besides subagentFailed", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    spawn("ses_s1", "S3 macros")
    fail("ses_s1", "provider.auth", "Invalid API key", 401)
    expect(of("providerError")).toEqual([{ kind: "providerError", sessionID: "ses_root", title: "KVM Rewrite", text: "S3 macros: Invalid API key", key: "ses_s1" }])
    expect(of("subagentFailed")).toHaveLength(1)
  })

  test("a quota retry raises providerError once per run; the run's final quota failure adds nothing; a new run may raise it again", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    retry("ses_root", 1, "provider.quota", "Quota exceeded")
    retry("ses_root", 2, "provider.quota", "Quota exceeded")
    expect(of("providerError")).toEqual([{ kind: "providerError", sessionID: "ses_root", title: "KVM Rewrite", text: "KVM Rewrite: Quota exceeded", key: "ses_root" }])
    expect(of("retry")).toEqual([{ kind: "retry", sessionID: "ses_root", title: "KVM Rewrite", text: "Attempt 1 · Quota exceeded: Quota exceeded" }])
    fail("ses_root", "provider.quota", "Quota exceeded")
    expect(of("providerError")).toHaveLength(1)
    expect(of("failed").every((a: any) => a.unlessPref === "providerError")).toBe(true)
    both("session.execution.started", { sessionID: "ses_root" })
    fail("ses_root", "provider.quota", "Quota exceeded")
    expect(of("providerError")).toHaveLength(2)
  })

  test("a subagent's auth retry raises providerError; a rate-limit retry does not (its retry push names the type)", () => {
    both("session.execution.started", { sessionID: "ses_root" })
    spawn("ses_s1", "S1")
    retry("ses_s1", 1, "provider.auth", "Unauthorized")
    expect(of("providerError")).toEqual([{ kind: "providerError", sessionID: "ses_root", title: "KVM Rewrite", text: "S1: Unauthorized", key: "ses_s1" }])
    retry("ses_root", 1, "provider.rate-limit", "Slow down")
    expect(of("providerError")).toHaveLength(1)
    expect(of("retry")).toEqual([{ kind: "retry", sessionID: "ses_root", title: "KVM Rewrite", text: "Attempt 1 · Rate limited: Slow down" }])
  })
})
