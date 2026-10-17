// Web push (VAPID) for paired devices: hand-offs from the terminal, questions, permissions, finished and
// failed runs, and (conversation mode, nobody watching) what the agent said. Payloads carry only {kind,
// sessionID, title, body, requestID?}: no tokens, no transcript beyond one spoken text, shortened. Each device picks the kinds it wants, may set quiet hours, and users mute sessions.
import webpush from "web-push"
import { type PushPrefs, type PushTarget, type QuietHours, type Store } from "./store"

export { DEFAULT_PUSH_PREFS, type PushPrefs } from "./store"

/** What happened, as the registry and the spoke socket report it. */
export type PushKind = "handoff" | "blocked" | "finished" | "say"
/** What a blocked or finished notification is about. */
export type PushDetail = "permission" | "form" | "succeeded" | "failed"
/** The precise notification kind; one per device toggle. */
export type NotificationKind = keyof PushPrefs

/** Extra facts for one notification. */
export interface PushExtra {
  /** permission: the request ID, so the notification can answer it. */
  readonly requestID?: string
}

export interface PushPayload {
  readonly kind: NotificationKind | "test"
  readonly sessionID: string
  readonly title: string
  readonly body: string
  readonly requestID?: string
}

/** The device toggle that decides an alert. */
export function pushKindFor(kind: PushKind, detail?: PushDetail): NotificationKind {
  switch (kind) {
    case "blocked":
      return detail === "form" ? "question" : "permission"
    case "finished":
      return detail === "failed" ? "failed" : "finished"
    default:
      return kind
  }
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
const MAX_NAME = 60

const webPushSender: PushSender = (target, payload, options) =>
  webpush.sendNotification(target, payload, { ...options, vapidDetails: { ...options.vapidDetails } })

export interface PushOptions {
  readonly store: Store
  /** VAPID subject: a mailto: or https: URL. */
  readonly subject: string
  readonly sender?: PushSender
  readonly now?: () => number
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

const shorten = (title: string): string => clip(title, MAX_NAME) || "Session"

export function pushPayload(
  kind: PushKind,
  sessionID: string,
  sessionTitle: string,
  detail?: PushDetail,
  text?: string,
  extra: PushExtra = {},
): PushPayload {
  const name = shorten(sessionTitle)
  const precise = pushKindFor(kind, detail)
  switch (precise) {
    case "say":
      return { kind: precise, sessionID, title: name, body: clip(text ?? "", SAY_MAX_CHARS) || "New reply. Tap to listen." }
    case "handoff":
      return { kind: precise, sessionID, title: name, body: "Sent from the terminal. Tap to talk." }
    case "question":
      return { kind: precise, sessionID, title: `${name} has a question`, body: "Tap to see it." }
    case "permission":
      // Never the request's summary (it may be a command line); the service worker fetches it from the hub.
      return {
        kind: precise,
        sessionID,
        title: `${name} needs permission`,
        body: "Tap to review and answer.",
        ...(extra.requestID ? { requestID: extra.requestID } : {}),
      }
    case "failed":
      return { kind: precise, sessionID, title: `${name} failed`, body: "Tap to open the session." }
    case "finished":
      return { kind: precise, sessionID, title: `${name} finished`, body: "Tap to open the session." }
  }
}

/** web-push options per notification kind: urgent kinds wake a dozing phone and wait longer for it. */
export function sendOptionsFor(kind: NotificationKind | "test"): { TTL: number; urgency: "high" | "normal" } {
  switch (kind) {
    case "question":
    case "permission":
    case "failed":
      return { TTL: URGENT_TTL_SECONDS, urgency: "high" }
    case "finished":
      return { TTL: URGENT_TTL_SECONDS, urgency: "normal" }
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
  /** `session kind` → when it was last sent and how long it cools down. */
  private readonly lastSent = new Map<string, { at: number; cooldown: number }>()

  constructor(options: PushOptions) {
    this.store = options.store
    this.subject = options.subject
    this.sender = options.sender ?? webPushSender
    this.now = options.now ?? Date.now
  }

  /** The VAPID public key (applicationServerKey); generated and persisted on first use. */
  publicKey(): string {
    return this.keys().publicKey
  }

  /**
   * Notifies every subscribed device that wants this kind of notification — only devices of `ownerID`
   * (the session's owner) when given — unless the session is muted by the device's user or the device is
   * in its quiet hours (hand-offs, an explicit request from the terminal, go through both). Returns the
   * number of successful deliveries.
   */
  async notify(
    kind: PushKind,
    sessionID: string,
    title: string,
    detail?: PushDetail,
    body?: string,
    ownerID?: string,
    extra?: PushExtra,
  ): Promise<number> {
    const precise = pushKindFor(kind, detail)
    if (!this.cool(`${sessionID}\n${precise}`, precise === "say" ? SAY_COOLDOWN_MS : PUSH_COOLDOWN_MS)) return 0
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
      if (!this.store.pushPrefs(s.deviceID)[precise]) return false
      if (precise === "handoff") return true
      const quiet = this.store.quietHours(s.deviceID)
      return !isMuted(owner) && !(quiet && inQuietHours(quiet, at))
    })
    if (targets.length === 0) return 0
    const payload = pushPayload(kind, sessionID, title, detail, body, extra)
    const { delivered } = await this.send(targets, payload)
    return delivered
  }

  /** Sends a test notification to `deviceID`'s own subscriptions, whatever its prefs; one per TEST_COOLDOWN_MS. */
  async test(deviceID: string): Promise<PushTestResult> {
    const key = `test\n${deviceID}`
    const last = this.lastSent.get(key)
    if (last && this.now() - last.at < last.cooldown) {
      return { limited: true, retryAfter: Math.ceil((last.cooldown - (this.now() - last.at)) / 1000) }
    }
    this.cool(key, TEST_COOLDOWN_MS)
    const targets = this.store.pushSubscriptions().filter((s) => s.deviceID === deviceID)
    const payload: PushPayload = { kind: "test", sessionID: "", title: "Hub", body: "Test notification: notifications work on this device." }
    const { delivered, failed } = await this.send(targets, payload)
    return { sent: delivered, failed }
  }

  private async send(
    targets: readonly { endpoint: string; keys: PushTarget["keys"] }[],
    payload: PushPayload,
  ): Promise<{ delivered: number; failed: Array<{ host: string; status?: number }> }> {
    const keys = this.keys()
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
      if (status === 404 || status === 410) this.store.dropPushSubscription(endpoint)
      else console.error(`[hub] push to ${hostOf(endpoint)} failed: ${status ?? (result.reason as Error)?.message}`)
    })
    return { delivered, failed }
  }

  /** True (and records the send) when (session, kind) is outside its cooldown. */
  private cool(key: string, cooldown: number): boolean {
    const t = this.now()
    for (const [k, sent] of this.lastSent) if (t - sent.at >= sent.cooldown) this.lastSent.delete(k)
    if (this.lastSent.has(key)) return false
    this.lastSent.set(key, { at: t, cooldown })
    return true
  }

  private keys() {
    const existing = this.store.vapid()
    if (existing) return existing
    const keys = webpush.generateVAPIDKeys()
    this.store.setVapid(keys)
    return keys
  }
}

