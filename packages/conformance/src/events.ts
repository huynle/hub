// Check "events": every event a (non-OpenCode) spoke sent is in the harness subset with valid, bounded data
// (harnessEventProblem), is about a session the spoke reported, and carries no raw tool input or output: neither under
// a raw key (input, output, stdout, tool_response …) nor as an over-long extra field.
import { harnessEventProblem } from "../../protocol/src/index.ts"

/** Keys that carry a tool's raw input or output (Claude Code hook payloads, Codex items, generic names). */
export const RAW_KEYS: ReadonlySet<string> = new Set([
  "input",
  "output",
  "stdout",
  "stderr",
  "raw",
  "tool_input",
  "tool_output",
  "tool_response",
  "toolInput",
  "toolOutput",
  "toolResponse",
])

/** Longest text a field the harness subset does not define may carry. */
export const EXTRA_TEXT_MAX = 1000
/** Fields the harness subset defines (their bounds are harnessEventProblem's). */
const DEFINED = new Set([
  "sessionID",
  "parentID",
  "title",
  "turnID",
  "inferred",
  "error",
  "message",
  "status",
  "type",
  "attempt",
  "assistantMessageID",
  "ordinal",
  "text",
  "inboxID",
  "origin",
  "id",
  "summary",
  "background",
  "action",
  "resources",
  "save",
  "source",
  "messageID",
  "requestID",
  "reply",
  "form",
  "fields",
  "metadata",
])
const MAX_PROBLEMS = 20

function rawProblem(value: unknown, path: string, defined: boolean): string | undefined {
  if (typeof value === "string") return !defined && value.length > EXTRA_TEXT_MAX ? `${path} is ${value.length} characters (fields outside the subset: at most ${EXTRA_TEXT_MAX})` : undefined
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const problem = rawProblem(v, `${path}[${i}]`, defined)
      if (problem) return problem
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  for (const [key, v] of Object.entries(value)) {
    if (RAW_KEYS.has(key)) return `raw tool data in ${path}.${key} (send a short summary instead)`
    const problem = rawProblem(v, `${path}.${key}`, defined && DEFINED.has(key))
    if (problem) return problem
  }
  return undefined
}

const sessionOf = (data: unknown): unknown => {
  const d = data as Record<string, any>
  return d?.sessionID ?? d?.form?.sessionID
}

export function eventProblems(input: { events: readonly { type: string; data: unknown }[]; sessions: ReadonlySet<string> }): string[] {
  const problems: string[] = []
  for (const [i, event] of input.events.entries()) {
    const label = `event #${i + 1} ${JSON.stringify(event?.type)}`
    const problem = harnessEventProblem(event) ?? rawProblem(event.data, "data", true)
    if (problem) problems.push(`${label}: ${problem}`)
    else {
      const sessionID = sessionOf(event.data)
      if (typeof sessionID === "string" && !input.sessions.has(sessionID)) problems.push(`${label}: session ${sessionID} was not reported in a sessions frame`)
    }
  }
  return problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `… and ${problems.length - MAX_PROBLEMS} more`] : problems
}
