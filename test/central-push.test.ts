import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_PUSH_PREFS, inQuietHours, NOTIFICATION_LABELS, Push, PUSH_COOLDOWN_MS, pushPayload, SAY_COOLDOWN_MS, sendOptionsFor, TEST_COOLDOWN_MS, URGENT_TTL_SECONDS, type PushSender } from "../src/central/push"
import { MemoryKv } from "../src/central/backend/memory-kv"
import { PUSH_PREF_KEYS } from "../src/central/store"
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
  test("generated once, persisted, reused after reopening the store", async () => {
    const push = new Push({ store, subject: "mailto:a@b.c", sender: fakeSender().sender, now })
    const key = await push.publicKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    expect(await push.publicKey()).toBe(key)
    expect(store.data().vapid?.publicKey).toBe(key)
    const reopened = new Push({ store: Store.open(dir), subject: "mailto:a@b.c", sender: fakeSender().sender, now })
    expect(await reopened.publicKey()).toBe(key)
  })
})

describe("subscriptions and prefs", () => {
  test("dedupe by endpoint; several per device; unsubscribe only own; device removal drops them", async () => {
    const a = (await store.addDevice("a")).device
    const b = (await store.addDevice("b")).device
    await store.addPushSubscription(a.id, sub(1))
    await store.addPushSubscription(a.id, sub(2))
    await store.addPushSubscription(a.id, sub(1))
    expect(store.pushSubscriptions().map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint])
    // The same endpoint re-subscribed by another device moves to that device.
    await store.addPushSubscription(b.id, sub(2))
    expect(store.pushSubscriptions().filter((s) => s.deviceID === b.id).map((s) => s.endpoint)).toEqual([sub(2).endpoint])
    expect(await store.removePushSubscription(a.id, sub(2).endpoint)).toBe(false)
    expect(await store.removePushSubscription(a.id, sub(1).endpoint)).toBe(true)
    await store.removeDevice(b.id)
    expect(store.pushSubscriptions()).toEqual([])
  })

  const defaults = {
    handoff: true,
    question: true,
    permission: true,
    done: true,
    failed: true,
    turn: false,
    stopped: false,
    retry: false,
    subagentDone: false,
    subagentFailed: false,
    jobDone: false,
    jobFailed: false,
    longTool: false,
    say: true,
    activity: false,
    decision: true,
    message: true,
    providerError: true,
  }

  test("prefs default to needs-you, all done, failed, hand-offs and say; are per device and persist", async () => {
    const a = (await store.addDevice("a")).device
    expect(store.pushPrefs(a.id)).toEqual(defaults)
    expect(DEFAULT_PUSH_PREFS).toEqual(defaults)
    expect([...PUSH_PREF_KEYS].sort() as string[]).toEqual(Object.keys(defaults).sort())
    await store.setPushPrefs(a.id, { turn: true, subagentDone: true })
    expect(Store.open(dir).pushPrefs(a.id)).toEqual({ ...defaults, turn: true, subagentDone: true })
  })

  test("devices stored before providerError existed get it on by default", async () => {
    const a = (await store.addDevice("a")).device
    const raw = store.data()
    const { providerError: _, ...before } = defaults
    raw.devices.find((d) => d.id === a.id)!.pushPrefs = { ...before, failed: false } as any
    writeFileSync(path.join(dir, "state.json"), JSON.stringify(raw))
    expect(Store.open(dir).pushPrefs(a.id)).toEqual({ ...defaults, failed: false, providerError: true })
  })

  test("the old 'finished' key (every root turn) is accepted and means all done", async () => {
    const a = (await store.addDevice("a")).device
    expect(await store.setPushPrefs(a.id, { finished: false } as any)).toMatchObject({ done: false, turn: false })
    expect(await store.setPushPrefs(a.id, { finished: true } as any)).toMatchObject({ done: true, turn: false })
    expect("finished" in store.pushPrefs(a.id)).toBe(false)
  })

  test("0.7 prefs migrate: finished → all done (not every turn), failed and activity kept, new kinds off", async () => {
    const a = (await store.addDevice("a")).device
    const b = (await store.addDevice("b")).device
    const raw = store.data()
    raw.devices.find((d) => d.id === a.id)!.pushPrefs = { handoff: true, question: true, permission: true, finished: true, failed: true, say: true, activity: true } as any
    raw.devices.find((d) => d.id === b.id)!.pushPrefs = { handoff: true, question: true, permission: false, finished: false, failed: false, say: false, activity: false } as any
    writeFileSync(path.join(dir, "state.json"), JSON.stringify(raw))
    const reopened = Store.open(dir)
    expect(reopened.pushPrefs(a.id)).toEqual({ ...defaults, done: true, failed: true, activity: true })
    expect(reopened.pushPrefs(b.id)).toEqual({ ...defaults, permission: false, done: false, failed: false, say: false })
    const stored = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).devices.find((d: any) => d.id === a.id).pushPrefs
    expect(stored.finished).toBeUndefined()
    expect(stored.done).toBe(true)
  })

  test("legacy prefs migrate: blocked → question + permission, finished → all done + failed", async () => {
    const a = (await store.addDevice("a")).device
    const b = (await store.addDevice("b")).device
    const raw = store.data()
    // 0.5.0 stored the whole {handoff, blocked, finished, say} object.
    raw.devices.find((d) => d.id === a.id)!.pushPrefs = { handoff: true, blocked: false, finished: true, say: false } as any
    raw.devices.find((d) => d.id === b.id)!.pushPrefs = { handoff: false, blocked: true, finished: false, say: true } as any
    writeFileSync(path.join(dir, "state.json"), JSON.stringify(raw))
    const reopened = Store.open(dir)
    expect(reopened.pushPrefs(a.id)).toEqual({ ...defaults, handoff: true, question: false, permission: false, done: true, failed: true, say: false })
    expect(reopened.pushPrefs(b.id)).toEqual({ ...defaults, handoff: false, question: true, permission: true, done: false, failed: false, say: true })
    // Migrated on open and written back without the legacy key.
    expect(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).devices.find((d: any) => d.id === a.id).pushPrefs.blocked).toBeUndefined()
  })

  test("a legacy blocked toggle sets both question and permission", async () => {
    const a = (await store.addDevice("a")).device
    expect(await store.setPushPrefs(a.id, { blocked: false } as any)).toMatchObject({ question: false, permission: false })
  })

  test("quiet hours per device: valid HH:MM and an IANA time zone, or null to clear", async () => {
    const a = (await store.addDevice("a")).device
    expect(store.quietHours(a.id)).toBeUndefined()
    expect(await store.setQuietHours(a.id, { start: "22:00", end: "07:30", timeZone: "Europe/Berlin" })).toEqual({ start: "22:00", end: "07:30", timeZone: "Europe/Berlin" })
    expect(Store.open(dir).quietHours(a.id)).toEqual({ start: "22:00", end: "07:30", timeZone: "Europe/Berlin" })
    await store.setQuietHours(a.id, null)
    expect(store.quietHours(a.id)).toBeUndefined()
  })

  test("muted sessions are per user, deduped, capped and persisted", async () => {
    const user = (await store.addDevice("a")).device.ownerID
    expect(store.mutedSessions(user)).toEqual([])
    await store.setSessionMuted(user, "ses_1", true)
    await store.setSessionMuted(user, "ses_1", true)
    await store.setSessionMuted(user, "ses_2", true)
    expect(Store.open(dir).mutedSessions(user)).toEqual(["ses_1", "ses_2"])
    await store.setSessionMuted(user, "ses_1", false)
    expect(store.mutedSessions(user)).toEqual(["ses_2"])
    for (let i = 0; i < 600; i++) await store.setSessionMuted(user, `ses_x${i}`, true)
    expect(store.mutedSessions(user).length).toBe(500)
    expect(store.mutedSessions(user).at(-1)).toBe("ses_x599")
  })
})

describe("payloads per kind", () => {
  test("every kind has a short label shown in the title after the session name", () => {
    expect(Object.keys(NOTIFICATION_LABELS).sort()).toEqual([...PUSH_PREF_KEYS].sort())
    const title = (kind: any, text?: string, subject?: string) => pushPayload(kind, "ses_1", "KVM Rewrite", text, { subject }).title
    expect(title("question")).toBe("KVM Rewrite · Question")
    expect(title("decision")).toBe("KVM Rewrite · Decision")
    expect(title("message")).toBe("KVM Rewrite · Message")
    expect(title("permission")).toBe("KVM Rewrite · Needs permission")
    expect(title("done")).toBe("KVM Rewrite · All done")
    expect(title("failed")).toBe("KVM Rewrite · Failed")
    expect(title("turn")).toBe("KVM Rewrite · Turn finished")
    expect(title("stopped")).toBe("KVM Rewrite · Stopped")
    expect(title("retry")).toBe("KVM Rewrite · Retrying")
    expect(title("providerError", "explore: Quota exceeded")).toBe("KVM Rewrite · Model provider error")
    expect(title("subagentDone", undefined, "S3 macros")).toBe("KVM Rewrite · Subagent S3 macros finished")
    expect(title("subagentFailed", undefined, "S3 macros")).toBe("KVM Rewrite · Subagent S3 macros failed")
    expect(title("jobDone", undefined, "exited 0")).toBe("KVM Rewrite · Script exited 0")
    expect(title("jobFailed", undefined, "exited 1")).toBe("KVM Rewrite · Script exited 1")
    expect(title("longTool", undefined, "45s")).toBe("KVM Rewrite · Long tool finished (45s)")
    // Say and hand-off keep the session name alone (the body says it all).
    expect(title("say", "hi")).toBe("KVM Rewrite")
    expect(title("handoff")).toBe("KVM Rewrite · Hand-off")
    expect(title("activity", "3 tools")).toBe("KVM Rewrite · Activity")
  })

  test("bodies carry the given detail, clipped; a failure's reason; defaults otherwise", () => {
    expect(pushPayload("failed", "s", "t", "Provider blocked the response").body).toBe("Provider blocked the response")
    expect(pushPayload("failed", "s", "t").body).toBe("Tap to open the session.")
    expect(pushPayload("jobFailed", "s", "t", "x".repeat(300), { subject: "exited 1" }).body.length).toBeLessThanOrEqual(180)
    expect(pushPayload("done", "s", "t").body).toBe("Nothing is running or waiting. Tap to open.")
    // Decisions and agent messages never carry their text (an agent wrote it): a generic body, the session to open.
    expect(pushPayload("decision", "ses_1", "t", "Drop column legacy_id?")).toEqual({ kind: "decision", sessionID: "ses_1", title: "t · Decision", body: "A decision waits for you. Tap to answer." })
    expect(pushPayload("message", "ses_1", "t", "secret text")).toEqual({ kind: "message", sessionID: "ses_1", title: "t · Message", body: "Tap to see it." })
  })

  test("a decision push names its Decision (the tap opens its card); other kinds never carry one", () => {
    expect(pushPayload("decision", "ses_1", "t", undefined, { decisionID: "dec_abc" })).toEqual({
      kind: "decision",
      sessionID: "ses_1",
      title: "t · Decision",
      body: "A decision waits for you. Tap to answer.",
      decisionID: "dec_abc",
    })
    expect(pushPayload("message", "ses_1", "t", undefined, { decisionID: "dec_abc" })).not.toHaveProperty("decisionID")
  })

  test("urgency and lifetime per kind", () => {
    for (const kind of ["question", "permission", "failed", "decision", "message", "providerError"] as const) expect(sendOptionsFor(kind)).toEqual({ TTL: URGENT_TTL_SECONDS, urgency: "high" })
    for (const kind of ["done", "subagentFailed", "jobFailed", "stopped"] as const) expect(sendOptionsFor(kind)).toEqual({ TTL: URGENT_TTL_SECONDS, urgency: "normal" })
    for (const kind of ["turn", "retry", "subagentDone", "jobDone", "longTool", "activity"] as const) expect(sendOptionsFor(kind)).toEqual({ TTL: 300, urgency: "normal" })
    for (const kind of ["say", "handoff", "test"] as const) expect(sendOptionsFor(kind)).toEqual({ TTL: 300, urgency: "high" })
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

  const setup = async (failures: Record<string, number> = {}) => {
    fake = fakeSender(failures)
    push = new Push({ store, subject: "mailto:admin@example.com", sender: fake.sender, now })
    const p = await store.addDevice("phone")
    const t = await store.addDevice("tablet")
    phone = p.device.id
    tablet = t.device.id
    await store.addPushSubscription(phone, sub(1))
    await store.addPushSubscription(tablet, sub(2))
    return { phoneToken: p.token, tabletToken: t.token }
  }

  test("sends {kind, sessionID, title, body} with TTL 300 and high urgency; returns successful sends", async () => {
    await setup()
    expect(await push.notify("handoff", "ses_1", "api-server")).toBe(2)
    expect(fake.sent.map((s) => s.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint])
    const { payload, options } = fake.sent[0]!
    expect(Object.keys(payload).sort()).toEqual(["body", "kind", "sessionID", "title"])
    expect(payload).toMatchObject({ kind: "handoff", sessionID: "ses_1" })
    expect(payload.title).toContain("api-server")
    expect(options).toMatchObject({ TTL: 300, urgency: "high" })
    expect(options.vapidDetails).toEqual({
      subject: "mailto:admin@example.com",
      publicKey: await push.publicKey(),
      privateKey: store.data().vapid!.privateKey,
    })
  })

  test("blocked titles say what is needed; kinds are precise; urgent kinds live longer", async () => {
    await setup()
    
    await push.notify("permission", "ses_1", "api-server", "bash: rm -rf build", undefined, { requestID: "per_1" })
    await push.notify("question", "ses_2", "docs")
    await push.notify("failed", "ses_3", "build")
    await push.notify("done", "ses_4", "lint")
    const by = (kind: string) => fake.sent.find((s) => s.payload.kind === kind)!
    expect(by("permission").payload).toMatchObject({ title: "api-server · Needs permission", sessionID: "ses_1", requestID: "per_1" })
    // The request's summary (a command line) never goes through the push service.
    expect(fake.sent.find((s) => s.payload.kind === "permission")!.raw).not.toContain("rm -rf")
    expect(by("question").payload.title).toBe("docs · Question")
    expect(by("failed").payload.title).toBe("build · Failed")
    expect(by("done").payload.title).toBe("lint · All done")
    for (const kind of ["permission", "question", "failed"]) {
      expect(by(kind).options).toMatchObject({ urgency: "high", TTL: URGENT_TTL_SECONDS })
    }
    expect(by("done").options.urgency).toBe("normal")
    expect(URGENT_TTL_SECONDS).toBeGreaterThanOrEqual(3600)
  })

  test("payload never carries tokens, cookies or long titles", async () => {
    const { phoneToken, tabletToken } = await setup()
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
    await setup()
    expect(await push.notify("turn", "ses_1", "t")).toBe(0)
    await store.setPushPrefs(tablet, { turn: true })
    expect(await push.notify("turn", "ses_2", "t")).toBe(1)
    expect(fake.sent.map((s) => s.endpoint)).toEqual([sub(2).endpoint])
    // failed is its own toggle.
    await store.setPushPrefs(phone, { failed: false })
    expect(await push.notify("failed", "ses_2c", "t")).toBe(1)
    await store.setPushPrefs(phone, { subagentDone: true })
    expect(await push.notify("subagentDone", "ses_2d", "t", undefined, undefined, { subject: "explore" })).toBe(1)
    await store.setPushPrefs(phone, { permission: false })
    expect(await push.notify("permission", "ses_3", "t")).toBe(1)
    expect(await push.notify("question", "ses_4", "t")).toBe(2)
    await store.setPushPrefs(tablet, { question: false })
    expect(await push.notify("question", "ses_5", "t")).toBe(1)
  })

  test("a muted session notifies nothing of its owner's devices except hand-offs", async () => {
    await setup()
    const owner = store.devices().find((d) => d.id === phone)!.ownerID
    await store.setSessionMuted(owner, "ses_1", true)
    expect(await push.notify("permission", "ses_1", "t", undefined, owner)).toBe(0)
    expect(await push.notify("say", "ses_1", "t", "hi", owner)).toBe(0)
    expect(await push.notify("handoff", "ses_1", "t", undefined, owner)).toBe(2)
    expect(await push.notify("permission", "ses_2", "t", undefined, owner)).toBe(2)
  })

  test("quiet hours silence a device except hand-offs", async () => {
    await setup()
    clock = Date.parse("2026-01-15T23:00:00Z")
    await store.setQuietHours(phone, { start: "22:00", end: "07:00", timeZone: "UTC" })
    expect(await push.notify("permission", "ses_1", "t")).toBe(1)
    expect(fake.sent.map((s) => s.endpoint)).toEqual([sub(2).endpoint])
    expect(await push.notify("handoff", "ses_1", "t")).toBe(2)
    clock = Date.parse("2026-01-16T08:00:00Z")
    expect(await push.notify("permission", "ses_2", "t")).toBe(2)
  })

  test("cooldown of 30 s per (session, kind)", async () => {
    await setup()
    expect(PUSH_COOLDOWN_MS).toBe(30_000)
    expect(await push.notify("permission", "ses_1", "t")).toBe(2)
    clock += 10_000
    expect(await push.notify("permission", "ses_1", "t")).toBe(0)
    // Another kind of the same session has its own cooldown.
    expect(await push.notify("question", "ses_1", "t")).toBe(2)
    expect(await push.notify("handoff", "ses_1", "t")).toBe(2)
    expect(await push.notify("permission", "ses_2", "t")).toBe(2)
    clock += PUSH_COOLDOWN_MS
    expect(await push.notify("permission", "ses_1", "t")).toBe(2)
  })

  test("say pushes carry the spoken text (at most 180 chars) under the session title, high urgency, 10 s cooldown", async () => {
    await setup()
    expect(SAY_COOLDOWN_MS).toBe(10_000)
    expect(await push.notify("say", "ses_1", "api-server", `${"x".repeat(300)}`)).toBe(2)
    const { payload, options } = fake.sent[0]!
    expect(payload).toEqual({ kind: "say", sessionID: "ses_1", title: "api-server", body: `${"x".repeat(179)}…` })
    expect(options.urgency).toBe("high")
    clock += 5_000
    expect(await push.notify("say", "ses_1", "api-server", "next")).toBe(0)
    clock += 5_000
    await store.setPushPrefs(phone, { say: false })
    expect(await push.notify("say", "ses_1", "api-server", "  Tests\n  pass.  ")).toBe(1)
    expect(fake.sent.at(-1)!.payload.body).toBe("Tests pass.")
  })

  test("404/410 prune the subscription; other failures keep it; failures are not counted", async () => {
    await setup({ [sub(1).endpoint]: 410 })
    await store.addPushSubscription(phone, sub(3))
    await store.addPushSubscription(tablet, sub(4))
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
    await setup({ [sub(5).endpoint]: 500 })
    await store.addPushSubscription(phone, sub(5))
    await store.setPushPrefs(phone, { handoff: false, question: false, permission: false, say: false })
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

  // Cluster mode (P6-T8): cooldowns are Kv keys (SET NX PX), so two pods never both push the same (session, kind).
  test("cooldowns hold across pods sharing a Kv: notifications and test notifications", async () => {
    await setup()
    const kv = new MemoryKv({ now })
    const a = new Push({ store, subject: "mailto:a@b.c", sender: fake.sender, now, kv })
    const b = new Push({ store, subject: "mailto:a@b.c", sender: fake.sender, now, kv })
    expect(await a.notify("permission", "ses_1", "t")).toBe(2)
    clock += 10_000
    expect(await b.notify("permission", "ses_1", "t")).toBe(0)
    expect(await b.notify("question", "ses_1", "t")).toBe(2)
    clock += PUSH_COOLDOWN_MS
    expect(await b.notify("permission", "ses_1", "t")).toBe(2)
    expect(await a.test(phone)).toMatchObject({ sent: 1 })
    clock += 4_000
    expect(await b.test(phone)).toEqual({ limited: true, retryAfter: Math.ceil((TEST_COOLDOWN_MS - 4_000) / 1000) })
    clock += TEST_COOLDOWN_MS
    expect(await b.test(phone)).toMatchObject({ sent: 1 })
  })

  test("a test of a chosen kind looks like that kind (label, urgency), marked as a test", async () => {
    await setup()
    expect(await push.test(phone, "done")).toMatchObject({ sent: 1 })
    expect(fake.sent[0]!.payload).toMatchObject({ kind: "done", sessionID: "", title: "Test session · All done", test: true })
    expect(fake.sent[0]!.options.urgency).toBe("normal")
    clock += TEST_COOLDOWN_MS
    expect(await push.test(phone, "jobFailed")).toMatchObject({ sent: 1 })
    expect(fake.sent[1]!.payload.title).toBe("Test session · Script exited 1")
  })

  test("no subscriptions → 0", async () => {
    push = new Push({ store, subject: "mailto:a@b.c", sender: fakeSender().sender, now })
    expect(await push.notify("handoff", "ses_1", "t")).toBe(0)
  })
})
