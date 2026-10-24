// Test helpers: a fake central server (HTTP enrollment + /spoke/ws) and an async event queue.
import type { Server, ServerWebSocket } from "bun"
import { encode, parseSpokeMessage, PROTOCOL_VERSION, type EnrollPoll, type ServerMessage, type SpokeMessage } from "../src/protocol"

export interface FakeCentral {
  url: string
  frames: SpokeMessage[]
  auth: Array<string | null>
  sockets: Array<ServerWebSocket<unknown>>
  closed: number
  /** Replies for POST /spoke/enroll/poll, consumed in order (last one repeats). */
  pollReplies: EnrollPoll[]
  send(message: ServerMessage | string): void
  /** Sends a server request and resolves with the spoke's `res` frame. */
  request(req: unknown): Promise<Extract<SpokeMessage, { t: "res" }>>
  stop(): void
}

export function fakeCentral(
  options: {
    onFrame?: (m: SpokeMessage, ws: ServerWebSocket<unknown>) => void
    port?: number
    enrollExtra?: Record<string, unknown>
    /** Features the welcome lists (none by default, like a hub that predates them). */
    hubFeatures?: readonly string[]
  } = {},
): FakeCentral {
  let reqID = 0
  const waiters = new Map<string, (m: Extract<SpokeMessage, { t: "res" }>) => void>()
  const fake: FakeCentral = {
    url: "",
    frames: [],
    auth: [],
    sockets: [],
    closed: 0,
    pollReplies: [{ status: "pending" }],
    send(message) {
      fake.sockets.at(-1)?.send(typeof message === "string" ? message : encode(message))
    },
    request(req) {
      const id = `srv${++reqID}`
      return new Promise((resolve) => {
        waiters.set(id, resolve)
        fake.send(JSON.stringify({ t: "req", id, req }))
      })
    },
    stop: () => {},
  }
  const server: Server<unknown> = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const path = new URL(req.url).pathname
      if (path === "/spoke/enroll") {
        return Response.json({
          userCode: "ABCD-EFGH",
          deviceCode: "dev_1",
          approveURL: `${fake.url}/approve`,
          intervalMs: 10,
          expiresAt: Date.now() + 60_000,
          ...options.enrollExtra,
        })
      }
      if (path === "/spoke/enroll/poll") {
        const reply = fake.pollReplies.length > 1 ? fake.pollReplies.shift()! : fake.pollReplies[0]!
        return Response.json(reply)
      }
      if (path !== "/spoke/ws") return new Response("not found", { status: 404 })
      fake.auth.push(req.headers.get("authorization"))
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 })
    },
    websocket: {
      open(ws) {
        fake.sockets.push(ws)
      },
      close() {
        fake.closed++
      },
      message(ws, data) {
        const m = parseSpokeMessage(typeof data === "string" ? data : Buffer.from(data).toString("utf8"))
        if (!m) return
        fake.frames.push(m)
        if (m.t === "hello") {
          const features = options.hubFeatures ? { features: [...options.hubFeatures] } : {}
          ws.send(encode({ t: "welcome", v: PROTOCOL_VERSION, machineID: "m_1", publicURL: "https://voice.example", ...features }))
        }
        if (m.t === "res") waiters.get(m.id)?.(m)
        options.onFrame?.(m, ws)
      },
    },
  })
  fake.url = `http://127.0.0.1:${server.port}`
  fake.stop = () => stopServer(server)
  return fake
}

/**
 * Stops a Bun server without hanging: in Bun 1.3.5, once the server has closed a WebSocket itself,
 * stop(true)'s promise can stay pending forever (see src/central/http.ts). An afterEach hook awaiting it
 * then hangs the whole test run (hooks have no timeout); seen about 1 in 8 full runs on Linux CI.
 */
export function stopServer(server: { stop(force?: boolean): unknown }): Promise<void> {
  return Promise.race([Promise.resolve(server.stop(true)).then(() => undefined), Bun.sleep(250)])
}

/** A loopback port nothing listens on (taken from a server that was just stopped). */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = probe.port!
  probe.stop(true)
  return port
}

export const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

/** A push-driven async iterable, standing in for ctx.event.subscribe. */
export class EventQueue<T> {
  private items: T[] = []
  private wake?: () => void
  push(item: T): void {
    this.items.push(item)
    this.wake?.()
  }
  async *iterate(signal: AbortSignal): AsyncIterable<T> {
    while (!signal.aborted) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
      this.wake = undefined
    }
  }
}
