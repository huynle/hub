// Web push (VAPID) for paired devices: hand-offs from the terminal, sessions waiting on a permission or
// question, finished runs, and (conversation mode, nobody watching) what the agent said. Payloads carry
// only {kind, sessionID, title, body}: no tokens, no transcript beyond one spoken text, shortened.
import webpush from "web-push"
import { DEFAULT_PUSH_PREFS, type PushPrefs, type PushTarget, type Store } from "./store"

export { DEFAULT_PUSH_PREFS, type PushPrefs } from "./store"

export type PushKind = keyof PushPrefs
/** What a blocked or finished notification is about. */
export type PushDetail = "permission" | "form" | "succeeded" | "failed"

export interface PushPayload {
  readonly kind: PushKind
  readonly sessionID: string
  readonly title: string
  readonly body: string
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
): PushPayload {
  const name = shorten(sessionTitle)
  switch (kind) {
    case "say":
      return { kind, sessionID, title: name, body: clip(text ?? "", SAY_MAX_CHARS) || "New reply. Tap to listen." }
    case "handoff":
      return { kind, sessionID, title: name, body: "Sent from the terminal. Tap to talk." }
    case "blocked":
      return detail === "form"
        ? { kind, sessionID, title: `${name} has a question`, body: "Tap to see it." }
        : { kind, sessionID, title: `${name} needs permission`, body: "Tap to review and answer." }
    case "finished":
      return detail === "failed"
        ? { kind, sessionID, title: `${name} failed`, body: "Tap to open the session." }
        : { kind, sessionID, title: `${name} finished`, body: "Tap to open the session." }
  }
}

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
   * Notifies every subscribed device that wants `kind` — only devices of `ownerID` (the session's
   * owner) when given. Returns the number of successful deliveries.
   */
  async notify(kind: PushKind, sessionID: string, title: string, detail?: PushDetail, body?: string, ownerID?: string): Promise<number> {
    if (!this.cool(`${sessionID}\n${kind}`, kind === "say" ? SAY_COOLDOWN_MS : PUSH_COOLDOWN_MS)) return 0
    const owners = new Map(this.store.devices().map((d) => [d.id, d.ownerID]))
    const targets = this.store
      .pushSubscriptions()
      .filter((s) => (ownerID === undefined || owners.get(s.deviceID) === ownerID) && this.store.pushPrefs(s.deviceID)[kind])
    if (targets.length === 0) return 0
    const payload = JSON.stringify(pushPayload(kind, sessionID, title, detail, body))
    const keys = this.keys()
    const options: PushSendOptions = {
      TTL: PUSH_TTL_SECONDS,
      urgency: kind === "finished" ? "normal" : "high",
      timeout: SEND_TIMEOUT_MS,
      vapidDetails: { subject: this.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
    }
    const results = await Promise.allSettled(
      targets.map((target) => this.sender({ endpoint: target.endpoint, keys: target.keys }, payload, options)),
    )
    let delivered = 0
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return void delivered++
      const status = statusOf(result.reason)
      const endpoint = targets[index]!.endpoint
      if (status === 404 || status === 410) this.store.dropPushSubscription(endpoint)
      else console.error(`[opencode-hub] push to ${hostOf(endpoint)} failed: ${status ?? (result.reason as Error)?.message}`)
    })
    return delivered
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
