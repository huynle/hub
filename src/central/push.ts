// Web push (VAPID) for paired devices, one toggle per notification kind (docs/notifications.md): hand-offs, questions,
// permissions, all done, failed / stopped / retrying runs, every turn, subagents, scripts, long tools, spoken replies
// and the activity digest. Payloads carry only {kind, sessionID, title, body, requestID?, test?}: no tokens, no
// transcript beyond one spoken text or a short reason, shortened. Each device picks the kinds it wants, may set quiet
// hours, and users mute sessions.
import webpush from "web-push"
import { MemoryKv } from "./backend/memory-kv"
import type { Kv } from "./backend/types"
import { type PushPrefs, type PushTarget, type QuietHours, type Store, type VapidKeys } from "./store"

export { DEFAULT_PUSH_PREFS, type PushPrefs } from "./store"

/** The notification kind; one per device toggle. */
export type NotificationKind = keyof PushPrefs

/** Short label of each kind, shown in the title after the session name (and in Settings). */
export const NOTIFICATION_LABELS: Readonly<Record<NotificationKind, string>> = Object.freeze({
  handoff: "Hand-off",
  question: "Question",
  permission: "Needs permission",
  done: "All done",
  failed: "Failed",
  turn: "Turn finished",
  stopped: "Stopped",
  retry: "Retrying",
  subagentDone: "Subagent finished",
  subagentFailed: "Subagent failed",
  jobDone: "Script finished",
  jobFailed: "Script failed",
  longTool: "Long tool finished",
  say: "Spoken reply",
  activity: "Activity",
  decision: "Decision",
  message: "Message",
  providerError: "Model provider error",
})

/** True for a known notification kind (API input). */
export const isNotificationKind = (value: unknown): value is NotificationKind => typeof value === "string" && Object.hasOwn(NOTIFICATION_LABELS, value)

/** Extra facts for one notification. */
export interface PushExtra {
  /** permission: the request ID, so the notification can answer it. */
  readonly requestID?: string
  /** What the notification is about, for the title: a subagent's title, a job's outcome ("exited 1"), a duration. */
  readonly subject?: string
  /** Identity of what ended (subagent session, job, tool call): the cooldown is per session, kind and key. Not sent. */
  readonly key?: string
  /** decision: the Decision, so a tap opens its card. */
  readonly decisionID?: string
  /** Skip devices that have this kind on (they were notified through it instead). Not sent. */
  readonly unlessPref?: NotificationKind
}

export interface PushPayload {
  readonly kind: NotificationKind | "test"
  readonly sessionID: string
  readonly title: string
  readonly body: string
  readonly requestID?: string
  readonly decisionID?: string
  /** A test notification shaped like `kind`. */
  readonly test?: true
  /** Per-session kinds (providerError, subagentFailed): the session it is about, so the service worker tags each apart. */
  readonly tagKey?: string
}

const minutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))

/** True when `at` falls in the quiet hours (local time of their zone); never for an empty or invalid range. */
export function inQuietHours(quiet: QuietHours, at: number): boolean {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at)
  } catch {
    return false
  }
  const hour = Number(parts.find((p) => p.type === "hour")?.value)
  const minute = Number(parts.find((p) => p.type === "minute")?.value)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  const now = (hour % 24) * 60 + minute
  const start = minutes(quiet.start)
  const end = minutes(quiet.end)
  if (start === end) return false
  return start < end ? now >= start && now < end : now >= start || now < end
}

export interface PushSendOptions {
  readonly TTL: number
  readonly urgency: "high" | "normal"
  readonly timeout: number
  readonly vapidDetails: { readonly subject: string; readonly publicKey: string; readonly privateKey: string }
}

/** Delivers one message; rejects with an error carrying `statusCode` when the push service refuses it. */
export type PushSender = (target: PushTarget, payload: string, options: PushSendOptions) => Promise<unknown>

export const PUSH_COOLDOWN_MS = 30_000
/** Spoken replies are pushed more often than other kinds. */
export const SAY_COOLDOWN_MS = 10_000
/** Longest spoken text carried in a say notification body. */
export const SAY_MAX_CHARS = 180
export const PUSH_TTL_SECONDS = 300
/** Questions, permissions and run results stay deliverable for an hour (a phone in doze picks them up later). */
export const URGENT_TTL_SECONDS = 3600
/** One test notification per device in this window. */
export const TEST_COOLDOWN_MS = 10_000
const SEND_TIMEOUT_MS = 10_000
const COOL_KEY = (key: string) => `push:cool:${key}`
const MAX_NAME = 60

const webPushSender: PushSender = (target, payload, options) =>
  webpush.sendNotification(target, payload, { ...options, vapidDetails: { ...options.vapidDetails } })

export interface PushOptions {
  readonly store: Store
  /** VAPID subject: a mailto: or https: URL. */
  readonly subject: string
  readonly sender?: PushSender
  readonly now?: () => number
  /** Timers for delayed activity digests (tests). */
  readonly timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
  /** Cooldowns (default: this process, on `now`; Valkey in a cluster, so pods share them). */
  readonly kv?: Kv
}

/** One step of interest in a session tree, for activity updates. */
export interface ActivityStep {
  /** tool: a short tool call (only counted); anything else is a line of the digest and sends it. */
  readonly kind: "tool" | "long" | "subagent" | "job" | "idle"
  readonly text: string
}

/** An activity step of a root session, as the registry reports it. */
export interface ActivityAlert {
  readonly sessionID: string
  readonly title: string
  readonly step?: ActivityStep
  readonly owner?: string
}

/** Lines of a digest kept (older ones become "+n more"). */
const DIGEST_LINES = 5

interface Digest {
  title: string
  tools: number
  lines: string[]
  last?: number
  timer?: unknown
}

const realTimers = {
  set: (fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** "3 tools · explore finished · bun run build exited 0". */
export function digestBody(tools: number, lines: readonly string[]): string {
  const shown = lines.length > DIGEST_LINES ? [`+${lines.length - DIGEST_LINES + 1} more`, ...lines.slice(-(DIGEST_LINES - 1))] : [...lines]
  return [...(tools ? [`${tools} tool${tools === 1 ? "" : "s"}`] : []), ...shown].join(" · ")
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

const shorten = (title: string): string => clip(title, MAX_NAME) || "Session"

const MAX_SUBJECT = 40

/** The title after the session name: the kind's label, with its subject where it has one. */
function kindTitle(kind: NotificationKind, subject: string | undefined): string {
  const about = subject ? clip(subject, MAX_SUBJECT) : ""
  switch (kind) {
    case "subagentDone":
      return about ? `Subagent ${about} finished` : NOTIFICATION_LABELS.subagentDone
    case "subagentFailed":
      return about ? `Subagent ${about} failed` : NOTIFICATION_LABELS.subagentFailed
    case "jobDone":
    case "jobFailed":
      return about ? `Script ${about}` : NOTIFICATION_LABELS[kind]
    case "longTool":
      return about ? `${NOTIFICATION_LABELS.longTool} (${about})` : NOTIFICATION_LABELS.longTool
    default:
      return NOTIFICATION_LABELS[kind]
  }
}

const OPEN = "Tap to open the session."
/** A session ID: the only key a payload may carry (job and tool IDs stay on the hub). */
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/

export function pushPayload(kind: NotificationKind, sessionID: string, sessionTitle: string, text?: string, extra: PushExtra = {}): PushPayload {
  const name = shorten(sessionTitle)
  const detail = clip(text ?? "", SAY_MAX_CHARS)
  const title = `${name} · ${kindTitle(kind, extra.subject)}`
  switch (kind) {
    case "say":
      // A spoken reply reads as the session talking.
      return { kind, sessionID, title: name, body: detail || "New reply. Tap to listen." }
    case "handoff":
      return { kind, sessionID, title, body: "Sent from the terminal. Tap to talk." }
    case "question":
      return { kind, sessionID, title, body: "Tap to see it." }
    // An agent wrote the question or message: never in the payload (the console shows it after sign-in).
    case "decision":
      return { kind, sessionID, title, body: "A decision waits for you. Tap to answer.", ...(extra.decisionID ? { decisionID: extra.decisionID } : {}) }
    case "message":
      return { kind, sessionID, title, body: "Tap to see it." }
    case "permission":
      // Never the request's summary (it may be a command line); the service worker fetches it from the hub.
      return { kind, sessionID, title, body: "Tap to review and answer.", ...(extra.requestID ? { requestID: extra.requestID } : {}) }
    case "done":
      return { kind, sessionID, title, body: detail || "Nothing is running or waiting. Tap to open." }
    case "activity":
      return { kind, sessionID, title, body: detail || "New activity." }
    case "providerError":
    case "subagentFailed":
      return { kind, sessionID, title, body: detail || OPEN, ...(extra.key && SESSION_ID.test(extra.key) ? { tagKey: extra.key } : {}) }
    default:
      return { kind, sessionID, title, body: detail || OPEN }
  }
}

/** What a test notification of each kind is about. */
const TEST_SUBJECT: Partial<Record<NotificationKind, string>> = { subagentDone: "explore", subagentFailed: "explore", jobDone: "exited 0", jobFailed: "exited 1", longTool: "45s" }

/** web-push options per notification kind: urgent kinds wake a dozing phone and wait longer for it. */
export function sendOptionsFor(kind: NotificationKind | "test"): { TTL: number; urgency: "high" | "normal" } {
  switch (kind) {
    case "question":
    case "permission":
    case "failed":
    case "decision":
    case "message":
    case "providerError":
      return { TTL: URGENT_TTL_SECONDS, urgency: "high" }
    case "done":
    case "stopped":
    case "subagentFailed":
    case "jobFailed":
      // Worth seeing later, not worth waking a dozing phone.
      return { TTL: URGENT_TTL_SECONDS, urgency: "normal" }
    case "turn":
    case "retry":
    case "subagentDone":
    case "jobDone":
    case "longTool":
    case "activity":
      // Progress: stale soon, replaced by the next one.
      return { TTL: PUSH_TTL_SECONDS, urgency: "normal" }
    default:
      return { TTL: PUSH_TTL_SECONDS, urgency: "high" }
  }
}

/** Result of a test notification. */
export type PushTestResult =
  | { readonly sent: number; readonly failed: ReadonlyArray<{ readonly host: string; readonly status?: number }> }
  | { readonly limited: true; readonly retryAfter: number }

const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).host
  } catch {
    return "invalid endpoint"
  }
}

const statusOf = (cause: unknown): number | undefined => {
  const code = (cause as { statusCode?: unknown } | null)?.statusCode
  return typeof code === "number" ? code : undefined
}

export class Push {
  private readonly store: Store
  private readonly subject: string
  private readonly sender: PushSender
  private readonly now: () => number
  /** Cooldowns: `push:cool:<session kind>` / `push:cool:test <device>` → when it was sent, expiring with the cooldown. */
  private readonly kv: Kv
  /**
   * `device session` → the activity digest being collected. Kept in this process: activity is reported by the
   * pod holding the session's connection.
   */
  private readonly digests = new Map<string, Digest>()
  private readonly timers: NonNullable<PushOptions["timers"]>

  constructor(options: PushOptions) {
    this.store = options.store
    this.subject = options.subject
    this.sender = options.sender ?? webPushSender
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? realTimers
    this.kv = options.kv ?? new MemoryKv({ now: this.now })
  }

  /**
   * Activity updates: collects a session's steps per device that wants them (pref `activity`, not muted, not in
   * quiet hours) and sends one collapsing notification: at once when the device got none for this session within
   * its interval, else when the interval ends, with everything that happened meanwhile. Short tools only count.
   */
  activity(alert: ActivityAlert): void {
    const step = alert.step
    if (!alert.owner || !step) return
    const at = this.now()
    for (const deviceID of this.activityDevices(alert.owner, alert.sessionID, at)) {
      const key = `${deviceID}\n${alert.sessionID}`
      let digest = this.digests.get(key)
      if (!digest) this.digests.set(key, (digest = { title: alert.title, tools: 0, lines: [] }))
      digest.title = alert.title
      if (step.kind === "tool") {
        digest.tools++
        continue
      }
      if (digest.lines.at(-1) !== step.text) digest.lines.push(step.text)
      if (digest.lines.length > 50) digest.lines.splice(0, digest.lines.length - 50)
      if (digest.timer !== undefined) continue
      const wait = digest.last === undefined ? 0 : digest.last + this.store.activityMinutes(deviceID) * 60_000 - at
      if (wait <= 0) void this.flushDigest(deviceID, alert.sessionID, alert.owner)
      else {
        const owner = alert.owner
        digest.timer = this.timers.set(() => void this.flushDigest(deviceID, alert.sessionID, owner), wait)
      }
    }
    this.pruneDigests(at)
  }

  /** Devices of `owner` with a subscription that want activity updates for the session now. */
  private activityDevices(owner: string, sessionID: string, at: number): string[] {
    if (this.store.mutedSessions(owner).includes(sessionID)) return []
    const mine = new Set(this.store.devices().filter((d) => d.ownerID === owner).map((d) => d.id))
    const devices = new Set<string>()
    for (const s of this.store.pushSubscriptions()) {
      if (!mine.has(s.deviceID) || devices.has(s.deviceID) || !this.store.pushPrefs(s.deviceID).activity) continue
      const quiet = this.store.quietHours(s.deviceID)
      if (quiet && inQuietHours(quiet, at)) continue
      devices.add(s.deviceID)
    }
    return [...devices]
  }

  private async flushDigest(deviceID: string, sessionID: string, owner: string): Promise<void> {
    const key = `${deviceID}\n${sessionID}`
    const digest = this.digests.get(key)
    if (!digest) return
    if (digest.timer !== undefined) this.timers.clear(digest.timer)
    digest.timer = undefined
    const body = digestBody(digest.tools, digest.lines)
    digest.tools = 0
    digest.lines = []
    digest.last = this.now()
    // Settings may have changed while it waited.
    if (!body || !this.activityDevices(owner, sessionID, digest.last).includes(deviceID)) return
    const targets = this.store.pushSubscriptions().filter((s) => s.deviceID === deviceID)
    await this.send(targets, pushPayload("activity", sessionID, digest.title, body))
  }

  /** Forgets digests idle for an hour (nothing pending, interval long over). */
  private pruneDigests(at: number): void {
    if (this.digests.size < 1000) return
    for (const [key, digest] of this.digests) {
      if (digest.timer === undefined && !digest.lines.length && (digest.last ?? 0) < at - 3_600_000) this.digests.delete(key)
    }
  }

  /** The VAPID public key (applicationServerKey); generated and persisted on first use. */
  async publicKey(): Promise<string> {
    return (await this.keys()).publicKey
  }

  /**
   * Notifies every subscribed device that wants this kind of notification — only devices of `ownerID`
   * (the session's owner) when given — unless the session is muted by the device's user or the device is
   * in its quiet hours (hand-offs, an explicit request from the terminal, go through both). Returns the
   * number of successful deliveries.
   */
  async notify(kind: NotificationKind, sessionID: string, title: string, body?: string, ownerID?: string, extra?: PushExtra): Promise<number> {
    const precise = kind
    const key = `${sessionID}\n${precise}${extra?.key ? `\n${extra.key}` : ""}`
    if (!(await this.cool(key, precise === "say" ? SAY_COOLDOWN_MS : PUSH_COOLDOWN_MS))) return 0
    const owners = new Map(this.store.devices().map((d) => [d.id, d.ownerID]))
    const at = this.now()
    const muted = new Map<string, boolean>()
    const isMuted = (userID: string | undefined) => {
      if (userID === undefined) return false
      if (!muted.has(userID)) muted.set(userID, this.store.mutedSessions(userID).includes(sessionID))
      return muted.get(userID)!
    }
    const targets = this.store.pushSubscriptions().filter((s) => {
      const owner = owners.get(s.deviceID)
      if (ownerID !== undefined && owner !== ownerID) return false
      const prefs = this.store.pushPrefs(s.deviceID)
      if (!prefs[precise]) return false
      if (extra?.unlessPref && prefs[extra.unlessPref]) return false
      if (precise === "handoff") return true
      const quiet = this.store.quietHours(s.deviceID)
      return !isMuted(owner) && !(quiet && inQuietHours(quiet, at))
    })
    if (targets.length === 0) return 0
    const payload = pushPayload(kind, sessionID, title, body, extra)
    const { delivered } = await this.send(targets, payload)
    return delivered
  }

  /**
   * Sends a test notification to `deviceID`'s own subscriptions, whatever its prefs; one per TEST_COOLDOWN_MS. With
   * a kind, it looks like that kind (title, urgency) for a "Test session".
   */
  async test(deviceID: string, kind?: NotificationKind): Promise<PushTestResult> {
    const key = `test\n${deviceID}`
    if (!(await this.cool(key, TEST_COOLDOWN_MS))) {
      const at = Number(await this.kv.get(COOL_KEY(key)))
      const left = Number.isFinite(at) ? TEST_COOLDOWN_MS - (this.now() - at) : TEST_COOLDOWN_MS
      return { limited: true, retryAfter: Math.max(1, Math.ceil(left / 1000)) }
    }
    const targets = this.store.pushSubscriptions().filter((s) => s.deviceID === deviceID)
    const payload: PushPayload = kind
      ? { ...pushPayload(kind, "", "Test session", `Test: this is how “${NOTIFICATION_LABELS[kind]}” looks on this device.`, { subject: TEST_SUBJECT[kind] }), test: true }
      : { kind: "test", sessionID: "", title: "Hub", body: "Test notification: notifications work on this device." }
    const { delivered, failed } = await this.send(targets, payload)
    return { sent: delivered, failed }
  }

  private async send(
    targets: readonly { endpoint: string; keys: PushTarget["keys"] }[],
    payload: PushPayload,
  ): Promise<{ delivered: number; failed: Array<{ host: string; status?: number }> }> {
    const keys = await this.keys()
    const options: PushSendOptions = {
      ...sendOptionsFor(payload.kind),
      timeout: SEND_TIMEOUT_MS,
      vapidDetails: { subject: this.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
    }
    const raw = JSON.stringify(payload)
    const results = await Promise.allSettled(
      targets.map((target) => this.sender({ endpoint: target.endpoint, keys: target.keys }, raw, options)),
    )
    let delivered = 0
    const failed: Array<{ host: string; status?: number }> = []
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return void delivered++
      const status = statusOf(result.reason)
      const endpoint = targets[index]!.endpoint
      failed.push({ host: hostOf(endpoint), ...(status !== undefined ? { status } : {}) })
      if (status === 404 || status === 410) {
        void this.store.dropPushSubscription(endpoint).catch((cause: unknown) => console.error(`[hub] push subscription not dropped: ${(cause as Error)?.message ?? cause}`))
      }
      else console.error(`[hub] push to ${hostOf(endpoint)} failed: ${status ?? (result.reason as Error)?.message}`)
    })
    return { delivered, failed }
  }

  /** True (and records the send, SET NX PX: one pod wins) when `key` is outside its cooldown. */
  private cool(key: string, cooldown: number): Promise<boolean> {
    return this.kv.set(COOL_KEY(key), String(this.now()), { px: cooldown, nx: true })
  }

  /** The stored keys; the first call generates a pair (when pods race, every pod gets the pair stored first). */
  private async keys(): Promise<VapidKeys> {
    const existing = this.store.vapid()
    if (existing) return existing
    return this.store.setVapid(webpush.generateVAPIDKeys())
  }
}

