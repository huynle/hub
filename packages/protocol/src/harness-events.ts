// The harness event subset: the forwarded events (FORWARDED_EVENTS, index.ts) a spoke of a harness other than
// OpenCode may send, with their data shapes and a validator. Every type is one hubs already accept, so a frame a
// non-OpenCode spoke sends passes older hubs' parsers too; nothing here changes what the hub parses. A hub (or the
// conformance suite) checks a non-OpenCode spoke's events with harnessEventProblem.
//
// Rules for all of them:
// - `sessionID` (and parentID, form.sessionID) follow the hub's ID rule, `ses_` + letters and digits: a spoke maps
//   its harness's native IDs (a Claude Code UUID, a Codex thread ID) to hub IDs before sending (e.g. ses_cc<32 hex>).
// - Other IDs (tool calls, permission requests, forms, messages, turns) are plain IDs (wire.ts ID).
// - Extra data fields are allowed (a newer spoke may add some; hubs ignore what they do not read); the fields
//   listed here must be valid.
// - Texts are bounded: no full tool inputs or outputs, only short summaries (as compactActivity does for OpenCode).
//
// Turn interruption: "session.execution.interrupted" ends a turn the user or the hub interrupted. A spoke that sees
// the interruption (Codex's Interrupt hook, an rpc turn/completed with status "interrupted") sends it at once. A
// harness that reports none (Claude Code fires no Stop hook on Esc) leaves the spoke to infer it later, from the
// transcript or the next prompt: it sends the event with `inferred: true`, so the hub knows the run's end time is
// approximate.
//
// Imports only from wire.ts: index.ts re-exports this module.

import { ID, isObj, nonEmpty, num } from "./wire.ts"

/** Event types a non-OpenCode spoke may send (all in FORWARDED_EVENTS). */
export const HARNESS_EVENTS = [
  "session.created",
  "session.renamed",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.status",
  "session.text.ended",
  "session.inbox.delivered",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
] as const
export type HarnessEventType = (typeof HARNESS_EVENTS)[number]

/** Longest session title. */
export const HARNESS_TITLE_MAX = 200
/** Longest run error message. */
export const HARNESS_ERROR_MAX = 1000
/** Longest tool summary or tool error (as ACTIVITY_SUMMARY_MAX). */
export const HARNESS_SUMMARY_MAX = 160
/** Longest retry reason (as RETRY_MESSAGE_MAX). */
export const HARNESS_RETRY_MAX = 200
/** Longest final reply text (session.text.ended). */
export const HARNESS_TEXT_MAX = 16_000
/** Longest permission action, and the most resources (and save patterns) and the length of each. */
export const HARNESS_ACTION_MAX = 200
export const HARNESS_RESOURCES_MAX = 100
export const HARNESS_RESOURCE_MAX = 4000
/** Most fields a form carries (the hub keeps the ones it can render). */
export const HARNESS_FORM_FIELDS_MAX = 50

/** A hub session ID: `ses_` + 1–200 letters and digits. */
export const isHubSessionID = (v: unknown): v is string => typeof v === "string" && /^ses_[A-Za-z0-9]{1,200}$/.test(v)

type Turn = { readonly sessionID: string; readonly turnID?: string }

/** Each type's data, as a non-OpenCode spoke sends it. */
export interface HarnessEventData {
  "session.created": { readonly sessionID: string; readonly parentID?: string; readonly title?: string }
  "session.renamed": { readonly sessionID: string; readonly title: string }
  "session.deleted": { readonly sessionID: string }
  /** A turn started (the session is busy). `turnID`: the harness's turn, when it has one. */
  "session.execution.started": Turn
  "session.execution.succeeded": Turn
  "session.execution.failed": Turn & { readonly error?: { readonly message: string } }
  /** `inferred`: the harness reported no interruption; the spoke found it later (see the header). */
  "session.execution.interrupted": Turn & { readonly inferred?: true }
  "session.status": { readonly sessionID: string; readonly status: { readonly type: "idle" | "busy" } | { readonly type: "retry"; readonly attempt?: number; readonly message?: string } }
  /** The turn's reply (e.g. Claude Code's Stop last_assistant_message); `ordinal` counts replies in the message. */
  "session.text.ended": { readonly sessionID: string; readonly assistantMessageID: string; readonly ordinal: number; readonly text: string }
  /** A prompt entered the session: typed by the user, or a message the hub delivered. */
  "session.inbox.delivered": { readonly sessionID: string; readonly inboxID: string; readonly origin?: "user" | "hub" }
  "session.tool.called": { readonly sessionID: string; readonly id: string; readonly assistantMessageID?: string; readonly summary?: string; readonly background?: boolean }
  "session.tool.success": { readonly sessionID: string; readonly id: string }
  "session.tool.failed": { readonly sessionID: string; readonly id: string; readonly error?: string }
  /**
   * The harness asks to act: `action` in the hub's vocabulary ("shell", "edit", "read", "<server>_<tool>"), what it
   * applies to, and the patterns an "always" reply would save.
   */
  "permission.asked": {
    readonly sessionID: string
    readonly id: string
    readonly action: string
    readonly resources: readonly string[]
    readonly save?: readonly string[]
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly id: string }
  }
  /** Answered (here, locally, or by a hook): the request is no longer pending. */
  "permission.replied": { readonly sessionID: string; readonly requestID: string; readonly reply?: "once" | "always" | "reject" }
  /** A form (question); `fields` as OpenCode's FormField (the hub keeps what it can render). */
  "form.created": { readonly form: { readonly id: string; readonly sessionID: string; readonly title?: string; readonly fields: readonly unknown[]; readonly metadata?: Record<string, unknown> } }
  "form.replied": { readonly sessionID: string; readonly id: string }
  "form.cancelled": { readonly sessionID: string; readonly id: string }
}

export type HarnessEvent = { [K in HarnessEventType]: { readonly type: K; readonly data: HarnessEventData[K] } }[HarnessEventType]

const plainID = (v: unknown): v is string => typeof v === "string" && ID.test(v)
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)
const strings = (v: unknown, max: number, length: number) => Array.isArray(v) && v.length <= max && v.every((s) => text(s, length))

type Check = (d: Record<string, unknown>) => string | undefined

const session: Check = (d) => (isHubSessionID(d.sessionID) ? undefined : "data.sessionID must be a hub session ID (ses_ + letters and digits)")
const turn: Check = (d) => session(d) ?? (optional(d.turnID, plainID) ? undefined : "data.turnID must be an ID")
const both = (...checks: Check[]): Check => (d) => {
  for (const check of checks) {
    const problem = check(d)
    if (problem) return problem
  }
  return undefined
}
const field = (name: string, check: (v: unknown) => boolean, what: string): Check => (d) => (check(d[name]) ? undefined : `data.${name} must be ${what}`)
const id = (name: string) => field(name, plainID, "an ID")
const STATUS_TYPES = new Set(["idle", "busy"])

const CHECKS: Record<HarnessEventType, Check> = {
  "session.created": both(
    session,
    field("parentID", (v) => optional(v, isHubSessionID), "a hub session ID"),
    field("title", (v) => optional(v, (t) => text(t, HARNESS_TITLE_MAX)), `at most ${HARNESS_TITLE_MAX} characters`),
  ),
  "session.renamed": both(session, field("title", (v) => nonEmpty(v) && v.length <= HARNESS_TITLE_MAX, `1–${HARNESS_TITLE_MAX} characters`)),
  "session.deleted": session,
  "session.execution.started": turn,
  "session.execution.succeeded": turn,
  "session.execution.failed": both(
    turn,
    field("error", (v) => optional(v, (e) => isObj(e) && text(e.message, HARNESS_ERROR_MAX)), `{message} of at most ${HARNESS_ERROR_MAX} characters`),
  ),
  "session.execution.interrupted": both(turn, field("inferred", (v) => v === undefined || v === true, "true when sent")),
  "session.status": both(
    session,
    field(
      "status",
      (s) =>
        isObj(s) &&
        (STATUS_TYPES.has(s.type as string) ||
          (s.type === "retry" && optional(s.attempt, num) && optional(s.message, (m) => text(m, HARNESS_RETRY_MAX)))),
      "{type: idle | busy} or {type: retry, attempt?, message?}",
    ),
  ),
  "session.text.ended": both(
    session,
    id("assistantMessageID"),
    field("ordinal", (v) => Number.isInteger(v) && (v as number) >= 0, "a whole number ≥ 0"),
    field("text", (v) => text(v, HARNESS_TEXT_MAX), `text of at most ${HARNESS_TEXT_MAX} characters`),
  ),
  "session.inbox.delivered": both(session, id("inboxID"), field("origin", (v) => v === undefined || v === "user" || v === "hub", "user or hub")),
  "session.tool.called": both(
    session,
    id("id"),
    field("assistantMessageID", (v) => optional(v, plainID), "an ID"),
    field("summary", (v) => optional(v, (s) => text(s, HARNESS_SUMMARY_MAX)), `at most ${HARNESS_SUMMARY_MAX} characters`),
    field("background", (v) => optional(v, (b) => typeof b === "boolean"), "true or false"),
  ),
  "session.tool.success": both(session, id("id")),
  "session.tool.failed": both(session, id("id"), field("error", (v) => optional(v, (e) => text(e, HARNESS_SUMMARY_MAX)), `at most ${HARNESS_SUMMARY_MAX} characters`)),
  "permission.asked": both(
    session,
    id("id"),
    field("action", (v) => nonEmpty(v) && v.length <= HARNESS_ACTION_MAX, `1–${HARNESS_ACTION_MAX} characters`),
    field("resources", (v) => strings(v, HARNESS_RESOURCES_MAX, HARNESS_RESOURCE_MAX), `a list of at most ${HARNESS_RESOURCES_MAX} texts`),
    field("save", (v) => optional(v, (s) => strings(s, HARNESS_RESOURCES_MAX, HARNESS_RESOURCE_MAX)), `a list of at most ${HARNESS_RESOURCES_MAX} texts`),
    field("source", (v) => optional(v, (s) => isObj(s) && s.type === "tool" && plainID(s.messageID) && plainID(s.id)), "{type: tool, messageID, id}"),
  ),
  "permission.replied": both(session, id("requestID"), field("reply", (v) => v === undefined || v === "once" || v === "always" || v === "reject", "once, always or reject")),
  "form.created": field(
    "form",
    (f) =>
      isObj(f) &&
      plainID(f.id) &&
      isHubSessionID(f.sessionID) &&
      optional(f.title, (t) => text(t, HARNESS_TITLE_MAX)) &&
      Array.isArray(f.fields) &&
      f.fields.length <= HARNESS_FORM_FIELDS_MAX &&
      f.fields.every(isObj) &&
      optional(f.metadata, isObj),
    `{id, sessionID, title?, fields (at most ${HARNESS_FORM_FIELDS_MAX} objects), metadata?}`,
  ),
  "form.replied": both(session, id("id")),
  "form.cancelled": both(session, id("id")),
}

/** Why `event` is not an event a non-OpenCode spoke may send, or undefined when it is. */
export function harnessEventProblem(event: unknown): string | undefined {
  if (!isObj(event)) return "event must be an object"
  if (typeof event.type !== "string" || !Object.hasOwn(CHECKS, event.type)) return `event type must be one of ${HARNESS_EVENTS.join(", ")}`
  if (!isObj(event.data)) return "event data must be an object"
  return CHECKS[event.type as HarnessEventType](event.data)
}

/** Whether `event` is an event a non-OpenCode spoke may send (see harnessEventProblem). */
export const isHarnessEvent = (event: unknown): event is HarnessEvent => harnessEventProblem(event) === undefined
