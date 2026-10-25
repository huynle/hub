// Checks "deliver.idempotent" and "deliver.modes" (judgments; the runner sends the delivers).
//
// Idempotent: the hub retries a deliver with the same messageID (a reconnect, a pod handover); the spoke admits the
// message once and answers every retry as it answered the first time. Admissions are counted from the spoke's own
// session.inbox.delivered events with origin "hub" (matching the inboxID when the answer names one).
//
// Modes: `delivered` is one of DELIVERED; wake: false never starts a turn; and a spoke whose evidence cannot see the
// harness take the message in (hooks, screen, or an unknown level) claims "steer" or "turn" only with confirmation: its
// session.inbox.delivered (origin hub) for the message. Otherwise it must say "queued" (design §1.2).
import { DELIVERED } from "../../protocol/src/index.ts"

export type Answer = { readonly ok: boolean; readonly result?: unknown; readonly error?: string } | undefined
type Event = { readonly type: string; readonly data: unknown }

/** Evidence that observes the harness accept a prompt (the hub trusts it for delivery modes). */
export const CONFIRMING_EVIDENCE: ReadonlySet<string> = new Set(["native", "rpc"])

export function idempotencyProblems(input: { answers: readonly Answer[]; admissions: number }): string[] {
  const problems: string[] = []
  const [first, ...retries] = input.answers
  if (!first) problems.push("no answer to the first deliver")
  else if (!first.ok) problems.push(`the first deliver failed: ${first.error ?? "no error message"}`)
  for (const [i, retry] of retries.entries()) {
    if (!retry) problems.push(`no answer to retry #${i + 1}`)
    else if (!retry.ok) problems.push(`retry #${i + 1} failed: ${retry.error ?? "no error message"}`)
    else if (first?.ok && JSON.stringify(retry.result) !== JSON.stringify(first.result)) {
      problems.push(`the answer to retry #${i + 1} (${JSON.stringify(retry.result)}) differs from the first (${JSON.stringify(first.result)})`)
    }
  }
  if (input.admissions > 1) problems.push(`the message was admitted ${input.admissions} times (session.inbox.delivered, origin hub); a messageID is admitted once`)
  return problems
}

/** How many hub-origin session.inbox.delivered events of `sessionID` (with `inboxID`, when given) are in `events`. */
export function confirmations(events: readonly Event[], sessionID: string, inboxID?: string): number {
  return events.filter((e) => {
    const d = e.data as Record<string, unknown> | undefined
    return e.type === "session.inbox.delivered" && d?.sessionID === sessionID && d?.origin === "hub" && (inboxID === undefined || d?.inboxID === inboxID)
  }).length
}

export function deliverModeProblems(input: { evidence: string; wake: boolean; answer: Answer; confirmed: boolean }): string[] {
  const { answer } = input
  if (!answer?.ok) return []
  const delivered = (answer.result as { delivered?: unknown } | undefined)?.delivered
  if (!(DELIVERED as readonly unknown[]).includes(delivered)) return [`delivered ${JSON.stringify(delivered)} is not one of ${DELIVERED.join(", ")}`]
  const problems: string[] = []
  if (!input.wake && delivered === "turn") problems.push('a deliver with wake: false answered "turn" (it must not start a turn)')
  if ((delivered === "steer" || delivered === "turn") && !CONFIRMING_EVIDENCE.has(input.evidence) && !input.confirmed) {
    problems.push(`answered "${delivered}" without a confirmation (session.inbox.delivered, origin hub) on ${input.evidence} evidence: say "queued" unless the harness confirmed it`)
  }
  return problems
}
