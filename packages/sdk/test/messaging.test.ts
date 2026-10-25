// The SDK's messaging verbs (phase 2): msg, ask (with a wait loop of ≤60 s polls), message, reply, decline,
// inbox, mute and unmute send what the hub's /api/agent message routes expect and answer the hub's body.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HubClient, isHubError, WAIT_POLL_MAX_S } from "../src/index.ts"
import { fakeHub } from "./fake-hub.ts"

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const client = () => new HubClient({ url: hub.url, token: "tok" })
const seen = () => hub.seen.map(({ method, path, body }) => ({ method, path, ...(body !== undefined ? { body } : {}) }))
const message = (extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  kind: "ask",
  from: { kind: "session", sessionID: "ses_1" },
  to: "@web",
  recipient: { kind: "session", sessionID: "ses_2" },
  text: "ready?",
  state: "open",
  at: 1,
  hop: 1,
  ...extra,
})

describe("msg", () => {
  test("sends to, text and only the options given", async () => {
    const body = { message: message({ kind: "msg", state: "sent" }), delivery: "turn" }
    hub.routes["POST /api/agent/msg"] = () => Response.json(body, { status: 201 })
    expect(await client().msg("@web", "hello")).toEqual(body as any)
    await client().msg("@@reviewer", "all", { all: true, wake: false, urgent: true })
    expect(seen().map((s) => s.body)).toEqual([
      { to: "@web", text: "hello" },
      { to: "@@reviewer", text: "all", wake: false, urgent: true, all: true },
    ])
  })
})

describe("ask", () => {
  test("without wait: one request, expires in seconds", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: message(), delivery: "steer" }, { status: 201 })
    expect((await client().ask("@web", "ready?", { expires: 7200 })).message.state).toBe("open")
    expect(seen()).toEqual([{ method: "POST", path: "/api/agent/ask", body: { to: "@web", text: "ready?", expiresIn: 7200 } }])
  })

  test("wait up to 60 s is one request", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: message({ state: "answered" }), answer: message({ id: "msg_2", kind: "reply", text: "yes" }) }, { status: 201 })
    const asked = await client().ask("@web", "ready?", { wait: 30 })
    expect(asked.answer?.text).toBe("yes")
    expect(seen()).toEqual([{ method: "POST", path: "/api/agent/ask", body: { to: "@web", text: "ready?", wait: 30 } }])
  })

  test("a longer wait loops on GET /messages/:id in polls of at most 60 s until answered", async () => {
    expect(WAIT_POLL_MAX_S).toBe(60)
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: message(), delivery: "steer" }, { status: 201 })
    let polls = 0
    hub.routes["GET /api/agent/messages/msg_1"] = () =>
      Response.json(++polls < 2 ? { message: message() } : { message: message({ state: "declined" }), answer: message({ id: "msg_3", kind: "decline", text: "no" }) })
    const asked = await client().ask("@web", "ready?", { wait: 300 })
    expect(asked).toMatchObject({ message: { state: "declined" }, answer: { kind: "decline" }, delivery: "steer" })
    expect(seen().map((s) => s.path)).toEqual(["/api/agent/ask", "/api/agent/messages/msg_1?wait=60", "/api/agent/messages/msg_1?wait=60"])
    expect(seen()[0]!.body).toEqual({ to: "@web", text: "ready?", wait: 60 })
  })

  test("the loop ends when the wait is spent, the last poll only for what is left", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: message() }, { status: 201 })
    hub.routes["GET /api/agent/messages/msg_1"] = () => Response.json({ message: message() })
    const asked = await client().ask("@web", "ready?", { wait: 150 })
    expect(asked.message.state).toBe("open")
    expect(seen().map((s) => s.path)).toEqual(["/api/agent/ask", "/api/agent/messages/msg_1?wait=60", "/api/agent/messages/msg_1?wait=30"])
  })

  test("all cannot wait", async () => {
    await expect(client().ask("@@reviewer", "q", { all: true, wait: 5 })).rejects.toThrow(/wait/)
    expect(seen()).toEqual([])
  })
})

describe("reading and answering", () => {
  test("message, with an optional wait", async () => {
    hub.routes["GET /api/agent/messages/msg_1"] = () => Response.json({ message: message() })
    expect((await client().message("msg_1")).message.id).toBe("msg_1")
    await client().message("msg_1", { wait: 10 })
    expect(seen().map((s) => s.path)).toEqual(["/api/agent/messages/msg_1", "/api/agent/messages/msg_1?wait=10"])
  })

  test("reply and decline answer by message id", async () => {
    hub.routes["POST /api/agent/reply"] = () => Response.json({ message: message({ kind: "reply" }), original: message({ state: "answered" }) }, { status: 201 })
    hub.routes["POST /api/agent/decline"] = () => Response.json({ message: message({ kind: "decline" }), original: message({ state: "declined" }) }, { status: 201 })
    expect((await client().reply("msg_1", "yes")).original.state).toBe("answered")
    await client().reply("msg_1", "later", { wake: false })
    expect((await client().decline("msg_1", "not mine")).original.state).toBe("declined")
    expect(seen().map((s) => s.body)).toEqual([{ replyTo: "msg_1", text: "yes" }, { replyTo: "msg_1", text: "later", wake: false }, { replyTo: "msg_1", why: "not mine" }])
  })

  test("inbox, mute and unmute", async () => {
    hub.routes["GET /api/agent/inbox"] = () => Response.json({ asks: [], waiting: [], messages: [], muted: [] })
    hub.routes["POST /api/agent/mute"] = () => Response.json({ muted: ["ses_1"] })
    hub.routes["POST /api/agent/unmute"] = () => Response.json({ muted: [] })
    expect((await client().inbox()).muted).toEqual([])
    expect((await client().mute("@api")).muted).toEqual(["ses_1"])
    expect((await client().unmute("ses_1")).muted).toEqual([])
    expect(seen()).toEqual([
      { method: "GET", path: "/api/agent/inbox" },
      { method: "POST", path: "/api/agent/mute", body: { session: "@api" } },
      { method: "POST", path: "/api/agent/unmute", body: { session: "ses_1" } },
    ])
  })

  test("errors are the hub's envelope", async () => {
    hub.routes["POST /api/agent/reply"] = () => Response.json({ error: { code: "gone", message: "already answered" } }, { status: 410 })
    expect(isHubError(await client().reply("msg_1", "x").catch((e: unknown) => e), "gone")).toBe(true)
  })
})
