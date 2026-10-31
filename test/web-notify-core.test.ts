// Notification status on this device and whether to re-subscribe (web/src/core/notify-core.ts).
import { describe, expect, test } from "bun:test"
import { describeTestResult, NOTIFY_GROUPS, NOTIFY_KINDS, notifyStatus, notifySummary, quietHoursLabel, shouldResubscribe, type NotifyEnv } from "../web/src/core/notify-core"
import { NOTIFICATION_LABELS } from "../src/central/push"
import { DEFAULT_PUSH_PREFS, PUSH_PREF_KEYS } from "../src/central/store"

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
  test("one toggle per hub kind, grouped, each with the hub's label and a one-line description", () => {
    expect(NOTIFY_GROUPS.map((g) => [g.title, g.kinds.map((k) => k.key)])).toEqual([
      ["Needs you", ["question", "permission", "decision", "message"]],
      ["Session", ["done", "failed", "providerError", "turn", "stopped", "retry"]],
      ["Subagents", ["subagentDone", "subagentFailed"]],
      ["Scripts and tools", ["jobDone", "jobFailed", "longTool"]],
      ["Voice", ["say", "handoff"]],
      ["Activity digest", ["activity"]],
    ])
    expect(NOTIFY_KINDS.map((k) => k.key).sort()).toEqual([...PUSH_PREF_KEYS].sort())
    for (const kind of NOTIFY_KINDS) {
      expect(kind.label).toBe(NOTIFICATION_LABELS[kind.key])
      expect(kind.description.length).toBeGreaterThan(10)
      expect(kind.description).not.toContain("\n")
    }
  })
  test("summary of what this device gets, in group order", () => {
    expect(notifySummary({ ...DEFAULT_PUSH_PREFS })).toBe("You'll get: Question, Needs permission, Decision, Message, All done, Failed, Model provider error, Spoken reply, Hand-off.")
    expect(notifySummary({ jobFailed: true, done: false })).toBe("You'll get: Script failed.")
    expect(notifySummary({})).toBe("You'll get no notifications on this device.")
  })
  test("quiet hours label", () => {
    expect(quietHoursLabel(null)).toBe("Off")
    expect(quietHoursLabel({ start: "22:00", end: "07:00", timeZone: "Europe/Berlin" })).toBe("22:00–07:00 (Europe/Berlin)")
  })
})
