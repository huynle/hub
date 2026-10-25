// Hub message delivery (the deliver op): how a message is admitted into an OpenCode session, the id OpenCode
// gets for it, the metadata it carries, who put each inbox item there, and applying each message once.
//
// Messages go in through OpenCode's native session.synthetic with a client id (decision 52aqsopo): OpenCode
// keeps them in the session's inbox (busy sessions, open forms, interrupts) and deduplicates the id, even across
// restarts. The model sees only the text (the hub-rendered envelope), never the metadata.
import { createHash } from "node:crypto"
import type { DeliverMeta, DeliverResult, Delivered, DeliveryMode, InboxOrigin } from "../protocol"
import { PROMPT_SOURCE } from "./conversation"

export interface DeliveryPlan {
  /** How OpenCode admits it into a busy session: after the running turn (queue) or into it (steer). */
  readonly delivery: DeliveryMode
  /** Whether OpenCode starts a turn for it when the session is idle. */
  readonly resume: boolean
  /** What the spoke reports to the hub. */
  readonly delivered: Delivered
}

export interface RecipientState {
  /** A turn runs (or OpenCode reports the session busy). */
  readonly busy: boolean
  /** A form (question) is open in the session. */
  readonly formOpen: boolean
  /** The session is a subagent's (it has a parent). */
  readonly subagent: boolean
}

/**
 * How to admit a message. Busy recipients get plain messages after the running turn and asks into it, unless
 * the hub chose (`meta.delivery`, e.g. urgent: steer). Idle recipients get a turn. With a form open OpenCode
 * holds the message until the form is answered ("retained").
 *
 * `wake:false` and subagent sessions are admitted without starting a turn ("queued"). They default to steer: a
 * queued item gets its own model call when a turn ends (that would wake the session), while a steered one
 * without resume waits for the next turn and arrives before its prompt (or joins a turn already running).
 */
export function planDelivery(req: { readonly wake: boolean; readonly meta: DeliverMeta }, state: RecipientState): DeliveryPlan {
  const resume = req.wake && !state.subagent
  const delivery = req.meta.delivery ?? (!resume || req.meta.kind === "ask" ? "steer" : "queue")
  return { delivery, resume, delivered: deliveredAs(delivery, resume, state) }
}

function deliveredAs(delivery: DeliveryMode, resume: boolean, state: RecipientState): Delivered {
  if (!resume) return "queued"
  if (state.formOpen) return "retained"
  if (state.busy) return delivery === "steer" ? "steer" : "queued"
  return "turn"
}

/** OpenCode message ids: "msg_" and id characters. */
const OPENCODE_ID = /^msg_[A-Za-z0-9]{1,200}$/

/**
 * The id OpenCode gets for a hub message: the hub's own `msg_…` id, else a stable `msg_hub…` id derived from it,
 * so every retry of the same message reuses one id (OpenCode applies it once).
 */
export function harnessMessageID(messageID: string): string {
  if (OPENCODE_ID.test(messageID)) return messageID
  return `msg_hub${createHash("sha256").update(messageID).digest("hex").slice(0, 40)}`
}

/** metadata stored with a delivered message (for timelines; the model does not see it). */
export function deliverMetadata(req: { readonly messageID: string; readonly meta: DeliverMeta }): Record<string, unknown> {
  const { kind, from, to, replyTo } = req.meta
  return { source: PROMPT_SOURCE, messageID: req.messageID, kind, from, to, ...(replyTo !== undefined ? { replyTo } : {}) }
}

const record = (v: unknown): Record<string, any> => (typeof v === "object" && v !== null ? (v as Record<string, any>) : {})

/** A bounded insertion-ordered map: the oldest entry goes when it is full. */
class Bounded<V> {
  private readonly map = new Map<string, V>()
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    return this.map.get(key)
  }
  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }
  delete(key: string): void {
    this.map.delete(key)
  }
}

/**
 * Who put each inbox item into a session, from OpenCode's session.inbox.enqueued events and the spoke's own
 * deliveries: a user item is the user's (typed, or sent from the phone), a synthetic item with hub metadata is
 * the hub's; anything else (OpenCode's own notes, compaction) has no origin.
 */
export class InboxOrigins {
  private readonly origins: Bounded<InboxOrigin>
  constructor(max = 1000) {
    this.origins = new Bounded(max)
  }

  observe(event: { readonly type: string; readonly data?: unknown }): void {
    if (event.type !== "session.inbox.enqueued") return
    const data = record(event.data)
    if (typeof data.inboxID !== "string" || this.origins.get(data.inboxID) === "hub") return
    const item = record(data.item)
    const metadata = record(record(item.payload).metadata)
    if (item.type === "user") this.origins.set(data.inboxID, "user")
    else if (item.type === "synthetic" && metadata.source === PROMPT_SOURCE && typeof metadata.messageID === "string") this.origins.set(data.inboxID, "hub")
  }

  /** Marks an inbox item the spoke delivered for the hub. */
  hub(inboxID: string): void {
    this.origins.set(inboxID, "hub")
  }

  /** The item's origin, when known; forgets it (an item is delivered once). */
  take(inboxID: string): InboxOrigin | undefined {
    const origin = this.origins.get(inboxID)
    this.origins.delete(inboxID)
    return origin
  }
}

export interface Admission {
  readonly result: DeliverResult
  /** Whether it was sent with resume (could start a turn). */
  readonly resumed: boolean
}

/**
 * Applies each hub message once: a duplicate messageID (the hub's retry, in flight or done) gets the first
 * result without another admission. Only a retry that asks to wake a message first admitted without waking is
 * sent again (OpenCode keeps one message for the id and wakes the session). Failures are not remembered.
 */
export class DeliveryLedger {
  private readonly entries: Bounded<Promise<Admission>>
  constructor(max = 1000) {
    this.entries = new Bounded(max)
  }

  async run(messageID: string, wake: boolean, send: () => Promise<Admission>): Promise<DeliverResult> {
    const known = this.entries.get(messageID)
    if (known) {
      const admission = await known.catch(() => undefined)
      if (admission && (!wake || admission.resumed)) return admission.result
      if (this.entries.get(messageID) !== known) return this.run(messageID, wake, send)
    }
    const attempt = send()
    this.entries.set(messageID, attempt)
    try {
      return (await attempt).result
    } catch (cause) {
      if (this.entries.get(messageID) === attempt) this.entries.delete(messageID)
      throw cause
    }
  }
}
