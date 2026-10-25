// A stub model server on loopback speaking OpenAI chat completions (<url>/v1/chat/completions), Anthropic Messages
// (<url>/v1/messages, count_tokens) and OpenAI Responses (<url>/v1/responses), streaming or not. It records every
// model request and answers with scripted replies: queued ones first, then the respond script, then default text.
import { anthropic, chat, isStubError, responses, type Format, type Inspected, type ModelFormat, type StubReply } from "./model-formats.ts"
import { stopServer } from "./fake-hub.ts"

export type { ModelFormat, StubError, StubReply, StubToolCall, StubTurn } from "./model-formats.ts"

export interface ModelRequest extends Inspected {
  readonly format: ModelFormat
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: any
  readonly stream: boolean
}

export interface StubModelOptions {
  /** Answers a request (after the queue); undefined falls back to the default text. */
  respond?: (req: ModelRequest) => StubReply | undefined | Promise<StubReply | undefined>
  /** The default reply's text ("ack"). */
  defaultText?: string
  port?: number
}

export interface StubModel {
  /** http://127.0.0.1:<port> (ANTHROPIC_BASE_URL). */
  url: string
  /** <url>/v1 (an OpenAI-compatible baseURL, for chat completions and Responses). */
  openaiBaseURL: string
  /** Same as url: Anthropic clients append /v1/messages. */
  anthropicBaseURL: string
  requests: ModelRequest[]
  /** Replies for the next requests, in order. */
  queue(...replies: StubReply[]): void
  next(predicate?: (req: ModelRequest) => boolean, timeoutMs?: number): Promise<ModelRequest>
  stop(): Promise<void>
}

const FORMATS: Record<ModelFormat, Format> = { chat, anthropic, responses }

function formatFor(method: string, path: string): ModelFormat | undefined {
  if (method !== "POST") return undefined
  if (path.endsWith("/chat/completions")) return "chat"
  if (path.endsWith("/messages")) return "anthropic"
  if (path.endsWith("/responses")) return "responses"
  return undefined
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => (out[key] = value))
  return out
}

export function stubModel(options: StubModelOptions = {}): StubModel {
  const queued: StubReply[] = []
  const waiters = new Set<() => void>()
  let n = 0
  const stub: StubModel = {
    url: "",
    openaiBaseURL: "",
    anthropicBaseURL: "",
    requests: [],
    queue: (...replies) => void queued.push(...replies),
    async next(predicate = () => true, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = stub.requests.find(predicate)
        if (found) return found
        const left = deadline - Date.now()
        if (left <= 0) throw new Error("timed out waiting for model request")
        await new Promise<void>((resolve) => {
          waiters.add(resolve)
          setTimeout(resolve, left)
        })
      }
    },
    stop: async () => {},
  }
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === "GET" && path.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "stub", object: "model", created: 0, owned_by: "stub" }] })
      if (req.method === "POST" && path.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: 10 })
      const format = formatFor(req.method, path)
      if (!format) return Response.json({ error: "stub: not found" }, { status: 404 })
      const text = await req.text()
      let body: any = {}
      try {
        body = text ? JSON.parse(text) : {}
      } catch {}
      const codec = FORMATS[format]
      const record: ModelRequest = { format, method: req.method, path, headers: headerRecord(req.headers), body, stream: body?.stream === true, ...codec.inspect(body) }
      stub.requests.push(record)
      for (const wake of [...waiters]) wake()
      waiters.clear()
      const reply = queued.shift() ?? (await options.respond?.(record)) ?? { text: options.defaultText ?? "ack" }
      const id = ++n
      if (isStubError(reply)) {
        if (reply.delayMs) await Bun.sleep(reply.delayMs)
        return Response.json(reply.body ?? { error: "stub error" }, { status: reply.status })
      }
      if (!record.stream) {
        if (reply.delayMs) await Bun.sleep(reply.delayMs)
        return Response.json(codec.json(body, reply, id))
      }
      const { head, tail } = codec.stream(body, reply, id)
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(encoder.encode(head.join("")))
            if (reply.delayMs) await Bun.sleep(reply.delayMs)
            controller.enqueue(encoder.encode(tail.join("")))
            controller.close()
          } catch {
            // The client went away mid-stream (an interrupt test); nothing to do.
          }
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
  stub.url = `http://127.0.0.1:${server.port}`
  stub.openaiBaseURL = `${stub.url}/v1`
  stub.anthropicBaseURL = stub.url
  stub.stop = () => stopServer(server)
  return stub
}
