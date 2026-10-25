// Check "features" (feature honesty): the hub sends a spoke only what its hello announced, so the spoke must keep its
// word both ways. Every announced op (and op option) succeeds with a well-formed result or fails with a well-formed
// error; every op or option it did not announce is refused with an error: never a silent ok, never left unanswered
// (a hub that predates announced core ops sends them anyway). Samples are minimal, valid requests (a request the
// spoke cannot parse is dropped unanswered, which would prove nothing) against a session the spoke reported.
import { isDeliverResult, requestFeatures, type ServerRequest } from "../../protocol/src/index.ts"

type Op = ServerRequest["op"]

/** Every op the hub may send a spoke. */
export const ALL_OPS: readonly Op[] = [
  "turn",
  "steer",
  "interrupt",
  "stop",
  "permission",
  "form",
  "context",
  "rename",
  "autoName",
  "summary",
  "diff",
  "conversation",
  "models",
  "modelPrefs",
  "setModelPrefs",
  "timeline",
  "timelinePart",
  "timelineFile",
  "expose",
  "create",
  "sessionTokens",
  "actTokens",
  "deliver",
]

export interface ProbeContext {
  /** A session the spoke reported. */
  readonly sessionID: string
  /** A directory the spoke reported (for create). */
  readonly directory: string
  readonly hubURL: string
  readonly sessionToken: string
  readonly actToken: string
}

export interface Probe {
  /** The op, or op+option for an option probe (e.g. "permission+permissionMessage"). */
  readonly label: string
  readonly req: ServerRequest
  readonly expect: "serve" | "refuse"
}

export interface ProbeAnswer {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

const TOKEN_TTL_MS = 60 * 60_000
const META = { kind: "msg", from: "@conformance", to: "@spoke" } as const

/** A minimal valid request for `op` (side effects kept small: no wake, no turn beyond one word, missing IDs). */
export function sampleRequest(op: Op, ctx: ProbeContext): ServerRequest {
  const sessionID = ctx.sessionID
  const exp = Date.now() + TOKEN_TTL_MS
  switch (op) {
    case "turn":
      return { op, sessionID, text: "conformance", voiceStyle: false }
    case "steer":
      return { op, sessionID, text: "conformance" }
    case "permission":
      return { op, sessionID, requestID: "per_conformance_none", decision: "reject" }
    case "form":
      return { op, sessionID, formID: "frm_conformance_none", cancel: true }
    case "rename":
      return { op, sessionID, title: "Conformance" }
    case "diff":
      return { op, sessionID, file: "README.md" }
    case "conversation":
      return { op, sessionID, on: false }
    case "expose":
      return { op, sessionID, on: true }
    case "setModelPrefs":
      return { op, sessionID, voice: null }
    case "timeline":
      return { op, sessionID, limit: 1 }
    case "timelinePart":
      return { op, sessionID, messageID: "msg_conformance_none", partID: "prt_conformance_none" }
    case "timelineFile":
      return { op, sessionID, messageID: "msg_conformance_none", index: 0 }
    case "create":
      return { op, directory: ctx.directory, title: "Conformance" }
    case "sessionTokens":
      return { op, tokens: [{ sessionID, token: ctx.sessionToken, exp }], hubURL: ctx.hubURL }
    case "actTokens":
      return { op, tokens: [{ sessionID, token: ctx.actToken, exp }] }
    case "deliver":
      return { op, sessionID, messageID: "msg_conformance_probe", text: "conformance probe", wake: false, meta: META }
    default:
      return { op, sessionID } as ServerRequest
  }
}

/** Requests that use an op option (a modifier feature). */
function optionProbes(ctx: ProbeContext): Array<{ label: string; req: ServerRequest }> {
  return [
    { label: "permission+permissionMessage", req: { op: "permission", sessionID: ctx.sessionID, requestID: "per_conformance_none", decision: "reject", message: "conformance" } },
    {
      label: "deliver+hubPrompt",
      req: { op: "deliver", sessionID: ctx.sessionID, messageID: "msg_conformance_prompt", text: "conformance", wake: false, meta: { kind: "prompt", from: "@conformance", to: "@spoke", grant: "grt_conformance" } },
    },
    { label: "create+launch", req: { op: "create", directory: ctx.directory, launchID: "lch_conformance" } },
  ]
}

/** Every probe: each op and option, expected served when all its features (requestFeatures) are, else refused. */
export function featureProbes(served: ReadonlySet<string>, ctx: ProbeContext): Probe[] {
  const all = [...ALL_OPS.map((op) => ({ label: op as string, req: sampleRequest(op, ctx) })), ...optionProbes(ctx)]
  return all.map(({ label, req }) => ({ label, req, expect: requestFeatures(req).every((f) => served.has(f)) ? "serve" : "refuse" }))
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string")

/** Whether an ok result of `op` has the shape the hub reads (ops without a rule: any object). */
function resultProblem(op: Op, result: unknown): string | undefined {
  switch (op) {
    case "deliver":
      return isDeliverResult(result) ? undefined : "a deliver result needs delivered (steer, turn, queued or retained) and an optional inboxID"
    case "sessionTokens":
    case "actTokens":
      return isObj(result) && strings(result.applied) && Array.isArray(result.skipped) ? undefined : "needs applied and skipped lists"
    case "stop":
      return isObj(result) && strings(result.stopped) ? undefined : "needs a stopped list"
    case "rename":
      return isObj(result) && typeof result.title === "string" ? undefined : "needs the title"
    case "create":
      return isObj(result) && typeof result.sessionID === "string" ? undefined : "needs the sessionID"
    case "steer":
      return isObj(result) && typeof result.inboxID === "string" ? undefined : "needs the inboxID"
    case "turn":
      return isObj(result) && typeof result.outcome === "string" && typeof result.reply === "string" ? undefined : "needs outcome and reply"
    default:
      return isObj(result) ? undefined : "must be an object"
  }
}

/** The problem with a probe's answer (undefined: none). `res` undefined: no answer within the timeout. */
export function judgeProbe(probe: Probe, res: ProbeAnswer | undefined): string | undefined {
  const what = `${probe.expect === "refuse" ? "unannounced" : "announced"} ${JSON.stringify(probe.label)}`
  if (!res) return `no answer to ${what} (a spoke must answer every request)`
  if (!res.ok) return typeof res.error === "string" && res.error.trim() !== "" ? undefined : `refused ${what} without an error message`
  if (probe.expect === "refuse") return `${what} was answered ok: it must be refused (not announced in the hello)`
  const problem = resultProblem(probe.req.op, res.result)
  return problem ? `malformed result for ${what}: ${problem}` : undefined
}
