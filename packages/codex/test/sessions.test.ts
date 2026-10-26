// CodexSessions: the Codex spoke's view of the threads it is attached to, driven by app-server notifications and
// server requests, and serving the hub's ops through app-server methods (spike v0hsdqhm):
// turn → turn/start (waits for turn/completed), steer → turn/steer, interrupt/stop → turn/interrupt,
// permission → the approval request's response (first answer wins: answered elsewhere → gone),
// deliver → thread/inject_items (wake false) or turn/steer / turn/start, create → thread/start.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harnessEventProblem, type DeliverRequest, type HarnessEvent, type SessionInfo } from "../../protocol/src/index.ts"
import { codexSessionID, requestKey } from "../src/ids.ts"
import { RpcError } from "../src/jsonrpc.ts"
import { CodexSessions, type AppServerPort } from "../src/sessions.ts"

const T1 = "01a174bd-b46a-7531-85b7-7ad9d9830551"
const S1 = codexSessionID(T1)
const TURN = "01a174bd-b4b9-7521-9e45-75aec2fe5aab"
const TURN2 = "01a174bd-c000-7521-9e45-75aec2fe5aab"

type Call = { method: string; params: any }

function fakeServer(name = "own", answers: Record<string, (params: any) => unknown> = {}) {
  const calls: Call[] = []
  const responses: { id: number | string; result: unknown }[] = []
  const port: AppServerPort = {
    name,
    async request(method, params) {
      calls.push({ method, params })
      const answer = answers[method]
      if (!answer) return {}
      return answer(params)
    },
    respond(id, result) {
      responses.push({ id, result })
    },
  }
  return { port, calls, responses }
}

function setup(options: { answers?: Record<string, (params: any) => unknown>; turnTimeoutMs?: number; threadDefaults?: Record<string, unknown> } = {}) {
  const events: HarnessEvent[] = []
  const reported = new Map<string, SessionInfo>()
  const ended: string[] = []
  const server = fakeServer("own", {
    "turn/start": () => ({ turn: { id: TURN, status: "inProgress", items: [] } }),
    "turn/steer": () => ({ turnId: TURN }),
    "thread/start": (p) => ({ thread: { id: T1, cwd: p.cwd, name: null, preview: "" } }),
    ...options.answers,
  })
  const sessions = new CodexSessions({
    spoke: {
      upsertSession: (info) => void reported.set(info.id, info),
      endSession: (id) => void (reported.delete(id), ended.push(id)),
      emit: (event) => {
        const problem = harnessEventProblem(event)
        if (problem) throw new Error(`invalid event ${event.type}: ${problem}`)
        events.push(event)
        return true
      },
    },
    createServer: async () => server.port,
    now: () => 1000,
    projectOf: () => undefined,
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.threadDefaults ? { threadDefaults: options.threadDefaults } : {}),
  })
  const attach = (status: unknown = { type: "idle" }) => sessions.attach(server.port, { id: T1, cwd: "/w/app", name: "Fix login", preview: "fix the login", status })
  const note = (method: string, params: Record<string, unknown>) => sessions.notification(server.port, method, { threadId: T1, ...params })
  const types = () => events.map((e) => e.type)
  const last = <K extends HarnessEvent["type"]>(type: K) => events.filter((e) => e.type === type).at(-1)?.data as any
  return { sessions, server, events, reported, ended, attach, note, types, last }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const meta = { kind: "msg", from: "@a", to: "@b" } as const
const deliver = (extra: Partial<DeliverRequest> = {}): DeliverRequest => ({ op: "deliver", sessionID: S1, messageID: "msg_1", text: "hello from @a", wake: true, meta, ...extra })

describe("threads", () => {
  test("attach reports the thread as a hub session and sends session.created", () => {
    const { attach, reported, events } = setup()
    attach()
    expect(reported.get(S1)).toMatchObject({ id: S1, title: "Fix login", directory: "/w/app", owned: true, updated: 1000 })
    expect(events[0]).toEqual({ type: "session.created", data: { sessionID: S1, title: "Fix login" } })
  })

  test("a thread without a name is titled from its preview; attaching twice reports once", () => {
    const { sessions, server, reported, types } = setup()
    sessions.attach(server.port, { id: T1, cwd: "/w", preview: "x".repeat(300) })
    sessions.attach(server.port, { id: T1, cwd: "/w", preview: "again" })
    expect(reported.get(S1)!.title.length).toBeLessThanOrEqual(200)
    expect(types().filter((t) => t === "session.created")).toHaveLength(1)
    expect(sessions.has(S1)).toBe(true)
  })

  test("an active thread is reported busy", () => {
    const { attach, last } = setup()
    attach({ type: "active", activeFlags: [] })
    expect(last("session.status")).toEqual({ sessionID: S1, status: { type: "busy" } })
  })

  test("renamed and closed threads", () => {
    const { attach, note, reported, ended, last, types } = setup()
    attach()
    note("thread/name/updated", { threadName: "Login fixed" })
    expect(last("session.renamed")).toEqual({ sessionID: S1, title: "Login fixed" })
    expect(reported.get(S1)?.title).toBe("Login fixed")
    note("thread/closed", {})
    expect(ended).toEqual([S1])
    expect(types()).not.toContain("session.deleted")
  })

  test("an archived thread is deleted for the hub", () => {
    const { attach, note, ended, last } = setup()
    attach()
    note("thread/archived", {})
    expect(last("session.deleted")).toEqual({ sessionID: S1 })
    expect(ended).toEqual([S1])
  })

  test("a closed connection ends its threads", () => {
    const { sessions, server, attach, ended } = setup()
    attach()
    sessions.connectionClosed(server.port)
    expect(ended).toEqual([S1])
    expect(sessions.has(S1)).toBe(false)
  })

  test("notifications for threads it does not know are ignored", () => {
    const { note, events } = setup()
    note("turn/started", { turn: { id: TURN } })
    expect(events).toEqual([])
  })
})

describe("turn events", () => {
  test("a turn: status, started, user prompt, tools, reply, succeeded, idle", () => {
    const { attach, note, events, types, last } = setup()
    attach()
    note("thread/status/changed", { status: { type: "active", activeFlags: [] } })
    note("turn/started", { turn: { id: TURN, status: "inProgress", items: [] } })
    note("item/started", { turnId: TURN, item: { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "hi" }] } })
    note("item/started", { turnId: TURN, item: { type: "commandExecution", id: "call_1", command: "/bin/bash -lc 'touch made.txt'", status: "inProgress" } })
    note("item/completed", { turnId: TURN, item: { type: "commandExecution", id: "call_1", command: "/bin/bash -lc 'touch made.txt'", status: "completed", exitCode: 0 } })
    note("item/started", { turnId: TURN, item: { type: "fileChange", id: "fc_1", changes: [{ path: "/w/app/a.ts" }], status: "inProgress" } })
    note("item/completed", { turnId: TURN, item: { type: "fileChange", id: "fc_1", changes: [{ path: "/w/app/a.ts" }], status: "failed" } })
    note("item/completed", { turnId: TURN, item: { type: "agentMessage", id: "msg_stub2", text: "done" } })
    note("thread/status/changed", { status: { type: "idle" } })
    note("turn/completed", { turn: { id: TURN, status: "completed", items: [] } })
    expect(types()).toEqual([
      "session.created",
      "session.status",
      "session.execution.started",
      "session.inbox.delivered",
      "session.tool.called",
      "session.tool.success",
      "session.tool.called",
      "session.tool.failed",
      "session.status",
      "session.text.ended",
      "session.execution.succeeded",
    ])
    expect(last("session.execution.started")).toEqual({ sessionID: S1, turnID: TURN })
    expect(last("session.inbox.delivered")).toEqual({ sessionID: S1, inboxID: "u1", origin: "user" })
    expect(events[4]!.data).toMatchObject({ id: "call_1", assistantMessageID: TURN, summary: "touch made.txt" })
    expect(last("session.text.ended")).toEqual({ sessionID: S1, assistantMessageID: "msg_stub2", ordinal: 0, text: "done" })
    expect(last("session.execution.succeeded")).toEqual({ sessionID: S1, turnID: TURN })
    expect(last("session.status")).toEqual({ sessionID: S1, status: { type: "idle" } })
  })

  test("interrupted and failed turns", () => {
    const { attach, note, last } = setup()
    attach()
    note("turn/started", { turn: { id: TURN } })
    note("turn/completed", { turn: { id: TURN, status: "interrupted" } })
    expect(last("session.execution.interrupted")).toEqual({ sessionID: S1, turnID: TURN })
    note("turn/started", { turn: { id: TURN2 } })
    note("turn/completed", { turn: { id: TURN2, status: "failed", error: { message: "model said no" } } })
    expect(last("session.execution.failed")).toEqual({ sessionID: S1, turnID: TURN2, error: { message: "model said no" } })
  })

  test("a declined command is a failed tool", () => {
    const { attach, note, last } = setup()
    attach()
    note("item/started", { turnId: TURN, item: { type: "commandExecution", id: "call_2", command: "rm -rf x", status: "inProgress" } })
    note("item/completed", { turnId: TURN, item: { type: "commandExecution", id: "call_2", command: "rm -rf x", status: "declined" } })
    expect(last("session.tool.failed")).toEqual({ sessionID: S1, id: "call_2", error: "declined" })
  })
})

describe("permission", () => {
  const ask = (s: ReturnType<typeof setup>, id: number | string = 0, extra: Record<string, unknown> = {}) =>
    s.sessions.serverRequest(s.server.port, id, "item/commandExecution/requestApproval", {
      threadId: T1,
      turnId: TURN,
      itemId: "call_1",
      command: "/bin/bash -lc 'touch made.txt'",
      cwd: "/w/app",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      ...extra,
    })

  test("a command approval asks the hub (shell, the command, the tool call)", () => {
    const s = setup()
    s.attach()
    expect(ask(s)).toBe(true)
    expect(s.last("permission.asked")).toEqual({
      sessionID: S1,
      id: requestKey("own", 0),
      action: "shell",
      resources: ["/bin/bash -lc 'touch made.txt'"],
      source: { type: "tool", messageID: TURN, id: "call_1" },
    })
  })

  test("once, always and reject answer accept, acceptForSession and decline; then permission.replied", async () => {
    for (const [decision, answer] of [
      ["once", "accept"],
      ["always", "acceptForSession"],
      ["reject", "decline"],
    ] as const) {
      const s = setup()
      s.attach()
      ask(s, 7)
      const requestID = requestKey("own", 7)
      expect(await s.sessions.permission({ op: "permission", sessionID: S1, requestID, decision })).toEqual({})
      expect(s.server.responses).toEqual([{ id: 7, result: { decision: answer } }])
      expect(s.last("permission.replied")).toEqual({ sessionID: S1, requestID, reply: decision })
    }
  })

  test("decisions the request does not offer fall back: reject → cancel, always → the offered amendment or accept", async () => {
    const s = setup()
    s.attach()
    const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["touch", "made.txt"] } }
    ask(s, 1, { availableDecisions: ["accept", amendment, "cancel"] })
    ask(s, 2, { availableDecisions: ["accept", amendment, "cancel"] })
    ask(s, 3, { availableDecisions: ["accept", "cancel"] })
    await s.sessions.permission({ op: "permission", sessionID: S1, requestID: requestKey("own", 1), decision: "reject" })
    await s.sessions.permission({ op: "permission", sessionID: S1, requestID: requestKey("own", 2), decision: "always" })
    await s.sessions.permission({ op: "permission", sessionID: S1, requestID: requestKey("own", 3), decision: "always" })
    expect(s.server.responses).toEqual([
      { id: 1, result: { decision: "cancel" } },
      { id: 2, result: { decision: amendment } },
      { id: 3, result: { decision: "accept" } },
    ])
  })

  test("answered elsewhere first (serverRequest/resolved): permission.replied without a reply, the hub's answer is gone", async () => {
    const s = setup()
    s.attach()
    ask(s, 4)
    s.note("serverRequest/resolved", { requestId: 4 })
    const requestID = requestKey("own", 4)
    expect(s.last("permission.replied")).toEqual({ sessionID: S1, requestID })
    expect(await s.sessions.permission({ op: "permission", sessionID: S1, requestID, decision: "once" })).toEqual({ gone: true })
    expect(s.server.responses).toEqual([])
  })

  test("an unknown request is gone; resolved after the hub's answer sends nothing more", async () => {
    const s = setup()
    s.attach()
    expect(await s.sessions.permission({ op: "permission", sessionID: S1, requestID: "per_none", decision: "once" })).toEqual({ gone: true })
    ask(s, 5)
    await s.sessions.permission({ op: "permission", sessionID: S1, requestID: requestKey("own", 5), decision: "once" })
    const before = s.events.length
    s.note("serverRequest/resolved", { requestId: 5 })
    expect(s.events.length).toBe(before)
  })

  test("a file change approval asks for edit on the item's files", () => {
    const s = setup()
    s.attach()
    s.note("item/started", { turnId: TURN, item: { type: "fileChange", id: "fc_1", changes: [{ path: "/w/app/a.ts" }, { path: "/w/app/b.ts" }], status: "inProgress" } })
    s.sessions.serverRequest(s.server.port, 9, "item/fileChange/requestApproval", { threadId: T1, turnId: TURN, itemId: "fc_1" })
    expect(s.last("permission.asked")).toMatchObject({ action: "edit", resources: ["/w/app/a.ts", "/w/app/b.ts"], source: { type: "tool", messageID: TURN, id: "fc_1" } })
  })

  test("other server requests and unknown threads are left to other clients", () => {
    const s = setup()
    s.attach()
    expect(s.sessions.serverRequest(s.server.port, 1, "item/tool/requestUserInput", { threadId: T1 })).toBe(false)
    expect(s.sessions.serverRequest(s.server.port, 2, "item/commandExecution/requestApproval", { threadId: "01a174bd-0000-7000-8000-000000000000", itemId: "x", command: "ls" })).toBe(false)
  })

  test("a session's pending requests go when its thread ends", async () => {
    const s = setup()
    s.attach()
    ask(s, 6)
    s.note("thread/closed", {})
    s.attach()
    expect(await s.sessions.permission({ op: "permission", sessionID: S1, requestID: requestKey("own", 6), decision: "once" })).toEqual({ gone: true })
  })
})

describe("turn, steer, interrupt, stop", () => {
  test("turn starts a turn with the text and resolves with its reply when it completes", async () => {
    const s = setup()
    s.attach()
    const result = s.sessions.turn({ op: "turn", sessionID: S1, text: "do it", voiceStyle: false })
    await flush()
    const call = s.server.calls.find((c) => c.method === "turn/start")!
    expect(call.params).toMatchObject({ threadId: T1, input: [{ type: "text", text: "do it", text_elements: [] }] })
    expect(call.params.clientUserMessageId).toMatch(/^inb_/)
    s.note("turn/started", { turn: { id: TURN } })
    s.note("item/started", { turnId: TURN, item: { type: "userMessage", id: "u1", clientId: call.params.clientUserMessageId } })
    s.note("item/completed", { turnId: TURN, item: { type: "agentMessage", id: "m1", text: "did it" } })
    s.note("turn/completed", { turn: { id: TURN, status: "completed" } })
    expect(await result).toEqual({ outcome: "succeeded", reply: "did it" })
    expect(s.last("session.inbox.delivered")).toEqual({ sessionID: S1, inboxID: call.params.clientUserMessageId, origin: "user" })
  })

  test("turn passes images as data URLs; interrupted turns say so", async () => {
    const s = setup()
    s.attach()
    const result = s.sessions.turn({ op: "turn", sessionID: S1, text: "", voiceStyle: false, images: [{ mime: "image/png", data: "AAAA" }] })
    await flush()
    expect(s.server.calls.at(-1)!.params.input).toEqual([{ type: "image", url: "data:image/png;base64,AAAA" }])
    s.note("turn/completed", { turn: { id: TURN, status: "interrupted" } })
    expect(await result).toMatchObject({ outcome: "interrupted", reply: "" })
  })

  test("turn times out with the reply so far", async () => {
    const s = setup({ turnTimeoutMs: 20 })
    s.attach()
    const result = s.sessions.turn({ op: "turn", sessionID: S1, text: "slow", voiceStyle: false })
    await flush()
    s.note("item/completed", { turnId: TURN, item: { type: "agentMessage", id: "m1", text: "partial" } })
    expect(await result).toEqual({ outcome: "timeout", reply: "partial" })
  })

  test("turn on a busy thread is refused", async () => {
    const s = setup()
    s.attach()
    s.note("turn/started", { turn: { id: TURN } })
    await expect(s.sessions.turn({ op: "turn", sessionID: S1, text: "x", voiceStyle: false })).rejects.toThrow(/busy|running/)
  })

  test("steer goes into the running turn; on an idle thread it starts one", async () => {
    const s = setup()
    s.attach()
    s.note("turn/started", { turn: { id: TURN } })
    const steered = await s.sessions.steer({ op: "steer", sessionID: S1, text: "also this" })
    const call = s.server.calls.at(-1)!
    expect(call.method).toBe("turn/steer")
    expect(call.params).toMatchObject({ threadId: T1, expectedTurnId: TURN, input: [{ type: "text", text: "also this", text_elements: [] }] })
    expect(steered.inboxID).toBe(call.params.clientUserMessageId)
    s.note("turn/completed", { turn: { id: TURN, status: "completed" } })
    await s.sessions.steer({ op: "steer", sessionID: S1, text: "next" })
    expect(s.server.calls.at(-1)!.method).toBe("turn/start")
  })

  test("interrupt and stop interrupt the running turn; on an idle thread there is nothing to stop", async () => {
    const s = setup()
    s.attach()
    expect(await s.sessions.stop({ op: "stop", sessionID: S1 })).toEqual({ stopped: [] })
    expect(await s.sessions.interrupt({ op: "interrupt", sessionID: S1 })).toEqual({})
    expect(s.server.calls.filter((c) => c.method === "turn/interrupt")).toEqual([])
    s.note("turn/started", { turn: { id: TURN } })
    expect(await s.sessions.interrupt({ op: "interrupt", sessionID: S1 })).toEqual({})
    expect(await s.sessions.stop({ op: "stop", sessionID: S1 })).toEqual({ stopped: [S1] })
    expect(s.server.calls.filter((c) => c.method === "turn/interrupt").map((c) => c.params)).toEqual([
      { threadId: T1, turnId: TURN },
      { threadId: T1, turnId: TURN },
    ])
  })
})

describe("deliver", () => {
  test("wake false injects the message into the thread (no turn): queued, confirmed once", async () => {
    const s = setup()
    s.attach()
    const admission = await s.sessions.deliver(deliver({ wake: false }))
    const call = s.server.calls.at(-1)!
    expect(call).toEqual({ method: "thread/inject_items", params: { threadId: T1, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello from @a" }] }] } })
    expect(admission).toEqual({ result: { delivered: "queued", inboxID: expect.stringMatching(/^inb_/) }, resumed: false })
    expect(s.last("session.inbox.delivered")).toEqual({ sessionID: S1, inboxID: admission.result.inboxID, origin: "hub" })
  })

  test("wake on an idle thread starts a turn with it; the harness's user message confirms it as the hub's", async () => {
    const s = setup()
    s.attach()
    const admission = await s.sessions.deliver(deliver())
    const call = s.server.calls.at(-1)!
    expect(call.method).toBe("turn/start")
    expect(admission).toEqual({ result: { delivered: "turn", inboxID: call.params.clientUserMessageId }, resumed: true })
    expect(s.types()).not.toContain("session.inbox.delivered")
    s.note("item/started", { turnId: TURN, item: { type: "userMessage", id: "u9", clientId: call.params.clientUserMessageId } })
    expect(s.last("session.inbox.delivered")).toEqual({ sessionID: S1, inboxID: call.params.clientUserMessageId, origin: "hub" })
  })

  test("wake on a busy thread steers it; delivery queue waits for the turn's end, then starts a turn", async () => {
    const s = setup()
    s.attach()
    s.note("turn/started", { turn: { id: TURN } })
    expect((await s.sessions.deliver(deliver({ messageID: "m1" }))).result.delivered).toBe("steer")
    expect(s.server.calls.at(-1)!.method).toBe("turn/steer")
    const queued = await s.sessions.deliver(deliver({ messageID: "m2", meta: { ...meta, delivery: "queue" } }))
    expect(queued).toMatchObject({ result: { delivered: "queued" }, resumed: true })
    expect(s.server.calls.filter((c) => c.method === "turn/start")).toHaveLength(0)
    s.note("turn/completed", { turn: { id: TURN, status: "completed" } })
    await flush()
    const start = s.server.calls.filter((c) => c.method === "turn/start")
    expect(start).toHaveLength(1)
    expect(start[0]!.params.clientUserMessageId).toBe(queued.result.inboxID)
  })

  test("a steer that loses the race to the turn's end starts a turn instead", async () => {
    const s = setup({ answers: { "turn/steer": () => Promise.reject(new RpcError("turn/steer: no active turn to steer", -32600)) } })
    s.attach()
    s.note("turn/started", { turn: { id: TURN } })
    expect((await s.sessions.deliver(deliver())).result.delivered).toBe("turn")
    expect(s.server.calls.map((c) => c.method)).toEqual(["turn/steer", "turn/start"])
  })

  test("a prompt (hubPrompt) is wrapped in its provenance envelope", async () => {
    const s = setup()
    s.attach()
    await s.sessions.deliver(deliver({ wake: false, text: "review this", meta: { kind: "prompt", from: "@lead", to: "@b", grant: "grt_1" } }))
    const text = s.server.calls.at(-1)!.params.items[0].content[0].text as string
    expect(text).toMatch(/^\[hub\] prompt from @lead · grant grt_1 · msg_1/)
    expect(text).toContain("review this")
  })

  test("waking a message first injected without waking starts a turn that points at it (not a second copy)", async () => {
    const s = setup()
    s.attach()
    await s.sessions.deliver(deliver({ wake: false }))
    const woke = await s.sessions.deliver(deliver({ wake: true }))
    expect(woke.result.delivered).toBe("turn")
    const call = s.server.calls.at(-1)!
    expect(call.method).toBe("turn/start")
    expect(call.params.input[0].text).not.toContain("hello from @a")
    expect(call.params.input[0].text).toContain("msg_1")
  })
})

describe("create", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cx-create-"))

  test("create starts a thread in the directory on the spoke's own app-server, reports it and names it", async () => {
    const s = setup({ threadDefaults: { approvalPolicy: "untrusted" } })
    const result = await s.sessions.create({ op: "create", directory: dir, title: "New work" })
    expect(result).toEqual({ sessionID: S1 })
    expect(s.server.calls[0]).toEqual({ method: "thread/start", params: { cwd: dir, approvalPolicy: "untrusted" } })
    expect(s.server.calls[1]).toEqual({ method: "thread/name/set", params: { threadId: T1, name: "New work" } })
    expect(s.reported.get(S1)).toMatchObject({ directory: dir, title: "New work" })
  })

  test("a launch create passes the model; an agent, a relative or missing directory are refused", async () => {
    const s = setup()
    await s.sessions.create({ op: "create", directory: dir, launchID: "lch_1", model: { providerID: "openai", modelID: "gpt-5.1-codex" } })
    expect(s.server.calls[0]!.params).toEqual({ cwd: dir, model: "gpt-5.1-codex" })
    await expect(s.sessions.create({ op: "create", directory: dir, agent: "build" })).rejects.toThrow(/agent/)
    await expect(s.sessions.create({ op: "create", directory: "relative/dir" })).rejects.toThrow(/absolute/)
    await expect(s.sessions.create({ op: "create", directory: path.join(dir, "missing") })).rejects.toThrow(/not a directory|does not exist/)
  })
})
