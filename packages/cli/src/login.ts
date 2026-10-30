// `hub login` without --token: the CLI login device code (src/central/http.ts, POST /cli/login and /cli/login/poll).
// The terminal asks with its name and the scopes it wants; a signed-in user approves it in the console as
// themselves, choosing the scopes (launch only when they tick it or the terminal asked for it); the next poll hands
// out an app token of that user, once.
//
// Policy (the machine enrollment's, packages/cli/src/bootstrap/enrollment/policy.ts):
// - The hub URL is https (plain http only for a loopback hub); redirects are refused, never followed.
// - The approval link shown is on the hub's own origin (approvalURL).
// - The wait is bounded by the hub's expiry and by maxWaitMs; `signal` cancels it.
// - The token is returned to the caller only, never printed. A poll that fails in transit is retried until the
//   deadline (a reply lost after the hub handed the token out cannot be fetched again: the user revokes that token).
import { approvalURL, checkServerURL, isUserCode } from "./bootstrap/enrollment/policy.ts"
import { UsageError } from "./args"
import { CliError, EXIT } from "./http"

/** The longest a login waits for approval, whatever the hub says (the hub's own expiry is 10 minutes). */
export const LOGIN_MAX_WAIT_MS = 15 * 60_000
const MIN_INTERVAL_MS = 500
const MAX_INTERVAL_MS = 30_000

/** What to show the user while waiting. Never a credential. */
export interface LoginPrompt {
  readonly userCode: string
  readonly approveURL: string
  readonly expiresAt: number
  /** The scopes the approval page offers ticked. */
  readonly scopes: readonly string[]
  readonly warning?: string
}

export interface DeviceLoginOptions {
  readonly server: string
  /** Names this terminal on the approval page (and in the token's label). */
  readonly clientName: string
  /** Asked for beyond the hub's defaults (sessions:read, messages:send, messages:read). */
  readonly scopes?: readonly string[]
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly now?: () => number
  /** The poll interval (default: the hub's, at least 500 ms). */
  readonly intervalMs?: number
  readonly maxWaitMs?: number
  readonly onPrompt?: (prompt: LoginPrompt) => void
}

export interface DeviceLogin {
  readonly token: string
  readonly tokenID: string
  readonly scopes: readonly string[]
}

const cancelled = () => new CliError(EXIT.needsUser, "login cancelled; nothing was stored", "Run `hub login` again")

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const stringList = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((s) => typeof s === "string") ? (value as string[]) : undefined)

/** POSTs JSON without following redirects; the parsed reply, or a CliError. */
async function post(fetcher: typeof fetch, server: string, pathname: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  let response: Response
  try {
    response = await fetcher(`${server}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual", ...(signal ? { signal } : {}) })
  } catch (cause) {
    if (signal?.aborted) throw cancelled()
    throw new CliError(EXIT.unavailable, `could not reach ${server}`, "Check the URL given to `hub login`")
  }
  if (response.status >= 300 && response.status < 400) throw new CliError(EXIT.other, `${server} redirected the login request; login does not follow redirects`, "Use the hub's final https URL")
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  return { status: response.status, body: parsed }
}

const hubMessage = (body: unknown): string | undefined => (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message.slice(0, 200) : undefined)

/** Runs the device-code login: the approved app token, or a CliError (nothing to store). */
export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLogin> {
  const server = checkServerURL(options.server)
  if (!server) throw new UsageError(`the hub URL must be https (plain http only for a loopback hub), without user info, query or fragment: ${String(options.server).slice(0, 200)}`)
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const { signal } = options
  if (signal?.aborted) throw cancelled()

  const started = await post(fetcher, server, "/cli/login", { clientName: options.clientName, ...(options.scopes?.length ? { scopes: options.scopes } : {}) }, signal)
  if (started.status === 404) throw new CliError(EXIT.unavailable, `${server} has no CLI login (an older hub)`, "Create an app token in the console (Settings → Agents) and run `hub login --token <token>`")
  if (started.status !== 200) throw new CliError(started.status === 429 ? EXIT.rateLimited : started.status === 400 ? EXIT.usage : EXIT.other, `${server} refused the login: ${hubMessage(started.body) ?? `HTTP ${started.status}`}`)
  const start = started.body
  if (!isRecord(start) || !isUserCode(start.userCode) || typeof start.deviceCode !== "string" || !start.deviceCode || !Number.isFinite(start.expiresAt) || !Number.isFinite(start.intervalMs)) {
    throw new CliError(EXIT.other, `${server} sent an invalid login reply`)
  }
  const link = approvalURL(server, start.approveURL, start.userCode)
  const expiresAt = Math.min(start.expiresAt as number, now() + (options.maxWaitMs ?? LOGIN_MAX_WAIT_MS))
  options.onPrompt?.({ userCode: start.userCode, approveURL: link.url, expiresAt, scopes: stringList(start.scopes) ?? [], ...(link.warning ? { warning: link.warning } : {}) })

  const interval = options.intervalMs ?? Math.min(Math.max(start.intervalMs as number, MIN_INTERVAL_MS), MAX_INTERVAL_MS)
  for (;;) {
    if (signal?.aborted) throw cancelled()
    if (now() > expiresAt) break
    let poll: { status: number; body: unknown } | undefined
    try {
      poll = await post(fetcher, server, "/cli/login/poll", { deviceCode: start.deviceCode }, signal)
    } catch (cause) {
      if (signal?.aborted) throw cancelled()
      if (!(cause instanceof CliError) || cause.exit !== EXIT.unavailable) throw cause
      poll = undefined // in transit: try again
    }
    if (poll?.status === 429) throw new CliError(EXIT.rateLimited, `the login was approved, but ${hubMessage(poll.body) ?? "the hub could not issue a token"}`, "Revoke unused app tokens in the console (Settings → Agents) and run `hub login` again")
    const status = poll && isRecord(poll.body) ? poll.body.status : undefined
    if (status === "approved") {
      const body = poll!.body as Record<string, unknown>
      const scopes = stringList(body.scopes)
      if (typeof body.token !== "string" || !body.token || typeof body.tokenID !== "string" || !scopes) throw new CliError(EXIT.other, `${server} sent an invalid login reply`)
      return { token: body.token, tokenID: body.tokenID, scopes }
    }
    if (status === "denied") throw new CliError(EXIT.forbidden, "the login was denied on the hub; nothing was stored")
    if (status === "expired") break
    await sleep(interval, signal)
  }
  if (signal?.aborted) throw cancelled()
  throw new CliError(EXIT.needsUser, "the login code expired before it was approved; nothing was stored", "Run `hub login` again and approve the code in the console")
}

/** The lines printed while waiting (stderr). */
export function promptText(prompt: LoginPrompt): string {
  const minutes = Math.max(1, Math.round((prompt.expiresAt - Date.now()) / 60_000))
  return [
    ...(prompt.warning ? [`hub: warning: ${prompt.warning}`] : []),
    `To log in, open ${prompt.approveURL}`,
    `and approve code ${prompt.userCode} as yourself (expires in ${minutes} min; Ctrl-C cancels).`,
    ...(prompt.scopes.length ? [`Requested scopes: ${prompt.scopes.join(", ")} (you choose on the page).`] : []),
    "Waiting for approval…",
  ].join("\n")
}

/** What the new login may not do yet, and how to get it (stdout, after the login). */
export function scopeNotes(scopes: readonly string[], tokenID: string): string[] {
  if (!scopes.includes("sessions:launch")) return ["note: this login cannot launch sessions; to launch from this terminal run `hub login --scope sessions:launch` (or tick \"Launch sessions\" on the approval page)"]
  return [
    `note: launching also needs a grant with verb launch for this token (holder app:${tokenID}) covering the repository:`,
    scopes.includes("messages:send")
      ? `  create it in the console, or ask for it: hub grant request --project <repo path> --allow launch --why "launch from my terminal"`
      : "  create it in the console (Settings → Agents)",
  ]
}
