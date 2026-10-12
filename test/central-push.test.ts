import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_PUSH_PREFS, Push, PUSH_COOLDOWN_MS, SAY_COOLDOWN_MS, type PushSender } from "../src/central/push"
import { Store } from "../src/central/store"

interface Sent {
  endpoint: string
  payload: any
  raw: string
  options: any
}

/** Fake web-push sender: records sends, fails endpoints listed in `failures` with that status code. */
function fakeSender(failures: Record<string, number> = {}) {
  const sent: Sent[] = []
  const sender: PushSender = async (target, payload, options) => {
    const status = failures[target.endpoint]
    if (status) throw Object.assign(new Error(`Received unexpected response code`), { statusCode: status })
    sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload), raw: payload, options })
  }
  return { sent, sender }
}

const sub = (n: number) => ({ endpoint: `https://push.example/ep${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } })

let dir: string
let store: Store
let clock: number
const now = () => clock

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "voice-push-"))
  store = Store.open(dir, now)
  clock = 1_000_000
})

describe("VAPID keys", () => {
  test("generated once, persisted, reused after reopening the store", () => {
    const push = new Push({ store, subject: "mailto:a@b.c", sender: fakeSender().sender, now })
    const key = push.publicKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    expect(push.publicKey()).toBe(key)
    expect(store.data().vapid?.publicKey).toBe(key)
    const reopened = new Push({ store: Store.open(dir), subject: "mailto:a@b.c", sender: fakeSender().sender, now })
    expect(reopened.publicKey()).toBe(key)
  })
})

describe("subscriptions and prefs", () => {
  test("dedupe by endpoint; several per device; unsubscribe only own; device removal drops them", () => {
    const a = store.addDevice("a").device
    const b = store.addDevice("b").device
    store.addPushSubscription(a.id, sub(1))
    store.addPushSubscription(a.id, sub(2))
    store.addPushSubscription(a.id, sub(1))
    expect(store.pushSubscriptions().map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint])
    // The same endpoint re-subscribed by another device moves to that device.
    store.addPushSubscription(b.id, sub(2))
    expect(store.pushSubscriptions().filter((s) => s.deviceID === b.id).map((s) => s.endpoint)).toEqual([sub(2).endpoint])
    expect(store.removePushSubscription(a.id, sub(2).endpoint)).toBe(false)
    expect(store.removePushSubscription(a.id, sub(1).endpoint)).toBe(true)
    store.removeDevice(b.id)
    expect(store.pushSubscriptions()).toEqual([])
  })

  test("prefs default to handoff+blocked, are per device and persist", () => {
    const a = store.addDevice("a").device
    expect(store.pushPrefs(a.id)).toEqual({ handoff: true, blocked: true, finished: false, say: true })
    expect(DEFAULT_PUSH_PREFS).toEqual({ handoff: true, blocked: true, finished: false, say: true })
    store.setPushPrefs(a.id, { finished: true })
    expect(Store.open(dir).pushPrefs(a.id)).toEqual({ handoff: true, blocked: true, finished: true, say: true })
  })
})

describe("notify", () => {
  let push: Push
  let fake: ReturnType<typeof fakeSender>
  let phone: string
  let tablet: string

  const setup = (failures: Record<string, number> = {}) => {
    fake = fakeSender(failures)
    push = new Push({ store, subject: "mailto:admin@example.com", sender: fake.sender, now })
    const p = store.addDevice("phone")
    const t = store.addDevice("tablet")
    phone = p.device.id
    tablet = t.device.id
    store.addPushSubscription(phone, sub(1))
    store.addPushSubscription(tablet, sub(2))
    return { phoneToken: p.token, tabletToken: t.token }
  }

  test("sends {kind, sessionID, title, body} with TTL 300 and high urgency; returns successful sends", async () => {
    setup()
    expect(await push.notify("handoff", "ses_1", "api-server")).toBe(2)
    expect(fake.sent.map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint])
    const { payload, options } = fake.sent[0]!
    expect(Object.keys(payload).sort()).toEqual(["body", "kind", "sessionID", "title"])
    expect(payload).toMatchObject({ kind: "handoff", sessionID: "ses_1" })
    expect(payload.title).toContain("api-server")
    expect(options).toMatchObject({ TTL: 300, urgency: "high" })
    expect(options.vapidDetails).toEqual({
      subject: "mailto:admin@example.com",
      publicKey: push.publicKey(),
      privateKey: store.data().vapid!.privateKey,
    })
  })

  test("blocked titles say what is needed; finished is normal urgency", async () => {
    setup()
    store.setPushPrefs(phone, { finished: true })
    await push.notify("blocked", "ses_1", "api-server", "permission")
    await push.notify("blocked", "ses_2", "docs", "form")
    await push.notify("finished", "ses_3", "build", "failed")
    const titles = fake.sent.map((s) => s.payload.title)
    expect(titles).toContain("api-server needs permission")
    expect(titles).toContain("docs has a question")
    expect(titles).toContain("build failed")
    expect(fake.sent.find((s) => s.payload.kind === "finished")!.options.urgency).toBe("normal")
  })

  test("payload never carries tokens, cookies or long titles", async () => {
    const { phoneToken, tabletToken } = setup()
    await push.notify("handoff", "ses_1", "x".repeat(500))
    for (const s of fake.sent) {
      expect(s.raw).not.toContain(phoneToken)
      expect(s.raw).not.toContain(tabletToken)
      expect(s.raw).not.toContain("voice_device")
      expect(s.raw).not.toContain(store.data().vapid!.privateKey)
      expect(s.payload.title.length).toBeLessThanOrEqual(100)
    }
  })

  test("prefs are respected per device", async () => {
    setup()
    expect(await push.notify("finished", "ses_1", "t", "succeeded")).toBe(0)
    store.setPushPrefs(tablet, { finished: true })
    expect(await push.notify("finished", "ses_2", "t", "succeeded")).toBe(1)
    expect(fake.sent.map((s) => s.endpoint)).toEqual([sub(2).endpoint])
    store.setPushPrefs(phone, { blocked: false })
    expect(await push.notify("blocked", "ses_3", "t", "permission")).toBe(1)
  })

  test("cooldown of 30 s per (session, kind)", async () => {
    setup()
    expect(PUSH_COOLDOWN_MS).toBe(30_000)
    expect(await push.notify("blocked", "ses_1", "t", "permission")).toBe(2)
    clock += 10_000
    expect(await push.notify("blocked", "ses_1", "t", "form")).toBe(0)
    expect(await push.notify("handoff", "ses_1", "t")).toBe(2)
    expect(await push.notify("blocked", "ses_2", "t", "permission")).toBe(2)
    clock += PUSH_COOLDOWN_MS
    expect(await push.notify("blocked", "ses_1", "t", "permission")).toBe(2)
  })

  test("say pushes carry the spoken text (at most 180 chars) under the session title, high urgency, 10 s cooldown", async () => {
    setup()
    expect(SAY_COOLDOWN_MS).toBe(10_000)
    expect(await push.notify("say", "ses_1", "api-server", undefined, `${"x".repeat(300)}`)).toBe(2)
    const { payload, options } = fake.sent[0]!
    expect(payload).toEqual({ kind: "say", sessionID: "ses_1", title: "api-server", body: `${"x".repeat(179)}…` })
    expect(options.urgency).toBe("high")
    clock += 5_000
    expect(await push.notify("say", "ses_1", "api-server", undefined, "next")).toBe(0)
    clock += 5_000
    store.setPushPrefs(phone, { say: false })
    expect(await push.notify("say", "ses_1", "api-server", undefined, "  Tests\n  pass.  ")).toBe(1)
    expect(fake.sent.at(-1)!.payload.body).toBe("Tests pass.")
  })

  test("404/410 prune the subscription; other failures keep it; failures are not counted", async () => {
    setup({ [sub(1).endpoint]: 410 })
    store.addPushSubscription(phone, sub(3))
    store.addPushSubscription(tablet, sub(4))
    push = new Push({
      store,
      subject: "mailto:a@b.c",
      sender: fakeSender({ [sub(1).endpoint]: 410, [sub(3).endpoint]: 404, [sub(4).endpoint]: 500 }).sender,
      now,
    })
    expect(await push.notify("handoff", "ses_1", "t")).toBe(1)
    expect(store.pushSubscriptions().map((s) => s.endpoint).sort()).toEqual([sub(2).endpoint, sub(4).endpoint])
  })

  test("no subscriptions → 0", async () => {
    push = new Push({ store, subject: "mailto:a@b.c", sender: fakeSender().sender, now })
    expect(await push.notify("handoff", "ses_1", "t")).toBe(0)
  })
})
