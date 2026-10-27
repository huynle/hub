// GET /api/agent/watch through the SDK: the SSE parser, and watch() as an async iterator of events (heartbeats
// skipped) that ends quietly on abort and reports a broken stream.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HubClient, HubTransportError, isHubError, SseParser, type WatchEvent } from "../src/index.ts"
import { fakeHub } from "./fake-hub.ts"

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const client = () => new HubClient({ url: hub.url, token: "tok" })
const sse = (body: ReadableStream<Uint8Array> | string) => new Response(body, { headers: { "content-type": "text/event-stream" } })

/** A stream the test writes to and closes or breaks. */
function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
  const encoder = new TextEncoder()
  return {
    stream,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error: Error) => controller.error(error),
  }
}

async function collect(events: AsyncIterable<WatchEvent>): Promise<WatchEvent[]> {
  const out: WatchEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe("SseParser", () => {
  test("parses events split across chunks, CRLF, comments and multi-line data; default event is message", () => {
    const parser = new SseParser()
    expect(parser.push(": hello\r\nevent: session.state\r\ndata: {\"a\"")).toEqual([])
    expect(parser.push(":1}\r\n\r\ndata: one\ndata: two\n\n")).toEqual([
      { event: "session.state", data: '{"a":1}' },
      { event: "message", data: "one\ntwo" },
    ])
  })

  test("events without data are skipped; a field without a colon is a field with an empty value", () => {
    const parser = new SseParser()
    expect(parser.push("event: ping\n\ndata\n\n")).toEqual([{ event: "message", data: "" }])
  })
})

describe("SseParser ids", () => {
  test("each event carries the latest id seen (a heartbeat's too), as a resumable cursor", () => {
    const parser = new SseParser()
    expect(parser.push("id: c1\ndata: a\n\ndata: b\n\nevent: ping\nid: c2\ndata: 0\n\ndata: c\n\n")).toEqual([
      { event: "message", data: "a", id: "c1" },
      { event: "message", data: "b", id: "c1" },
      { event: "ping", data: "0", id: "c2" },
      { event: "message", data: "c", id: "c2" },
    ])
  })
})

describe("watch", () => {
  test("cursor resumes: it goes in the query", async () => {
    hub.routes["GET /api/agent/watch"] = () => sse("")
    await collect(client().watch({ cursor: "hev1_a.b" }))
    expect(hub.seen.map((s) => s.path)).toEqual(["/api/agent/watch?cursor=hev1_a.b"])
  })


  test("yields the hub's events and skips ping heartbeats; the stream ending ends the iteration", async () => {
    hub.routes["GET /api/agent/watch"] = () => sse('event: ping\ndata: {}\n\nevent: session.state\ndata: {"sessionID":"ses_1"}\n\n')
    expect(await collect(client().watch())).toEqual([{ event: "session.state", data: '{"sessionID":"ses_1"}' }])
  })

  test("blocked and session go in the query", async () => {
    hub.routes["GET /api/agent/watch"] = () => sse("")
    await collect(client().watch({ blocked: true, session: "@api" }))
    await collect(client().watch({ blocked: false }))
    expect(hub.seen.map((s) => s.path)).toEqual(["/api/agent/watch?blocked=1&session=%40api", "/api/agent/watch"])
  })

  test("an abort ends the iteration quietly, before or during the stream", async () => {
    const before = new AbortController()
    before.abort()
    expect(await collect(client().watch({ signal: before.signal }))).toEqual([])
    expect(hub.seen).toEqual([])

    const live = controlled()
    hub.routes["GET /api/agent/watch"] = () => sse(live.stream)
    const during = new AbortController()
    const seen: WatchEvent[] = []
    live.write("data: x\n\n")
    for await (const event of client().watch({ signal: during.signal })) {
      seen.push(event)
      during.abort()
    }
    expect(seen).toEqual([{ event: "message", data: "x" }])
  })

  test("a broken stream is a stream HubTransportError", async () => {
    // Broken on the client's side (a connection reset), through the client's fetch option.
    const live = controlled()
    const broken = new HubClient({ url: "http://hub.invalid", token: "tok", fetch: async () => sse(live.stream) })
    const events = broken.watch()[Symbol.asyncIterator]()
    live.write("data: x\n\n")
    expect((await events.next()).value).toEqual({ event: "message", data: "x" })
    live.fail(new Error("reset"))
    const error = await events.next().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HubTransportError)
    expect((error as HubTransportError).kind).toBe("stream")
    expect((error as HubTransportError).message).toStartWith("the watch stream failed (")
  })

  test("the hub's envelope rejects the first step", async () => {
    hub.routes["GET /api/agent/watch"] = () => Response.json({ error: { code: "forbidden", message: "no" } }, { status: 403 })
    const error = await collect(client().watch()).catch((e: unknown) => e)
    expect(isHubError(error, "forbidden")).toBe(true)
  })
})
