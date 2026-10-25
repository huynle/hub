import { beforeEach, describe, expect, test } from "bun:test"
import { BusyError, PRESENCE_WINDOW_MS, Registry, WORKER_SPEECH_TTL_MS, type RegistryMessage } from "../src/central/registry"
import type { Hello, SessionInfo } from "../src/protocol"

const hello = (processID: string, kind: "service" | "standalone" = "standalone"): Hello => ({
  t: "hello",
  v: 1,
  processID,
  kind,
  directory: "/work",
  pid: 42,
  mode: "always",
  opencodeVersion: "2.0.0",
  pluginVersion: "0.0.1",
})

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: `title ${id}`,
  directory: "/work",
  updated: 1,
  owned: false,
  ...extra,
})

const ev = (type: string, data: Record<string, unknown>) => ({ type, data })

const laptop = { id: "mch_a", name: "laptop" }
const server = { id: "mch_b", name: "server" }

let registry: Registry
let messages: RegistryMessage[]

beforeEach(() => {
  registry = new Registry()
  messages = []
  registry.subscribe((m) => messages.push(m))
})

describe("catalog", () => {
  test("groups machines → processes → sessions with statuses", () => {
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1", { owned: true }), session("ses_2")])
    registry.connect("c2", server, hello("p2", "service"))
    const catalog = registry.catalog()
    expect(catalog.map((m) => m.id)).toEqual(["mch_a", "mch_b"])
    const p1 = catalog[0]!.processes[0]!
    expect(p1).toMatchObject({ id: "p1", kind: "standalone", directory: "/work", pid: 42, mode: "always" })
    expect(p1.sessions.map((s) => s.id)).toEqual(["ses_1", "ses_2"])
    expect(p1.sessions[0]).toMatchObject({ owned: true, busy: false })
    expect(p1.sessions[0]!.status).toEqual([{ id: "ses_1", title: "title ses_1", state: "idle", blockers: [] }])
    expect(messages.filter((m) => m.type === "catalog").length).toBeGreaterThanOrEqual(3)
    expect(registry.connections()).toBe(2)
  })

  test("disconnect removes the process and sessions reported only by it", () => {
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1")])
    registry.connect("c2", laptop, hello("p2", "service"))
    registry.setSessions("c2", [session("ses_1"), session("ses_2")])
    registry.disconnect("c2")
    expect(registry.hasSession("ses_1")).toBe(true)
    expect(registry.hasSession("ses_2")).toBe(false)
    registry.disconnect("c1")
    expect(registry.catalog()).toEqual([])
    expect(registry.status("ses_1")).toBeUndefined()
  })

  test("processes carry harness, harnessVersion and evidence; an old hello is OpenCode native", () => {
    registry.connect("c1", laptop, hello("p1"))
    registry.connect("c2", laptop, { ...hello("p2"), harness: "claude-code", harnessVersion: "1.0.3", evidence: "hooks", opencodeVersion: "" })
    const [old, claude] = registry.catalog()[0]!.processes
    expect(old).toMatchObject({ harness: "opencode", harnessVersion: "2.0.0", evidence: "native", opencodeVersion: "2.0.0" })
    expect(claude).toMatchObject({ harness: "claude-code", harnessVersion: "1.0.3", evidence: "hooks", opencodeVersion: "" })
  })

  test("supports(): announced features, plus the implied v1 set for an old OpenCode hello", () => {
    registry.connect("old", laptop, hello("p1"))
    registry.connect("oldAuto", laptop, { ...hello("p2"), features: ["autoName"] })
    registry.connect("claude", laptop, { ...hello("p3"), harness: "claude-code", features: ["summary"] })
    expect(registry.supports("old", "timeline")).toBe(true)
    expect(registry.supports("old", "modelPrefs")).toBe(true)
    expect(registry.supports("old", "autoName")).toBe(false)
    expect(registry.supports("oldAuto", "autoName")).toBe(true)
    expect(registry.supports("oldAuto", "create")).toBe(true)
    expect(registry.supports("claude", "summary")).toBe(true)
    expect(registry.supports("claude", "timeline")).toBe(false)
    expect(registry.supports("nope", "timeline")).toBe(false)
  })

  test("ignores frames from unknown connections", () => {
    registry.setSessions("nope", [session("ses_1")])
    registry.observe("nope", ev("session.execution.started", { sessionID: "ses_1" }))
    expect(registry.catalog()).toEqual([])
  })
})

describe("status from events", () => {
  beforeEach(() => {
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1", { owned: true }), session("ses_child", { parentID: "ses_1" })])
    messages = []
  })

  test("execution and child sessions roll up under the root", () => {
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    expect(registry.status("ses_1")?.[0]?.state).toBe("working")
    registry.observe("c1", ev("session.created", { sessionID: "ses_sub", parentID: "ses_1", title: "explore" }))
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_sub" }))
    const status = registry.status("ses_1")!
    expect(status.map((s) => s.id)).toEqual(["ses_1", "ses_child", "ses_sub"])
    expect(status.find((s) => s.id === "ses_sub")?.state).toBe("working")
    expect(messages).toContainEqual({ type: "status", sessionID: "ses_1", sessions: status })
  })

  test("permission blockers dedupe across processes; forms route by form.sessionID", () => {
    registry.connect("c2", laptop, hello("p2", "service"))
    registry.setSessions("c2", [session("ses_1")])
    const asked = ev("permission.asked", { sessionID: "ses_child", id: "per_1", action: "bash", resources: ["ls"] })
    registry.observe("c1", asked)
    registry.observe("c2", asked)
    registry.observe("c1", ev("form.created", { form: { id: "frm_1", sessionID: "ses_1", title: "Pick" } }))
    const status = registry.status("ses_1")!
    expect(status.find((s) => s.id === "ses_child")?.blockers).toEqual([
      { kind: "permission", id: "per_1", summary: "bash: ls", action: "bash", resources: ["ls"] },
    ])
    expect(status[0]?.blockers).toEqual([{ kind: "form", id: "frm_1", summary: "Pick" }])
    expect(status[0]?.state).toBe("blocked")
  })

  test("text deltas of the root session are broadcast", () => {
    registry.observe("c1", ev("session.text.delta", { sessionID: "ses_1", delta: "Hel" }))
    expect(messages).toContainEqual({ type: "delta", sessionID: "ses_1", rootID: "ses_1", text: "Hel" })
  })

  test("renames from a new sessions frame update the title", () => {
    registry.setSessions("c1", [session("ses_1", { owned: true, title: "renamed" })])
    expect(registry.status("ses_1")?.[0]?.title).toBe("renamed")
  })
})

describe("owner selection", () => {
  test("prefers owned processes, most recent activity first", () => {
    registry.connect("svc", laptop, hello("p0", "service"))
    registry.setSessions("svc", [session("ses_1")])
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1", { owned: true })])
    registry.connect("b", laptop, hello("pb"))
    registry.setSessions("b", [session("ses_1", { owned: true })])
    registry.observe("a", ev("session.viewed", { sessionID: "ses_1" }))
    expect(registry.owner("ses_1")).toBe("a")
    registry.observe("b", ev("session.execution.started", { sessionID: "ses_1" }))
    expect(registry.owner("ses_1")).toBe("b")
  })

  test("falls back to a service process that reports the session", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1")])
    registry.connect("svc", laptop, hello("p0", "service"))
    registry.setSessions("svc", [session("ses_1")])
    expect(registry.owner("ses_1")).toBe("svc")
  })

  test("falls back to the service process on the reporting machine", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1")])
    registry.connect("other", server, hello("px", "service"))
    registry.connect("svc", laptop, hello("p0", "service"))
    expect(registry.owner("ses_1")).toBe("svc")
  })

  test("without an owned or service candidate, routes to the reporter with the most recent activity", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1")])
    registry.connect("b", server, hello("pb"))
    registry.setSessions("b", [session("ses_1")])
    registry.connect("elsewhere", { id: "mch_c", name: "nas" }, hello("px", "service"))
    registry.observe("a", ev("session.viewed", { sessionID: "ses_1" }))
    expect(registry.owner("ses_1")).toBe("a")
    registry.observe("b", ev("session.execution.started", { sessionID: "ses_1" }))
    expect(registry.owner("ses_1")).toBe("b")
  })

  test("a single non-owned standalone reporter gets the turn", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1")])
    expect(registry.owner("ses_1")).toBe("a")
  })

  test("no owner when nobody reports the session", () => {
    registry.connect("svc", laptop, hello("p0", "service"))
    expect(registry.owner("ses_missing")).toBeUndefined()
  })
})

describe("turns", () => {
  test("one active turn per session", () => {
    const release = registry.beginTurn("ses_1")
    expect(() => registry.beginTurn("ses_1")).toThrow(BusyError)
    const other = registry.beginTurn("ses_2")
    release()
    registry.beginTurn("ses_1")()
    other()
  })

  test("cancelTurns releases the tree's locks once; the old release cannot free a newer turn", () => {
    let cancelled = 0
    const release = registry.beginTurn("ses_1", () => cancelled++)
    registry.cancelTurns("ses_1")
    registry.cancelTurns("ses_1")
    expect(cancelled).toBe(1)
    const next = registry.beginTurn("ses_1")
    release()
    expect(() => registry.beginTurn("ses_1")).toThrow(BusyError)
    next()
    registry.beginTurn("ses_1")()
  })

  test("busy flag shows in the catalog", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1")])
    const release = registry.beginTurn("ses_1")
    expect(registry.catalog()[0]!.processes[0]!.sessions[0]!.busy).toBe(true)
    release()
    expect(registry.catalog()[0]!.processes[0]!.sessions[0]!.busy).toBe(false)
  })
})

describe("permission routing", () => {
  test("routes to the process that reported a pending permission, with its own session", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1", { owned: true })])
    registry.connect("b", laptop, hello("pb", "service"))
    registry.setSessions("b", [session("ses_1")])
    registry.observe("a", ev("session.created", { sessionID: "ses_sub", parentID: "ses_1", title: "x" }))
    registry.observe("b", ev("permission.asked", { sessionID: "ses_sub", id: "per_1", action: "bash" }))
    expect(registry.permissionTarget("ses_1", "per_1")).toEqual({ connID: "b", sessionID: "ses_sub" })
    expect(registry.permissionTarget("ses_1", "per_2")).toBeUndefined()
    registry.observe("b", ev("permission.replied", { sessionID: "ses_sub", requestID: "per_1" }))
    expect(registry.permissionTarget("ses_1", "per_1")).toBeUndefined()
  })

  test("not routed once the reporting process is gone", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1", { owned: true })])
    registry.connect("b", laptop, hello("pb"))
    registry.observe("b", ev("permission.asked", { sessionID: "ses_1", id: "per_1", action: "bash" }))
    registry.disconnect("b")
    expect(registry.permissionTarget("ses_1", "per_1")).toBeUndefined()
  })
})

describe("form routing", () => {
  test("forms route to every process that forwarded them until replied or cancelled", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1", { owned: true })])
    registry.connect("b", laptop, hello("pb", "service"))
    registry.setSessions("b", [session("ses_1")])
    registry.observe("a", ev("session.created", { sessionID: "ses_sub", parentID: "ses_1", title: "x" }))
    const created = ev("form.created", { form: { id: "frm_1", sessionID: "ses_sub", title: "Q", fields: [{ key: "q0", type: "string" }] } })
    registry.observe("b", created)
    registry.observe("a", created)
    expect(registry.formTargets("ses_1", "frm_1")).toEqual([
      { connID: "b", sessionID: "ses_sub" },
      { connID: "a", sessionID: "ses_sub" },
    ])
    expect(registry.formTargets("ses_1", "frm_2")).toEqual([])
    registry.observe("a", ev("form.replied", { id: "frm_1", sessionID: "ses_sub", answer: {} }))
    expect(registry.formTargets("ses_1", "frm_1")).toEqual([])
  })

  test("a form nobody holds is dropped with its blocker", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.setSessions("a", [session("ses_1", { owned: true })])
    registry.observe("a", ev("form.created", { form: { id: "frm_1", sessionID: "ses_1", title: "Q" } }))
    expect(registry.status("ses_1")![0]!.blockers).toHaveLength(1)
    registry.dropForm("frm_1")
    expect(registry.status("ses_1")![0]!.blockers).toEqual([])
    expect(registry.formTargets("ses_1", "frm_1")).toEqual([])
  })
})

describe("machine connections", () => {
  test("lists connection IDs per machine", () => {
    registry.connect("a", laptop, hello("pa"))
    registry.connect("b", laptop, hello("pb"))
    registry.connect("c", server, hello("pc"))
    expect(registry.connectionsFor("mch_a").sort()).toEqual(["a", "b"])
  })
})

describe("alerts (push triggers)", () => {
  let alerts: any[]
  beforeEach(() => {
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [
      session("ses_1", { owned: true, title: "api-server" }),
      session("ses_child", { parentID: "ses_1" }),
    ])
    registry.connect("c2", laptop, hello("p2", "service"))
    registry.setSessions("c2", [session("ses_1", { title: "api-server" })])
    alerts = []
    registry.subscribeAlerts((alert) => void (alert.kind !== "activity" && alerts.push(alert)))
  })

  test("a new permission anywhere in the tree alerts once for the root, never on SSE", () => {
    const asked = ev("permission.asked", { sessionID: "ses_child", id: "per_1", action: "bash", resources: ["rm -rf"] })
    registry.observe("c1", asked)
    registry.observe("c2", asked)
    expect(alerts).toEqual([{ kind: "permission", sessionID: "ses_1", title: "api-server", requestID: "per_1" }])
    expect(messages.some((m) => (m as any).type === "alert")).toBe(false)
  })

  test("a new form alerts as a question; unknown sessions do not alert", () => {
    registry.observe("c1", ev("form.created", { form: { id: "frm_1", sessionID: "ses_1", title: "Pick" } }))
    registry.observe("c1", ev("form.created", { form: { id: "frm_1", sessionID: "ses_1", title: "Pick" } }))
    registry.observe("c1", ev("permission.asked", { sessionID: "ses_other", id: "per_9", action: "bash" }))
    expect(alerts).toEqual([{ kind: "question", sessionID: "ses_1", title: "api-server" }])
  })

  test("a root turn alerts turn, a root failure failed (with its reason); a child's end is not a root's", () => {
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_child" }))
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.failed", { sessionID: "ses_1", error: { message: "x" } }))
    registry.observe("c1", ev("session.execution.interrupted", { sessionID: "ses_1", reason: "user" }))
    expect(alerts).toEqual([
      { kind: "turn", sessionID: "ses_1", title: "api-server" },
      { kind: "failed", sessionID: "ses_1", title: "api-server", text: "x" },
    ])
  })

  test("no turn alert while a voice turn is active for the session", () => {
    const release = registry.beginTurn("ses_1")
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    release()
    expect(alerts).toEqual([])
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(alerts).toHaveLength(1)
  })

  test("unsubscribe stops alerts", () => {
    const off = registry.subscribeAlerts(() => {})
    off()
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(alerts).toHaveLength(1)
  })
})

describe("activity feed", () => {
  let t: number
  const activity = () => messages.filter((m) => m.type === "activity") as Array<Extract<RegistryMessage, { type: "activity" }>>
  const tool = (type: string, sessionID: string, id: string, extra: Record<string, unknown> = {}) =>
    ev(`session.tool.${type}`, { sessionID, assistantMessageID: "msg_1", id, ...extra })

  beforeEach(() => {
    t = 1000
    registry = new Registry(() => t)
    messages = []
    registry.subscribe((m) => messages.push(m))
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1", { owned: true }), session("ses_kid", { parentID: "ses_1" }), session("ses_2")])
    registry.connect("c2", laptop, hello("p2", "service"))
    registry.setSessions("c2", [session("ses_1")])
  })

  test("a tool runs: name from input.started, summary from called, state from success; duplicates are silent", () => {
    registry.observe("c1", tool("input.started", "ses_1", "tool_1", { name: "bash" }))
    registry.observe("c2", tool("input.started", "ses_1", "tool_1", { name: "bash" }))
    t = 1100
    registry.observe("c1", tool("called", "ses_1", "tool_1", { summary: "bun test", background: false }))
    registry.observe("c2", tool("called", "ses_1", "tool_1", { summary: "bun test", background: false }))
    t = 1200
    registry.observe("c1", tool("success", "ses_1", "tool_1"))
    registry.observe("c2", tool("success", "ses_1", "tool_1"))
    expect(activity()).toEqual([
      { type: "activity", sessionID: "ses_1", rootID: "ses_1", item: { id: "tool_1", sessionID: "ses_1", kind: "tool", tool: "bash", state: "running", at: 1000 } },
      {
        type: "activity",
        sessionID: "ses_1",
        rootID: "ses_1",
        item: { id: "tool_1", sessionID: "ses_1", kind: "tool", tool: "bash", summary: "bun test", state: "running", at: 1000 },
      },
      {
        type: "activity",
        sessionID: "ses_1",
        rootID: "ses_1",
        item: { id: "tool_1", sessionID: "ses_1", kind: "tool", tool: "bash", summary: "bun test", state: "done", at: 1200 },
      },
    ])
  })

  test("child session activity maps to its root; failures carry the error; background is kept", () => {
    registry.observe("c1", tool("input.started", "ses_kid", "tool_k", { name: "task" }))
    registry.observe("c1", tool("called", "ses_kid", "tool_k", { summary: "explore", background: true }))
    registry.observe("c1", tool("failed", "ses_kid", "tool_k", { error: "boom" }))
    const last = activity().at(-1)!
    expect(last).toEqual({
      type: "activity",
      sessionID: "ses_kid",
      rootID: "ses_1",
      item: { id: "tool_k", sessionID: "ses_kid", kind: "tool", tool: "task", summary: "explore", background: true, state: "failed", error: "boom", at: 1000 },
    })
    expect(registry.activity("ses_1").map((i) => i.id)).toEqual(["tool_k"])
    expect(registry.activity("ses_2")).toEqual([])
  })

  test("reasoning shows as thinking until the next activity in that session or the run ends", () => {
    registry.observe("c1", ev("session.reasoning.started", { sessionID: "ses_1", assistantMessageID: "msg_1" }))
    registry.observe("c2", ev("session.reasoning.started", { sessionID: "ses_1", assistantMessageID: "msg_1" }))
    expect(activity().map((m) => [m.item.id, m.item.kind, m.item.state])).toEqual([["thinking:msg_1", "thinking", "running"]])
    t = 1500
    registry.observe("c1", tool("input.started", "ses_1", "tool_1", { name: "read" }))
    expect(activity().map((m) => [m.item.id, m.item.state])).toEqual([
      ["thinking:msg_1", "running"],
      ["thinking:msg_1", "done"],
      ["tool_1", "running"],
    ])
    registry.observe("c1", ev("session.reasoning.started", { sessionID: "ses_1", assistantMessageID: "msg_2" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(activity().slice(-2).map((m) => [m.item.id, m.item.state])).toEqual([
      ["thinking:msg_2", "running"],
      ["thinking:msg_2", "done"],
    ])
    // the still-running tool is left alone: its own success/failure closes it
    expect(registry.activity("ses_1").find((i) => i.id === "tool_1")?.state).toBe("running")
  })

  test("keeps the 30 most recent items per root, newest last; the session view includes them", () => {
    for (let i = 0; i < 35; i++) registry.observe("c1", tool("input.started", i % 2 ? "ses_kid" : "ses_1", `tool_${i}`, { name: "read" }))
    const items = registry.activity("ses_1")
    expect(items).toHaveLength(30)
    expect(items[0]!.id).toBe("tool_5")
    expect(items.at(-1)!.id).toBe("tool_34")
    expect(registry.session("ses_1")?.activity).toEqual(items)
    expect(registry.session("ses_kid")?.activity).toEqual(items)
    // updates to an evicted item are ignored
    registry.observe("c1", tool("success", "ses_1", "tool_0"))
    expect(registry.activity("ses_1")).toHaveLength(30)
    expect(activity()).toHaveLength(35)
  })

  test("events for unknown sessions or tools are ignored", () => {
    registry.observe("c1", tool("input.started", "ses_unknown", "tool_x", { name: "read" }))
    registry.observe("c1", tool("success", "ses_1", "tool_never_started"))
    expect(activity()).toEqual([])
  })
})

describe("presence and conversation-mode alerts", () => {
  let t: number
  let alerts: any[]
  const ended = (sessionID: string, ordinal: number, text: string) =>
    ev("session.text.ended", { sessionID, assistantMessageID: "msg_1", ordinal, text })

  beforeEach(() => {
    t = 1_000_000
    registry = new Registry(() => t)
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1", { owned: true, title: "api-server" }), session("ses_kid", { parentID: "ses_1" })])
    alerts = []
    registry.subscribeAlerts((alert) => void (alert.kind !== "activity" && alerts.push(alert)))
  })

  test("a root is watched for 45 s after any device reports one of its sessions visible; hidden clears that device", () => {
    expect(PRESENCE_WINDOW_MS).toBe(45_000)
    expect(registry.watched("ses_1")).toBe(false)
    registry.setPresence("dev_a", "ses_kid", true)
    expect(registry.watched("ses_1")).toBe(true)
    t += 45_000
    expect(registry.watched("ses_1")).toBe(true)
    t += 1
    expect(registry.watched("ses_1")).toBe(false)
    registry.setPresence("dev_a", "ses_1", true)
    registry.setPresence("dev_b", "ses_1", true)
    registry.setPresence("dev_a", "ses_1", false)
    expect(registry.watched("ses_1")).toBe(true)
    registry.setPresence("dev_b", "ses_1", false)
    expect(registry.watched("ses_1")).toBe(false)
  })

  test("in conversation mode: no turn alert while watched; when not watched, turn and each spoken root text alert", () => {
    registry.setConversation("ses_1", true, "c1")
    registry.setPresence("dev_a", "ses_1", true)
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    registry.observe("c1", ended("ses_1", 0, "Hello."))
    expect(alerts).toEqual([])

    registry.setPresence("dev_a", "ses_1", false)
    registry.observe("c1", ended("ses_1", 1, "All tests pass."))
    registry.observe("c1", ended("ses_kid", 0, "Subagent chatter."))
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(alerts).toEqual([
      { kind: "say", sessionID: "ses_1", title: "api-server", text: "All tests pass." },
      { kind: "turn", sessionID: "ses_1", title: "api-server" },
    ])
  })

  test("outside conversation mode too, presence suppresses run notifications (not questions); texts never alert", () => {
    registry.setPresence("dev_a", "ses_1", true)
    registry.observe("c1", ended("ses_1", 0, "Hello."))
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.failed", { sessionID: "ses_1", error: { message: "x" } }))
    registry.observe("c1", ev("form.created", { form: { id: "frm_1", sessionID: "ses_1", title: "Pick" } }))
    expect(alerts).toEqual([{ kind: "question", sessionID: "ses_1", title: "api-server" }])
    registry.setPresence("dev_a", "ses_1", false)
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(alerts.at(-1)).toEqual({ kind: "turn", sessionID: "ses_1", title: "api-server" })
  })

  test("an expired child result is not spoken when its success arrives late", () => {
    registry.setConversation("ses_1", true, "c1")
    registry.observe("c1", ended("ses_kid", 0, "Stale result."))
    t += WORKER_SPEECH_TTL_MS + 1
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_kid" }))
    expect(alerts).toEqual([])
  })
})

describe("session browser", () => {
  test("catalog sessions carry exposure, workspace, owner process, overall state, blockers and the current activity", () => {
    registry.connect("c1", laptop, hello("p1", "service"))
    registry.setSessions("c1", [
      session("ses_1", { exposed: true, project: "/u/voice", projectName: "voice", directory: "/u/voice/web" }),
      session("ses_kid", { parentID: "ses_1", exposed: true }),
      session("ses_off", { exposed: false, project: "/u/webshop", projectName: "webshop" }),
      // Older spokes only reported exposed sessions and had no exposed field.
      session("ses_old"),
    ])
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.tool.input.started", { sessionID: "ses_kid", id: "tool_1", name: "bash" }))
    registry.observe("c1", ev("session.tool.called", { sessionID: "ses_kid", id: "tool_1", summary: "bun test" }))
    registry.observe("c1", ev("permission.asked", { sessionID: "ses_kid", id: "per_1", action: "shell", resources: ["rm -rf x"] }))
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_off" }))
    registry.observe("c1", ev("session.tool.input.started", { sessionID: "ses_off", id: "tool_9", name: "read" }))
    registry.observe("c1", ev("session.tool.called", { sessionID: "ses_off", id: "tool_9", summary: "a.ts" }))
    const sessions = registry.catalog()[0]!.processes[0]!.sessions
    const byID = new Map(sessions.map((s) => [s.id, s]))
    expect(byID.get("ses_1")).toMatchObject({
      id: "ses_1",
      directory: "/u/voice/web",
      project: "/u/voice",
      projectName: "voice",
      exposed: true,
      processID: "p1",
      machineID: "mch_a",
      state: "blocked",
      conversation: false,
      busy: false,
      now: { kind: "tool", tool: "bash", summary: "bun test" },
      blockers: [{ kind: "permission", id: "per_1", summary: "shell: rm -rf x", sessionID: "ses_kid", sessionTitle: "title ses_kid" }],
    })
    expect(byID.get("ses_kid")).toMatchObject({ state: "blocked", now: { kind: "tool", tool: "bash" } })
    // Voice off only disables speech: status, blockers and activity are tracked like any other session.
    expect(byID.get("ses_off")).toMatchObject({ exposed: false, state: "working", blockers: [], projectName: "webshop" })
    expect(byID.get("ses_off")!.status.map((s) => s.id)).toEqual(["ses_off"])
    expect(byID.get("ses_old")).toMatchObject({ exposed: true, state: "idle" })
    expect(registry.session("ses_off")).toMatchObject({ id: "ses_off", exposed: false, state: "working", project: "/u/webshop" })
    expect(registry.session("ses_off")!.activity.length).toBeGreaterThan(0)
    expect(registry.session("ses_1")).toMatchObject({ exposed: true, state: "blocked", now: { kind: "tool" }, projectName: "voice" })
  })

  test("a session is exposed when any reporting process exposes it; any reporter may own it", () => {
    registry.connect("c1", laptop, hello("p1", "service"))
    registry.setSessions("c1", [session("ses_1", { exposed: false, owned: true }), session("ses_2", { exposed: false })])
    registry.connect("c2", laptop, hello("p2"))
    registry.setSessions("c2", [session("ses_1", { exposed: true })])
    expect(registry.exposed("ses_1")).toBe(true)
    expect(registry.exposed("ses_2")).toBe(false)
    expect(registry.exposed("ses_none")).toBeUndefined()
    // c1 viewed or ran ses_1 recently (owned), so it runs turns even with Voice off.
    expect(registry.owner("ses_1")).toBe("c1")
    expect(registry.owner("ses_2")).toBe("c1")
  })

  test("expose goes to a reporting service process first, else the most recent reporter", () => {
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1", { exposed: false }), session("ses_2", { exposed: false })])
    registry.connect("c2", laptop, hello("p2", "service"))
    registry.setSessions("c2", [session("ses_1", { exposed: false })])
    expect(registry.exposeTarget("ses_1")).toBe("c2")
    expect(registry.exposeTarget("ses_2")).toBe("c1")
    expect(registry.exposeTarget("ses_none")).toBeUndefined()
  })

  test("the machine's service process and the workspaces it reported", () => {
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1", { directory: "/u/other" })])
    expect(registry.serviceFor("mch_a")).toBeUndefined()
    registry.connect("c2", laptop, hello("p2", "service"))
    registry.setSessions("c2", [session("ses_2", { directory: "/u/voice/web", project: "/u/voice" })])
    registry.connect("c3", server, hello("p3", "service"))
    expect(registry.serviceFor("mch_a")).toBe("c2")
    expect(registry.serviceFor("mch_b")).toBe("c3")
    expect(registry.reportsWorkspace("c2", "/u/voice")).toBe(true)
    expect(registry.reportsWorkspace("c2", "/u/voice/web/")).toBe(true)
    expect(registry.reportsWorkspace("c2", "/u/voice/web/../web")).toBe(true)
    expect(registry.reportsWorkspace("c2", "/u/other")).toBe(false)
    expect(registry.reportsWorkspace("c2", "/u")).toBe(false)
  })

  test("an unchanged sessions frame does not re-broadcast the catalog", () => {
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1")])
    const before = messages.filter((m) => m.type === "catalog").length
    registry.setSessions("c1", [session("ses_1")])
    expect(messages.filter((m) => m.type === "catalog").length).toBe(before)
    registry.setSessions("c1", [session("ses_1", { title: "renamed" })])
    expect(messages.filter((m) => m.type === "catalog").length).toBe(before + 1)
  })
})

describe("streaming text and reasoning", () => {
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
  /** Moves the clock to `to`, running due timers in order. */
  const advance = (to: number) => {
    for (;;) {
      const next = [...queue].sort((a, b) => a.due - b.due)[0]
      if (!next || next.due > to) break
      queue = queue.filter((x) => x !== next)
      t = Math.max(t, next.due)
      next.fn()
    }
    t = to
  }
  const streamed = () => messages.filter((m) => m.type === "delta" || m.type === "reasoning") as any[]
  const text = (sessionID: string, assistantMessageID: string, delta: string) => ev("session.text.delta", { sessionID, assistantMessageID, ordinal: 0, delta })
  const thought = (sessionID: string, assistantMessageID: string, delta: string) => ev("session.reasoning.delta", { sessionID, assistantMessageID, delta })

  beforeEach(() => {
    t = 1000
    queue = []
    registry = new Registry(() => t, timers)
    messages = []
    registry.subscribe((m) => messages.push(m))
    registry.connect("c1", laptop, hello("p1"))
    registry.setSessions("c1", [session("ses_1", { owned: true }), session("ses_kid", { parentID: "ses_1" })])
  })

  test("root and subagent text deltas are broadcast with rootID and messageID; unknown sessions are dropped", () => {
    registry.observe("c1", text("ses_1", "msg_1", "Hel"))
    registry.observe("c1", text("ses_kid", "msg_k", "Running"))
    registry.observe("c1", text("ses_unknown", "msg_x", "nope"))
    expect(streamed()).toEqual([
      { type: "delta", sessionID: "ses_1", rootID: "ses_1", messageID: "msg_1", ordinal: 0, text: "Hel" },
      { type: "delta", sessionID: "ses_kid", rootID: "ses_1", messageID: "msg_k", ordinal: 0, text: "Running" },
    ])
  })

  test("reasoning deltas of the root and subagents are broadcast as reasoning messages", () => {
    registry.observe("c1", thought("ses_1", "msg_1", "Let me"))
    registry.observe("c1", thought("ses_kid", "msg_k", "Checking"))
    expect(streamed()).toEqual([
      { type: "reasoning", sessionID: "ses_1", rootID: "ses_1", messageID: "msg_1", delta: "Let me" },
      { type: "reasoning", sessionID: "ses_kid", rootID: "ses_1", messageID: "msg_k", delta: "Checking" },
    ])
  })

  test("bursts are coalesced per session to at most one message per 100 ms, keeping all text in order", () => {
    registry.observe("c1", text("ses_1", "msg_1", "a"))
    expect(streamed().map((m) => m.text)).toEqual(["a"])
    t = 1010
    registry.observe("c1", text("ses_1", "msg_1", "b"))
    t = 1020
    registry.observe("c1", text("ses_1", "msg_1", "c"))
    // another session is not held back by ses_1's window
    registry.observe("c1", text("ses_kid", "msg_k", "k"))
    expect(streamed().map((m) => m.text)).toEqual(["a", "k"])
    advance(1100)
    expect(streamed().map((m) => m.text)).toEqual(["a", "k", "bc"])

    messages = []
    let all = ""
    for (let i = 0; i < 100; i++) {
      advance(1200 + i * 10)
      all += String(i % 10)
      registry.observe("c1", text("ses_1", "msg_1", String(i % 10)))
    }
    advance(5000)
    const out = streamed()
    expect(out.length).toBeLessThanOrEqual(11)
    expect(out.map((m) => m.text).join("")).toBe(all)
  })

  test("a new message or stream kind is a separate message, in arrival order", () => {
    registry.observe("c1", text("ses_1", "msg_1", "a"))
    t = 1010
    registry.observe("c1", thought("ses_1", "msg_2", "r1"))
    registry.observe("c1", thought("ses_1", "msg_2", "r2"))
    registry.observe("c1", text("ses_1", "msg_2", "x"))
    advance(1100)
    expect(streamed().map((m) => [m.type, m.messageID, m.text ?? m.delta])).toEqual([
      ["delta", "msg_1", "a"],
      ["reasoning", "msg_2", "r1r2"],
      ["delta", "msg_2", "x"],
    ])
  })

  test("held deltas are sent before anything else in that session, so say never overtakes its text", () => {
    registry.setConversation("ses_1", true, "c1")
    registry.observe("c1", text("ses_1", "msg_1", "Hel"))
    t = 1010
    registry.observe("c1", text("ses_1", "msg_1", "lo."))
    registry.observe("c1", ev("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "Hello." }))
    const order = () => messages.filter((m) => m.type === "delta" || m.type === "say").map((m: any) => `${m.type}:${m.text}`)
    expect(order()).toEqual(["delta:Hel", "delta:lo.", "say:Hello."])
    advance(2000)
    expect(order()).toEqual(["delta:Hel", "delta:lo.", "say:Hello."])
    expect(queue).toEqual([])
  })

  describe("speak while it writes", () => {
    const says = () => messages.filter((m) => m.type === "say") as any[]
    const ended = (sessionID: string, assistantMessageID: string, text: string, ordinal = 0) =>
      ev("session.text.ended", { sessionID, assistantMessageID, ordinal, text })
    let alerts: any[]
    beforeEach(() => {
      alerts = []
      registry.subscribeAlerts((a) => alerts.push(a))
    })

    test("root text in conversation mode is spoken sentence by sentence while it streams, after its deltas", () => {
      registry.setConversation("ses_1", true, "c1")
      registry.observe("c1", text("ses_1", "msg_1", "I checked the build."))
      expect(says()).toEqual([])
      t = 1010
      registry.observe("c1", text("ses_1", "msg_1", " It"))
      expect(says()).toEqual([{ type: "say", sessionID: "ses_1", messageID: "msg_1", ordinal: 0, seq: 0, text: "I checked the build." }])
      // the held delta went out first, so the say never overtakes the bubble's text
      const order = messages.filter((m) => m.type === "delta" || m.type === "say").map((m: any) => `${m.type}:${m.text}`)
      expect(order).toEqual(["delta:I checked the build.", "delta: It", "say:I checked the build."])
      registry.observe("c1", text("ses_1", "msg_1", " passes! Ship"))
      registry.observe("c1", ended("ses_1", "msg_1", "I checked the build. It passes! Ship it."))
      expect(says().map((m) => [m.seq, m.text])).toEqual([
        [0, "I checked the build."],
        [1, "It passes!"],
        [2, "Ship it."],
      ])
      // nobody watching: one push with the whole text, at the end
      expect(alerts).toEqual([{ kind: "say", sessionID: "ses_1", title: "title ses_1", text: "I checked the build. It passes! Ship it." }])
      advance(5000)
      expect(says()).toHaveLength(3)
    })

    test("text that ends without streamed deltas is spoken as sentences too", () => {
      registry.setConversation("ses_1", true, "c1")
      registry.observe("c1", ended("ses_1", "msg_1", "One. Two."))
      expect(says().map((m) => [m.seq, m.text])).toEqual([
        [0, "One."],
        [1, "Two."],
      ])
    })

    test("two processes reporting the same text: each sentence is spoken once", () => {
      registry.connect("c2", laptop, hello("p2", "service"))
      registry.setSessions("c2", [session("ses_1"), session("ses_kid", { parentID: "ses_1" })])
      registry.setConversation("ses_1", true, "c1")
      for (const conn of ["c1", "c2"]) registry.observe(conn, text("ses_1", "msg_1", "First one. "))
      for (const conn of ["c1", "c2"]) registry.observe(conn, text("ses_1", "msg_1", "Second"))
      for (const conn of ["c1", "c2"]) registry.observe(conn, ended("ses_1", "msg_1", "First one. Second one."))
      expect(says().map((m) => m.text)).toEqual(["First one.", "Second one."])
    })

    test("each text part (ordinal) has its own sentence sequence", () => {
      registry.setConversation("ses_1", true, "c1")
      registry.observe("c1", ended("ses_1", "msg_1", "Part one.", 0))
      registry.observe("c1", ev("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 1, delta: "Part two. And" }))
      registry.observe("c1", ended("ses_1", "msg_1", "Part two. And three.", 1))
      expect(says().map((m) => [m.ordinal, m.seq, m.text])).toEqual([
        [0, 0, "Part one."],
        [1, 0, "Part two."],
        [1, 1, "And three."],
      ])
    })

    test("not spoken: conversation mode off, and subagent text (its paired final message path is unchanged)", () => {
      registry.observe("c1", text("ses_1", "msg_1", "Quiet one. Quiet two."))
      registry.observe("c1", ended("ses_1", "msg_1", "Quiet one. Quiet two."))
      registry.setConversation("ses_1", true, "c1")
      registry.observe("c1", text("ses_kid", "msg_k", "Worker chatter. More chatter."))
      expect(says()).toEqual([])
    })

    test("an interrupted run or conversation mode turning off drops the unspoken rest", () => {
      registry.setConversation("ses_1", true, "c1")
      registry.observe("c1", text("ses_1", "msg_1", "Spoken. Never"))
      registry.observe("c1", ev("session.execution.interrupted", { sessionID: "ses_1" }))
      registry.observe("c1", text("ses_1", "msg_2", "Also spoken. Not"))
      registry.setConversation("ses_1", false)
      registry.setConversation("ses_1", true, "c1")
      registry.observe("c1", text("ses_1", "msg_2", " this. Later"))
      expect(says().map((m) => m.text)).toEqual(["Spoken.", "Also spoken."])
    })
  })

  test("reasoning.ended closes the thinking item; a reasoning delta without a start opens one", () => {
    const activity = () => messages.filter((m) => m.type === "activity").map((m: any) => [m.item.id, m.item.sessionID, m.item.state])
    registry.observe("c1", thought("ses_kid", "msg_k", "hmm"))
    registry.observe("c1", thought("ses_kid", "msg_k", "hmm"))
    expect(activity()).toEqual([["thinking:msg_k", "ses_kid", "running"]])
    registry.observe("c1", ev("session.reasoning.ended", { sessionID: "ses_kid", assistantMessageID: "msg_k" }))
    registry.observe("c1", ev("session.reasoning.ended", { sessionID: "ses_kid", assistantMessageID: "msg_k" }))
    expect(activity()).toEqual([
      ["thinking:msg_k", "ses_kid", "running"],
      ["thinking:msg_k", "ses_kid", "done"],
    ])
    // a late delta of a finished stretch does not reopen it
    registry.observe("c1", thought("ses_kid", "msg_k", "late"))
    expect(activity()).toHaveLength(2)
  })

  test("working sessions in status trees carry since, the time their run started", () => {
    t = 5000
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    t = 6000
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_kid" }))
    const status = () => registry.status("ses_1")!.map((s: any) => [s.id, s.state, s.since])
    expect(status()).toEqual([
      ["ses_1", "working", 5000],
      ["ses_kid", "working", 6000],
    ])
    const last = messages.filter((m) => m.type === "status").at(-1) as any
    expect(last.sessions.map((s: any) => s.since)).toEqual([5000, 6000])
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_kid" }))
    expect(status()[1]).toEqual(["ses_kid", "idle", undefined])
    expect(registry.session("ses_1")?.status[0]).toMatchObject({ since: 5000 })
  })
})
