// The act verbs in the CLI (design §5, §8): the answer of `hub answer` (key=value pairs, or --json '{…}' / --json -),
// the short text of what the hub answers to approve, deny, answer, prompt and stop, and the lines a needs_user
// failure adds (its evaluation and the Decision it opened). The shapes are packages/sdk's types (acting-routes.ts).
import type { Approved, Denied, Envelope, Evaluation, FormAnswer, FormAnswered, PromptDelivery, Prompted, Stopped } from "../../sdk/src/index.ts"
import { jsonObjectArg, UsageError, type Parsed } from "./args"
import { oneLine } from "./format"

const grantText = (grant: string | undefined) => (grant ? `grant ${grant}` : undefined)
const inParens = (parts: readonly (string | undefined)[]) => {
  const shown = parts.filter(Boolean)
  return shown.length ? ` (${shown.join(", ")})` : ""
}

export const approvedText = (b: Approved): string => `approved ${b.requestID} in ${b.sessionID}${inParens([b.decision, grantText(b.grant)])}`

export function deniedText(b: Denied): string {
  const reason = b.reasonSent === true ? "; the reason reached the harness" : b.reasonSent === false ? "; the harness did not get the reason (older spoke)" : ""
  return `denied ${b.requestID} in ${b.sessionID}${inParens([grantText(b.grant)])}${reason}`
}

export const answeredText = (b: FormAnswered, cancelled: boolean): string => `${cancelled ? "cancelled" : "answered"} ${b.formID} in ${b.sessionID}${inParens([grantText(b.grant)])}`

export function promptedText(b: Prompted): string {
  if ("messageID" in b) return `prompted ${b.sessionID}: ${b.messageID} delivered (${b.delivered})${b.grant ? `, grant ${b.grant}` : ""}`
  return `prompted ${b.sessionID}: ${b.mode === "steer" ? "steered into the running turn" : "started a turn"}`
}

export const stoppedText = (b: Stopped): string => `stopped ${b.sessionID}${inParens([grantText(b.grant)])}`

/** The deliveries of a prompt. */
export const DELIVERIES: readonly PromptDelivery[] = ["queue", "steer"]

/** The --delivery of `hub prompt`. */
export function deliveryArg(value: string | undefined): PromptDelivery | undefined {
  if (value !== undefined && !(DELIVERIES as readonly string[]).includes(value)) throw new UsageError(`--delivery is one of ${DELIVERIES.join(", ")}`)
  return value as PromptDelivery | undefined
}

/** The answer of `hub answer`: key=value pairs (a repeated key is a list), or a JSON object from --json; "cancel" for --cancel. */
export async function formAnswerArg(pairs: readonly string[], flags: Parsed["flags"], stdin: (() => Promise<string>) | undefined): Promise<FormAnswer | "cancel"> {
  const json = typeof flags.json === "string" ? flags.json : undefined
  const given = [pairs.length > 0, json !== undefined, flags.cancel === true].filter(Boolean).length
  if (given > 1) throw new UsageError("give either key=value pairs, --json '{…}' or --cancel")
  if (flags.cancel === true) return "cancel"
  if (json !== undefined) return (await jsonObjectArg(json, stdin, "answer")) as FormAnswer
  if (!pairs.length) throw new UsageError("needs key=value pairs (or --json '{…}', or --cancel)")
  const answer: Record<string, string | string[]> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    if (eq <= 0) throw new UsageError(`answers are key=value (got "${pair}")`)
    const key = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    const before = answer[key]
    answer[key] = before === undefined ? value : [...(Array.isArray(before) ? before : [before]), value]
  }
  return answer
}

/** What a needs_user failure adds: the evaluation, the grants checked and the Decision opened for the user. */
export function needsUserLines(envelope: Envelope): string[] {
  const lines: string[] = []
  const evaluation = envelope.evaluation as Evaluation | undefined
  if (evaluation && typeof evaluation === "object") {
    lines.push(`evaluation: ${evaluation.verdict}${evaluation.tier ? ` (${evaluation.tier})` : ""} — ${oneLine(String(evaluation.reason ?? ""), 300)}`)
    const grants = Array.isArray(evaluation.grants) ? evaluation.grants : []
    lines.push(`grants checked: ${grants.length ? grants.join(", ") : "none"}`)
  }
  if (typeof envelope.decisionID === "string") lines.push(`decision ${envelope.decisionID} is open for the user`)
  return lines
}
