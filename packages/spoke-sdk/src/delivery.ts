// Harness-neutral delivery helpers (the deliver op): the provenance envelope an agent's prompt (kind "prompt") is
// rendered in, who put each inbox item into a session, and applying each hub message once (DeliveryLedger: the hub
// retries a deliver with the same messageID; a harness may not deduplicate it, so the spoke must).
import { sanitizeLabel, sanitizeText } from "../../sdk/src/envelope.ts"
import type { DeliverMeta, DeliverResult, InboxOrigin } from "../../protocol/src/index.ts"
import { PROMPT_SOURCE } from "./prompt-source.ts"

/** Body lines that could pass for a header or boundary (or an escaped one): escaped with a leading backslash. */
const FORGEABLE = /^\s*\\*(?:\[hub\]|-{3,}|↩)/i

/**
 * The text a session sees for an agent's prompt (kind "prompt"): a provenance header naming the sender and the
 * grant, then the sanitised body between two boundaries (the same shape as the hub's message envelope, so
 * timelines read the body back). The header comes from the hub's meta, never from the body.
 */
export function renderPromptEnvelope(input: { readonly messageID: string; readonly from: string; readonly grant: string; readonly text: string }): string {
  const id = sanitizeLabel(input.messageID)
  const boundary = `----- ${id} -----`
  const body = sanitizeText(input.text)
    .split("\n")
    .map((line) => (FORGEABLE.test(line) ? `\\${line}` : line))
    .join("\n")
  return [`[hub] prompt from ${sanitizeLabel(input.from)} · grant ${sanitizeLabel(input.grant)} · ${id}`, boundary, body, boundary].join("\n")
}

/** What OpenCode gets for a deliver: a prompt wrapped in its provenance envelope, other kinds as the hub rendered them. */
export function deliverText(req: { readonly messageID: string; readonly text: string; readonly meta: DeliverMeta }): string {
  if (req.meta.kind !== "prompt") return req.text
  return renderPromptEnvelope({ messageID: req.messageID, from: req.meta.from, grant: req.meta.grant ?? "", text: req.text })
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
    // A hub message (hub metadata with its messageID) is never the user's, whatever item type OpenCode gives it.
    if (metadata.source === PROMPT_SOURCE && typeof metadata.messageID === "string" && (item.type === "synthetic" || item.type === "user")) this.origins.set(data.inboxID, "hub")
    else if (item.type === "user") this.origins.set(data.inboxID, "user")
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
