// The messaging verbs' helpers (design §3): text arguments (or "-" for stdin) and the short text of what the hub
// answers to msg, ask, reply, decline, inbox and mute. The shapes are packages/sdk's types (message-routes.ts).
import type { AgentMessage, Asked, Inbox, MessageDelivery, Party, Replied, Sent } from "../../sdk/src/index.ts"
import { UsageError } from "./args"
import { oneLine } from "./format"

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

/** How long an ask stays open when --expires is not given (the hub's default). */
export const ASK_EXPIRES_DEFAULT_S = 24 * 60 * 60

const UNIT_S: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }

/** Seconds from `90`, `30s`, `5m`, `1.5h` or `1d`. */
export function durationArg(value: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(value)
  if (!match) throw new UsageError(`${flag} takes seconds or a duration like 30s, 5m, 2h, 1d (got "${value}")`)
  return Number(match[1]) * UNIT_S[match[2]!]!
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

/** What an ask came to, its text, and the exit code: answered 0, declined 1, open after a wait 1, expired 8. */
export function askOutcome(asked: Asked, waited: number | undefined): { text: string; exit: number; note?: string } {
  const { message, answer } = asked
  const head = sentText(asked)
  const by = answer ? partyText(answer.from) : partyText(message.recipient)
  switch (message.state) {
    case "answered":
      return { text: `${head}\nanswer ${answer?.id ?? "?"} from ${by}:\n${answer?.text ?? ""}`, exit: 0 }
    case "declined":
      return { text: `${head}\ndeclined by ${by}: ${answer?.text ?? ""}`, exit: 1 }
    case "expired":
      return { text: `${head}\nexpired without an answer`, exit: 8 }
    default: {
      const until = message.expiresAt !== undefined ? `open until ${iso(message.expiresAt)}` : "open"
      const text = `${head}\n${until}; the answer shows in \`hub inbox\``
      if (waited === undefined) return { text, exit: 0 }
      return { text, exit: 1, note: `no answer within ${waited} s; ${message.id} is still open (see \`hub inbox\`)` }
    }
  }
}

/** `reply msg_r to @api: delivered (started a turn) (answers msg_1)` */
export const repliedText = (replied: Replied): string => `${sentText(replied)} (answers ${replied.original.id})`

/** `declined msg_1 (decline msg_d to @api: queued …)` */
export const declinedText = (replied: Replied): string => `declined ${replied.original.id} (${sentText(replied)})`

/** Open asks to answer (with how), the caller's own open asks, recent messages, mutes. */
export function inboxText(inbox: Inbox): string {
  const lines: string[] = []
  const until = (m: AgentMessage) => (m.expiresAt !== undefined ? `  (open until ${iso(m.expiresAt)})` : "")
  if (inbox.asks.length) {
    lines.push("asks to answer:")
    for (const m of inbox.asks) {
      lines.push(`  ${m.id} from ${partyText(m.from)}  ${iso(m.at)}: ${oneLine(m.text, 200)}${until(m)}`)
      lines.push(`    ↩ hub reply ${m.id} "…" · hub decline ${m.id} --why "…"`)
    }
  }
  if (inbox.waiting.length) {
    lines.push("waiting for answers:")
    for (const m of inbox.waiting) lines.push(`  ${m.id} to ${toText(m)}  ${iso(m.at)}: ${oneLine(m.text, 200)}${until(m)}`)
  }
  if (inbox.messages.length) {
    lines.push("messages:")
    for (const m of inbox.messages) lines.push(`  ${m.id} ${m.kind} from ${partyText(m.from)}  ${iso(m.at)}${m.replyTo ? ` (re ${m.replyTo})` : ""}: ${oneLine(m.text, 200)}`)
  }
  if (inbox.muted.length) lines.push(mutedText(inbox.muted))
  return lines.length ? lines.join("\n") : "inbox empty"
}

export const mutedText = (muted: readonly string[]): string => `muted: ${muted.length ? muted.join(", ") : "nobody"}`
