import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_PUSH_PREFS, inQuietHours, Push, PUSH_COOLDOWN_MS, pushKindFor, SAY_COOLDOWN_MS, TEST_COOLDOWN_MS, URGENT_TTL_SECONDS, type PushSender } from "../src/central/push"
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

  test("prefs default to hand-offs, questions, permissions and say; are per device and persist", () => {
    const a = store.addDevice("a").device
    const defaults = { handoff: true, question: true, permission: true, finished: false, failed: false, say: true }
    expect(store.pushPrefs(a.id)).toEqual(defaults)
    expect(DEFAULT_PUSH_PREFS).toEqual(defaults)
    store.setPushPrefs(a.id, { finished: true })
    expect(Store.open(dir).pushPrefs(a.id)).toEqual({ ...defaults, finished: true })
  })

  test("legacy prefs migrate: blocked → question + permission, finished → finished + failed", () => {
    const a = store.addDevice("a").device
    const b = store.addDevice("b").device
    const raw = store.data()
    // 0.5.0 stored the whole {handoff, blocked, finished, say} object.
    raw.devices.find((d) => d.id === a.id)!.pushPrefs = { handoff: true, blocked: false, finished: true, say: false } as any
    raw.devices.find((d) => d.id === b.id)!.pushPrefs = { handoff: false, blocked: true, finished: false, say: true } as any
    writeFileSync(path.join(dir, "state.json"), JSON.stringify(raw))
    const reopened = Store.open(dir)
    expect(reopened.pushPrefs(a.id)).toEqual({ handoff: true, question: false, permission: false, finished: true, failed: true, say: false })
    expect(reopened.pushPrefs(b.id)).toEqual({ handoff: false, question: true, permission: true, finished: false, failed: false, say: true })
    // Migrated on open and written back without the legacy key.
    expect(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).devices.find((d: any) => d.id === a.id).pushPrefs.blocked).toBeUndefined()
  })

  test("a legacy blocked toggle sets both question and permission", () => {
    const a = store.addDevice("a").device
    expect(store.setPushPrefs(a.id, { blocked: false } as any)).toMatchObject({ question: false, permission: false })
  })

  test("quiet hours per device: valid HH:MM and an IANA time zone, or null to clear", () => {
    const a = store.addDevice("a").device
    expect(store.quietHours(a.id)).toBeUndefined()
    expect(store.setQuietHours(a.id, { start: "22:00", end: "07:30", timeZone: "Europe/Berlin" })).toEqual({ start: "22:00", end: "07:30", timeZone: "Europe/Berlin" })
    expect(Store.open(dir).quietHours(a.id)).toEqual({ start: "22:00", end: "07:30", timeZone: "Europe/Berlin" })
    store.setQuietHours(a.id, null)
    expect(store.quietHours(a.id)).toBeUndefined()
  })

  test("muted sessions are per user, deduped, capped and persisted", () => {
    const user = store.addDevice("a").device.ownerID
    expect(store.mutedSessions(user)).toEqual([])
    store.setSessionMuted(user, "ses_1", true)
    store.setSessionMuted(user, "ses_1", true)
    store.setSessionMuted(user, "ses_2", true)
    expect(Store.open(dir).mutedSessions(user)).toEqual(["ses_1", "ses_2"])
    store.setSessionMuted(user, "ses_1", false)
    expect(store.mutedSessions(user)).toEqual(["ses_2"])
    for (let i = 0; i < 600; i++) store.setSessionMuted(user, `ses_x${i}`, true)
    expect(store.mutedSessions(user).length).toBe(500)
    expect(store.mutedSessions(user).at(-1)).toBe("ses_x599")
  })
})

describe("kind mapping", () => {
  test("alerts map to the precise notification kind", () => {
    expect(pushKindFor("handoff")).toBe("handoff")
    expect(pushKindFor("say")).toBe("say")
    expect(pushKindFor("blocked", "form")).toBe("question")
    expect(pushKindFor("blocked", "permission")).toBe("permission")
    expect(pushKindFor("blocked")).toBe("permission")
    expect(pushKindFor("finished", "succeeded")).toBe("finished")
    expect(pushKindFor("finished", "failed")).toBe("failed")
    expect(pushKindFor("finished")).toBe("finished")
  })
})

describe("quiet hours", () => {
  // 2026-01-15 is winter: Berlin is UTC+1.
  const at = (iso: string) => Date.parse(iso)
  const night = { start: "22:00", end: "07:00", timeZone: "Europe/Berlin" }
  test("over midnight, in the device's time zone", () => {
    expect(inQuietHours(night, at("2026-01-15T21:30:00Z"))).toBe(true) // 22:30 Berlin
    expect(inQuietHours(night, at("2026-01-15T05:59:00Z"))).toBe(true) // 06:59
    expect(inQuietHours(night, at("2026-01-15T06:00:00Z"))).toBe(false) // 07:00
    expect(inQuietHours(night, at("2026-01-15T20:59:00Z"))).toBe(false) // 21:59
  })
  test("within a day; equal start and end means never; a bad zone means never", () => {
    const lunch = { start: "12:00", end: "13:00", timeZone: "UTC" }
    expect(inQuietHours(lunch, at("2026-01-15T12:30:00Z"))).toBe(true)
    expect(inQuietHours(lunch, at("2026-01-15T13:00:00Z"))).toBe(false)
    expect(inQuietHours({ start: "08:00", end: "08:00", timeZone: "UTC" }, at("2026-01-15T08:00:00Z"))).toBe(false)
    expect(inQuietHours({ start: "00:00", end: "23:59", timeZone: "Mars/Olympus" }, at("2026-01-15T08:00:00Z"))).toBe(false)
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

  test("blocked titles say what is needed; kinds are precise; urgent kinds live longer", async () => {
    setup()
    store.setPushPrefs(phone, { finished: true, failed: true })
    await push.notify("blocked", "ses_1", "api-server", "permission", "bash: rm -rf build", undefined, { requestID: "per_1" })
    await push.notify("blocked", "ses_2", "docs", "form")
    await push.notify("finished", "ses_3", "build", "failed")
    await push.notify("finished", "ses_4", "lint", "succeeded")
    const by = (kind: string) => fake.sent.find((s) => s.payload.kind === kind)!
    expect(by("permission").payload).toMatchObject({ title: "api-server needs permission", sessionID: "ses_1", requestID: "per_1" })
    // The request's summary (a command line) never goes through the push service.
    expect(fake.sent.find((s) => s.payload.kind === "permission")!.raw).not.toContain("rm -rf")
    expect(by("question").payload.title).toBe("docs has a question")
    expect(by("failed").payload.title).toBe("build failed")
    expect(by("finished").payload.title).toBe("lint finished")
    for (const kind of ["permission", "question", "failed"]) {
      expect(by(kind).options).toMatchObject({ urgency: "high", TTL: URGENT_TTL_SECONDS })
    }
    expect(by("finished").options.urgency).toBe("normal")
    expect(URGENT_TTL_SECONDS).toBeGreaterThanOrEqual(3600)
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

  test("prefs are respected per device and per precise kind", async () => {
    setup()
    expect(await push.notify("finished", "ses_1", "t", "succeeded")).toBe(0)
    store.setPushPrefs(tablet, { finished: true })
    expect(await push.notify("finished", "ses_2", "t", "succeeded")).toBe(1)
    expect(fake.sent.map((s) => s.endpoint)).toEqual([sub(2).endpoint])
    // failed is its own toggle now.
    expect(await push.notify("finished", "ses_2b", "t", "failed")).toBe(0)
    store.setPushPrefs(phone, { failed: true })
    expect(await push.notify("finished", "ses_2c", "t", "failed")).toBe(1)
    store.setPushPrefs(phone, { permission: false })
    expect(await push.notify("blocked", "ses_3", "t", "permission")).toBe(1)
    expect(await push.notify("blocked", "ses_4", "t", "form")).toBe(2)
    store.setPushPrefs(tablet, { question: false })
    expect(await push.notify("blocked", "ses_5", "t", "form")).toBe(1)
  })

  test("a muted session notifies nothing of its owner's devices except hand-offs", async () => {
    setup()
    const owner = store.devices().find((d) => d.id === phone)!.ownerID
    store.setSessionMuted(owner, "ses_1", true)
    expect(await push.notify("blocked", "ses_1", "t", "permission", undefined, owner)).toBe(0)
    expect(await push.notify("say", "ses_1", "t", undefined, "hi", owner)).toBe(0)
    expect(await push.notify("handoff", "ses_1", "t", undefined, undefined, owner)).toBe(2)
    expect(await push.notify("blocked", "ses_2", "t", "permission", undefined, owner)).toBe(2)
  })

  test("quiet hours silence a device except hand-offs", async () => {
    setup()
    clock = Date.parse("2026-01-15T23:00:00Z")
    store.setQuietHours(phone, { start: "22:00", end: "07:00", timeZone: "UTC" })
    expect(await push.notify("blocked", "ses_1", "t", "permission")).toBe(1)
    expect(fake.sent.map((s) => s.endpoint)).toEqual([sub(2).endpoint])
    expect(await push.notify("handoff", "ses_1", "t")).toBe(2)
    clock = Date.parse("2026-01-16T08:00:00Z")
    expect(await push.notify("blocked", "ses_2", "t", "permission")).toBe(2)
  })

  test("cooldown of 30 s per (session, kind)", async () => {
    setup()
    expect(PUSH_COOLDOWN_MS).toBe(30_000)
    expect(await push.notify("blocked", "ses_1", "t", "permission")).toBe(2)
    clock += 10_000
    expect(await push.notify("blocked", "ses_1", "t", "permission")).toBe(0)
    // Another kind of the same session has its own cooldown.
    expect(await push.notify("blocked", "ses_1", "t", "form")).toBe(2)
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

  test("test notifications go only to the given device, ignore prefs and are rate limited", async () => {
    setup({ [sub(5).endpoint]: 500 })
    store.addPushSubscription(phone, sub(5))
    store.setPushPrefs(phone, { handoff: false, question: false, permission: false, say: false })
    const result = await push.test(phone)
    expect(result).toEqual({ sent: 1, failed: [{ host: "push.example", status: 500 }] })
    expect(fake.sent.map((s) => s.endpoint)).toEqual([sub(1).endpoint])
    expect(fake.sent[0]!.payload).toMatchObject({ kind: "test", sessionID: "" })
    expect(await push.test(phone)).toEqual({ limited: true, retryAfter: Math.ceil(TEST_COOLDOWN_MS / 1000) })
    // Another device has its own limit.
    expect(await push.test(tablet)).toMatchObject({ sent: 1 })
    clock += TEST_COOLDOWN_MS
    expect(await push.test(phone)).toMatchObject({ sent: 1 })
  })

  test("no subscriptions → 0", async () => {
    push = new Push({ store, subject: "mailto:a@b.c", sender: fakeSender().sender, now })
    expect(await push.notify("handoff", "ses_1", "t")).toBe(0)
  })
})
