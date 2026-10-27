// The canonical agent event journal (lifecycle design: Events, Event rollout stage 1): compact allowlisted events
// per user, bounded to 24 h / 10,000, appended once per stable event id by the writers (status/blockers on the pod
// holding the spoke, catalog presence by one leader, messages and launches on their origin pod, archive by the route).
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { AGENT_EVENTS_AGE_MS, AGENT_EVENTS_MAX, AgentEvents, launchEvent, messageEvent, StatusDiff } from "../src/central/agent/events"
import type { Launch } from "../src/central/agent/launch-store"
import type { Message } from "../src/central/agent/messages"
import { MemoryEventLog } from "../src/central/backend/memory-events"
import { MemoryKv } from "../src/central/backend/memory-kv"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

/** waitFor for an async check. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("eventually timed out")
    await Bun.sleep(10)
  }
}

const journal = (now = () => 1_000) => new AgentEvents({ log: new MemoryEventLog({ now, max: AGENT_EVENTS_MAX, maxAgeMs: AGENT_EVENTS_AGE_MS }), kv: new MemoryKv({ now }), now })

describe("AgentEvents", () => {
  test("bounds are 10,000 events and 24 hours per user", () => {
    expect(AGENT_EVENTS_MAX).toBe(10_000)
    expect(AGENT_EVENTS_AGE_MS).toBe(86_400_000)
  })

  test("appends compact events with a stable evt_ id, readable after a log position", async () => {
    const events = journal()
    const start = await events.latest("u1")
    const id = await events.append("u1", { type: "session.changed", family: "session", subject: { sessionID: "ses_1" }, data: { state: "idle" } })
    expect(id).toMatch(/^evt_[0-9a-f]{20}$/)
    const read = await events.since("u1", start)
    expect("records" in read && read.records.map((r) => r.event)).toEqual([{ id, at: 1_000, type: "session.changed", subject: { sessionID: "ses_1" }, data: { state: "idle" } }])
    expect("records" in read && read.records[0]!.family).toBe("session")
  })

  test("appending one event id twice stores it once (idempotent fan-out)", async () => {
    const events = journal()
    const start = await events.latest("u1")
    const input = { id: "evt_00000000000000000001", type: "session.archived", family: "manage" as const, subject: { sessionID: "ses_1" }, data: { archived: true } }
    expect(await events.append("u1", input)).toBe(input.id)
    expect(await events.append("u1", input)).toBe(input.id)
    const read = await events.since("u1", start)
    expect("records" in read && read.records.length).toBe(1)
  })

  test("journals are per user", async () => {
    const events = journal()
    const start = await events.latest("u2")
    await events.append("u1", { type: "session.added", family: "session", subject: { sessionID: "ses_1" }, data: {} })
    const read = await events.since("u2", start)
    expect("records" in read && read.records).toEqual([])
  })
})

describe("compact payloads", () => {
  test("a message event carries no text", () => {
    const message: Message = {
      id: "msg_1",
      kind: "ask",
      from: { kind: "session", sessionID: "ses_1" },
      to: "@web-work",
      recipient: { kind: "session", sessionID: "ses_2" },
      text: "SECRET body text",
      state: "open",
      at: 5,
      hop: 0,
      expiresAt: 99,
    } as Message
    const event = messageEvent(message)
    expect(JSON.stringify(event)).not.toContain("SECRET")
    expect(event).toMatchObject({ type: "message.changed", family: "message", subject: { messageID: "msg_1", sessionID: "ses_2", senderID: "ses_1" }, data: { kind: "ask", state: "open", to: "@web-work" } })
  })

  test("a launch event carries no prompt, reason or labels", () => {
    const launch = {
      id: "lch_1",
      state: "ended",
      reason: "SECRET reason text",
      outcome: "failed",
      sessionID: "ses_9",
      name: "worker",
      by: "app:tok_1",
      spec: { prompt: "SECRET prompt", labels: { team: "SECRET label" } },
    } as unknown as Launch
    const event = launchEvent(launch)
    expect(JSON.stringify(event)).not.toContain("SECRET")
    expect(event).toMatchObject({ type: "launch.changed", family: "launch", subject: { launchID: "lch_1", sessionID: "ses_9" }, data: { state: "ended", outcome: "failed", name: "worker" }, audience: { by: "app:tok_1" } })
  })

  test("status diffs: state with prev, blockers without summaries, nothing when unchanged", () => {
    const diff = new StatusDiff()
    const tree = (state: string, blockers: { kind: string; id: string; summary: string }[]) => [{ id: "ses_1", state, blockers }] as any
    expect(diff.events("ses_1", tree("working", []))).toEqual([{ type: "session.changed", family: "session", subject: { sessionID: "ses_1", rootID: "ses_1" }, data: { state: "working" } }])
    const opened = diff.events("ses_1", tree("blocked", [{ kind: "permission", id: "per_1", summary: "SECRET bash: rm -rf" }]))
    expect(JSON.stringify(opened)).not.toContain("SECRET")
    expect(opened).toEqual([
      { type: "blocker.opened", family: "session", subject: { sessionID: "ses_1", rootID: "ses_1" }, data: { blockerID: "per_1", kind: "permission" } },
      { type: "session.changed", family: "session", subject: { sessionID: "ses_1", rootID: "ses_1" }, data: { state: "blocked", prev: "working" } },
    ])
    expect(diff.events("ses_1", tree("blocked", [{ kind: "permission", id: "per_1", summary: "x" }]))).toEqual([])
    expect(diff.events("ses_1", tree("idle", []))).toEqual([
      { type: "blocker.closed", family: "session", subject: { sessionID: "ses_1", rootID: "ses_1" }, data: { blockerID: "per_1" } },
      { type: "session.changed", family: "session", subject: { sessionID: "ses_1", rootID: "ses_1" }, data: { state: "idle", prev: "blocked" } },
    ])
  })
})

const MANAGE = "hat_fake_manage"
const verifiers: BearerVerifier[] = [{ kind: "app", verify: (token) => (token === MANAGE ? { kind: "app", userID: "local", tokenID: "tok_manage", scopes: ["sessions:manage"] } : undefined) }]

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const event = (type: string, data: Record<string, unknown>) => ({ t: "event" as const, event: { type, data } })

/** Every journal record of the local user since the hub started. */
async function records(hub: Harness, from: string) {
  const read = await hub.agentEvents.since("local", from)
  if (!("records" in read)) throw new Error("journal reset")
  return read.records.map((r) => r.event)
}

describe("writers (over a real hub)", () => {
  test("presence, state and blockers from a spoke are journaled compactly", async () => {
    h = await harness({ agent: { verifiers } } as any)
    const hub = h
    const from = await hub.agentEvents.latest("local")
    const client = await spoke(hub, { sessions: [session("ses_1", { title: "SECRET title", projectName: "hub" })] })
    client.send(event("permission.asked", { sessionID: "ses_1", id: "per_1", action: "bash", resources: ["SECRET rm -rf"] }))
    await eventually(async () => (await records(hub, from)).some((e) => e.type === "blocker.opened"))
    const all = await records(hub, from)
    expect(JSON.stringify(all)).not.toContain("SECRET")
    expect(all.find((e) => e.type === "session.added")).toMatchObject({ subject: { sessionID: "ses_1" } })
    expect(all.find((e) => e.type === "blocker.opened")).toMatchObject({ subject: { sessionID: "ses_1", rootID: "ses_1" }, data: { blockerID: "per_1", kind: "permission" } })
    client.ws.close()
    await eventually(async () => (await records(hub, from)).some((e) => e.type === "session.removed"))
  })

  test("archive changes are journaled once per actual change", async () => {
    h = await harness({ agent: { verifiers } } as any)
    const hub = h
    await spoke(hub, { sessions: [session("ses_1", { title: "API", projectName: "hub" })] })
    await waitFor(() => (hub.store.agentData("local").names?.length ?? 0) === 1)
    const from = await hub.agentEvents.latest("local")
    const put = (archived: boolean) => hub.api("/api/agent/sessions/ses_1/archive", { method: "PUT", json: { archived }, cookie: null, origin: null, headers: { authorization: `Bearer ${MANAGE}` } })
    for (const archived of [true, true, false]) expect((await put(archived)).status).toBe(200)
    const archives = (await records(hub, from)).filter((e) => e.type === "session.archived")
    expect(archives.map((e) => [e.subject.sessionID, e.data.archived])).toEqual([
      ["ses_1", true],
      ["ses_1", false],
    ])
  })

  test("agent messages are journaled with their parties, never their text", async () => {
    h = await harness({ agent: { verifiers } } as any)
    const hub = h
    const client = await spoke(hub, { hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver"] } as any, sessions: [session("ses_1", { title: "API refactor", owned: true }), session("ses_2", { title: "Web work", owned: true })] })
    client.ws.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data))
      if (frame.t === "req" && frame.req.op === "deliver") client.send({ t: "res", id: frame.id, ok: true, result: { delivered: "turn" } })
    })
    await waitFor(() => (hub.store.agentData("local").names?.length ?? 0) === 2)
    const from = await hub.agentEvents.latest("local")
    const res = await hub.api("/api/agent/msg", { method: "POST", json: { to: "@web-work", text: "SECRET message body", from: "@api-refactor" } })
    expect(res.status).toBe(201)
    await eventually(async () => (await records(hub, from)).some((e) => e.type === "message.changed"))
    const read = await hub.agentEvents.since("local", from)
    const record = "records" in read ? read.records.find((r) => r.event.type === "message.changed") : undefined
    expect(JSON.stringify(record)).not.toContain("SECRET")
    expect(record).toMatchObject({ family: "message", event: { subject: { sessionID: "ses_2" }, data: { kind: "msg", from: "@me", to: "@web-work" } }, audience: { parties: ["user", "ses:ses_2"] } })
  })

  test("the console's Archive (view preferences) is journaled per changed session", async () => {
    h = await harness({ agent: { verifiers } } as any)
    const hub = h
    const from = await hub.agentEvents.latest("local")
    const prefs = (hiddenSessions: string[]) => hub.api("/api/prefs/view", { method: "PUT", json: { hiddenSessions } })
    for (const hidden of [["ses_1", "ses_2"], ["ses_1", "ses_2"], ["ses_2"]]) expect((await prefs(hidden)).status).toBe(200)
    const archives = (await records(hub, from)).filter((e) => e.type === "session.archived")
    expect(archives.map((e) => [e.subject.sessionID, e.data.archived])).toEqual([
      ["ses_1", true],
      ["ses_2", true],
      ["ses_1", false],
    ])
  })
})
