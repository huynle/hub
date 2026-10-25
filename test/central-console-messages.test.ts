// The console's view of agent messages (P2-T10a): every stored message goes out on the user's /api/events stream
// as a 'message' event (live transcript rows), and GET /api/sessions/:session/messages also answers for a session
// that is offline but known to the user's directory (its history stays readable).
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, session, spoke, sse, waitFor, type Harness } from "./central-harness"

const USER = "local"
const TOKENS: Record<string, string> = { ses_1: "hst_fake_ses_1", ses_2: "hst_fake_ses_2" }
const verifiers: BearerVerifier[] = [
  {
    kind: "session",
    verify: (token) => {
      const sessionID = Object.keys(TOKENS).find((id) => TOKENS[id] === token)
      return sessionID ? { kind: "session", userID: USER, machineID: "mch_x", sessionID } : undefined
    },
  },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const as = (sessionID: string, pathname: string, body: unknown) =>
  h.api(pathname, { method: "POST", json: body, cookie: null, origin: null, headers: { authorization: `Bearer ${TOKENS[sessionID]!}` } })

async function start() {
  h = await harness({ agent: { verifiers } } as any)
  const client = await spoke(h, {
    hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver"] },
    sessions: [session("ses_1", { title: "API refactor", owned: true }), session("ses_2", { title: "Web work", owned: true })],
  })
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t === "req" && frame.req.op === "deliver") client.send({ t: "res", id: frame.id, ok: true, result: { delivered: "turn" } })
  })
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === 2)
  return client
}

describe("console message events (/api/events)", () => {
  test("a stored message reaches the user's stream as a 'message' event with the stored message", async () => {
    await start()
    const events = sse(await h.api("/api/events"))
    const sent = await json(await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "please look" }))
    const event = await events.next((m) => m.type === "message")
    expect(event).toEqual({ type: "message", message: sent.message })
    expect(event.message).toMatchObject({ text: "please look", from: { kind: "session", sessionID: "ses_1" }, recipient: { kind: "session", sessionID: "ses_2" }, to: "@web-work" })
    await events.cancel()
  })

  test("replies are published too (the answer of an ask)", async () => {
    await start()
    const ask = await json(await as("ses_1", "/api/agent/ask", { to: "@web-work", text: "ok?", wait: 0 }))
    const events = sse(await h.api("/api/events"))
    const reply = await json(await as("ses_2", "/api/agent/reply", { replyTo: ask.message.id, text: "yes" }))
    expect((await events.next((m) => m.type === "message")).message).toMatchObject({ id: reply.message.id, kind: "reply", replyTo: ask.message.id })
    await events.cancel()
  })
})

describe("GET /api/sessions/:session/messages for offline sessions", () => {
  test("a session the directory knows still lists its messages after its spoke went away; unknown ones are 404", async () => {
    const client = await start()
    const sent = await json(await as("ses_1", "/api/agent/msg", { to: "@web-work", text: "kept" }))
    client.close()
    await waitFor(() => !h.registry.hasSession("ses_1"))
    const res = await h.api("/api/sessions/ses_1/messages")
    expect(res.status).toBe(200)
    expect((await json(res)).messages.map((m: any) => m.id)).toEqual([sent.message.id])
    const unknown = await h.api("/api/sessions/ses_nope/messages")
    expect(unknown.status).toBe(404)
    expect(await json(unknown)).toEqual({ error: "Not found" })
  })
})
