// Decision cards (design §12.1; P2-T10b): what a session or app asked the user (`hub ask @me`), shown on Home and
// in the sessions it concerns. Pure state and labels: the open list (GET /api/decisions?state=open, then SSE
// 'decision' events: open ones replace, closed ones leave), which cards a session shows, the deadline countdown,
// the asker, the tier note, and the answer the console posts (POST /api/decisions/:id/answer {option?, text?}).
import { partyAddress } from "./timeline-core"

export interface DecisionOptionView {
  readonly id: string
  readonly label: string
  /** A timeout may pick only a safe option. */
  readonly safe?: true
}

export type DecisionParty =
  | { readonly kind: "session"; readonly sessionID: string; readonly name?: string }
  | { readonly kind: "user" }
  | { readonly kind: "app"; readonly tokenID: string; readonly label?: string }

/** The hub's Decision (src/central/agent/decisions.ts Decision), as the console uses it. */
export interface DecisionView {
  readonly id: string
  readonly messageID: string
  readonly from: DecisionParty
  readonly about: readonly string[]
  readonly sessionID?: string
  readonly question: string
  readonly options: readonly DecisionOptionView[]
  readonly recommendation?: { readonly option: string; readonly why?: string }
  readonly urgency: "low" | "normal" | "high"
  readonly tier: "confirm" | "tap"
  readonly deadline?: number
  readonly onTimeout?: string
  readonly state: "open" | "answered" | "expired"
  readonly at: number
  readonly expiresAt: number
  readonly escalatedAt?: number
  readonly answer?: { readonly option?: string; readonly text?: string; readonly answeredBy: "user" | "timeout"; readonly at: number }
}

const STATES = new Set(["open", "answered", "expired"])
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** A Decision from the hub (list or SSE event); undefined when it is not one. Malformed options are dropped. */
export function parseDecision(raw: unknown): DecisionView | undefined {
  if (!isObject(raw)) return undefined
  const { id, question, options, state, about, at, from } = raw
  if (typeof id !== "string" || !id.startsWith("dec_") || typeof question !== "string") return undefined
  if (!Array.isArray(options) || !Array.isArray(about) || typeof state !== "string" || !STATES.has(state) || typeof at !== "number" || !isObject(from)) return undefined
  const clean = options.filter((o): o is DecisionOptionView => isObject(o) && typeof o.id === "string" && typeof o.label === "string")
  return { ...(raw as unknown as DecisionView), options: clean, about: about.filter((s): s is string => typeof s === "string") }
}

const newestFirst = (a: DecisionView, b: DecisionView) => b.at - a.at || (a.id < b.id ? 1 : -1)

/** The open ones, newest first. */
export function openDecisions(list: readonly DecisionView[]): DecisionView[] {
  return list.filter((d) => d.state === "open").sort(newestFirst)
}

/** The open list after a 'decision' event: an open Decision is added or replaced, a closed one leaves. */
export function applyDecision(list: readonly DecisionView[], decision: DecisionView): DecisionView[] {
  return openDecisions([...list.filter((d) => d.id !== decision.id), decision])
}

/** The cards a session shows: the Decisions it asked and those about it. */
export function decisionsFor(list: readonly DecisionView[], sessionID: string): DecisionView[] {
  return list.filter((d) => (d.from.kind === "session" && d.from.sessionID === sessionID) || d.about.includes(sessionID))
}

/** Who asked: `@name`, the session ID, or `app <label>`. */
export const askerLabel = (d: DecisionView): string => partyAddress(d.from)

/** Tap Decisions are answered only from a signed-in console (not a device token): say so on the card. */
export const tierNote = (d: DecisionView): string => (d.tier === "tap" ? "Answer here (tap): only a signed-in console can answer this one." : "")

/** Time left until `at`, in its two largest units ("2h 5m", "4m 10s", "12s"); "" once past. */
export function countdown(at: number, now: number): string {
  const left = at - now
  if (left < 0) return ""
  const s = Math.floor(left / 1000)
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** The deadline line: the countdown and the safe option a timeout takes; "" without a deadline. */
export function deadlineText(d: DecisionView, now: number): string {
  if (d.deadline === undefined) return ""
  const left = countdown(d.deadline, now)
  if (!left) return "Past its deadline"
  const then = d.onTimeout ? d.options.find((o) => o.id === d.onTimeout)?.label : undefined
  return `Deadline in ${left}${then ? ` · then ${then}` : ""}`
}

export type AnswerResult = { readonly ok: true; readonly body: { option?: string; text?: string } } | { readonly ok: false; readonly problem: string }

/** The answer to post: an option (and an optional note) when the Decision has options, else the text. */
export function answerBody(d: DecisionView, option: string | undefined, text: string): AnswerResult {
  const note = text.trim()
  if (!d.options.length) return note ? { ok: true, body: { text: note } } : { ok: false, problem: "Type an answer" }
  if (option === undefined || !d.options.some((o) => o.id === option)) return { ok: false, problem: "Pick one of the options" }
  return { ok: true, body: { option, ...(note ? { text: note } : {}) } }
}
