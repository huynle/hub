// The messaging verbs' helpers (design §3): text arguments (or "-" for stdin) and the short text of what the hub
// answers to msg, ask, reply, decline, inbox and mute. The shapes are packages/sdk's types (message-routes.ts).
import type { AgentMessage, MessageDelivery, Party, Sent } from "../../sdk/src/index.ts"
import { UsageError } from "./args"

/** A text argument: the value, or all of stdin for "-" (one trailing newline dropped); never empty. */
export async function textArg(value: string, stdin: (() => Promise<string>) | undefined, what = "text"): Promise<string> {
  let text = value
  if (value === "-") {
    if (!stdin) throw new UsageError(`cannot read the ${what} from stdin here`)
    text = (await stdin()).replace(/\r?\n$/, "")
  }
  if (!text.trim()) throw new UsageError(`the ${what} is empty`)
  return text
}

/** `@name`, the session ID, `@me`, or the app token. */
export function partyText(party: Party): string {
  if (party.kind === "session") return party.name ? `@${party.name.replace(/^@+/, "")}` : party.sessionID
  if (party.kind === "user") return "@me"
  return `app ${party.label ?? party.tokenID}`
}

const DELIVERY: Record<MessageDelivery, string> = {
  turn: "delivered (started a turn)",
  steer: "delivered (into the running turn)",
  queued: "queued (read at its next turn)",
  retained: "retained (held until its open question is answered)",
  pending: "pending (offline; delivered when it reconnects, for 24 h)",
}

export const deliveryText = (delivery: MessageDelivery | undefined): string => (delivery ? (DELIVERY[delivery] ?? delivery) : "stored (in its inbox)")

/** `to @@reviewer → @api` when the address is not the recipient's own name. */
function toText(message: AgentMessage): string {
  const recipient = partyText(message.recipient)
  return message.to === recipient || message.to === (message.recipient as { sessionID?: string }).sessionID ? recipient : `${message.to} → ${recipient}`
}

/** `msg_… to @web-work: delivered (started a turn)` */
export const sentText = ({ message, delivery }: Sent): string => `${message.kind} ${message.id} to ${toText(message)}: ${deliveryText(delivery)}`
