// Webhooks (P4-T10; design §6.1, §12.2, §12.4; decision znbg8xa5 #8): the hub POSTs events to URLs that users and
// app tokens register.
//
// - Registrations per user in the StateStore collection "webhooks" (key: the id `wh_<16 hex>`): url, events
//   (exact types or `launch.*`), an optional label, `by` (`user`, or `app:<token id>` for an app token's own) and
//   the signing secret `whsec_…`, returned only by register. Users see and manage all of theirs; an app token only
//   its own. An app registration gets only events of what that app started (`by` of the event), and is dropped
//   once its token is revoked or loses the scope (appAlive).
// - URLs: https on a public host (publicURLProblem), checked at registration and again, re-resolved, right before
//   every send (publicFetch: no redirects, timeout, bounded response read). hub.json agents.webhooks.allowPrivate
//   admits http and private targets (self-hosted receivers).
// - Durable outbox in the StateStore collection "webhook-outbox", key `<webhook id>.<event id>`: at least once,
//   deduplicated by event id (the first write wins, ifVersion 0), retried with backoff (backoffMs; then failed),
//   one sender per delivery under a lease (Locks), so several hubs can drain the same store. Finished
//   deliveries stay keepMs (GET …/:id shows them), then are pruned.
// - Each POST: the event JSON, Hub-Signature `t=<unix s>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, Hub-Event (its
//   type) and Hub-Delivery (stable across retries), per packages/protocol/src/webhook.ts.
import { createHash, createHmac, randomBytes } from "node:crypto"
import {
  formatWebhookSignature,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
  webhookSignedPayload,
} from "../../protocol"
import type { Clock, Locks, StateStore, Timers } from "../backend/types"
import { publicFetch, PublicURLError, publicURLProblem, type ResolveHost } from "../push-target"
import { AgentError } from "./errors"
import type { AgentEvent, EventAudience, EventFamily } from "./events"
import { LAUNCH_STATES, type Launch } from "./launch-store"

export const WEBHOOKS = "webhooks"
export const WEBHOOK_OUTBOX = "webhook-outbox"
/** Every event type a webhook can receive (phase 4: launch changes). */
export const CANONICAL_WEBHOOK_EVENT_TYPES: readonly string[] = [
  "session.added", "session.removed", "session.changed", "session.archived", "session.named",
  "blocker.opened", "blocker.closed", "machine.changed", "role.claimed", "role.released",
  "message.changed", "launch.changed",
]
/** Includes persisted pre-canonical launch registrations for rolling rollback compatibility. */
export const WEBHOOK_EVENT_TYPES: readonly string[] = [...CANONICAL_WEBHOOK_EVENT_TYPES, ...LAUNCH_STATES.map((state) => `launch.${state}`)]
export const DEFAULT_WEBHOOK_EVENTS: readonly string[] = ["launch.*"]
export const MAX_WEBHOOKS = 20
export const MAX_WEBHOOK_URL = 2048
export const MAX_WEBHOOK_LABEL = 100
export const MAX_WEBHOOK_EVENTS = 20
/** Waits between attempts: 7 attempts over about 8.5 hours. */
export const WEBHOOK_BACKOFF_MS: readonly number[] = [10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]
export const WEBHOOK_TIMEOUT_MS = 10_000
/** Bytes of a receiver's response the hub reads. */
export const WEBHOOK_RESPONSE_MAX = 64 * 1024
export const WEBHOOK_KEEP_MS = 86_400_000
/** Deliveries per user in the outbox; past it new events are dropped (logged). */
export const WEBHOOK_OUTBOX_MAX = 5000
const POLL_MS = 5000
const CONCURRENCY = 8

/** An event as webhooks carry it (CloudEvents-shaped, design §12.2). */
export interface WebhookEvent {
  readonly id: string
  readonly type: string
  /** The hub's public URL. */
  readonly source: string
  readonly subject: string
  /** ISO 8601. */
  readonly time: string
  readonly user: string
  readonly schemaVersion: 1
  readonly data: unknown
}

/** Who a registration belongs to: the user, or one of their app tokens. */
export type WebhookOwner = "user" | `app:${string}`

interface Registration {
  readonly id: string
  readonly url: string
  readonly events: readonly string[]
  readonly by: WebhookOwner
  readonly label?: string
  readonly created: number
  readonly secret: string
}

/** A registration as the API shows it (never its secret). */
export type WebhookView = Omit<Registration, "secret">

export type DeliveryState = "pending" | "delivered" | "failed"

export interface DeliveryAttempt {
  readonly at: number
  readonly status?: number
  readonly error?: string
}

interface OutboxEntry {
  /** The Hub-Delivery header. */
  readonly id: string
  readonly webhook: string
  readonly event: WebhookEvent
  readonly state: DeliveryState
  readonly attempts: number
  readonly created: number
  readonly nextAt: number
  readonly finishedAt?: number
  readonly last?: DeliveryAttempt
}

export interface DeliveryView {
  readonly id: string
  readonly event: string
  readonly type: string
  readonly state: DeliveryState
  readonly attempts: number
  readonly created: number
  readonly nextAt?: number
  readonly last?: DeliveryAttempt
}

export interface RegisterInput {
  readonly url?: unknown
  readonly events?: unknown
  readonly label?: unknown
}

export interface WebhooksDeps {
  readonly state: StateStore
  /** One sender per delivery across hubs; without it, this process is the only sender. */
  readonly locks?: Locks
  readonly now?: Clock
  readonly timers?: Timers
  /** The events' source (the hub's public URL). */
  readonly source: string
  /** Every user ID (the sender drains each user's outbox). */
  readonly users: () => readonly string[]
  readonly resolve: ResolveHost
  /** hub.json agents.webhooks.allowPrivate. */
  readonly allowPrivate?: boolean
  readonly fetch?: typeof globalThis.fetch
  /** Whether an app token (by its id) may still have webhooks; its registrations are dropped when not. */
  readonly appAlive?: (userID: string, tokenID: string) => boolean
  /** Current scopes of an app token; absent preserves the legacy liveness-only check. */
  readonly appScopes?: (userID: string, tokenID: string) => readonly string[] | undefined
  readonly backoffMs?: readonly number[]
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly keepMs?: number
  readonly maxWebhooks?: number
  readonly maxOutbox?: number
  readonly pollMs?: number
  /** The lease owner (unique per hub process). */
  readonly owner?: string
  readonly userAgent?: string
}

const defaultTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const hex = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length)
const invalid = (message: string, hint?: string) => new AgentError("invalid", message, hint ? { hint } : {})

/** Whether a registration's pattern (an exact type or `<prefix>.*`) covers an event type. */
function matches(pattern: string, type: string): boolean {
  return pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : pattern === type
}

function eventsOf(raw: unknown): string[] {
  if (raw === undefined) return [...DEFAULT_WEBHOOK_EVENTS]
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WEBHOOK_EVENTS || !raw.every((e): e is string => typeof e === "string")) {
    throw invalid(`events must be a list of 1 to ${MAX_WEBHOOK_EVENTS} event types`, `e.g. ["launch.*", "message.changed"]`)
  }
  for (const pattern of raw) {
    if (!WEBHOOK_EVENT_TYPES.some((type) => matches(pattern, type))) throw invalid(`Unknown event type ${pattern}`, "Use a canonical event type or family wildcard")
  }
  return [...new Set(raw)]
}

export function webhookEventScopes(patterns: readonly string[]): string[] {
  const scopes = new Set<string>()
  if (patterns.some((pattern) => LAUNCH_STATES.some((state) => matches(pattern, `launch.${state}`)))) scopes.add("sessions:launch")
  for (const pattern of patterns) for (const type of CANONICAL_WEBHOOK_EVENT_TYPES) if (matches(pattern, type)) {
    if (type === "message.changed") scopes.add("messages:read")
    else if (type === "launch.changed") scopes.add("sessions:launch")
    else if (["session.archived", "session.named", "role.claimed", "role.released"].includes(type)) scopes.add("sessions:manage")
    else scopes.add("sessions:read")
  }
  return [...scopes]
}

export function canonicalWebhookEvent(source: string, userID: string, event: AgentEvent): WebhookEvent {
  return { id: event.id, type: event.type, source, subject: event.subject.launchID ?? event.subject.messageID ?? event.subject.sessionID ?? event.subject.machineID ?? event.id, time: new Date(event.at).toISOString(), user: userID, schemaVersion: 1, data: { subject: event.subject, data: event.data } }
}

const view = ({ secret: _secret, ...rest }: Registration): WebhookView => rest

const deliveryView = (entry: OutboxEntry): DeliveryView => ({
  id: entry.id,
  event: entry.event.id,
  type: entry.event.type,
  state: entry.state,
  attempts: entry.attempts,
  created: entry.created,
  ...(entry.state === "pending" ? { nextAt: entry.nextAt } : {}),
  ...(entry.last ? { last: entry.last } : {}),
})

/** The webhook event for a launch change: `launch.<state>`, its id stable per step (launch, state, time). */
export function launchEvent(source: string, launch: Launch, data: unknown): WebhookEvent {
  return {
    id: `evt_${hex(`${launch.id}\u0000${launch.state}\u0000${launch.at}`, 24)}`,
    type: `launch.${launch.state}`,
    source,
    subject: launch.id,
    time: new Date(launch.at).toISOString(),
    user: launch.owner,
    schemaVersion: 1,
    data: { launch: data },
  }
}

/** The hex HMAC-SHA256 over `<t>.<body>` (Hub-Signature v1). */
export function signWebhook(secret: string, t: number, body: string): string {
  return createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secret).update(webhookSignedPayload(t, body)).digest("hex")
}

export class Webhooks {
  private readonly now: Clock
  private readonly timers: Timers
  private readonly backoffMs: readonly number[]
  private readonly owner: string
  private running: Promise<void> | undefined
  private again = false
  private started = false
  private poll: unknown
  private kickTimer: unknown

  constructor(private readonly deps: WebhooksDeps) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? defaultTimers
    this.backoffMs = deps.backoffMs ?? WEBHOOK_BACKOFF_MS
    this.owner = deps.owner ?? `hub-${process.pid}-${randomBytes(4).toString("hex")}`
  }

  async register(userID: string, by: WebhookOwner, input: RegisterInput): Promise<{ webhook: WebhookView; secret: string }> {
    const { url } = input
    if (typeof url !== "string" || url.length === 0) throw invalid("url must be a string")
    if (url.length > MAX_WEBHOOK_URL) throw invalid(`url must be at most ${MAX_WEBHOOK_URL} characters`)
    const problem = await publicURLProblem(url, { resolve: this.deps.resolve, label: "Webhook URL", allowPrivate: this.deps.allowPrivate === true })
    if (problem) throw invalid(problem, this.deps.allowPrivate ? undefined : "Webhooks need an https URL on a public host")
    const events = eventsOf(input.events)
    let label: string | undefined
    if (input.label !== undefined && input.label !== null) {
      if (typeof input.label !== "string") throw invalid("label must be a string")
      label = input.label.trim() || undefined
      if (label && label.length > MAX_WEBHOOK_LABEL) throw invalid(`label must be at most ${MAX_WEBHOOK_LABEL} characters`)
    }
    const max = this.deps.maxWebhooks ?? MAX_WEBHOOKS
    if ((await this.deps.state.list(userID, WEBHOOKS)).length >= max) throw new AgentError("rate_limited", `At most ${max} webhooks per user`, { hint: "Delete unused webhooks" })
    const registration: Registration = {
      id: `wh_${randomBytes(8).toString("hex")}`,
      url,
      events,
      by,
      ...(label ? { label } : {}),
      created: this.now(),
      secret: `whsec_${randomBytes(32).toString("base64url")}`,
    }
    const written = await this.deps.state.put(userID, WEBHOOKS, registration.id, registration, { ifVersion: 0 })
    if (!written.ok) throw new Error("webhook id collision")
    return { webhook: view(registration), secret: registration.secret }
  }

  /** The user's registrations (by: only that owner's), by id. */
  async list(userID: string, by?: WebhookOwner): Promise<WebhookView[]> {
    return (await this.registrations(userID)).filter((r) => by === undefined || r.by === by).map(view)
  }

  async get(userID: string, id: string, by?: WebhookOwner): Promise<WebhookView | undefined> {
    const registration = await this.registration(userID, id, by)
    return registration && view(registration)
  }

  /** Deletes a registration and its outbox; false when it is not the caller's. */
  async remove(userID: string, id: string, by?: WebhookOwner): Promise<boolean> {
    if (!(await this.registration(userID, id, by))) return false
    await this.deps.state.delete(userID, WEBHOOKS, id)
    for (const entry of await this.deps.state.list<OutboxEntry>(userID, WEBHOOK_OUTBOX)) {
      if (entry.value.webhook === id) await this.deps.state.delete(userID, WEBHOOK_OUTBOX, entry.key)
    }
    return true
  }

  /** A registration's deliveries still kept, oldest first. */
  async deliveries(userID: string, id: string): Promise<DeliveryView[]> {
    return (await this.deps.state.list<OutboxEntry>(userID, WEBHOOK_OUTBOX))
      .map((e) => e.value)
      .filter((e) => e.webhook === id)
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
      .map(deliveryView)
  }

  /**
   * Queues an event for every matching registration of the user: user registrations always, app registrations
   * only when `by` (who caused it) is that app. Resolves with how many deliveries were newly queued (an event
   * already queued for a registration is not queued again).
   */
  async publish(userID: string, event: WebhookEvent, options: { readonly by?: string; readonly owners?: readonly string[]; readonly matchTypes?: readonly string[] } = {}): Promise<number> {
    const matchTypes = options.matchTypes ?? [event.type]
    const targets = (await this.registrations(userID)).filter((r) => (r.by === "user" || r.by === options.by || options.owners?.includes(r.by)) && r.events.some((p) => matchTypes.some((type) => matches(p, type))))
    if (!targets.length) return 0
    const max = this.deps.maxOutbox ?? WEBHOOK_OUTBOX_MAX
    let size = (await this.deps.state.list(userID, WEBHOOK_OUTBOX)).length
    let queued = 0
    for (const registration of targets) {
      if (size >= max) {
        console.error(`[hub] webhook outbox of ${userID} is full; event ${event.id} dropped for ${registration.id}`)
        break
      }
      const key = `${registration.id}.${event.id}`
      const entry: OutboxEntry = { id: `whd_${hex(key, 24)}`, webhook: registration.id, event, state: "pending", attempts: 0, created: this.now(), nextAt: this.now() }
      if ((await this.deps.state.put(userID, WEBHOOK_OUTBOX, key, entry, { ifVersion: 0 })).ok) {
        queued++
        size++
      }
    }
    if (queued) this.kick()
    return queued
  }

  publishCanonical(userID: string, event: AgentEvent, _family: EventFamily, audience?: EventAudience): Promise<number> {
    const legacyLaunchType = event.type === "launch.changed" && typeof event.data.state === "string" ? `launch.${event.data.state}` : undefined
    return this.publish(userID, canonicalWebhookEvent(this.deps.source, userID, event), {
      ...(audience?.by ? { by: audience.by } : {}),
      ...(audience?.parties ? { owners: audience.parties.filter((party) => party.startsWith("app:")) } : {}),
      ...(legacyLaunchType ? { matchTypes: [event.type, legacyLaunchType] } : {}),
    })
  }

  /** A launch change (the LaunchFeed): `data` is the launch as the API shows it. */
  async onLaunch(userID: string, launch: Launch, data: unknown): Promise<number> {
    return this.publish(userID, launchEvent(this.deps.source, launch, data), launch.by !== undefined ? { by: launch.by } : {})
  }

  /** Starts the sender: drains now and every pollMs, and soon after each publish. */
  start(): void {
    if (this.started) return
    this.started = true
    const tick = () => {
      this.poll = this.timers.set(() => {
        void this.drain()
          .catch((cause) => console.error(`[hub] webhook delivery failed: ${(cause as Error).message}`))
          .finally(() => this.started && tick())
      }, this.deps.pollMs ?? POLL_MS)
    }
    this.kick()
    tick()
  }

  stop(): void {
    this.started = false
    if (this.poll !== undefined) this.timers.clear(this.poll)
    if (this.kickTimer !== undefined) this.timers.clear(this.kickTimer)
    this.poll = this.kickTimer = undefined
  }

  /** Sends every due delivery once (and prunes finished ones); concurrent calls share one run. */
  drain(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        for (const userID of this.deps.users()) await this.drainUser(userID)
      } while (this.again)
    })().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private kick(): void {
    if (!this.started || this.kickTimer !== undefined) return
    this.kickTimer = this.timers.set(() => {
      this.kickTimer = undefined
      void this.drain().catch((cause) => console.error(`[hub] webhook delivery failed: ${(cause as Error).message}`))
    }, 0)
  }

  private async registrations(userID: string): Promise<Registration[]> {
    return (await this.deps.state.list<Registration>(userID, WEBHOOKS)).map((e) => e.value).sort((a, b) => a.id.localeCompare(b.id))
  }

  private async registration(userID: string, id: string, by?: WebhookOwner): Promise<Registration | undefined> {
    const found = (await this.deps.state.get<Registration>(userID, WEBHOOKS, id))?.value
    return found && (by === undefined || found.by === by) ? found : undefined
  }

  private async drainUser(userID: string): Promise<void> {
    const now = this.now()
    const keep = this.deps.keepMs ?? WEBHOOK_KEEP_MS
    const due: string[] = []
    for (const { key, value, version } of await this.deps.state.list<OutboxEntry>(userID, WEBHOOK_OUTBOX)) {
      if (value.state !== "pending") {
        if (now - (value.finishedAt ?? value.created) > keep) await this.deps.state.delete(userID, WEBHOOK_OUTBOX, key, { ifVersion: version })
      } else if (value.nextAt <= now) due.push(key)
    }
    for (let i = 0; i < due.length; i += CONCURRENCY) await Promise.all(due.slice(i, i + CONCURRENCY).map((key) => this.attempt(userID, key)))
  }

  /** One attempt at one delivery, under its lease. */
  private async attempt(userID: string, key: string): Promise<void> {
    const timeoutMs = this.deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS
    const lockKey = `webhook:${userID}:${key}`
    const { locks } = this.deps
    if (locks && !(await locks.acquire(lockKey, this.owner, timeoutMs + 30_000))) return
    try {
      const current = await this.deps.state.get<OutboxEntry>(userID, WEBHOOK_OUTBOX, key)
      const now = this.now()
      if (!current || current.value.state !== "pending" || current.value.nextAt > now) return
      const entry = current.value
      const registration = await this.registration(userID, entry.webhook)
      if (!registration) {
        await this.deps.state.delete(userID, WEBHOOK_OUTBOX, key)
        return
      }
      if (registration.by !== "user" && this.deps.appAlive && !this.deps.appAlive(userID, registration.by.slice("app:".length))) {
        await this.remove(userID, registration.id)
        return
      }
      if (registration.by !== "user" && this.deps.appScopes) {
        const scopes = this.deps.appScopes(userID, registration.by.slice("app:".length))
        const required = ["events:subscribe", ...webhookEventScopes(registration.events)]
        if (!scopes || required.some((scope) => !scopes.includes(scope))) {
          await this.remove(userID, registration.id)
          return
        }
      }
      const { last, final } = await this.send(registration, entry, now, timeoutMs)
      const attempts = entry.attempts + 1
      const delivered = last.status !== undefined && last.status >= 200 && last.status < 300
      const done = delivered || final || attempts > this.backoffMs.length
      const next: OutboxEntry = done
        ? { ...entry, attempts, last, state: delivered ? "delivered" : "failed", finishedAt: this.now() }
        : { ...entry, attempts, last, nextAt: now + this.backoffMs[attempts - 1]! }
      await this.deps.state.put(userID, WEBHOOK_OUTBOX, key, next, { ifVersion: current.version })
    } finally {
      if (locks) await locks.release(lockKey, this.owner)
    }
  }

  private async send(registration: Registration, entry: OutboxEntry, now: number, timeoutMs: number): Promise<{ last: DeliveryAttempt; final: boolean }> {
    const body = JSON.stringify(entry.event)
    const t = Math.floor(now / 1000)
    try {
      const result = await publicFetch(
        registration.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": this.deps.userAgent ?? "hub-webhooks",
            [WEBHOOK_SIGNATURE_HEADER]: formatWebhookSignature(t, [signWebhook(registration.secret, t, body)]),
            [WEBHOOK_EVENT_HEADER]: entry.event.type,
            [WEBHOOK_DELIVERY_HEADER]: entry.id,
          },
          body,
        },
        {
          resolve: this.deps.resolve,
          label: "Webhook URL",
          allowPrivate: this.deps.allowPrivate === true,
          timeoutMs,
          maxBytes: this.deps.maxResponseBytes ?? WEBHOOK_RESPONSE_MAX,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        },
      )
      return { last: { at: now, status: result.status }, final: false }
    } catch (cause) {
      const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300)
      return { last: { at: now, error }, final: cause instanceof PublicURLError }
    }
  }
}
