// Server-sent events: encoding for the stub model servers and a parser for tests reading their streams.

export interface SSEEvent {
  readonly event: string | undefined
  readonly data: string
}

/** One SSE frame; `event` names it (Anthropic and Responses streams), else it is a bare `data:` frame. */
export function sseFrame(data: unknown, event?: string): string {
  const text = typeof data === "string" ? data : JSON.stringify(data)
  return `${event ? `event: ${event}\n` : ""}${text
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`
}

/** Parses a complete SSE body into its events (comments and frames without data are skipped). */
export function parseSSE(body: string): SSEEvent[] {
  const events: SSEEvent[] = []
  for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") })
  }
  return events
}
