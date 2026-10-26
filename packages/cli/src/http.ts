// The CLI's side of talking to the hub: a HubClient (packages/sdk) for the resolved credentials, and the SDK's
// errors turned into CliErrors with the exit code of each error code (design §8, plus usage and unauthorized) and
// a hint for credential errors.
import { HubClient, HubError, HubTransportError, type Envelope } from "../../sdk/src/index.ts"
import type { Credentials } from "./credentials"

export type { Envelope } from "../../sdk/src/index.ts"

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

/** The hub's hint, plus what to do about a credential error from here. */
function hintFor(envelope: Envelope, credentials: Credentials): string | undefined {
  const own =
    credentials.source === "http"
      ? undefined // a POST /mcp caller has no CLI login or shell to fix
      : envelope.code === "token_expired"
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

/** An SDK error as the CLI reports it; anything else is returned unchanged. */
export function cliError(error: unknown, credentials: Credentials): unknown {
  if (error instanceof HubError) return new CliError(exitOf(error.code), error.message, hintFor(error.envelope, credentials), error.envelope)
  if (error instanceof HubTransportError) return new CliError(EXIT.other, error.message, error.kind === "unreachable" ? "Check HUB_URL or the URL given to `hub login`" : undefined)
  return error
}

export const clientFor = (credentials: Credentials): HubClient =>
  new HubClient({ url: credentials.url, token: credentials.token, ...(credentials.fetch ? { fetch: credentials.fetch } : {}) })

/** Runs `use` with a client for `credentials`; SDK errors become CliErrors. */
export async function withHub<T>(credentials: Credentials, use: (hub: HubClient) => Promise<T>): Promise<T> {
  try {
    return await use(clientFor(credentials))
  } catch (error) {
    throw cliError(error, credentials)
  }
}
