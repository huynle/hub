// Opt-in "Activity updates": a collapsing push per session, at most one per device interval, summarizing steps of
// interest (subagents, long tools, background jobs ending, the session going idle).
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as registryModule from "../src/central/registry"
import { Registry, type Alert } from "../src/central/registry"
import { Push, type PushSender } from "../src/central/push"
import { DEFAULT_PUSH_PREFS, Store } from "../src/central/store"
import type { Hello, SessionInfo } from "../src/protocol"

// Read through the module so a missing export fails an assertion (RED), not the import.
const ACTIVITY_INTERVAL_MINUTES: number = (registryModule as any).ACTIVITY_INTERVAL_MINUTES ?? 5
const LONG_TOOL_MS: number = (registryModule as any).LONG_TOOL_MS ?? 30_000
const sub = (n: number) => ({ endpoint: `https://push.example/ep${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } })

let store: Store
let clock: number
let timers: Array<{ at: number; fn: () => void; id: number }>
let sent: Array<{ endpoint: string; payload: any; options: any }>
let push: Push
const now = () => clock

const sender: PushSender = async (target, payload, options) => {
  sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload), options })
}
let nextTimer = 1
const fakeTimers = {
  set: (fn: () => void, ms: number) => {
    const id = nextTimer++
    timers.push({ at: clock + ms, fn, id })
    return id
  },
  clear: (id: unknown) => {
    timers = timers.filter((t) => t.id !== id)
  },
}
const advance = async (ms: number) => {
  const end = clock + ms
  for (;;) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    timers = timers.filter((t) => t !== due)
    clock = due.at
    due.fn()
    await Bun.sleep(0)
  }
  clock = end
  await Bun.sleep(0)
}

const step = (kind: string, text: string) => ({ kind, text })
const activity = (p: Push, sessionID: string, s: { kind: string; text: string }, owner = "u1") =>
  (p as any).activity?.({ kind: "activity", sessionID, title: "Main", step: s, owner })

function device(owner = "u1", n = 1, on = true) {
  const d = store.addDevice(`phone ${n}`, owner).device
  store.addPushSubscription(d.id, sub(n))
  if (on) store.setPushPrefs(d.id, { activity: true } as any)
  return d
}

beforeEach(() => {
  store = Store.open(mkdtempSync(path.join(tmpdir(), "hub-digest-")), now)
  clock = 1_000_000
  timers = []
  sent = []
  push = new Push({ store, subject: "mailto:a@b.c", sender, now, timers: fakeTimers } as any)
})

describe("activity digest push", () => {
  test("defaults: 5 minutes, long tools from 30 s", () => {
    expect((registryModule as any).ACTIVITY_INTERVAL_MINUTES).toBe(5)
    expect((registryModule as any).LONG_TOOL_MS).toBe(30_000)
  })

  test("off by default on every device; the toggle is a push pref", async () => {
    expect((DEFAULT_PUSH_PREFS as any).activity).toBe(false)
    device("u1", 1, false)
    activity(push, "ses_1", step("idle", "Finished"))
    await advance(10 * 60_000)
    expect(sent).toEqual([])
  })

  test("a step of interest is sent at once, collapsing per session, normal urgency, short TTL", async () => {
    device()
    activity(push, "ses_1", step("tool", "bash"))
    activity(push, "ses_1", step("tool", "read"))
    activity(push, "ses_1", step("job", "bun run build exited 0"))
    await advance(0)
    expect(sent.length).toBe(1)
    expect(sent[0]!.payload).toEqual({ kind: "activity", sessionID: "ses_1", title: "Main", body: "2 tools · bun run build exited 0" })
    expect(sent[0]!.options).toMatchObject({ urgency: "normal", TTL: 300 })
  })

  test("short tools alone never send; they are counted in the next digest", async () => {
    device()
    for (let i = 0; i < 5; i++) activity(push, "ses_1", step("tool", "read"))
    await advance(30 * 60_000)
    expect(sent).toEqual([])
  })

  test("at most one per session per interval: later steps are collapsed into one at the end of it", async () => {
    device()
    activity(push, "ses_1", step("subagent", "explore started"))
    await advance(0)
    activity(push, "ses_1", step("tool", "bash"))
    activity(push, "ses_1", step("subagent", "explore finished"))
    activity(push, "ses_1", step("idle", "Finished"))
    await advance(ACTIVITY_INTERVAL_MINUTES * 60_000 - 1)
    expect(sent.length).toBe(1)
    await advance(1)
    expect(sent.length).toBe(2)
    expect(sent[1]!.payload.body).toBe("1 tool · explore finished · Finished")
    // Another session has its own window.
    activity(push, "ses_2", step("idle", "Finished"))
    await advance(0)
    expect(sent.length).toBe(3)
  })

  test("the interval is per device (setting, minutes)", async () => {
    const slow = device("u1", 1)
    const fast = device("u1", 2)
    ;(store as any).setActivityMinutes?.(fast.id, 1)
    expect((store as any).activityMinutes?.(slow.id)).toBe(ACTIVITY_INTERVAL_MINUTES)
    activity(push, "ses_1", step("idle", "Finished"))
    await advance(0)
    activity(push, "ses_1", step("job", "sleep 60 exited 0"))
    await advance(60_000)
    expect(sent.map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint, sub(2).endpoint])
  })

  test("muted sessions, quiet hours and other users' devices get nothing", async () => {
    const me = store.upsertUser({ email: "me@example.com", role: "user" }).id
    const other = store.upsertUser({ email: "other@example.com", role: "user" }).id
    const mine = device(me, 1)
    device(other, 2)
    store.setSessionMuted(me, "ses_muted", true)
    activity(push, "ses_muted", step("idle", "Finished"), me)
    store.setQuietHours(mine.id, { start: "00:00", end: "23:59", timeZone: "UTC" })
    activity(push, "ses_1", step("idle", "Finished"), me)
    await advance(10 * 60_000)
    expect(sent).toEqual([])
  })
})

const hello = (processID: string): Hello => ({ t: "hello", v: 1, processID, kind: "standalone", directory: "/work", pid: 1, mode: "always", opencodeVersion: "2", pluginVersion: "0" })
const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: `title ${id}`, directory: "/work", updated: 1, owned: true, ...extra })
const ev = (type: string, data: Record<string, unknown>) => ({ type, data })

describe("registry: activity steps", () => {
  let t: number
  let registry: Registry
  let alerts: Alert[]
  beforeEach(() => {
    t = 1_000_000
    registry = new Registry(() => t)
    alerts = []
    registry.subscribeAlerts((a) => alerts.push(a))
    registry.connect("c1", { id: "m", name: "m" }, hello("p1"))
    registry.setSessions("c1", [session("ses_1"), session("ses_kid", { parentID: "ses_1", title: "explore" })])
  })
  const steps = () => alerts.filter((a) => (a.kind as string) === "activity").map((a) => `${a.sessionID} ${(a as any).step.kind}: ${(a as any).step.text}`)

  test("subagent start and finish, tools (long ones named), job exits and the root going idle", () => {
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_kid" }))
    registry.observe("c1", ev("session.tool.called", { sessionID: "ses_kid", id: "t1", summary: "ls" }))
    registry.observe("c1", ev("session.tool.success", { sessionID: "ses_kid", id: "t1" }))
    registry.observe("c1", ev("session.tool.input.started", { sessionID: "ses_1", id: "t2", name: "bash" }))
    registry.observe("c1", ev("session.tool.called", { sessionID: "ses_1", id: "t2", summary: "bun test" }))
    t += LONG_TOOL_MS + 5000
    registry.observe("c1", ev("session.tool.failed", { sessionID: "ses_1", id: "t2", error: "exit 1" }))
    registry.observe("c1", ev("shell.created", { sessionID: "ses_kid", id: "sh_1", kind: "shell", command: "sleep 60", status: "running", at: t }))
    registry.observe("c1", ev("shell.exited", { sessionID: "ses_kid", id: "sh_1", kind: "shell", status: "exited", exit: 0, at: t }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_kid" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(steps()).toEqual([
      "ses_1 subagent: explore started",
      "ses_1 tool: ls",
      "ses_1 long: bun test failed (35s)",
      "ses_1 job: sleep 60 exited 0",
      "ses_1 subagent: explore finished",
      "ses_1 idle: Finished",
    ])
  })

  test("nothing while a device shows the session", () => {
    registry.setPresence("dev", "ses_1", true)
    registry.observe("c1", ev("session.execution.started", { sessionID: "ses_kid" }))
    registry.observe("c1", ev("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(steps()).toEqual([])
  })
})
