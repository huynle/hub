// Check "reconnect" (judgment; the runner sends the bye and closes the socket). A draining hub's bye carries
// retryAfterMs: the spoke reconnects after a jittered delay of at most that (not its long backoff), hellos again and
// re-reports its sessions. The window allows a grace for process and network latency.
export interface ReconnectOutcome {
  readonly retryAfterMs: number
  readonly graceMs: number
  /** When the new hello arrived, in ms after the bye (undefined: none). */
  readonly helloAfterMs: number | undefined
  /** Whether the new connection reported the sessions again. */
  readonly resentSessions: boolean
}

export function reconnectProblems(o: ReconnectOutcome): string[] {
  const window = o.retryAfterMs + o.graceMs
  if (o.helloAfterMs === undefined) return [`did not reconnect within ${window} ms after bye {retryAfterMs: ${o.retryAfterMs}}`]
  const problems: string[] = []
  if (o.helloAfterMs > window) problems.push(`reconnected ${o.helloAfterMs} ms after bye {retryAfterMs: ${o.retryAfterMs}}; the window is ${window} ms`)
  if (!o.resentSessions) problems.push("did not report its sessions again after reconnecting")
  return problems
}
