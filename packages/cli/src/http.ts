// Talking to the hub's /api/agent: bearer requests, the {error: {code, message, hint?, ...}} envelope and the
// exit code of each error code (design §8, plus usage and unauthorized).
import type { Credentials } from "./credentials"

export const EXIT = {
  ok: 0,
  other: 1,
  usage: 2,
  notFound: 3,
  needsUser: 4,
  forbidden: 5,
  rateLimited: 6,
  unavailable: 7,
  gone: 8,
  unauthorized: 9,
} as const

const EXIT_OF: Record<string, number> = {
  invalid: EXIT.usage,
  not_found: EXIT.notFound,
  ambiguous: EXIT.notFound,
  name_taken: EXIT.notFound,
  needs_user: EXIT.needsUser,
  forbidden: EXIT.forbidden,
  paused: EXIT.forbidden,
  rate_limited: EXIT.rateLimited,
  unsupported: EXIT.unavailable,
  offline: EXIT.unavailable,
  gone: EXIT.gone,
  unauthorized: EXIT.unauthorized,
  token_expired: EXIT.unauthorized,
}

export interface Envelope {
  readonly code: string
  readonly message: string
  readonly hint?: string
  readonly [extra: string]: unknown
}

/** A failure to report: message (and hint) on stderr, the envelope on stdout with --json, then exit. */
export class CliError extends Error {
  constructor(
    readonly exit: number,
    message: string,
    readonly hint?: string,
    readonly envelope?: Envelope,
  ) {
    super(message)
  }
}

export const exitOf = (code: string): number => EXIT_OF[code] ?? EXIT.other

const isEnvelope = (value: unknown): value is { error: Envelope } => {
  const error = (value as { error?: unknown } | null)?.error as Envelope | undefined
  return typeof error === "object" && error !== null && typeof error.code === "string" && typeof error.message === "string"
}

/** The hub's hint, plus what to do about a credential error from here. */
function hintFor(envelope: Envelope, credentials: Credentials): string | undefined {
  const own =
    envelope.code === "token_expired"
      ? credentials.source === "env"
        ? "session tokens are renewed for new shells: start a new shell"
        : "run `hub login` with a new app token"
      : envelope.code === "unauthorized"
        ? credentials.source === "env"
          ? "HUB_SESSION_TOKEN is not valid here (is the session still live?)"
          : "run `hub login` again"
        : undefined
  return [envelope.hint, own].filter(Boolean).join("; ") || undefined
}

const fromEnvelope = (envelope: Envelope, credentials: Credentials) => new CliError(exitOf(envelope.code), envelope.message, hintFor(envelope, credentials), envelope)

export interface RequestOptions {
  readonly method?: string
  readonly body?: unknown
  readonly signal?: AbortSignal
}

/** Sends a request; resolves the response when OK, else throws a CliError. Never puts the token in a message. */
export async function send(credentials: Credentials, pathname: string, options: RequestOptions = {}): Promise<Response> {
  const url = `${credentials.url.replace(/\/+$/, "")}${pathname}`
  const headers: Record<string, string> = { authorization: `Bearer ${credentials.token}`, accept: "application/json" }
  if (options.body !== undefined) headers["content-type"] = "application/json"
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      redirect: "manual",
    })
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    throw new CliError(EXIT.other, `cannot reach ${credentials.url} (${cause instanceof Error ? cause.message : String(cause)})`, "Check HUB_URL or the URL given to `hub login`")
  }
  if (response.ok) return response
  const text = await response.text().catch(() => "")
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (isEnvelope(body)) throw fromEnvelope(body.error, credentials)
  throw new CliError(EXIT.other, `HTTP ${response.status} from ${credentials.url}${pathname}`)
}

/** GET/POST answering JSON. */
export async function call<T = unknown>(credentials: Credentials, pathname: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(credentials, pathname, options)
  if (response.status === 204) return undefined as T
  try {
    return (await response.json()) as T
  } catch {
    throw new CliError(EXIT.other, `the hub at ${credentials.url} did not answer JSON for ${pathname}`)
  }
}
