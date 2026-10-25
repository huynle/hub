// Registry hooks the delivery engine uses (src/central/agent/delivery.ts): idle by real evidence, activity
// recency, human turns typed in the harness (session.inbox.delivered origin "user"), and alerts for the user.
import { describe, expect, test } from "bun:test"
import { INFERRED_IDLE_GRACE_MS, Registry, type Alert } from "../src/central/registry"
import type { Hello, SessionInfo } from "../src/protocol"

const hello = (processID: string, extra: Partial<Hello> = {}): Hello => ({
  t: "hello",
  v: 1,
  processID,
  kind: "standalone",
  directory: "/work",
  pid: 42,
  mode: "always",
  opencodeVersion: "2.0.0",
  pluginVersion: "0.0.1",
  ...extra,
})

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: `title ${id}`, directory: "/work", updated: 1, owned: false, ...extra })
const ev = (type: string, data: Record<string, unknown>) => ({ type, data })
const laptop = { id: "mch_a", name: "laptop" }

function setup(extra: Partial<Hello> = {}) {
  const registry = new Registry(Date.now, undefined, () => "u1")
  registry.connect("c1", laptop, hello("p1", extra))
  registry.setSessions("c1", [session("ses_1", { owned: true }), session("ses_2")])
  return registry
}

describe("idle by real evidence", () => {
  test("a reported session with native evidence, an idle board and no hub turn is idle", () => {
    const registry = setup()
    expect(registry.idle("ses_1")).toBe(true)
    expect(registry.idle("ses_unknown")).toBe(false)
  })

  test("working, blocked or holding a hub turn is not idle", () => {
    const registry = setup()
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    expect(registry.idle("ses_1")).toBe(false)
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(registry.idle("ses_1")).toBe(true)
    const release = registry.beginTurn("ses_1")
    expect(registry.idle("ses_1")).toBe(false)
    release()
    expect(registry.idle("ses_1")).toBe(true)
    registry.observe("c1", ev("permission.asked", { id: "per_1", sessionID: "ses_1" }))
    expect(registry.idle("ses_1")).toBe(false)
  })

  test("hooks evidence counts; rpc without turnEvents, screen and unknown never do", () => {
    expect(setup({ harness: "claude-code", harnessVersion: "1", evidence: "hooks" }).idle("ses_1")).toBe(true)
    for (const evidence of ["rpc", "screen", "telepathy"]) {
      expect(setup({ harness: "x", harnessVersion: "1", evidence }).idle("ses_1")).toBe(false)
    }
  })

  test("rpc evidence counts when the spoke announces turnEvents (confirmed turn completion); screen never does", () => {
    expect(setup({ harness: "codex", harnessVersion: "0.160.0", evidence: "rpc", features: ["turnEvents"] }).idle("ses_1")).toBe(true)
    expect(setup({ harness: "x", harnessVersion: "1", evidence: "screen", features: ["turnEvents"] }).idle("ses_1")).toBe(false)
  })

  test("an inferred interruption counts as idle only after a short grace; a reported one at once", () => {
    let t = 1_000_000
    const registry = new Registry(() => t, undefined, () => "u1")
    registry.connect("c1", laptop, hello("p1", { harness: "claude-code", harnessVersion: "1", evidence: "hooks" }))
    registry.setSessions("c1", [session("ses_1", { owned: true }), session("ses_2", { owned: true })])
    for (const id of ["ses_1", "ses_2"]) registry.observe("c1", ev("session.execution.started", { sessionID: id }))
    registry.observe("c1", ev("session.execution.interrupted", { sessionID: "ses_1", inferred: true }))
    registry.observe("c1", ev("session.execution.interrupted", { sessionID: "ses_2" }))
    expect(registry.idle("ses_2")).toBe(true)
    expect(registry.idle("ses_1")).toBe(false)
    t += INFERRED_IDLE_GRACE_MS - 1
    expect(registry.idle("ses_1")).toBe(false)
    t += 1
    expect(registry.idle("ses_1")).toBe(true)
  })

  test("a turn starting during the grace is not idle; its end is idle at once", () => {
    let t = 1_000_000
    const registry = new Registry(() => t, undefined, () => "u1")
    registry.connect("c1", laptop, hello("p1", { harness: "claude-code", harnessVersion: "1", evidence: "hooks" }))
    registry.setSessions("c1", [session("ses_1", { owned: true })])
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.interrupted", { sessionID: "ses_1", inferred: true }))
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    expect(registry.idle("ses_1")).toBe(false)
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(registry.idle("ses_1")).toBe(true)
  })

  test("the owner's evidence decides when several processes report the session", () => {
    const registry = setup()
    registry.connect("c2", laptop, hello("p2", { harness: "x", harnessVersion: "1", evidence: "screen" }))
    registry.setSessions("c2", [session("ses_1", { owned: true })])
    registry.observe("c2", ev("session.status", { sessionID: "ses_1", status: { type: "idle" } }))
    expect(registry.owner("ses_1")).toBe("c2")
    expect(registry.idle("ses_1")).toBe(false)
  })
})

describe("recency", () => {
  test("grows with each event a process sends for the session", () => {
    const registry = setup()
    expect(registry.recency("ses_1")).toBe(0)
    registry.observe("c1", ev("session.status", { sessionID: "ses_1", status: { type: "idle" } }))
    const first = registry.recency("ses_1")
    registry.observe("c1", ev("session.status", { sessionID: "ses_2", status: { type: "idle" } }))
    expect(registry.recency("ses_2")).toBeGreaterThan(first)
  })
})

describe("human turns", () => {
  test("a prompt the user put in the inbox (origin user) is reported with the session's tenant", () => {
    const registry = setup()
    const turns: Array<[string, string | undefined]> = []
    const off = registry.onHumanTurn((sessionID, tenant) => turns.push([sessionID, tenant]))
    registry.observe("c1", ev("session.inbox.delivered", { sessionID: "ses_1", inboxID: "in_1", origin: "user" }))
    registry.observe("c1", ev("session.inbox.delivered", { sessionID: "ses_1", inboxID: "in_2", origin: "hub" }))
    registry.observe("c1", ev("session.inbox.delivered", { sessionID: "ses_1", inboxID: "in_3" }))
    expect(turns).toEqual([["ses_1", "u1"]])
    off()
    registry.observe("c1", ev("session.inbox.delivered", { sessionID: "ses_1", inboxID: "in_4", origin: "user" }))
    expect(turns).toHaveLength(1)
  })
})

describe("alerts for the user", () => {
  test("alertUser raises an alert for the session's tree, owned by its tenant, even while watched", () => {
    const registry = setup()
    const alerts: Alert[] = []
    registry.subscribeAlerts((alert) => alerts.push(alert))
    registry.alertUser("question", "ses_1", { subject: "Unanswered ask", text: "@beta has not answered" })
    expect(alerts).toEqual([{ kind: "question", sessionID: "ses_1", title: "title ses_1", subject: "Unanswered ask", text: "@beta has not answered", owner: "u1" }])
  })
})
