// Notifications on this device: what the browser and the hub say, what to offer, and the pref toggles.
// Pure logic (bun tests in test/web-notify-core.test.ts); web/src/app/push.ts gathers the facts.

export type PermissionState = "default" | "granted" | "denied"

/** What the browser and the hub report about notifications on this device. */
export interface NotifyEnv {
  /** Service workers, PushManager and Notification exist and the page is a secure context. */
  readonly supported: boolean
  readonly permission: PermissionState
  /** /sw.js is registered for this origin. */
  readonly worker: boolean
  /** The browser's current push subscription endpoint on this origin, if any. */
  readonly endpoint?: string
  /** The hub holds that endpoint for this device. */
  readonly hubSubscribed: boolean
  /** Subscriptions the hub holds for this device. */
  readonly hubSubscriptions: number
}

export interface NotifyStatus {
  readonly state: "unsupported" | "blocked" | "off" | "repair" | "on"
  readonly message: string
  /** The primary button: enable (subscribe), disable, or nothing possible from the page. */
  readonly action: "enable" | "disable" | "none"
  /** Show as a warning: this device will not get notifications. */
  readonly warn: boolean
}

export function notifyStatus(env: NotifyEnv): NotifyStatus {
  if (!env.supported) {
    return {
      state: "unsupported",
      message: "This browser can't get notifications here. On iPhone, add the app to the Home Screen first (iOS 16.4+); everywhere else the hub must be on https.",
      action: "none",
      warn: true,
    }
  }
  if (env.permission === "denied") {
    return { state: "blocked", message: "Notifications are blocked for this site. Allow them in the browser's site settings, then reload.", action: "none", warn: true }
  }
  if (env.permission === "default") {
    return { state: "off", message: "Notifications are off on this device.", action: "enable", warn: true }
  }
  if (!env.worker || !env.endpoint || !env.hubSubscribed) {
    return {
      state: "repair",
      message: "Allowed, but this device is not subscribed on this hub, so nothing will arrive (this happens after the hub moves to a new address). Enable again to fix it.",
      action: "enable",
      warn: true,
    }
  }
  return { state: "on", message: "On for this device.", action: "disable", warn: false }
}

/** Re-subscribe silently on load: permission is granted but the browser or the hub lost the subscription. */
export const shouldResubscribe = (env: NotifyEnv): boolean =>
  env.supported && env.permission === "granted" && (!env.endpoint || !env.hubSubscribed)

export interface PushTestAnswer {
  readonly sent: number
  readonly failed: ReadonlyArray<{ readonly host: string; readonly status?: number }>
  readonly subscriptions: number
}

export function describeTestResult(result: PushTestAnswer): { ok: boolean; text: string } {
  if (result.subscriptions === 0) return { ok: false, text: "This device is not subscribed; enable notifications first" }
  if (result.sent > 0) {
    return { ok: true, text: result.sent === 1 ? "Test notification sent to this device" : `Test notification sent (${result.sent} subscriptions)` }
  }
  const first = result.failed[0]
  if (!first) return { ok: false, text: "Test failed" }
  return { ok: false, text: `Test failed: ${first.host} ${first.status !== undefined ? `answered ${first.status}` : "did not answer"}` }
}

export type NotifyToggle = "question" | "permission" | "failed" | "finished" | "handoff" | "say"

/** Choices for the activity update interval (minutes). */
export const ACTIVITY_MINUTES = [1, 2, 5, 10, 15, 30, 60] as const

export const NOTIFY_TOGGLES: ReadonlyArray<readonly [NotifyToggle, string]> = [
  ["question", "A session asks a question"],
  ["permission", "A session needs permission"],
  ["failed", "A session failed"],
  ["finished", "A session finished (not Voice turns)"],
  ["handoff", "Hand-offs from the terminal"],
  ["say", "Voice replies when you're not watching"],
]

export interface QuietHours {
  readonly start: string
  readonly end: string
  readonly timeZone: string
}

export const quietHoursLabel = (quiet: QuietHours | null | undefined): string =>
  quiet ? `${quiet.start}–${quiet.end} (${quiet.timeZone})` : "Off"

/** This browser's IANA time zone (sent with quiet hours). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
