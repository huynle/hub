// Conversation mode on the hub: utterance (steer), interrupt, conversation on/off, say/heard SSE events,
// finished-push suppression, and re-sending conversation mode to a reconnected owner.
import { afterEach, describe, expect, test } from "bun:test"
import { harness, session, spoke, sse, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

type Client = Awaited<ReturnType<typeof spoke>>

/** Answers every server request with `reply(req)`; `undefined` leaves it pending, an Error answers ok:false. */
function answer(client: Client, reply: (req: any) => unknown) {
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const result = reply(frame.req)
    if (result instanceof Error) client.send({ t: "res", id: frame.id, ok: false, error: result.message })
    else if (result !== undefined) client.send({ t: "res", id: frame.id, ok: true, result })
  })
  return seen
}

const conversationSpoke = (client: Client, inbox = { n: 0 }) =>
  answer(client, (req) => {
    if (req.op === "steer") return { inboxID: `inb_${++inbox.n}` }
    if (req.op === "interrupt") return {}
    if (req.op === "conversation") return { agent: req.on ? "voice" : "build" }
    if (req.op === "turn") return undefined
    return {}
  })

const post = (path: string, json?: unknown) => h.api(path, { method: "POST", json: json ?? {} })

describe("utterance", () => {
  test("routes steer to the owner and returns 202 with the inbox ID", async () => {
    h = await harness()
    const machine = await h.store.addMachine("laptop")
    const svc = await spoke(h, { machine, processID: "svc", hello: { kind: "service" }, sessions: [session("ses_1")] })
    const svcSeen = conversationSpoke(svc)
    const tui = await spoke(h, { machine, processID: "tui", sessions: [session("ses_1", { owned: true })] })
    const tuiSeen = conversationSpoke(tui)
    const res = await post("/api/sessions/ses_1/utterance", { text: "  also check the tests  " })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ inboxID: "inb_1" })
    expect(tuiSeen).toEqual([{ op: "steer", sessionID: "ses_1", text: "also check the tests" }])
    expect(svcSeen).toEqual([])
  })

  test("is accepted while a voice turn holds the session", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const seen = conversationSpoke(client)
    const turn = post("/api/sessions/ses_1/turn", { text: "long task" }).catch(() => undefined)
    await waitFor(() => seen.some((r) => r.op === "turn"))
    const res = await post("/api/sessions/ses_1/utterance", { text: "and hurry" })
    expect(res.status).toBe(202)
    void turn
  })

  test("validates text and requires an owner", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const seen = conversationSpoke(client)
    expect((await post("/api/sessions/ses_1/utterance", { text: "   " })).status).toBe(400)
    expect((await post("/api/sessions/ses_1/utterance", { text: 5 })).status).toBe(400)
    expect((await post("/api/sessions/ses_1/utterance", { text: "x".repeat(4001) })).status).toBe(400)
    expect((await post("/api/sessions/ses_1/utterance", { text: "x".repeat(4000) })).status).toBe(202)
    // 0.3.0: a session none of your machines reports is 404 (as another user's would be).
    const none = await post("/api/sessions/ses_nobody/utterance", { text: "hi" })
    expect(none.status).toBe(404)
    expect(((await none.json()) as any).error).toBe("Not found")
    expect(seen.filter((r) => r.op === "steer")).toHaveLength(1)
  })

  test("spoke error is 502; no answer is 504", async () => {
    h = await harness({ timing: { requestTimeoutMs: 500 } })
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    answer(client, (req) => (req.text === "fail" ? new Error("steer refused") : undefined))
    const failed = await post("/api/sessions/ses_1/utterance", { text: "fail" })
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as any).error).toContain("steer refused")
    expect((await post("/api/sessions/ses_1/utterance", { text: "slow" })).status).toBe(504)
  })
})

describe("interrupt", () => {
  test("sends interrupt to the owner and returns 204; 404 for an unreported session", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const seen = conversationSpoke(client)
    const res = await post("/api/sessions/ses_1/interrupt")
    expect(res.status).toBe(204)
    expect(seen).toEqual([{ op: "interrupt", sessionID: "ses_1" }])
    expect((await post("/api/sessions/ses_nobody/interrupt")).status).toBe(404)
  })
})

describe("conversation mode", () => {
  test("on/off is sent to the owner, returns the agent, emits SSE, and shows in session and catalog", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "Fix bug" })] })
    const seen = conversationSpoke(client)
    const events = sse(await h.api("/api/events"))

    const before = (await (await h.api("/api/sessions/ses_1")).json()) as any
    expect(before).toMatchObject({ id: "ses_1", title: "Fix bug", state: "idle", conversation: false })

    const on = await post("/api/sessions/ses_1/conversation", { on: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ on: true, agent: "voice" })
    expect(seen).toEqual([{ op: "conversation", sessionID: "ses_1", on: true }])
    expect(await events.next((m) => m.type === "conversation")).toEqual({ type: "conversation", sessionID: "ses_1", on: true })
    expect(((await (await h.api("/api/sessions/ses_1")).json()) as any).conversation).toBe(true)
    const machines = (await (await h.api("/api/machines")).json()) as any
    expect(machines.machines[0].processes[0].sessions[0].conversation).toBe(true)

    const off = await post("/api/sessions/ses_1/conversation", { on: false })
    expect(await off.json()).toEqual({ on: false, agent: "build" })
    expect(await events.next((m) => m.type === "conversation")).toEqual({ type: "conversation", sessionID: "ses_1", on: false })
    expect(((await (await h.api("/api/sessions/ses_1")).json()) as any).conversation).toBe(false)
    await events.cancel()
  })

  test("invalid body is 400; unreported session is 404; spoke error leaves it off", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    answer(client, () => new Error("no voice agent"))
    expect((await post("/api/sessions/ses_1/conversation", { on: "yes" })).status).toBe(400)
    expect((await post("/api/sessions/ses_nobody/conversation", { on: true })).status).toBe(404)
    const failed = await post("/api/sessions/ses_1/conversation", { on: true })
    expect(failed.status).toBe(502)
    expect(h.registry.conversation("ses_1")).toBe(false)
  })

  test("GET of an unknown session is 404", async () => {
    h = await harness()
    expect((await h.api("/api/sessions/ses_nobody")).status).toBe(404)
  })
})

describe("auth on conversation routes", () => {
  test("cookie required; POSTs need a same-origin Origin", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const seen = conversationSpoke(client)
    const routes: Array<[string, unknown]> = [
      ["/api/sessions/ses_1/utterance", { text: "hi" }],
      ["/api/sessions/ses_1/interrupt", {}],
      ["/api/sessions/ses_1/conversation", { on: true }],
    ]
    for (const [path, json] of routes) {
      expect((await h.api(path, { method: "POST", json, cookie: null })).status).toBe(401)
      expect((await h.api(path, { method: "POST", json, origin: "https://evil.test" })).status).toBe(403)
      expect((await h.api(path, { method: "POST", json, origin: null })).status).toBe(403)
    }
    expect((await h.api("/api/sessions/ses_1", { cookie: null })).status).toBe(401)
    expect(seen).toEqual([])
  })
})

const event = (type: string, data: Record<string, unknown>) => ({ t: "event" as const, event: { type, data } })
const ended = (sessionID: string, assistantMessageID: string, ordinal: number, text: string) =>
  event("session.text.ended", { sessionID, assistantMessageID, ordinal, text })

describe("say events", () => {
  test("only for root sessions in conversation mode, deduped, skipping blank text", async () => {
    h = await harness()
    const machine = await h.store.addMachine("laptop")
    const client = await spoke(h, {
      machine,
      sessions: [session("ses_1", { owned: true }), session("ses_sub", { parentID: "ses_1" }), session("ses_2", { owned: true })],
    })
    conversationSpoke(client)
    const other = await spoke(h, { machine, processID: "p2", hello: { kind: "service" }, sessions: [session("ses_1")] })
    expect((await post("/api/sessions/ses_1/conversation", { on: true })).status).toBe(200)
    const events = sse(await h.api("/api/events"))
    const says: any[] = []
    const collect = events.next((m) => {
      if (m.type === "say") says.push(m)
      return m.type === "say" && m.text === "Done."
    })

    client.send(ended("ses_1", "msg_1", 0, "Hello there."))
    other.send(ended("ses_1", "msg_1", 0, "Hello there.")) // the same text forwarded by another process
    client.send(ended("ses_1", "msg_1", 1, "  \n "))
    client.send(ended("ses_sub", "msg_s", 0, "Subagent chatter."))
    client.send(ended("ses_2", "msg_2", 0, "Not in conversation mode."))
    client.send(ended("ses_1", "msg_1", 2, "Done."))
    await collect
    expect(says).toEqual([
      { type: "say", sessionID: "ses_1", messageID: "msg_1", ordinal: 0, seq: 0, text: "Hello there." },
      { type: "say", sessionID: "ses_1", messageID: "msg_1", ordinal: 2, seq: 0, text: "Done." },
    ])
    await events.cancel()
  })

  test("stop after conversation mode is switched off", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    conversationSpoke(client)
    await post("/api/sessions/ses_1/conversation", { on: true })
    await post("/api/sessions/ses_1/conversation", { on: false })
    const events = sse(await h.api("/api/events"))
    client.send(ended("ses_1", "msg_1", 0, "Quiet."))
    client.send(event("session.text.delta", { sessionID: "ses_1", delta: "marker" }))
    const first = await events.next((m) => m.type === "say" || m.type === "delta")
    expect(first.type).toBe("delta")
    await events.cancel()
  })

  test("speaks a successful subagent's final text through its conversation root", async () => {
    h = await harness()
    const client = await spoke(h, {
      sessions: [session("ses_root", { owned: true }), session("ses_child", { parentID: "ses_root" })],
    })
    conversationSpoke(client)
    await post("/api/sessions/ses_root/conversation", { on: true })
    const events = sse(await h.api("/api/events"))

    client.send(event("session.execution.started", { sessionID: "ses_child" }))
    client.send(ended("ses_child", "msg_child", 0, "The Brain entry is saved and linked."))
    client.send(event("session.execution.succeeded", { sessionID: "ses_child" }))

    expect(await events.next((m) => m.type === "say")).toEqual({
      type: "say",
      sessionID: "ses_root",
      messageID: "msg_child",
      ordinal: 0,
      text: "The Brain entry is saved and linked.",
    })
    await events.cancel()
  })

  test("speaks late subagent text when success arrives first and dedupes repeated reports", async () => {
    h = await harness()
    const machine = await h.store.addMachine("laptop")
    const sessions = [session("ses_root", { owned: true }), session("ses_child", { parentID: "ses_root" })]
    const client = await spoke(h, { machine, processID: "tui", sessions })
    conversationSpoke(client)
    const other = await spoke(h, { machine, processID: "svc", hello: { kind: "service" }, sessions })
    conversationSpoke(other)
    await post("/api/sessions/ses_root/conversation", { on: true })
    const events = sse(await h.api("/api/events"))
    const says: any[] = []
    const collect = events.next((m) => {
      if (m.type === "say") says.push(m)
      return m.type === "say" && m.text === "Ready to use."
    })

    client.send(event("session.execution.started", { sessionID: "ses_child" }))
    client.send(event("session.execution.succeeded", { sessionID: "ses_child" }))
    client.send(ended("ses_child", "msg_preamble", 0, "Finishing up."))
    client.send(ended("ses_child", "msg_child", 0, "Ready to use."))
    other.send(ended("ses_child", "msg_child", 0, "Ready to use."))

    await collect
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(says).toHaveLength(1)
    expect(says[0]).toMatchObject({ sessionID: "ses_root", messageID: "msg_child", text: "Ready to use." })
    await events.cancel()
  })

  test("speaks only the latest subagent message with its parts in ordinal order", async () => {
    h = await harness()
    const client = await spoke(h, {
      sessions: [session("ses_root", { owned: true }), session("ses_child", { parentID: "ses_root" })],
    })
    conversationSpoke(client)
    await post("/api/sessions/ses_root/conversation", { on: true })
    const events = sse(await h.api("/api/events"))
    const says: any[] = []
    const collect = events.next((m) => {
      if (m.type === "say") says.push(m)
      return m.type === "say" && m.ordinal === 1
    })

    client.send(event("session.execution.started", { sessionID: "ses_child" }))
    client.send(ended("ses_child", "msg_preamble", 0, "I am starting now."))
    client.send(ended("ses_child", "msg_final", 1, "It is ready to use."))
    client.send(ended("ses_child", "msg_final", 0, "The change is complete."))
    client.send(event("session.execution.succeeded", { sessionID: "ses_child" }))

    await collect
    expect(says).toEqual([
      { type: "say", sessionID: "ses_root", messageID: "msg_final", ordinal: 0, text: "The change is complete." },
      { type: "say", sessionID: "ses_root", messageID: "msg_final", ordinal: 1, text: "It is ready to use." },
    ])
    await events.cancel()
  })

  test("a new subagent execution clears text left by its previous run", async () => {
    h = await harness()
    const client = await spoke(h, {
      sessions: [session("ses_root", { owned: true }), session("ses_child", { parentID: "ses_root" })],
    })
    conversationSpoke(client)
    await post("/api/sessions/ses_root/conversation", { on: true })
    const events = sse(await h.api("/api/events"))
    const says: any[] = []
    const collect = events.next((m) => {
      if (m.type === "say") says.push(m)
      return m.type === "say" && m.text === "Root marker."
    })

    client.send(event("session.execution.started", { sessionID: "ses_child" }))
    client.send(ended("ses_child", "msg_old", 0, "Old result."))
    client.send(event("session.execution.started", { sessionID: "ses_child" }))
    client.send(event("session.execution.succeeded", { sessionID: "ses_child" }))
    client.send(ended("ses_root", "msg_root", 0, "Root marker."))

    await collect
    expect(says).toEqual([{ type: "say", sessionID: "ses_root", messageID: "msg_root", ordinal: 0, seq: 0, text: "Root marker." }])
    await events.cancel()
  })

  test("does not speak failed, interrupted, root, or non-conversation child completions (a failure is announced instead)", async () => {
    h = await harness()
    const client = await spoke(h, {
      sessions: [
        session("ses_root", { owned: true }),
        session("ses_failed", { parentID: "ses_root" }),
        session("ses_interrupted", { parentID: "ses_root" }),
        session("ses_quiet", { owned: true }),
        session("ses_quiet_child", { parentID: "ses_quiet" }),
      ],
    })
    conversationSpoke(client)
    await post("/api/sessions/ses_root/conversation", { on: true })
    const events = sse(await h.api("/api/events"))
    const says: any[] = []
    const collect = events.next((m) => {
      if (m.type === "say") says.push(m)
      return m.type === "say" && m.text === "Root marker."
    })

    client.send(ended("ses_failed", "msg_failed", 0, "Do not speak failed."))
    client.send(event("session.execution.failed", { sessionID: "ses_failed", error: { message: "nope" } }))
    client.send(ended("ses_interrupted", "msg_interrupted", 0, "Do not speak interrupted."))
    client.send(event("session.execution.interrupted", { sessionID: "ses_interrupted" }))
    client.send(ended("ses_quiet_child", "msg_quiet", 0, "Do not speak quiet."))
    client.send(event("session.execution.succeeded", { sessionID: "ses_quiet_child" }))
    client.send(ended("ses_root", "msg_root", 0, "Root marker."))

    await collect
    expect(says).toEqual([
      { type: "say", sessionID: "ses_root", messageID: "announce:failed:ses_failed", ordinal: 0, text: "title ses_failed failed: nope." },
      { type: "say", sessionID: "ses_root", messageID: "msg_root", ordinal: 0, seq: 0, text: "Root marker." },
    ])
    await events.cancel()
  })
})

describe("worker announcements", () => {
  async function conversationTree(children: string[]) {
    h = await harness()
    const machine = await h.store.addMachine("laptop")
    const sessions = [session("ses_root", { owned: true }), ...children.map((id) => session(id, { parentID: "ses_root" }))]
    const client = await spoke(h, { machine, sessions })
    conversationSpoke(client)
    const other = await spoke(h, { machine, processID: "svc", hello: { kind: "service" }, sessions })
    conversationSpoke(other)
    await post("/api/sessions/ses_root/conversation", { on: true })
    const events = sse(await h.api("/api/events"))
    const says: any[] = []
    const until = (done: (m: any) => boolean) =>
      events.next((m) => {
        if (m.type === "say") says.push(m)
        return m.type === "say" && done(m)
      })
    return { client, other, events, says, until }
  }

  test("with several workers, results are prefixed with the task's title, in completion order", async () => {
    const { client, events, says, until } = await conversationTree(["ses_deploy", "ses_docs"])
    const collect = until((m) => m.text === "Nothing else changed.")
    client.send(event("session.execution.started", { sessionID: "ses_deploy" }))
    client.send(event("session.execution.started", { sessionID: "ses_docs" }))
    client.send(ended("ses_deploy", "msg_d", 0, "The deploy is green."))
    client.send(event("session.execution.succeeded", { sessionID: "ses_deploy" }))
    client.send(ended("ses_docs", "msg_c", 0, "Docs are updated."))
    client.send(ended("ses_docs", "msg_c", 1, "Nothing else changed."))
    client.send(event("session.execution.succeeded", { sessionID: "ses_docs" }))
    await collect
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(says.map((m) => m.text)).toEqual([
      "title ses_deploy finished: The deploy is green.",
      "title ses_docs finished: Docs are updated.",
      "Nothing else changed.",
    ])
    expect(says[0]).toMatchObject({ sessionID: "ses_root", messageID: "msg_d", ordinal: 0 })
    await events.cancel()
  })

  test("a lone worker's result is read as is", async () => {
    const { client, events, until } = await conversationTree(["ses_only", "ses_idle"])
    const collect = until(() => true)
    client.send(event("session.execution.started", { sessionID: "ses_only" }))
    client.send(ended("ses_only", "msg_o", 0, "All tests pass."))
    client.send(event("session.execution.succeeded", { sessionID: "ses_only" }))
    expect((await collect).text).toBe("All tests pass.")
    await events.cancel()
  })

  test("a result the voice agent already said is not read again", async () => {
    const { client, events, says, until } = await conversationTree(["ses_deploy"])
    const collect = until((m) => m.text === "Marker.")
    client.send(event("session.execution.started", { sessionID: "ses_deploy" }))
    client.send(ended("ses_root", "msg_r", 0, "Good news: the deploy is green!"))
    client.send(ended("ses_deploy", "msg_d", 0, "The deploy is green."))
    client.send(event("session.execution.succeeded", { sessionID: "ses_deploy" }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    client.send(ended("ses_root", "msg_r2", 0, "Marker."))
    await collect
    expect(says.map((m) => m.text)).toEqual(["Good news: the deploy is green!", "Marker."])
    await events.cancel()
  })

  test("a failed worker is announced once with its reason; a stopped one is not", async () => {
    const { client, other, events, says, until } = await conversationTree(["ses_lint", "ses_stop"])
    const collect = until((m) => m.text === "Marker.")
    client.send(event("session.execution.started", { sessionID: "ses_lint" }))
    client.send(event("session.execution.failed", { sessionID: "ses_lint", error: { message: "Rate limit exceeded" } }))
    other.send(event("session.execution.failed", { sessionID: "ses_lint", error: { message: "Rate limit exceeded" } }))
    client.send(event("session.execution.started", { sessionID: "ses_stop" }))
    client.send(event("session.execution.interrupted", { sessionID: "ses_stop" }))
    client.send(ended("ses_root", "msg_r", 0, "Marker."))
    await collect
    expect(says.map((m) => m.text)).toEqual(["title ses_lint failed: Rate limit exceeded.", "Marker."])
    await events.cancel()
  })

  test("a worker that needs permission or asks a question is announced once per request", async () => {
    const { client, other, events, says, until } = await conversationTree(["ses_clean"])
    const collect = until((m) => m.text === "Marker.")
    const asked = event("permission.asked", { sessionID: "ses_clean", id: "per_1", action: "shell", resources: ["rm -rf dist"] })
    client.send(asked)
    other.send(asked)
    const question = event("form.created", { form: { id: "frm_1", sessionID: "ses_clean", title: "Which branch?", fields: [] } })
    client.send(question)
    other.send(question)
    // The root's own permission is on screen already: not announced.
    client.send(event("permission.asked", { sessionID: "ses_root", id: "per_root", action: "shell", resources: ["ls"] }))
    client.send(ended("ses_root", "msg_r", 0, "Marker."))
    await collect
    expect(says.map((m) => m.text)).toEqual(["title ses_clean needs your permission.", "title ses_clean has a question.", "Marker."])
    await events.cancel()
  })
})

describe("heard events", () => {
  test("emitted when an utterance's inbox item is delivered, also if delivery beats the response", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    let n = 0
    client.ws.addEventListener("message", (raw) => {
      const frame = JSON.parse(String(raw.data))
      if (frame.t !== "req" || frame.req.op !== "steer") return
      const inboxID = `inb_${++n}`
      // The second utterance is delivered before the hub has the steer result.
      if (n === 2) client.send(event("session.inbox.delivered", { sessionID: "ses_1", inboxID }))
      client.send({ t: "res", id: frame.id, ok: true, result: { inboxID } })
    })
    const events = sse(await h.api("/api/events"))
    expect(await (await post("/api/sessions/ses_1/utterance", { text: "one" })).json()).toEqual({ inboxID: "inb_1" })
    client.send(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "inb_typed_in_tui" }))
    client.send(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "inb_1" }))
    expect(await events.next((m) => m.type === "heard")).toEqual({ type: "heard", sessionID: "ses_1", inboxID: "inb_1" })
    expect(await (await post("/api/sessions/ses_1/utterance", { text: "two" })).json()).toEqual({ inboxID: "inb_2" })
    expect(await events.next((m) => m.type === "heard")).toEqual({ type: "heard", sessionID: "ses_1", inboxID: "inb_2" })
    await events.cancel()
  })
})

describe("presence", () => {
  test("cookie and same Origin required; validates; marks the session watched until hidden", async () => {
    h = await harness()
    await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const presence = (json: unknown, init: { cookie?: null; origin?: string | null } = {}) =>
      h.api("/api/sessions/ses_1/presence", { method: "POST", json, ...init })
    expect((await presence({ visible: true }, { cookie: null })).status).toBe(401)
    expect((await presence({ visible: true }, { origin: null })).status).toBe(403)
    expect((await presence({ visible: true }, { origin: "https://evil.test" })).status).toBe(403)
    expect((await presence({ visible: "yes" })).status).toBe(400)
    expect(h.registry.watched("ses_1")).toBe(false)
    expect((await presence({ visible: true })).status).toBe(204)
    expect(h.registry.watched("ses_1")).toBe(true)
    expect((await presence({ visible: false })).status).toBe(204)
    expect(h.registry.watched("ses_1")).toBe(false)
  })
})

describe("push in conversation mode", () => {
  test("no turn push while the session is watched (conversation mode or not); a permission still pushes", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "Fix bug" })] })
    conversationSpoke(client)
    await post("/api/sessions/ses_1/conversation", { on: true })
    expect((await post("/api/sessions/ses_1/presence", { visible: true })).status).toBe(204)
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    client.send(event("session.execution.succeeded", { sessionID: "ses_1" }))
    client.send(event("permission.asked", { sessionID: "ses_1", id: "per_1", action: "bash" }))
    await waitFor(() => h.notified.length > 0)
    expect(h.notified).toEqual([{ kind: "permission", sessionID: "ses_1", title: "Fix bug" }])

    await post("/api/sessions/ses_1/conversation", { on: false })
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    client.send(event("session.execution.succeeded", { sessionID: "ses_1" }))
    await Bun.sleep(50)
    expect(h.notified).toHaveLength(1)
    expect((await post("/api/sessions/ses_1/presence", { visible: false })).status).toBe(204)
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    client.send(event("session.execution.succeeded", { sessionID: "ses_1" }))
    await waitFor(() => h.notified.length > 1)
    expect(h.notified[1]).toEqual({ kind: "turn", sessionID: "ses_1", title: "Fix bug" })
  })

  test("when nobody watches, spoken texts and turns are pushed so results reach a locked phone", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "Fix bug" })] })
    conversationSpoke(client)
    await post("/api/sessions/ses_1/conversation", { on: true })
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    client.send(ended("ses_1", "msg_1", 0, "The fix is in and tests pass."))
    client.send(event("session.execution.succeeded", { sessionID: "ses_1" }))
    await waitFor(() => h.notified.length === 2)
    expect(h.notified).toEqual([
      { kind: "say", sessionID: "ses_1", title: "Fix bug", body: "The fix is in and tests pass." },
      { kind: "turn", sessionID: "ses_1", title: "Fix bug" },
    ])
  })
})

describe("conversation mode across reconnects", () => {
  test("re-sent once to the process that owns the session after a reconnect", async () => {
    h = await harness()
    const machine = await h.store.addMachine("laptop")
    const first = await spoke(h, { machine, processID: "a", sessions: [session("ses_1", { owned: true })] })
    const firstSeen = conversationSpoke(first)
    await post("/api/sessions/ses_1/conversation", { on: true })
    first.send({ t: "sessions", sessions: [session("ses_1", { owned: true })] })
    first.close()
    await waitFor(() => h.registry.connections() === 0)
    expect(h.registry.conversation("ses_1")).toBe(true)

    const second = await spoke(h, { machine, processID: "b", sessions: [session("ses_1", { owned: true })] })
    const req = await second.next((f) => f.t === "req")
    expect(req.req).toEqual({ op: "conversation", sessionID: "ses_1", on: true })
    second.send({ t: "res", id: req.id, ok: true, result: { agent: "voice" } })
    second.send({ t: "sessions", sessions: [session("ses_1", { owned: true })] })
    const bystander = await spoke(h, { machine, processID: "c", hello: { kind: "service" }, sessions: [session("ses_1")] })
    const bystanderSeen = conversationSpoke(bystander)
    // Anything else the hub sends now would show up before this answer.
    second.send({ t: "req", id: "ping", req: { op: "pairCode" } })
    await second.next((f) => f.t === "res" && f.id === "ping")
    expect(second.frames.filter((f) => f.t === "req")).toHaveLength(1)
    expect(bystanderSeen).toEqual([])
    expect(firstSeen).toEqual([{ op: "conversation", sessionID: "ses_1", on: true }])
  })
})
