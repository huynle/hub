// The delivery engine wired into the hub (src/central/http.ts): real server, real WebSocket spokes that announce
// "deliver" and answer deliver requests like the OpenCode spoke will (P2-T3), the pending flush on a sessions
// frame, unsupported for spokes without the feature, and human-turn resets from the console and the harness.
import { afterEach, describe, expect, test } from "bun:test"
import type { AgentActor } from "../src/central/agent/actor"
import type { DeliverResult } from "../src/protocol"
import { harness, session, spoke, waitFor, type FakeSpoke, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const USER = "local"
const asUser: AgentActor = { kind: "user", userID: USER, deviceID: "d1", via: "cookie" }
const asSession = (sessionID: string): AgentActor => ({ kind: "session", userID: USER, machineID: "m", sessionID })
const sessions = [session("ses_1", { title: "API refactor", owned: true }), session("ses_2", { title: "Web work", owned: true })]

/** Answers deliver requests with `result`, steer with an inbox id and turn with a reply; records the requests. */
function answer(client: FakeSpoke, result: DeliverResult = { delivered: "turn" }) {
  const requests: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    requests.push(frame.req)
    if (frame.req.op === "deliver") client.send({ t: "res", id: frame.id, ok: true, result })
    if (frame.req.op === "steer") client.send({ t: "res", id: frame.id, ok: true, result: { inboxID: "in_1" } })
    if (frame.req.op === "turn") client.send({ t: "res", id: frame.id, ok: true, result: { outcome: "succeeded", reply: "ok" } })
  })
  return requests
}

async function start(features: string[] = ["deliver"]) {
  h = await harness()
  const client = await spoke(h, { hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features }, sessions })
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === 2)
  return { client, requests: answer(client) }
}

describe("delivery in the hub", () => {
  test("a message reaches the session through a spoke that announces deliver", async () => {
    const { requests } = await start()
    const sent = await h.delivery.send(USER, asSession("ses_1"), "@web-work", "msg", "hello")
    expect(sent.delivery).toBe("turn")
    const req = requests.find((r) => r.op === "deliver" && r.meta.kind !== "primer")
    expect(req).toMatchObject({ sessionID: "ses_2", messageID: sent.message.id, wake: true, meta: { kind: "msg", from: "@api-refactor", to: "@web-work", delivery: "queue" } })
    expect(req.text).toContain("[hub] msg from @api-refactor (laptop) to you")
  })

  test("the first message is preceded by one identity primer (wake:false), persisted on the session record", async () => {
    const { requests } = await start()
    await h.delivery.send(USER, asSession("ses_1"), "@web-work", "msg", "one")
    await h.delivery.send(USER, asSession("ses_1"), "@web-work", "msg", "two")
    const delivers = requests.filter((r) => r.op === "deliver")
    expect(delivers.map((r) => r.meta.kind)).toEqual(["primer", "msg", "msg"])
    expect(delivers[0]).toMatchObject({ sessionID: "ses_2", wake: false, meta: { kind: "primer", from: "hub", to: "@web-work", delivery: "steer" } })
    expect(delivers[0].text).toContain("[hub] You are @web-work.")
    expect(delivers[0].text).toContain("not from the user")
    expect(h.store.agentData(USER).sessions?.find((s) => s.sessionID === "ses_2")?.primed).toEqual(expect.any(Number))
    expect(h.store.agentData(USER).sessions?.find((s) => s.sessionID === "ses_1")?.primed).toBeUndefined()
  })

  test("POST /api/agent/name primes with the new name (again on each explicit rename); derived names never prime", async () => {
    const { requests } = await start()
    // ses_1 and ses_2 have derived names already: nothing was primed.
    expect(requests.filter((r) => r.op === "deliver")).toEqual([])
    const res = await h.api("/api/agent/name", { method: "POST", json: { name: "backend", session: "ses_1" } })
    expect(res.status).toBe(200)
    await waitFor(() => requests.some((r) => r.op === "deliver"))
    expect(requests.filter((r) => r.op === "deliver")).toEqual([expect.objectContaining({ sessionID: "ses_1", wake: false, meta: expect.objectContaining({ kind: "primer", to: "@backend" }) })])
    // An explicit rename primes again with the new name.
    expect((await h.api("/api/agent/name", { method: "POST", json: { name: "backend-2", session: "ses_1" } })).status).toBe(200)
    await waitFor(() => requests.filter((r) => r.op === "deliver").length === 2)
    expect(requests.filter((r) => r.op === "deliver")[1]).toMatchObject({ sessionID: "ses_1", wake: false, meta: { kind: "primer", to: "@backend-2" } })
  })

  test("a spoke without deliver: unsupported", async () => {
    await start([])
    expect(await h.delivery.send(USER, asUser, "@web-work", "msg", "hello").catch((cause) => cause.code)).toBe("unsupported")
  })

  test("a message to an offline session is pending and delivered when its spoke reports it again", async () => {
    const { client } = await start()
    client.close()
    await waitFor(() => !h.registry.hasSession("ses_2"))
    const sent = await h.delivery.send(USER, asUser, "@web-work", "msg", "while away")
    expect(sent.delivery).toBe("pending")
    const again = await spoke(h, { machine: { token: client.token }, hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver"] } })
    const requests = answer(again)
    again.send({ t: "sessions", sessions })
    await waitFor(() => requests.some((r) => r.op === "deliver" && r.meta.kind !== "primer"))
    expect(requests.filter((r) => r.op === "deliver").map((r) => r.meta.kind)).toEqual(["primer", "msg"])
    expect(requests.find((r) => r.op === "deliver" && r.meta.kind === "msg")).toMatchObject({ sessionID: "ses_2", messageID: sent.message.id })
    const stored = async () => (await h.delivery.messages.get(USER, sent.message.id))?.delivery
    for (let i = 0; i < 100 && (await stored()) !== "turn"; i++) await Bun.sleep(10)
    expect(await stored()).toBe("turn")
  })

  test("a console utterance is a human turn: the session's hop chain starts over", async () => {
    await start()
    await h.delivery.send(USER, asSession("ses_1"), "@web-work", "msg", "1")
    const party = { kind: "session" as const, sessionID: "ses_2" }
    expect(await h.delivery.hops.depth(USER, party)).toBe(1)
    const res = await h.api("/api/sessions/ses_2/utterance", { method: "POST", json: { text: "hi there" } })
    expect(res.status).toBe(202)
    expect(await h.delivery.hops.depth(USER, party)).toBe(0)
  })

  test("a console turn is a human turn too", async () => {
    await start()
    await h.delivery.send(USER, asSession("ses_1"), "@web-work", "msg", "1")
    const party = { kind: "session" as const, sessionID: "ses_2" }
    const res = await h.api("/api/sessions/ses_2/turn", { method: "POST", json: { text: "do it" } })
    expect(res.status).toBe(200)
    expect(await h.delivery.hops.depth(USER, party)).toBe(0)
  })

  test("a prompt the user typed in the harness (inbox origin user) is a human turn", async () => {
    const { client } = await start()
    await h.delivery.send(USER, asSession("ses_1"), "@web-work", "msg", "1")
    const party = { kind: "session" as const, sessionID: "ses_2" }
    client.send({ t: "event", event: { type: "session.inbox.delivered", data: { sessionID: "ses_2", inboxID: "in_9", origin: "user" } } })
    for (let i = 0; i < 100 && (await h.delivery.hops.depth(USER, party)) !== 0; i++) await Bun.sleep(10)
    expect(await h.delivery.hops.depth(USER, party)).toBe(0)
  })
})
