// Decisions and @me over HTTP (design §12.1; iw6kfmxg Security): sessions and apps open Decisions with
// POST /api/agent/ask {to: "@me", options, recommendation, urgency, tier, deadline, onTimeout, about}; only the
// user answers them, on the console routes (/api/decisions, same-origin cookie or device token; tap: cookie only);
// the first answer wins (later: 409 gone) and reaches the asker as a reply; push kinds 'decision' (generic,
// with the session to open) and 'message' (a msg to @me).
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, session, spoke, sse, waitFor, type Harness } from "./central-harness"

const USER = "local"
const TOKENS: Record<string, string> = { ses_1: "hst_fake_ses_1", ses_2: "hst_fake_ses_2" }
const APP = "hat_fake_app"

const verifiers: BearerVerifier[] = [
  {
    kind: "session",
    verify: (token) => {
      const sessionID = Object.keys(TOKENS).find((id) => TOKENS[id] === token)
      return sessionID ? { kind: "session", userID: USER, machineID: "mch_x", sessionID } : undefined
    },
  },
  { kind: "app", verify: (token) => (token === APP ? { kind: "app", userID: USER, tokenID: "tok_app", scopes: ["messages:send", "messages:read"], label: "concierge" } : undefined) },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const bearer = (pathname: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token}` } })
const as = (sessionID: string, pathname: string, body?: unknown) => bearer(pathname, TOKENS[sessionID]!, body === undefined ? {} : { method: "POST", json: body })
const asUser = (pathname: string, body?: unknown) => h.api(pathname, body === undefined ? {} : { method: "POST", json: body })

const OPTIONS = [
  { id: "go", label: "Proceed" },
  { id: "hold", label: "Hold", safe: true },
]

async function start() {
  h = await harness({ agent: { verifiers } } as any)
  const sessions = [session("ses_1", { title: "API refactor", owned: true }), session("ses_2", { title: "Web work", owned: true })]
  const client = await spoke(h, { hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver"] }, sessions })
  const requests: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    requests.push(frame.req)
    if (frame.req.op === "deliver") client.send({ t: "res", id: frame.id, ok: true, result: { delivered: frame.req.wake ? "turn" : "queued" } })
  })
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === 2)
  return { delivers: () => requests.filter((r) => r.op === "deliver" && r.meta.kind !== "primer") }
}

const askMe = (extra: Record<string, unknown> = {}) => as("ses_1", "/api/agent/ask", { to: "@me", text: "Drop column legacy_id?", options: OPTIONS, recommendation: { option: "hold", why: "still read" }, ...extra })

describe("ask @me opens a Decision", () => {
  test("201 with the ask (to the user) and the Decision; a 'decision' push with a generic body for the asking session", async () => {
    const { delivers } = await start()
    const res = await askMe({ urgency: "high", deadline: 7200, onTimeout: "hold" })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.message).toMatchObject({ kind: "ask", to: "@me", recipient: { kind: "user" }, state: "open", from: { kind: "session", sessionID: "ses_1" } })
    expect(body.decision).toMatchObject({
      messageID: body.message.id,
      about: ["ses_1"],
      sessionID: "ses_1",
      question: "Drop column legacy_id?",
      options: OPTIONS,
      recommendation: { option: "hold", why: "still read" },
      urgency: "high",
      tier: "confirm",
      onTimeout: "hold",
      state: "open",
    })
    expect(body.decision.id).toMatch(/^dec_[A-Za-z0-9]{22}$/)
    expect(body.decision.deadline - body.decision.at).toBe(7200_000)
    expect(delivers()).toEqual([])
    await waitFor(() => h.notified.some((n) => n.kind === "decision"))
    expect(h.notified.filter((n) => n.kind === "decision")).toEqual([{ kind: "decision", sessionID: "ses_1", title: "API refactor" }])
  })

  test("about takes addresses (the user's own sessions); unknown ones are not_found", async () => {
    await start()
    const body = await json(await askMe({ about: ["@web-work"] }))
    expect(body.decision).toMatchObject({ about: ["ses_2"], sessionID: "ses_2" })
    const res = await askMe({ about: ["@nobody"] })
    expect(res.status).toBe(404)
    expect((await json(res)).error.code).toBe("not_found")
  })

  test("bad Decision fields are invalid; Decision fields on an ask to a session are invalid; all with @me is invalid", async () => {
    await start()
    for (const extra of [{ onTimeout: "go", deadline: 60 }, { options: "go" }, { deadline: "2h" }, { urgency: 3 }, { about: "ses_2" }, { all: true }]) {
      const res = await askMe(extra)
      expect({ extra, status: res.status }).toEqual({ extra, status: 400 })
      expect((await json(res)).error.code).toBe("invalid")
    }
    const res = await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "hi", options: OPTIONS })
    expect(res.status).toBe(400)
  })

  test("a msg to @me is stored for the user with a 'message' push; the user cannot ask or message @me", async () => {
    await start()
    const res = await as("ses_1", "/api/agent/msg", { to: "@me", text: "deploy finished" })
    expect(res.status).toBe(201)
    expect((await json(res)).message).toMatchObject({ to: "@me", recipient: { kind: "user" } })
    await waitFor(() => h.notified.some((n) => n.kind === "message"))
    expect(h.notified.find((n) => n.kind === "message")).toEqual({ kind: "message", sessionID: "ses_1", title: "API refactor" })
    expect((await h.api("/api/agent/msg", { method: "POST", json: { to: "@me", text: "self" } })).status).toBe(400)
    expect((await h.api("/api/agent/ask", { method: "POST", json: { to: "@me", text: "self" } })).status).toBe(400)
  })
})

describe("answering on the console", () => {
  test("GET /api/decisions lists them (state filter); GET /api/decisions/:id shows one", async () => {
    await start()
    const { decision } = await json(await askMe())
    expect((await json(await h.api("/api/decisions"))).decisions.map((d: any) => d.id)).toEqual([decision.id])
    expect((await json(await h.api("/api/decisions?state=answered"))).decisions).toEqual([])
    expect((await json(await h.api(`/api/decisions/${decision.id}`))).decision).toMatchObject({ id: decision.id, state: "open" })
    expect((await h.api("/api/decisions/dec_unknown")).status).toBe(404)
    expect((await h.api("/api/decisions?state=bogus")).status).toBe(400)
  })

  test("the user's answer goes back to the asker as a reply; a later answer is 409 gone", async () => {
    const { delivers } = await start()
    const { decision } = await json(await askMe())
    const res = await asUser(`/api/decisions/${decision.id}/answer`, { option: "go", text: "ship it" })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.decision).toMatchObject({ state: "answered", answer: { option: "go", text: "ship it", answeredBy: "user" } })
    expect(body.reply).toMatchObject({ kind: "reply", replyTo: decision.messageID, recipient: { kind: "session", sessionID: "ses_1" } })
    expect(delivers().at(-1)).toMatchObject({ sessionID: "ses_1", meta: { kind: "reply", from: "@me", replyTo: decision.messageID } })
    expect(delivers().at(-1).text).toContain(`Decision ${decision.id}: Proceed [go]`)
    const again = await asUser(`/api/decisions/${decision.id}/answer`, { option: "hold" })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: "gone" })
    // The asker sees the answer on its ask.
    const asked = await json(await as("ses_1", `/api/agent/messages/${decision.messageID}`))
    expect(asked).toMatchObject({ message: { state: "answered" }, answer: { kind: "reply", from: { kind: "user" } } })
  })

  test("an asker waiting on its ask gets the answer when the user answers", async () => {
    await start()
    const waiting = askMe({ wait: 10 })
    await waitFor(() => h.notified.some((n) => n.kind === "decision"))
    const { decisions } = await json(await h.api("/api/decisions"))
    expect(decisions).toHaveLength(1)
    expect((await asUser(`/api/decisions/${decisions[0].id}/answer`, { option: "hold" })).status).toBe(200)
    const body = await json(await waiting)
    expect(body).toMatchObject({ message: { state: "answered" }, decision: { id: decisions[0].id }, answer: { kind: "reply", text: expect.stringContaining("Hold [hold]") } })
  })

  test("invalid answers are 400; cross-origin cookie answers are refused; sessions and apps cannot answer", async () => {
    await start()
    const { decision } = await json(await askMe())
    expect((await asUser(`/api/decisions/${decision.id}/answer`, { option: "nope" })).status).toBe(400)
    expect((await h.api(`/api/decisions/${decision.id}/answer`, { method: "POST", json: { option: "go" }, origin: "https://evil.test" })).status).toBe(403)
    expect((await bearer(`/api/decisions/${decision.id}/answer`, TOKENS.ses_1!, { method: "POST", json: { option: "go" } })).status).toBe(403)
    expect((await bearer(`/api/decisions/${decision.id}/answer`, APP, { method: "POST", json: { option: "go" } })).status).toBe(403)
    expect((await bearer("/api/decisions", APP)).status).toBe(403)
    // Nor through the agent API's reply/decline (the Decision is the only way to answer its ask).
    for (const [path, body] of [["/api/agent/reply", { replyTo: decision.messageID, text: "yes" }], ["/api/agent/decline", { replyTo: decision.messageID, why: "no" }]] as const) {
      const res = await asUser(path, body)
      expect(res.status).toBe(400)
      const error = (await json(res)).error
      expect(error).toMatchObject({ code: "invalid" })
      // The hint is for the person: where in the console, not the raw answer route.
      expect(error.hint).toBe("Answer it on the console's Home page (its decision card)")
    }
    expect((await json(await h.api(`/api/decisions/${decision.id}`))).decision.state).toBe("open")
  })

  test("tap Decisions: a device token (native app) is forbidden, the console cookie answers", async () => {
    await start()
    const { decision } = await json(await askMe({ tier: "tap" }))
    const { token } = await h.store.addDevice("phone app")
    const res = await bearer(`/api/decisions/${decision.id}/answer`, token, { method: "POST", json: { option: "go" } })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: "forbidden" })
    expect((await asUser(`/api/decisions/${decision.id}/answer`, { option: "go" })).status).toBe(200)
  })

  test("confirm Decisions answer from a device token too", async () => {
    await start()
    const { decision } = await json(await askMe())
    const { token } = await h.store.addDevice("phone app")
    expect((await bearer(`/api/decisions/${decision.id}/answer`, token, { method: "POST", json: { option: "go" } })).status).toBe(200)
  })
})

describe("console 'decision' events (/api/events)", () => {
  test("opening and answering a Decision reach the user's stream as 'decision' events with the Decision", async () => {
    await start()
    const events = sse(await h.api("/api/events"))
    const { decision } = await json(await askMe())
    expect(await events.next((m) => m.type === "decision")).toEqual({ type: "decision", decision })
    const answered = await json(await asUser(`/api/decisions/${decision.id}/answer`, { option: "hold" }))
    const event = await events.next((m) => m.type === "decision")
    expect(event).toEqual({ type: "decision", decision: answered.decision })
    expect(event.decision).toMatchObject({ id: decision.id, state: "answered", answer: { option: "hold", answeredBy: "user" } })
    await events.cancel()
  })
})

describe("agent reads", () => {
  test("GET /api/agent/decisions: the asker sees its own, other sessions none, the user all; :id likewise", async () => {
    await start()
    const { decision } = await json(await askMe())
    const app = await json(await bearer("/api/agent/ask", APP, { method: "POST", json: { to: "@me", text: "Restart?" } }))
    expect((await json(await as("ses_1", "/api/agent/decisions"))).decisions.map((d: any) => d.id)).toEqual([decision.id])
    expect((await json(await as("ses_2", "/api/agent/decisions"))).decisions).toEqual([])
    expect((await json(await bearer("/api/agent/decisions", APP))).decisions.map((d: any) => d.id)).toEqual([app.decision.id])
    expect((await json(await h.api("/api/agent/decisions"))).decisions).toHaveLength(2)
    expect((await json(await as("ses_1", `/api/agent/decisions/${decision.id}`))).decision.id).toBe(decision.id)
    const foreign = await as("ses_2", `/api/agent/decisions/${decision.id}`)
    expect(foreign.status).toBe(404)
    expect((await json(foreign)).error.code).toBe("not_found")
    expect((await json(await as("ses_1", "/api/agent/decisions?state=answered"))).decisions).toEqual([])
  })
})
