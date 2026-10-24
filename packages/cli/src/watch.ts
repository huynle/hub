// `hub watch`: GET /api/agent/watch (SSE) printed as JSON lines, one per event, until interrupted. Named `ping`
// events (heartbeats) are skipped.
import type { Credentials } from "./credentials"
import { CliError, EXIT, send } from "./http"

/** Parses SSE text incrementally: feed chunks, get complete events. */
export class SseParser {
  #buffer = ""

  push(chunk: string): { event: string; data: string }[] {
    this.#buffer += chunk.replace(/\r\n?/g, "\n")
    const out: { event: string; data: string }[] = []
    let end: number
    while ((end = this.#buffer.indexOf("\n\n")) >= 0) {
      const block = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 2)
      let event = "message"
      const data: string[] = []
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
        if (field === "event") event = value
        else if (field === "data") data.push(value)
      }
      if (data.length) out.push({ event, data: data.join("\n") })
    }
    return out
  }
}

/** One compact JSON line per event (non-JSON data is printed as is). */
const line = (data: string) => {
  try {
    return JSON.stringify(JSON.parse(data))
  } catch {
    return data
  }
}

export async function watch(credentials: Credentials, pathname: string, write: (line: string) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  let response: Response
  try {
    response = await send(credentials, pathname, signal ? { signal } : {})
  } catch (cause) {
    if (signal?.aborted) return
    throw cause
  }
  if (!response.body) throw new CliError(EXIT.other, "the hub sent no watch stream")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const event of parser.push(decoder.decode(value, { stream: true }))) if (event.event !== "ping") write(`${line(event.data)}\n`)
    }
  } catch (cause) {
    if (signal?.aborted) return
    throw new CliError(EXIT.other, `the watch stream failed (${cause instanceof Error ? cause.message : String(cause)})`, "Run `hub watch` again")
  }
  if (signal?.aborted) return
  throw new CliError(EXIT.other, "the watch stream ended (the hub closed it)", "Run `hub watch` again")
}
