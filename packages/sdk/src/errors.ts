// The hub's error envelope (design §8): every /api/agent failure answers {error: {code, message, hint?, ...extra}}.
// The SDK turns it into a HubError; failures without an envelope (hub unreachable, a proxy's HTML, a body that is not
// JSON, a broken stream) are HubTransportErrors. Neither ever carries the token.

/** The codes the hub answers with (src/central/agent/errors.ts); later phases may add more, so any string is kept. */
export type ErrorCode =
  | "invalid"
  | "unauthorized"
  | "token_expired"
  | "needs_user"
  | "forbidden"
  | "not_found"
  | "ambiguous"
  | "name_taken"
  | "gone"
  | "unsupported"
  | "paused"
  | "rate_limited"
  | "internal"
  | "offline"
  | (string & {})

export interface Envelope {
  readonly code: ErrorCode
  readonly message: string
  readonly hint?: string
  /** More fields, by code: candidates (ambiguous), retryAfter (rate_limited, seconds), feature/harness (unsupported). */
  readonly [extra: string]: unknown
}

/** A failure the hub reported in its envelope. */
export class HubError extends Error {
  override readonly name = "HubError"
  readonly code: ErrorCode
  readonly hint?: string

  constructor(
    /** HTTP status of the answer. */
    readonly status: number,
    readonly envelope: Envelope,
  ) {
    super(envelope.message)
    this.code = envelope.code
    if (typeof envelope.hint === "string") this.hint = envelope.hint
  }

  /** Seconds to wait before retrying (rate_limited), when the hub said. */
  get retryAfter(): number | undefined {
    const value = this.envelope.retryAfter
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }
}

/**
 * A failure without the hub's envelope: `unreachable` (no answer), `http` (a non-OK answer without the envelope, or
 * a redirect), `bad_response` (an OK answer that is not what was expected), `stream` (a watch stream that broke).
 */
export type TransportKind = "unreachable" | "http" | "bad_response" | "stream"

export class HubTransportError extends Error {
  override readonly name = "HubTransportError"
  /** HTTP status, for `http`. */
  readonly status?: number

  constructor(
    readonly kind: TransportKind,
    message: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    if (options.status !== undefined) this.status = options.status
  }
}

/** True for a HubError (with one of `codes`, when given). */
export const isHubError = (error: unknown, ...codes: ErrorCode[]): error is HubError =>
  error instanceof HubError && (codes.length === 0 || codes.includes(error.code))

/** The envelope inside a parsed body, if it is one (also the console routes' {error: message, code, hint?}). */
export function envelopeOf(body: unknown): Envelope | undefined {
  const raw = body as { error?: unknown; code?: unknown; hint?: unknown } | null
  const error = raw?.error as Envelope | undefined
  if (typeof error === "object" && error !== null && typeof error.code === "string" && typeof error.message === "string") return error
  if (typeof raw?.error === "string" && typeof raw.code === "string") return { code: raw.code, message: raw.error, ...(typeof raw.hint === "string" ? { hint: raw.hint } : {}) }
  return undefined
}
