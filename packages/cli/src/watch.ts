// `hub watch`: GET /api/agent/watch (SSE, through the SDK) printed as JSON lines, one per event, until interrupted.
// Heartbeats are skipped (the SDK does). The hub closing the stream or the stream breaking is an error.
import { HubTransportError } from "../../sdk/src/index.ts"
import type { Credentials } from "./credentials"
import { CliError, cliError, clientFor, EXIT } from "./http"

/** One compact JSON line per event (non-JSON data is printed as is). */
const line = (data: string) => {
  try {
    return JSON.stringify(JSON.parse(data))
  } catch {
    return data
  }
}

const AGAIN = "Run `hub watch` again"

export async function watch(credentials: Credentials, options: { blocked?: boolean; session?: string }, write: (line: string) => void, signal?: AbortSignal): Promise<void> {
  try {
    for await (const event of clientFor(credentials).watch({ ...options, ...(signal ? { signal } : {}) })) write(`${line(event.data)}\n`)
  } catch (cause) {
    if (signal?.aborted) return
    if (cause instanceof HubTransportError && cause.kind === "stream") throw new CliError(EXIT.other, cause.message, AGAIN)
    throw cliError(cause, credentials)
  }
  if (signal?.aborted) return
  throw new CliError(EXIT.other, "the watch stream ended (the hub closed it)", AGAIN)
}
