// Decisions in the CLI (design §12.1): the `hub ask @me` options (--option id=label[:safe], --recommend id --why,
// --urgency, --deadline, --on-timeout, --tier, --about) and the text of a Decision (ask @me, `hub decisions list`).
// The shapes are packages/sdk's types (src/central/agent/decisions.ts).
import type { AskOptions, Decision, DecisionOption, DecisionState } from "../../sdk/src/index.ts"
import { str, UsageError, type FlagKind, type Parsed } from "./args"
import { oneLine } from "./format"
import { durationArg, partyText } from "./messaging"

/** The ask flags that make a Decision (only for asks to @me). */
export const DECISION_FLAGS: Readonly<Record<string, FlagKind>> = {
  option: "multi",
  recommend: "string",
  why: "string",
  urgency: "string",
  deadline: "string",
  "on-timeout": "string",
  tier: "string",
  about: "multi",
}

const URGENCIES = ["low", "normal", "high"]
const TIERS = ["confirm", "tap"]
const STATES: readonly DecisionState[] = ["open", "answered", "expired", "closed"]
export const DECISION_STATES = STATES

/** `id=label` or `id=label:safe` (the label may contain colons; only a trailing `:safe` marks it safe). */
export function optionArg(value: string): DecisionOption {
  const eq = value.indexOf("=")
  if (eq <= 0) throw new UsageError(`--option takes id=label[:safe] (got "${value}")`)
  const id = value.slice(0, eq)
  let label = value.slice(eq + 1)
  const safe = label.endsWith(":safe")
  if (safe) label = label.slice(0, -":safe".length)
  if (!label.trim()) throw new UsageError(`--option ${id}: the label is empty`)
  return { id, label, ...(safe ? { safe: true } : {}) }
}

const oneOf = (value: string | undefined, allowed: readonly string[], flag: string) => {
  if (value !== undefined && !allowed.includes(value)) throw new UsageError(`${flag} is one of ${allowed.join(", ")}`)
  return value
}

/** The Decision fields of `hub ask` (empty when none is given); usage errors for bad ones or a non-@me ask. */
export function decisionOptions(flags: Parsed["flags"], to: string): Partial<AskOptions> {
  const given = Object.keys(DECISION_FLAGS).filter((flag) => flags[flag] !== undefined)
  if (!given.length) return {}
  if (to !== "@me") throw new UsageError(`${given.map((f) => `--${f}`).join(", ")}: only for asks to @me`)
  const recommend = str(flags, "recommend")
  const why = str(flags, "why")
  if (why !== undefined && recommend === undefined) throw new UsageError("--why explains --recommend")
  const deadline = str(flags, "deadline")
  const urgency = oneOf(str(flags, "urgency"), URGENCIES, "--urgency") as AskOptions["urgency"]
  const tier = oneOf(str(flags, "tier"), TIERS, "--tier") as AskOptions["tier"]
  const onTimeout = str(flags, "on-timeout")
  const options = flags.option as string[] | undefined
  const about = flags.about as string[] | undefined
  return {
    ...(options ? { options: options.map(optionArg) } : {}),
    ...(recommend !== undefined ? { recommendation: { option: recommend, ...(why !== undefined ? { why } : {}) } } : {}),
    ...(urgency ? { urgency } : {}),
    ...(tier ? { tier } : {}),
    ...(deadline !== undefined ? { deadline: durationArg(deadline, "--deadline") } : {}),
    ...(onTimeout !== undefined ? { onTimeout } : {}),
    ...(about ? { about } : {}),
  }
}

/** The --state filter of `hub decisions list`. */
export function stateArg(value: string | undefined): DecisionState | undefined {
  return oneOf(value, STATES, "--state") as DecisionState | undefined
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

/** `go Proceed · hold Hold (safe) — recommended: hold (why)`; empty for a free-text Decision without one. */
function choicesText(decision: Decision): string {
  const options = decision.options.map((o) => `${o.id} ${oneLine(o.label, 80)}${o.safe ? " (safe)" : ""}`).join(" · ")
  const r = decision.recommendation
  const recommended = r ? `recommended: ${r.option}${r.why ? ` (${oneLine(r.why, 200)})` : ""}` : ""
  return [options, recommended].filter(Boolean).join(" — ")
}

function stateText(decision: Decision): string {
  if (decision.state === "answered") {
    const a = decision.answer
    return `answered${a?.option ? ` ${a.option}` : ""}${a?.answeredBy === "timeout" ? " (timeout)" : ""}`
  }
  if (decision.state === "open" && decision.deadline !== undefined) return `open (deadline ${iso(decision.deadline)})`
  return decision.state
}

/** One Decision: `dec_1  open  high  from @api  Question` and its choices on the next line. */
export function decisionText(decision: Decision): string {
  const head = `${decision.id}  ${stateText(decision)}  ${decision.urgency}  from ${partyText(decision.from)}  ${oneLine(decision.question, 160)}`
  const choices = choicesText(decision)
  return choices ? `${head}\n  ${choices}` : head
}

export const decisionsText = (decisions: readonly Decision[]): string => (decisions.length ? decisions.map(decisionText).join("\n") : "no decisions")

/** What `hub ask @me` adds: the Decision it opened. */
export function openedText(decision: Decision): string {
  const tier = decision.tier === "tap" ? ", tap in the console" : ""
  const choices = choicesText(decision)
  return `decision ${decision.id} (${decision.urgency}${tier}): ${oneLine(decision.question, 160)}${choices ? `\n  ${choices}` : ""}\n  the user answers it in the console`
}
