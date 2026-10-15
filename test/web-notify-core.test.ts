// Notification status on this device and whether to re-subscribe (web/src/core/notify-core.ts).
import { describe, expect, test } from "bun:test"
import { describeTestResult, NOTIFY_TOGGLES, notifyStatus, quietHoursLabel, shouldResubscribe, type NotifyEnv } from "../web/src/core/notify-core"

const env = (over: Partial<NotifyEnv> = {}): NotifyEnv => ({
  supported: true,
  permission: "granted",
  worker: true,
  endpoint: "https://push.example/a",
  hubSubscribed: true,
  hubSubscriptions: 1,
  ...over,
})

describe("notifyStatus", () => {
  test("unsupported and blocked browsers cannot enable", () => {
    expect(notifyStatus(env({ supported: false }))).toMatchObject({ state: "unsupported", action: "none", warn: true })
    expect(notifyStatus(env({ permission: "denied" }))).toMatchObject({ state: "blocked", action: "none", warn: true })
  })

  test("permission not asked yet: off, enable offered", () => {
    expect(notifyStatus(env({ permission: "default", endpoint: undefined, hubSubscribed: false, hubSubscriptions: 0 }))).toMatchObject({ state: "off", action: "enable", warn: true })
  })

  test("granted but the hub holds no subscription for this browser (e.g. a new hub origin): needs repair", () => {
    const s = notifyStatus(env({ hubSubscribed: false, hubSubscriptions: 0 }))
    expect(s).toMatchObject({ state: "repair", action: "enable", warn: true })
    expect(s.message).toMatch(/not subscribed/i)
    expect(notifyStatus(env({ endpoint: undefined, hubSubscribed: false }))).toMatchObject({ state: "repair", action: "enable" })
    expect(notifyStatus(env({ worker: false }))).toMatchObject({ state: "repair", action: "enable" })
  })

  test("granted, worker registered and the hub knows the endpoint: on", () => {
    expect(notifyStatus(env())).toMatchObject({ state: "on", action: "disable", warn: false })
  })
})

describe("shouldResubscribe", () => {
  test("only with permission granted and something missing", () => {
    expect(shouldResubscribe(env())).toBe(false)
    expect(shouldResubscribe(env({ hubSubscribed: false }))).toBe(true)
    expect(shouldResubscribe(env({ endpoint: undefined }))).toBe(true)
    expect(shouldResubscribe(env({ permission: "default", hubSubscribed: false }))).toBe(false)
    expect(shouldResubscribe(env({ permission: "denied", hubSubscribed: false }))).toBe(false)
    expect(shouldResubscribe(env({ supported: false, hubSubscribed: false }))).toBe(false)
  })
})

describe("describeTestResult", () => {
  test("sent, failed with status, and nothing subscribed", () => {
    expect(describeTestResult({ sent: 1, failed: [], subscriptions: 1 })).toEqual({ ok: true, text: "Test notification sent to this device" })
    expect(describeTestResult({ sent: 2, failed: [], subscriptions: 2 })).toEqual({ ok: true, text: "Test notification sent (2 subscriptions)" })
    expect(describeTestResult({ sent: 0, failed: [{ host: "fcm.googleapis.com", status: 403 }], subscriptions: 1 })).toEqual({
      ok: false,
      text: "Test failed: fcm.googleapis.com answered 403",
    })
    expect(describeTestResult({ sent: 0, failed: [{ host: "x" }], subscriptions: 1 }).text).toBe("Test failed: x did not answer")
    expect(describeTestResult({ sent: 0, failed: [], subscriptions: 0 })).toEqual({ ok: false, text: "This device is not subscribed; enable notifications first" })
  })
})

describe("toggles and quiet hours", () => {
  test("one toggle per kind, in a fixed order", () => {
    expect(NOTIFY_TOGGLES.map(([key]) => key)).toEqual(["question", "permission", "failed", "finished", "handoff", "say"])
  })
  test("quiet hours label", () => {
    expect(quietHoursLabel(null)).toBe("Off")
    expect(quietHoursLabel({ start: "22:00", end: "07:00", timeZone: "Europe/Berlin" })).toBe("22:00–07:00 (Europe/Berlin)")
  })
})
