import { afterEach, describe, expect, test } from "bun:test"
import { centralConfig } from "../src/central/config"
import type { PushSender } from "../src/central/push"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const subscription = (n = 1) => ({
  endpoint: `https://push.example/ep${n}`,
  keys: { p256dh: `p256-${n}`, auth: `auth-${n}` },
})

function pushHarness(failures: Record<string, number> = {}) {
  const sent: Array<{ endpoint: string; raw: string; payload: any }> = []
  const sender: PushSender = async (target, payload) => {
    if (failures[target.endpoint]) throw Object.assign(new Error("gone"), { statusCode: failures[target.endpoint] })
    sent.push({ endpoint: target.endpoint, raw: payload, payload: JSON.parse(payload) })
  }
  h = harness({ notifier: undefined, pushSender: sender })
  return sent
}

describe("config", () => {
  test("VAPID subject from VOICE_VAPID_SUBJECT, else the https public URL, else a local mailto", () => {
    expect(centralConfig({}).vapidSubject).toBe("mailto:opencode-voice@localhost")
    expect(centralConfig({ VOICE_PUBLIC_URL: "https://voice.example.com" }).vapidSubject).toBe("https://voice.example.com")
    expect(centralConfig({ VOICE_VAPID_SUBJECT: "mailto:me@x.y" }).vapidSubject).toBe("mailto:me@x.y")
  })
})

describe("push API", () => {
  test("GET /api/push/key needs a paired device", async () => {
    pushHarness()
    expect((await h.api("/api/push/key", { cookie: null })).status).toBe(401)
    const res = await h.api("/api/push/key")
    expect(res.status).toBe(200)
    const { publicKey } = (await res.json()) as any
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    expect(((await (await h.api("/api/push/key")).json()) as any).publicKey).toBe(publicKey)
  })

  test("subscribe requires cookie and same Origin; validates; dedupes; applies prefs", async () => {
    pushHarness()
    const json = { subscription: subscription(), prefs: { finished: true } }
    expect((await h.api("/api/push/subscribe", { method: "POST", json, cookie: null })).status).toBe(401)
    expect((await h.api("/api/push/subscribe", { method: "POST", json, origin: null })).status).toBe(403)
    expect((await h.api("/api/push/subscribe", { method: "POST", json, origin: "https://evil.example" })).status).toBe(403)
    for (const bad of [
      { subscription: { ...subscription(), endpoint: "http://push.example/x" } },
      { subscription: { endpoint: "https://push.example/x" } },
      { subscription: { ...subscription(), keys: { p256dh: "", auth: "a" } } },
      {},
    ]) {
      expect((await h.api("/api/push/subscribe", { method: "POST", json: bad })).status).toBe(400)
    }
    const ok = await h.api("/api/push/subscribe", { method: "POST", json })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ prefs: { handoff: true, blocked: true, finished: true, say: true } })
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription(2) } })
    expect(h.store.pushSubscriptions().map((s) => s.endpoint)).toEqual([subscription().endpoint, subscription(2).endpoint])
  })

  test("unsubscribe removes only this device's subscription", async () => {
    pushHarness()
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    const other = h.store.addDevice("other").device
    h.store.addPushSubscription(other.id, subscription(2))
    const mine = { endpoint: subscription().endpoint }
    expect((await h.api("/api/push/unsubscribe", { method: "POST", json: mine, origin: null })).status).toBe(403)
    expect((await h.api("/api/push/unsubscribe", { method: "POST", json: mine })).status).toBe(204)
    expect((await h.api("/api/push/unsubscribe", { method: "POST", json: mine })).status).toBe(404)
    const theirs = { endpoint: subscription(2).endpoint }
    expect((await h.api("/api/push/unsubscribe", { method: "POST", json: theirs })).status).toBe(404)
    expect(h.store.pushSubscriptions()).toHaveLength(1)
  })

  test("GET/PUT /api/push/prefs per device", async () => {
    pushHarness()
    expect((await h.api("/api/push/prefs", { cookie: null })).status).toBe(401)
    expect(await (await h.api("/api/push/prefs")).json()).toEqual({
      prefs: { handoff: true, blocked: true, finished: false, say: true },
      subscriptions: 0,
    })
    expect((await h.api("/api/push/prefs", { method: "PUT", json: { finished: true }, origin: null })).status).toBe(403)
    const put = await h.api("/api/push/prefs", { method: "PUT", json: { finished: true, blocked: "nope", extra: 1 } })
    expect(await put.json()).toEqual({ prefs: { handoff: true, blocked: true, finished: true, say: true } })
    expect((await (await h.api("/api/push/prefs")).json()) as any).toMatchObject({ prefs: { finished: true } })
  })
})

describe("notifications", () => {
  test("handoff from a spoke reports devices notified; payload has no secrets", async () => {
    const sent = pushHarness({ [subscription(9).endpoint]: 410 })
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription(9) } })
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "mcp-gateway" })] })
    client.send({ t: "req", id: "h1", req: { op: "handoff", sessionID: "ses_1" } })
    const res = await client.next((f) => f.t === "res" && f.id === "h1")
    expect(res).toEqual({ t: "res", id: "h1", ok: true, result: { notified: 1 } })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toEqual({
      kind: "handoff",
      sessionID: "ses_1",
      title: "mcp-gateway",
      body: expect.any(String),
    })
    const deviceToken = h.cookie.split("=")[1]!
    expect(sent[0]!.raw).not.toContain(deviceToken)
    expect(sent[0]!.raw).not.toContain(client.token)
    expect(h.store.pushSubscriptions().map((s) => s.endpoint)).toEqual([subscription().endpoint])
  })

  test("a permission asked in a session pushes 'blocked'", async () => {
    const sent = pushHarness()
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "mcp-gateway" })] })
    client.send({
      t: "event",
      event: { type: "permission.asked", data: { sessionID: "ses_1", id: "per_1", action: "bash", resources: ["secret cmd"] } },
    })
    await waitFor(() => sent.length === 1)
    expect(sent[0]!.payload).toMatchObject({ kind: "blocked", sessionID: "ses_1", title: "mcp-gateway needs permission" })
    expect(sent[0]!.raw).not.toContain("secret cmd")
  })

  test("'finished' only when enabled and not for a turn started from the voice page", async () => {
    const sent = pushHarness()
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription(), prefs: { finished: true } } })
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "build" })] })
    client.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.t !== "req" || frame.req.op !== "turn") return
      client.send({ t: "event", event: { type: "session.execution.succeeded", data: { sessionID: "ses_1" } } })
      client.send({ t: "res", id: frame.id, ok: true, result: { outcome: "succeeded", reply: "done" } })
    })
    expect((await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "go" } })).status).toBe(200)
    await Bun.sleep(50)
    expect(sent).toEqual([])
    client.send({ t: "event", event: { type: "session.execution.succeeded", data: { sessionID: "ses_1" } } })
    await waitFor(() => sent.length === 1)
    expect(sent[0]!.payload).toMatchObject({ kind: "finished", sessionID: "ses_1", title: "build finished" })
  })
})
