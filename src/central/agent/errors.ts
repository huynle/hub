// The /api/agent error envelope (design §8, §14.5): {error: {code, message, hint?, ...extra}}. Only /api/agent/*
// answers this way; the console routes keep their {error: string, code?} envelope (the web app reads it).

/** HTTP status of each agent error code. */
export const AGENT_ERROR_STATUS = {
  /** Malformed request (bad JSON, bad fields, cookie and bearer together). */
  invalid: 400,
  /** No credential, or an unknown, revoked or disabled one. */
  unauthorized: 401,
  /** A session or app token that expired: get a new one. */
  token_expired: 401,
  /** Outside the grant; a recommendation was recorded for the user. */
  needs_user: 403,
  /** No grant or scope, or a credential not admitted on this route. */
  forbidden: 403,
  /** No such thing, or another user's (they answer alike). */
  not_found: 404,
  /** The address matches several sessions (`candidates`). */
  ambiguous: 409,
  /** Explicit name or exclusive role already held. */
  name_taken: 409,
  /** Already answered, expired or ended. */
  gone: 410,
  /** The spoke or node lacks the feature or runtime (`feature`, `harness`). */
  unsupported: 422,
  /** A kill switch is on. */
  paused: 423,
  /** A pair, recipient, user or launch cap (`retryAfter`, seconds). */
  rate_limited: 429,
  /** An unexpected failure (details are logged, not sent). */
  internal: 500,
  /** The machine is offline (actions only; messages queue instead). */
  offline: 503,
} as const satisfies Record<string, number>

export type AgentErrorCode = keyof typeof AGENT_ERROR_STATUS

export interface AgentErrorOptions {
  readonly hint?: string
  /** More fields in the envelope, e.g. candidates, retryAfter, feature; never code or message. */
  readonly extra?: Record<string, unknown>
}

/** Throw from an agent handler; answered as the envelope with the code's status. */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly options: AgentErrorOptions = {},
  ) {
    super(message)
  }
}

export function agentError(error: AgentError): Response {
  const { hint, extra = {} } = error.options
  const headers: Record<string, string> = { "cache-control": "no-store" }
  const retryAfter = extra.retryAfter
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) headers["retry-after"] = String(Math.ceil(retryAfter))
  return Response.json(
    { error: { ...extra, code: error.code, message: error.message, ...(hint ? { hint } : {}) } },
    { status: AGENT_ERROR_STATUS[error.code], headers },
  )
}

/** The envelope for anything an agent handler threw. */
export function agentFailure(cause: unknown): Response {
  if (cause instanceof AgentError) return agentError(cause)
  if (cause instanceof SyntaxError) return agentError(new AgentError("invalid", "Invalid JSON"))
  console.error("[hub] agent request failed:", cause)
  return agentError(new AgentError("internal", "Internal error"))
}
