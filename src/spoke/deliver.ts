// Hub message delivery (the deliver op): how a message is admitted into an OpenCode session, the id OpenCode
// gets for it, the metadata it carries, who put each inbox item there, and applying each message once.
//
// Messages go in through OpenCode's native session.synthetic with a client id (decision 52aqsopo): OpenCode
// keeps them in the session's inbox (busy sessions, open forms, interrupts) and deduplicates the id, even across
// restarts. The model sees only the text (the hub-rendered envelope), never the metadata. An agent's prompt (kind
// "prompt") gets its provenance envelope here, from the hub's meta, and is the hub's in the inbox (never a human turn).
import { createHash } from "node:crypto"
import type { DeliverMeta, Delivered, DeliveryMode } from "../protocol"
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
 * the hub chose (`meta.delivery`, e.g. urgent: steer). Idle recipients get a turn, always steered: a queued wake
 * would come after the reply to items already waiting (a primer, wake:false messages) with a model call of its own
 * (quirk hzmcqwpj), a steered one joins them in one call. With a form open OpenCode holds the message until the
 * form is answered ("retained").
 *
 * `wake:false` and subagent sessions are admitted without starting a turn ("queued"). They default to steer: a
 * queued item gets its own model call when a turn ends (that would wake the session), while a steered one
 * without resume waits for the next turn and arrives before its prompt (or joins a turn already running).
 */
export function planDelivery(req: { readonly wake: boolean; readonly meta: DeliverMeta }, state: RecipientState): DeliveryPlan {
  const resume = req.wake && !state.subagent
  const chosen = req.meta.delivery ?? (!resume || req.meta.kind === "ask" ? "steer" : "queue")
  // Idle: no running turn to queue behind; steered, the wake shares its model call with what already waits.
  const delivery = resume && !state.busy && !state.formOpen ? "steer" : chosen
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
  const { kind, from, to, replyTo, grant } = req.meta
  return { source: PROMPT_SOURCE, messageID: req.messageID, kind, from, to, ...(replyTo !== undefined ? { replyTo } : {}), ...(grant !== undefined ? { grant } : {}) }
}

// The prompt envelope, InboxOrigins and DeliveryLedger live in the spoke SDK (harness-neutral).
export { deliverText, DeliveryLedger, InboxOrigins, renderPromptEnvelope, type Admission } from "../../packages/spoke-sdk/src/delivery.ts"
