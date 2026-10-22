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
  test("VAPID subject from HUB_VAPID_SUBJECT, else the https public URL, else a local mailto", () => {
    expect(centralConfig({}).vapidSubject).toBe("mailto:hub@localhost")
    expect(centralConfig({ HUB_PUBLIC_URL: "https://voice.example.com" }).vapidSubject).toBe("https://voice.example.com")
    expect(centralConfig({ HUB_VAPID_SUBJECT: "mailto:me@x.y" }).vapidSubject).toBe("mailto:me@x.y")
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
    const json = { subscription: subscription(), prefs: { turn: true, finished: false } }
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
    // The old "finished" key still works: it is all done now.
    expect(await ok.json()).toEqual({ prefs: { handoff: true, question: true, permission: true, done: false, failed: true, turn: true, stopped: false, retry: false, subagentDone: false, subagentFailed: false, jobDone: false, jobFailed: false, longTool: false, say: true, activity: false } })
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
      prefs: { handoff: true, question: true, permission: true, done: true, failed: true, turn: false, stopped: false, retry: false, subagentDone: false, subagentFailed: false, jobDone: false, jobFailed: false, longTool: false, say: true, activity: false },
      quietHours: null,
      activityMinutes: 5,
      muted: [],
      subscriptions: 0,
    })
    expect((await h.api("/api/push/prefs", { method: "PUT", json: { turn: true }, origin: null })).status).toBe(403)
    const put = await h.api("/api/push/prefs", { method: "PUT", json: { subagentDone: true, jobFailed: true, question: "nope", extra: 1 } })
    expect(await put.json()).toMatchObject({ prefs: { handoff: true, question: true, permission: true, done: true, failed: true, turn: false, stopped: false, retry: false, subagentDone: true, subagentFailed: false, jobDone: false, jobFailed: true, longTool: false, say: true, activity: false } })
    expect((await (await h.api("/api/push/prefs")).json()) as any).toMatchObject({ prefs: { subagentDone: true, jobFailed: true } })
    // Clients up to 0.7 send `finished`: it sets all done (no longer every turn).
    expect(await (await h.api("/api/push/prefs", { method: "PUT", json: { finished: false } })).json()).toMatchObject({ prefs: { done: false, turn: false } })
    // 0.5.0 clients send `blocked`: it sets both questions and permissions.
    expect(await (await h.api("/api/push/prefs", { method: "PUT", json: { blocked: false } })).json()).toMatchObject({ prefs: { question: false, permission: false } })
  })

  test("activity updates: the toggle and the interval (1–60 whole minutes) per device", async () => {
    pushHarness()
    const put = (json: unknown) => h.api("/api/push/prefs", { method: "PUT", json })
    expect(await (await put({ activity: true, activityMinutes: 2 })).json()).toMatchObject({ prefs: { activity: true }, activityMinutes: 2 })
    for (const bad of [0, 61, 1.5, "5"]) expect((await put({ activityMinutes: bad })).status).toBe(400)
    expect(((await (await h.api("/api/push/prefs")).json()) as any).activityMinutes).toBe(2)
  })

  test("quiet hours: set with a time zone, validated, cleared with null", async () => {
    pushHarness()
    const quiet = { start: "22:00", end: "07:00", timeZone: "Europe/Berlin" }
    const set = await h.api("/api/push/prefs", { method: "PUT", json: { quietHours: quiet } })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({ quietHours: quiet })
    for (const bad of [{ ...quiet, start: "25:00" }, { ...quiet, timeZone: "Nowhere/Land" }, { start: "22:00" }, "22-07"]) {
      expect((await h.api("/api/push/prefs", { method: "PUT", json: { quietHours: bad } })).status).toBe(400)
    }
    expect(((await (await h.api("/api/push/prefs")).json()) as any).quietHours).toEqual(quiet)
    await h.api("/api/push/prefs", { method: "PUT", json: { quietHours: null } })
    expect(((await (await h.api("/api/push/prefs")).json()) as any).quietHours).toBeNull()
  })

  test("subscribe rejects endpoints on private or local hosts (SSRF), checked by resolving the host", async () => {
    const lookups: string[] = []
    h = harness({
      notifier: undefined,
      pushSender: async () => {},
      resolveHost: async (host) => {
        lookups.push(host)
        if (host === "fcm.googleapis.com") return ["142.250.80.10"]
        if (host === "evil.example.com") return ["127.0.0.1"]
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })
      },
    })
    const subscribe = (endpoint: string) =>
      h.api("/api/push/subscribe", { method: "POST", json: { subscription: { ...subscription(), endpoint } } })
    for (const endpoint of ["https://127.0.0.1:4097/api/x", "https://[::1]/x", "https://10.0.0.1/x", "https://localhost/x", "https://hub.internal/x"]) {
      const res = await subscribe(endpoint)
      expect({ endpoint, status: res.status }).toEqual({ endpoint, status: 400 })
    }
    expect(lookups).toEqual([])
    expect((await subscribe("https://evil.example.com/x")).status).toBe(400)
    expect((await subscribe("https://gone.example.com/x")).status).toBe(400)
    expect(h.store.pushSubscriptions()).toEqual([])
    expect((await subscribe("https://fcm.googleapis.com/fcm/send/abc")).status).toBe(200)
    expect(h.store.pushSubscriptions().map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/abc"])
  })

  test("GET /api/push/prefs?endpoint= says whether the hub holds that subscription for this device", async () => {
    pushHarness()
    const ep = encodeURIComponent(subscription().endpoint)
    expect(((await (await h.api(`/api/push/prefs?endpoint=${ep}`)).json()) as any).subscribed).toBe(false)
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    expect(await (await h.api(`/api/push/prefs?endpoint=${ep}`)).json()).toMatchObject({ subscribed: true, subscriptions: 1 })
    // Another device's endpoint does not count for this one.
    const other = h.store.addDevice("other").device
    h.store.addPushSubscription(other.id, subscription(2))
    expect(((await (await h.api(`/api/push/prefs?endpoint=${encodeURIComponent(subscription(2).endpoint)}`)).json()) as any).subscribed).toBe(false)
  })

  test("subscribe with oldEndpoint replaces the device's old subscription (pushsubscriptionchange)", async () => {
    pushHarness()
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    const res = await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription(2), oldEndpoint: subscription().endpoint } })
    expect(res.status).toBe(200)
    expect(h.store.pushSubscriptions().map((s) => s.endpoint)).toEqual([subscription(2).endpoint])
  })

  test("PUT /api/push/mute mutes and unmutes a session for the user", async () => {
    pushHarness()
    expect((await h.api("/api/push/mute", { method: "PUT", json: { sessionID: "ses_1", muted: true }, origin: null })).status).toBe(403)
    for (const bad of [{ sessionID: "", muted: true }, { sessionID: "ses_1" }, { sessionID: "x".repeat(300), muted: true }]) {
      expect((await h.api("/api/push/mute", { method: "PUT", json: bad })).status).toBe(400)
    }
    expect(await (await h.api("/api/push/mute", { method: "PUT", json: { sessionID: "ses_1", muted: true } })).json()).toEqual({ muted: ["ses_1"] })
    expect(((await (await h.api("/api/push/prefs")).json()) as any).muted).toEqual(["ses_1"])
    expect(await (await h.api("/api/push/mute", { method: "PUT", json: { sessionID: "ses_1", muted: false } })).json()).toEqual({ muted: [] })
  })

  test("POST /api/push/test reaches only the caller's device; other users get nothing; rate limited", async () => {
    const sent = pushHarness()
    expect((await h.api("/api/push/test", { method: "POST", json: {}, cookie: null })).status).toBe(401)
    expect((await h.api("/api/push/test", { method: "POST", json: {}, origin: null })).status).toBe(403)
    // No subscription yet: nothing sent, the answer says so (and it does not use up the rate limit).
    expect(await (await h.api("/api/push/test", { method: "POST", json: {} })).json()).toEqual({ sent: 0, failed: [], subscriptions: 0 })
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    // Another device of the same user, and another user's device.
    const mine2 = h.store.addDevice("tablet").device
    h.store.addPushSubscription(mine2.id, subscription(2))
    const bob = h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const bobDevice = h.store.addDevice("bob phone", bob.id)
    h.store.addPushSubscription(bobDevice.device.id, subscription(3))
    const res = await h.api("/api/push/test", { method: "POST", json: {} })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sent: 1, failed: [], subscriptions: 1 })
    expect(sent.map((s) => s.endpoint)).toEqual([subscription().endpoint])
    expect(sent[0]!.payload).toMatchObject({ kind: "test" })
    const again = await h.api("/api/push/test", { method: "POST", json: {} })
    expect(again.status).toBe(429)
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0)
    // Bob's test goes to bob's device only.
    const asBob = await h.api("/api/push/test", { method: "POST", json: {}, cookie: `voice_device=${bobDevice.token}` })
    expect(await asBob.json()).toMatchObject({ sent: 1 })
    expect(sent.map((s) => s.endpoint)).toEqual([subscription().endpoint, subscription(3).endpoint])
  })

  test("a test of a chosen kind looks like it; an unknown kind is refused", async () => {
    const sent = pushHarness()
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    expect((await h.api("/api/push/test", { method: "POST", json: { kind: "nope" } })).status).toBe(400)
    const res = await h.api("/api/push/test", { method: "POST", json: { kind: "subagentDone" } })
    expect(await res.json()).toEqual({ sent: 1, failed: [], subscriptions: 1 })
    expect(sent[0]!.payload).toMatchObject({ kind: "subagentDone", title: "Test session · Subagent explore finished", test: true })
  })

  test("a failed test push reports the push service status", async () => {
    pushHarness({ [subscription(4).endpoint]: 403 })
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription(4) } })
    expect(await (await h.api("/api/push/test", { method: "POST", json: {} })).json()).toEqual({
      sent: 0,
      failed: [{ host: "push.example", status: 403 }],
      subscriptions: 1,
    })
  })
})

describe("notifications", () => {
  test("handoff from a spoke reports devices notified; payload has no secrets", async () => {
    const sent = pushHarness({ [subscription(9).endpoint]: 410 })
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription(9) } })
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "api-server" })] })
    client.send({ t: "req", id: "h1", req: { op: "handoff", sessionID: "ses_1" } })
    const res = await client.next((f) => f.t === "res" && f.id === "h1")
    expect(res).toEqual({ t: "res", id: "h1", ok: true, result: { notified: 1 } })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toEqual({
      kind: "handoff",
      sessionID: "ses_1",
      title: "api-server · Hand-off",
      body: expect.any(String),
    })
    const deviceToken = h.cookie.split("=")[1]!
    expect(sent[0]!.raw).not.toContain(deviceToken)
    expect(sent[0]!.raw).not.toContain(client.token)
    expect(h.store.pushSubscriptions().map((s) => s.endpoint)).toEqual([subscription().endpoint])
  })

  test("a permission asked in a session pushes 'permission' with its request ID, never its summary", async () => {
    const sent = pushHarness()
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription() } })
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "api-server" })] })
    client.send({
      t: "event",
      event: { type: "permission.asked", data: { sessionID: "ses_1", id: "per_1", action: "bash", resources: ["secret cmd"] } },
    })
    await waitFor(() => sent.length === 1)
    expect(sent[0]!.payload).toMatchObject({ kind: "permission", sessionID: "ses_1", title: "api-server · Needs permission", requestID: "per_1" })
    expect(sent[0]!.raw).not.toContain("secret cmd")
  })

  test("'turn' only when enabled and not for a turn started from the voice page", async () => {
    const sent = pushHarness()
    await h.api("/api/push/subscribe", { method: "POST", json: { subscription: subscription(), prefs: { turn: true } } })
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true, title: "build" })] })
    client.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.t !== "req" || frame.req.op !== "turn") return
      client.send({ t: "event", event: { type: "session.execution.started", data: { sessionID: "ses_1" } } })
      client.send({ t: "event", event: { type: "session.execution.succeeded", data: { sessionID: "ses_1" } } })
      client.send({ t: "res", id: frame.id, ok: true, result: { outcome: "succeeded", reply: "done" } })
    })
    expect((await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "go" } })).status).toBe(200)
    await Bun.sleep(50)
    expect(sent).toEqual([])
    client.send({ t: "event", event: { type: "session.execution.started", data: { sessionID: "ses_1" } } })
    client.send({ t: "event", event: { type: "session.execution.succeeded", data: { sessionID: "ses_1" } } })
    await waitFor(() => sent.length === 1)
    expect(sent[0]!.payload).toMatchObject({ kind: "turn", sessionID: "ses_1", title: "build · Turn finished" })
  })
})
