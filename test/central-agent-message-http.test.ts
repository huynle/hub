// /api/agent message routes over HTTP (design §3, §8): msg, ask (with a ≤60 s wait), reply, decline, inbox,
// messages/:id, mute/unmute and the per-user messaging switch. Sessions are reported by a real spoke that
// announces "deliver"; session and app tokens come from fake verifiers.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, session, spoke, sse, waitFor, type Harness } from "./central-harness"

const USER = "local"
const TOKENS: Record<string, string> = { ses_1: "hst_fake_ses_1", ses_2: "hst_fake_ses_2", ses_3: "hst_fake_ses_3" }
const APP_SEND = "hat_fake_send"
const APP_READ = "hat_fake_read"

const verifiers: BearerVerifier[] = [
  {
    kind: "session",
    verify: (token) => {
      const sessionID = Object.keys(TOKENS).find((id) => TOKENS[id] === token)
      return sessionID ? { kind: "session", userID: USER, machineID: "mch_x", sessionID } : undefined
    },
  },
  {
    kind: "app",
    verify: (token) =>
      token === APP_SEND
        ? { kind: "app", userID: USER, tokenID: "tok_send", scopes: ["messages:send", "messages:read"], label: "brain" }
        : token === APP_READ
          ? { kind: "app", userID: USER, tokenID: "tok_read", scopes: ["sessions:read"] }
          : undefined,
  },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const bearer = (pathname: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token}` } })
/** A request as a session (its session token). */
const as = (sessionID: string, pathname: string, body?: unknown) => bearer(pathname, TOKENS[sessionID]!, body === undefined ? {} : { method: "POST", json: body })
/** A request as the user (device cookie). */
const asUser = (pathname: string, body?: unknown, method = "POST") => h.api(pathname, body === undefined ? {} : { method, json: body })

/** A hub with ses_1 "API refactor" (@api-refactor), ses_2 "Web work" (@web-work), ses_3 "Docs" (@docs). */
async function start() {
  h = await harness({ agent: { verifiers } } as any)
  const sessions = [session("ses_1", { title: "API refactor", owned: true }), session("ses_2", { title: "Web work", owned: true }), session("ses_3", { title: "Docs", owned: true })]
  const client = await spoke(h, { hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver"] }, sessions })
  const requests: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    requests.push(frame.req)
    if (frame.req.op === "deliver") client.send({ t: "res", id: frame.id, ok: true, result: { delivered: frame.req.wake ? "turn" : "queued" } })
  })
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === 3)
  // Identity primers (P2-T11) precede a session's first message; these tests look at the messages.
  return { client, delivers: () => requests.filter((r) => r.op === "deliver" && r.meta.kind !== "primer") }
}

describe("POST /api/agent/msg", () => {
  test("a session messages another: 201 with the stored message and how it was delivered", async () => {
    const { delivers } = await start()
    const res = await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "hello" })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body).toMatchObject({
      message: { kind: "msg", from: { kind: "session", sessionID: "ses_1" }, to: "@web-work", recipient: { kind: "session", sessionID: "ses_2" }, text: "hello", state: "sent" },
      delivery: "turn",
    })
    expect(body.message.id).toMatch(/^msg_/)
    expect(delivers()).toHaveLength(1)
    expect(delivers()[0]).toMatchObject({ sessionID: "ses_2", messageID: body.message.id, meta: { from: "@api-refactor", to: "@web-work" } })
  })

  test("the sender comes only from the credential: from/sender fields in the body are ignored", async () => {
    const { delivers } = await start()
    const body = await json(await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "hi", from: "@docs", sender: { kind: "user" }, recipient: "ses_3" }))
    expect(body.message.from).toMatchObject({ kind: "session", sessionID: "ses_1" })
    expect(body.message.recipient).toMatchObject({ sessionID: "ses_2" })
    expect(delivers()[0].text).toContain("[hub] msg from @api-refactor")
    expect(delivers()[0].text).not.toContain("@docs")
    // the user (cookie) sends as @me
    const mine = await json(await asUser("/api/agent/msg", { to: "@web-work", text: "from me", from: "@api-refactor" }))
    expect(mine.message.from).toEqual({ kind: "user" })
    expect(delivers()[1].meta.from).toBe("@me")
  })

  test("wake:false admits without waking; urgent steers; all reaches every holder of a role", async () => {
    const { delivers } = await start()
    expect((await json(await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "later", wake: false }))).delivery).toBe("queued")
    await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "now", urgent: true })
    expect(delivers().map((d) => [d.wake, d.meta.delivery])).toEqual([
      [false, "queue"],
      [true, "steer"],
    ])
    await as("ses_2", "/api/agent/roles/claim", { role: "reviewer" })
    await as("ses_3", "/api/agent/roles/claim", { role: "reviewer" })
    const res = await as("ses_1", "/api/agent/msg", { to: "@@reviewer", text: "all of you", all: true })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.sent.map((s: any) => s.message.recipient.sessionID).sort()).toEqual(["ses_2", "ses_3"])
  })

  test("self-messages are invalid", async () => {
    const { delivers } = await start()
    for (const to of ["@api-refactor", "ses_1"]) {
      const res = await as("ses_1", "/api/agent/msg", { to, text: "me" })
      expect(res.status).toBe(400)
      expect((await json(res)).error.code).toBe("invalid")
    }
    expect(delivers()).toEqual([])
  })

  test("bad bodies are invalid; unknown addresses not_found", async () => {
    await start()
    for (const bad of [{}, { to: "@web-work" }, { text: "x" }, { to: 5, text: "x" }, { to: "@web-work", text: 5 }, { to: "@web-work", text: "x", wake: "no" }, { to: "@web-work", text: "x", urgent: 1 }, { to: "@web-work", text: "x", all: "yes" }, { to: "@web-work", text: "  " }, { to: "@web-work", text: "x".repeat(10_001) }]) {
      const res = await as("ses_1", "/api/agent/msg", bad)
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 })
      expect((await json(res)).error.code).toBe("invalid")
    }
    const res = await as("ses_1", "/api/agent/msg", { to: "@nobody", text: "x" })
    expect(res.status).toBe(404)
    expect((await json(res)).error.code).toBe("not_found")
  })
})

describe("POST /api/agent/ask, /reply, /decline", () => {
  test("an ask is open until the recipient replies; the reply goes to the real sender", async () => {
    const { delivers } = await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "ready?" }))
    expect(ask.message).toMatchObject({ kind: "ask", state: "open", expiresAt: expect.any(Number) })
    const res = await as("ses_2", "/api/agent/reply", { replyTo: ask.message.id, text: "yes" })
    expect(res.status).toBe(201)
    const reply = await json(res)
    expect(reply).toMatchObject({
      message: { kind: "reply", from: { sessionID: "ses_2" }, recipient: { kind: "session", sessionID: "ses_1" }, replyTo: ask.message.id, text: "yes" },
      original: { id: ask.message.id, state: "answered" },
      delivery: expect.any(String),
    })
    expect(delivers().at(-1)).toMatchObject({ sessionID: "ses_1", meta: { kind: "reply", replyTo: ask.message.id } })
    // a second answer is gone
    const again = await as("ses_2", "/api/agent/reply", { replyTo: ask.message.id, text: "no" })
    expect(again.status).toBe(410)
    expect((await json(again)).error.code).toBe("gone")
  })

  test("only the recipient may reply or decline: anyone else, or an unknown id, gets not_found", async () => {
    await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "ready?" }))
    for (const [who, path, body] of [
      ["ses_1", "/api/agent/reply", { replyTo: ask.message.id, text: "spoof" }],
      ["ses_3", "/api/agent/reply", { replyTo: ask.message.id, text: "spoof" }],
      ["ses_3", "/api/agent/decline", { replyTo: ask.message.id, why: "spoof" }],
      ["ses_2", "/api/agent/reply", { replyTo: "msg_doesnotexist", text: "x" }],
    ] as const) {
      const res = await as(who, path, body)
      expect({ who, path, status: res.status }).toEqual({ who, path, status: 404 })
      expect((await json(res)).error.code).toBe("not_found")
    }
    expect((await h.delivery.messages.get(USER, ask.message.id))?.state).toBe("open")
  })

  test("decline closes the ask with a reason", async () => {
    await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "deploy?" }))
    const res = await as("ses_2", "/api/agent/decline", { replyTo: ask.message.id, why: "not mine" })
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ message: { kind: "decline", text: "not mine" }, original: { state: "declined" } })
    for (const bad of [{ replyTo: ask.message.id }, { why: "x" }, { replyTo: 5, why: "x" }]) expect((await as("ses_2", "/api/agent/decline", bad)).status).toBe(400)
  })

  test("ask bodies: expiresIn in seconds, wait 0–60 s", async () => {
    await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "q", expiresIn: 120 }))
    expect(ask.message.expiresAt - ask.message.at).toBe(120_000)
    for (const bad of [{ expiresIn: "2h" }, { expiresIn: 1 }, { wait: 61 }, { wait: -1 }, { wait: "5" }, { wait: 5, all: true }]) {
      const res = await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "q", ...bad })
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 })
    }
  })

  test("wait: the ask answers once it is replied to, with the answer", async () => {
    await start()
    const pending = as("ses_1", "/api/agent/ask", { to: "@web-work", text: "ready?", wait: 10 })
    let id: string | undefined
    for (let i = 0; i < 200 && !id; i++) {
      id = (await h.delivery.messages.inbox(USER, { kind: "session", sessionID: "ses_2" })).asks[0]?.id
      if (!id) await Bun.sleep(10)
    }
    const started = Date.now()
    expect((await as("ses_2", "/api/agent/reply", { replyTo: id, text: "yes" })).status).toBe(201)
    const res = await pending
    expect(Date.now() - started).toBeLessThan(2000)
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ message: { id, state: "answered" }, answer: { kind: "reply", text: "yes", replyTo: id } })
  })

  test("wait: an unanswered ask answers open after the wait", async () => {
    await start()
    const started = Date.now()
    const body = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "ready?", wait: 0.3 }))
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(body.message.state).toBe("open")
    expect(body.answer).toBeUndefined()
  })
})

describe("GET /api/agent/messages/:id", () => {
  test("its sender and recipient (and the user) read it; another session or app gets not_found", async () => {
    await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "ready?" }))
    const path = `/api/agent/messages/${ask.message.id}`
    for (const who of ["ses_1", "ses_2"]) expect((await json(await as(who, path))).message.id).toBe(ask.message.id)
    expect((await json(await asUser(path))).message.id).toBe(ask.message.id)
    for (const res of [await as("ses_3", path), await bearer(path, APP_SEND), await as("ses_1", "/api/agent/messages/msg_nope")]) {
      expect(res.status).toBe(404)
      expect((await json(res)).error.code).toBe("not_found")
    }
  })

  test("wait (query, seconds): long-polls until answered", async () => {
    await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "ready?" }))
    const pending = as("ses_1", `/api/agent/messages/${ask.message.id}?wait=10`)
    await Bun.sleep(50)
    await as("ses_2", "/api/agent/reply", { replyTo: ask.message.id, text: "done" })
    expect(await json(await pending)).toMatchObject({ message: { state: "answered" }, answer: { text: "done" } })
    for (const wait of ["61", "x", "-1"]) expect((await as("ses_1", `/api/agent/messages/${ask.message.id}?wait=${wait}`)).status).toBe(400)
  })
})

describe("GET /api/agent/inbox", () => {
  test("a session's open asks, its own waiting asks and recent messages", async () => {
    await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "ready?" }))
    await as("ses_3", "/api/agent/msg", { to: "@web-work", text: "fyi" })
    const inbox = await json(await as("ses_2", "/api/agent/inbox"))
    expect(inbox.asks.map((m: any) => m.id)).toEqual([ask.message.id])
    expect(inbox.messages.map((m: any) => m.text)).toEqual(["fyi", "ready?"])
    expect(inbox.muted).toEqual([])
    expect((await json(await as("ses_1", "/api/agent/inbox"))).waiting.map((m: any) => m.id)).toEqual([ask.message.id])
  })

  test("non-session senders get a stored-only inbox: the user's and an app's replies wait there", async () => {
    const { delivers } = await start()
    const mine = await json(await asUser("/api/agent/ask", { to: "@web-work", text: "user q" }))
    const app = await json(await bearer("/api/agent/ask", APP_SEND, { method: "POST", json: { to: "@web-work", text: "app q" } }))
    expect(app.message.from).toMatchObject({ kind: "app", tokenID: "tok_send" })
    const before = delivers().length
    const reply = await json(await as("ses_2", "/api/agent/reply", { replyTo: mine.message.id, text: "for you" }))
    expect(reply.delivery).toBeUndefined()
    await as("ses_2", "/api/agent/reply", { replyTo: app.message.id, text: "for the app" })
    expect(delivers().length).toBe(before)
    expect((await json(await asUser("/api/agent/inbox"))).messages.map((m: any) => m.text)).toEqual(["for you"])
    expect((await json(await bearer("/api/agent/inbox", APP_SEND))).messages.map((m: any) => m.text)).toEqual(["for the app"])
  })
})

describe("POST /api/agent/mute, /unmute", () => {
  test("a muted session's messages are forbidden until unmuted", async () => {
    await start()
    const muted = await as("ses_2", "/api/agent/mute", { session: "@api-refactor" })
    expect(muted.status).toBe(200)
    expect(await json(muted)).toEqual({ muted: ["ses_1"] })
    const res = await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "hi" })
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe("forbidden")
    expect((await as("ses_3", "/api/agent/msg", { to: "@web-work", text: "hi" })).status).toBe(201)
    expect((await json(await as("ses_2", "/api/agent/inbox"))).muted).toEqual(["ses_1"])
    expect(await json(await as("ses_2", "/api/agent/unmute", { session: "ses_1" }))).toEqual({ muted: [] })
    expect((await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "hi" })).status).toBe(201)
  })

  test("mute bodies: a session address, not yourself; unknown: not_found", async () => {
    await start()
    for (const bad of [{}, { session: 5 }, { session: "@web-work" }]) expect((await as("ses_2", "/api/agent/mute", bad)).status).toBe(400)
    expect((await as("ses_2", "/api/agent/mute", { session: "@nobody" })).status).toBe(404)
  })
})

describe("credentials and scopes", () => {
  test("an app token needs messages:send to send and messages:read to read", async () => {
    await start()
    const sends: Array<[string, unknown]> = [
      ["/api/agent/msg", { to: "@web-work", text: "x" }],
      ["/api/agent/ask", { to: "@web-work", text: "x" }],
      ["/api/agent/reply", { replyTo: "msg_x", text: "x" }],
      ["/api/agent/decline", { replyTo: "msg_x", why: "x" }],
      ["/api/agent/mute", { session: "@web-work" }],
      ["/api/agent/unmute", { session: "@web-work" }],
    ]
    for (const [path, body] of sends) {
      const res = await bearer(path, APP_READ, { method: "POST", json: body })
      expect({ path, status: res.status }).toEqual({ path, status: 403 })
      expect((await json(res)).error.code).toBe("forbidden")
    }
    for (const path of ["/api/agent/inbox", "/api/agent/messages/msg_x"]) expect((await bearer(path, APP_READ)).status).toBe(403)
    expect((await bearer("/api/agent/msg", APP_SEND, { method: "POST", json: { to: "@web-work", text: "x" } })).status).toBe(201)
    expect((await bearer("/api/agent/inbox", APP_SEND)).status).toBe(200)
  })
})

describe("GET /api/agent/watch: message events", () => {
  test("the user sees every message (no text); a session only its own; an app needs messages:read", async () => {
    await start()
    const user = sse(await asUser("/api/agent/watch"))
    const docs = sse(await as("ses_3", "/api/agent/watch"))
    const app = sse(await bearer("/api/agent/watch", APP_READ))
    const scoped = sse(await asUser("/api/agent/watch?session=@docs"))
    for (const stream of [user, docs, app, scoped]) await stream.next((m) => m.type === "ready")
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "secret question" }))
    const event = await user.next((m) => m.type === "message")
    expect(event).toEqual({ type: "message", id: ask.message.id, kind: "ask", state: "open", from: "@api-refactor", to: "@web-work", sessionID: "ses_2", senderID: "ses_1", delivery: "turn", at: expect.any(Number) })
    await as("ses_2", "/api/agent/reply", { replyTo: ask.message.id, text: "secret answer" })
    expect(await user.next((m) => m.type === "message")).toMatchObject({ kind: "reply", replyTo: ask.message.id, sessionID: "ses_1", senderID: "ses_2" })
    const mine = await json(await as("ses_1", "/api/agent/msg", { to: "@docs", text: "for docs" }))
    expect((await docs.next((m) => m.type === "message")).id).toBe(mine.message.id)
    expect((await scoped.next((m) => m.type === "message")).id).toBe(mine.message.id)
    await expect(app.next((m) => m.type === "message", 300)).rejects.toThrow(/timed out/)
    for (const stream of [user, docs, app, scoped]) await stream.cancel()
  })

  test("blocked=1 streams carry no message events", async () => {
    await start()
    const blocked = sse(await asUser("/api/agent/watch?blocked=1"))
    await blocked.next((m) => m.type === "ready")
    await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "x" })
    await expect(blocked.next((m) => m.type === "message", 300)).rejects.toThrow(/timed out/)
    await blocked.cancel()
  })
})

describe("GET /api/sessions/:session/messages (console)", () => {
  test("what the session sent and received, newest first, with a limit", async () => {
    await start()
    const out = await json(await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "out" }))
    const back = await json(await as("ses_2", "/api/agent/msg", { to: "@api-refactor", text: "back" }))
    await as("ses_3", "/api/agent/msg", { to: "@web-work", text: "not ses_1's" })
    const res = await h.api("/api/sessions/ses_1/messages")
    expect(res.status).toBe(200)
    expect((await json(res)).messages.map((m: any) => m.id)).toEqual([back.message.id, out.message.id])
    expect((await json(await h.api("/api/sessions/ses_1/messages?limit=1"))).messages.map((m: any) => m.id)).toEqual([back.message.id])
    for (const limit of ["0", "201", "x"]) expect((await h.api(`/api/sessions/ses_1/messages?limit=${limit}`)).status).toBe(400)
  })
})

describe("the per-user messaging switch", () => {
  test("off: every send, reply and decline is paused; reading still works; only the user flips it", async () => {
    await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "q" }))
    expect(await json(await asUser("/api/agent/messaging"))).toEqual({ enabled: true })
    expect((await as("ses_1", "/api/agent/messaging")).status).toBe(403)
    expect((await bearer("/api/agent/messaging", TOKENS.ses_1!, { method: "PUT", json: { enabled: false } })).status).toBe(403)
    expect((await asUser("/api/agent/messaging", { enabled: "no" }, "PUT")).status).toBe(400)
    const off = await asUser("/api/agent/messaging", { enabled: false }, "PUT")
    expect(off.status).toBe(200)
    expect(await json(off)).toEqual({ enabled: false })
    for (const [who, path, body] of [
      ["ses_1", "/api/agent/msg", { to: "@web-work", text: "x" }],
      ["ses_1", "/api/agent/ask", { to: "@web-work", text: "x" }],
      ["ses_2", "/api/agent/reply", { replyTo: ask.message.id, text: "x" }],
      ["ses_2", "/api/agent/decline", { replyTo: ask.message.id, why: "x" }],
    ] as const) {
      const res = await as(who, path, body)
      expect({ path, status: res.status }).toEqual({ path, status: 423 })
      expect((await json(res)).error.code).toBe("paused")
    }
    const hint: string = (await json(await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "x" }))).error.hint
    expect(hint).toMatch(/^Ask the user to turn messaging back on/)
    expect(hint).not.toMatch(/console \(PUT/)
    expect((await asUser("/api/agent/msg", { to: "@web-work", text: "x" })).status).toBe(423)
    expect((await as("ses_2", "/api/agent/inbox")).status).toBe(200)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: USER, action: "messaging.pause" })
    expect(await json(await asUser("/api/agent/messaging", { enabled: true }, "PUT"))).toEqual({ enabled: true })
    expect((await as("ses_2", "/api/agent/reply", { replyTo: ask.message.id, text: "x" })).status).toBe(201)
  })
})
