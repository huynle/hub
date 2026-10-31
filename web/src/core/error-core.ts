// Wording of session errors and model retries (e.g. a provider's "Quota exceeded"): labels for OpenCode's error
// types, "HTTP 429", countdowns to the next retry, and the error of a session tree from the hub's status entries
// (state "error" with the message in `detail`). Pure; every provider text stays plain text.

/** Short label of an OpenCode error type; undefined when unknown (the caller shows the message instead). */
export function errorLabel(type: unknown): string | undefined {
  if (typeof type !== "string" || !type) return undefined
  if (type.includes("budget")) return "Quota exceeded"
  return LABELS[type]
}

const LABELS: Record<string, string> = {
  "provider.quota": "Quota exceeded",
  "provider.free-limit": "Quota exceeded",
  "provider.auth": "Authentication failed",
  "provider.rate-limit": "Rate limited",
  "provider.internal": "Provider unavailable",
  "provider.transport": "Provider unavailable",
  "provider.timeout": "Provider unavailable",
  "provider.content-filter": "Blocked by content filter",
  "provider.no-route": "No route to model",
  "provider.invalid-request": "Invalid request",
  "provider.invalid-output": "Invalid model output",
  "provider.unsupported-operation": "Unsupported operation",
  "tool.execution": "Tool failed",
  "permission.rejected": "Permission rejected",
}

/** "HTTP 429" for an HTTP status code. */
export function httpStatus(status: unknown): string | undefined {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 999 ? `HTTP ${status}` : undefined
}

/** Time left until `next` (epoch ms): "4m 10s", "5s", "2h 1m"; undefined when missing or past. */
export function countdown(next: unknown, now: number): string | undefined {
  if (typeof next !== "number" || !Number.isFinite(next) || next <= now) return undefined
  const s = Math.ceil((next - now) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The message when it says more than the label. */
const extra = (label: string | undefined, message: string | undefined) => (label && message && !same(label, message) ? message : undefined)

export interface ErrorInfo {
  readonly errorType?: unknown
  readonly errorStatus?: unknown
  readonly message?: unknown
}

/** "Quota exceeded (HTTP 429): You exceeded your current quota", "Boom (HTTP 500)", "Error". */
export function errorLine(e: ErrorInfo): string {
  const label = errorLabel(e.errorType)
  const message = str(e.message)
  const status = httpStatus(e.errorStatus)
  const more = extra(label, message)
  return `${label ?? message ?? "Error"}${status ? ` (${status})` : ""}${more ? `: ${more}` : ""}`
}

export interface RetryInfo extends ErrorInfo {
  readonly attempt?: unknown
  /** Epoch ms of the next attempt. */
  readonly next?: unknown
}

/** "Retrying (attempt 3) · next in 4m 10s: Quota exceeded — <message>"; old data: "Retrying (attempt 2): Rate limited". */
export function retryLine(r: RetryInfo, now: number): string {
  const attempt = typeof r.attempt === "number" ? ` (attempt ${r.attempt})` : ""
  const left = countdown(r.next, now)
  const label = errorLabel(r.errorType)
  const message = str(r.message)
  const more = extra(label, message)
  const reason = label ? (more ? `${label} — ${more}` : label) : message
  return `Retrying${attempt}${left ? ` · next in ${left}` : ""}${reason ? `: ${reason}` : ""}`
}

export interface TreeError {
  /** The session in state "error" (the session itself or one of its subagents). */
  readonly sessionID: string
  /** Its title, for a subagent's error. */
  readonly title?: string
  /** "Quota exceeded", else the message, else "Error". */
  readonly label: string
  /** The error message (`detail`). */
  readonly message?: string
  /** "HTTP 429". */
  readonly status?: string
  /** One line: label, status and message. */
  readonly text: string
}

interface Entry {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly state?: string
  readonly detail?: unknown
  readonly errorType?: unknown
  readonly errorStatus?: unknown
}

const isEntry = (value: unknown): value is Entry => !!value && typeof value === "object" && typeof (value as Entry).id === "string"

/**
 * The error of a session (`sessionID`, else the root: the first entry) from its status tree: its own error, else
 * a subagent's while the session itself does not run. Nothing once a new run starts (the state leaves "error").
 */
export function treeError(status: unknown, sessionID?: string): TreeError | undefined {
  const list = Array.isArray(status) ? status.filter(isEntry) : []
  const own = sessionID ? list.find((s) => s.id === sessionID) : list[0]
  if (!own) return undefined
  if (own.state === "error") return describe(own)
  if (own.state === "working" || own.state === "blocked") return undefined
  const below = new Set([own.id])
  // Status trees list parents before children; repeat until no new descendant is found.
  for (let grew = true; grew; ) {
    grew = false
    for (const s of list) if (s.parentID && below.has(s.parentID) && !below.has(s.id)) (below.add(s.id), (grew = true))
  }
  const failed = list.find((s) => s.id !== own.id && below.has(s.id) && s.state === "error")
  return failed ? describe(failed) : undefined
}

function describe(s: Entry): TreeError {
  const message = str(s.detail)
  const status = httpStatus(s.errorStatus)
  const title = str(s.title)
  return {
    sessionID: s.id,
    ...(title ? { title } : {}),
    label: errorLabel(s.errorType) ?? message ?? "Error",
    ...(message ? { message } : {}),
    ...(status ? { status } : {}),
    text: errorLine({ errorType: s.errorType, errorStatus: s.errorStatus, message }),
  }
}
