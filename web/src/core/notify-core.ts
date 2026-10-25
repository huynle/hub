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

/** The hub's notification kinds (src/central/push.ts NOTIFICATION_LABELS; docs/notifications.md). */
export type NotifyKind =
  | "question"
  | "permission"
  | "done"
  | "failed"
  | "turn"
  | "stopped"
  | "retry"
  | "subagentDone"
  | "subagentFailed"
  | "jobDone"
  | "jobFailed"
  | "longTool"
  | "say"
  | "handoff"
  | "activity"
  | "decision"
  | "message"

export interface NotifyKindInfo {
  readonly key: NotifyKind
  /** As in the notification's title ("KVM Rewrite · All done"). */
  readonly label: string
  readonly description: string
}

export interface NotifyGroup {
  readonly title: string
  readonly kinds: readonly NotifyKindInfo[]
}

/** Choices for the activity update interval (minutes). */
export const ACTIVITY_MINUTES = [1, 2, 5, 10, 15, 30, 60] as const

/** Settings → Notifications: one toggle per kind, grouped. */
export const NOTIFY_GROUPS: readonly NotifyGroup[] = [
  {
    title: "Needs you",
    kinds: [
      { key: "question", label: "Question", description: "A session or subagent asks you something." },
      { key: "permission", label: "Needs permission", description: "A tool call waits for your OK (answer from the notification)." },
      { key: "decision", label: "Decision", description: "A session asks you to decide (hub ask @me), with options and a recommendation." },
      { key: "message", label: "Message", description: "Agent messaging needs you: a message to you, an unanswered ask, or sessions looping." },
    ],
  },
  {
    title: "Session",
    kinds: [
      { key: "done", label: "All done", description: "The session and all its subagents and scripts finished; nothing waits on you. Once per run." },
      { key: "failed", label: "Failed", description: "The session's run failed (provider or tool error), with the reason." },
      { key: "turn", label: "Turn finished", description: "Every reply of the main session, also the short ones between subagents. Noisy." },
      { key: "stopped", label: "Stopped", description: "A run stopped without you asking (OpenCode shut down, inactivity)." },
      { key: "retry", label: "Retrying", description: "The provider failed and OpenCode is retrying the request." },
    ],
  },
  {
    title: "Subagents",
    kinds: [
      { key: "subagentDone", label: "Subagent finished", description: "Each subagent that finishes, by name." },
      { key: "subagentFailed", label: "Subagent failed", description: "Each subagent that fails, with the reason." },
    ],
  },
  {
    title: "Scripts and tools",
    kinds: [
      { key: "jobDone", label: "Script finished", description: "A background shell or terminal exited 0." },
      { key: "jobFailed", label: "Script failed", description: "A background shell or terminal exited non-zero, was killed or timed out." },
      { key: "longTool", label: "Long tool finished", description: "A tool call that ran 30 seconds or more ended." },
    ],
  },
  {
    title: "Voice",
    kinds: [
      { key: "say", label: "Spoken reply", description: "Voice mode replies while no device shows the session." },
      { key: "handoff", label: "Hand-off", description: "A session sent to this device from the terminal (ignores quiet hours)." },
    ],
  },
  {
    title: "Activity digest",
    kinds: [{ key: "activity", label: "Activity", description: "One quiet, self-replacing summary per session: subagents, long tools, scripts, idle." }],
  },
]

export const NOTIFY_KINDS: readonly NotifyKindInfo[] = NOTIFY_GROUPS.flatMap((g) => g.kinds)

/** "You'll get: All done, Failed, Question." for the toggles that are on, in Settings order. */
export function notifySummary(prefs: Readonly<Record<string, boolean | undefined>>): string {
  const on = NOTIFY_KINDS.filter((k) => prefs[k.key]).map((k) => k.label)
  return on.length ? `You'll get: ${on.join(", ")}.` : "You'll get no notifications on this device."
}

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
