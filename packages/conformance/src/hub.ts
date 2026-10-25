// The recording hub the conformance runner points a spoke at. Like the testkit's fakeHub (a /spoke/ws that welcomes
// every hello and correlates server requests with the spoke's res), but it records every frame raw, valid or not, with
// its size and connection, because the checks judge exactly what the hub would have dropped (an oversize or
// unparsable frame), and it can say goodbye like a draining pod (bye{retryAfterMs}, then close).
import { encode, HUB_FEATURES, parseSpokeMessage, PROTOCOL_VERSION, type ServerRequest, type SpokeMessage } from "../../protocol/src/index.ts"
import { stopServer } from "../../testkit/src/index.ts"

export interface RecordedFrame {
  /** The connection (index into connections). */
  readonly conn: number
  readonly at: number
  readonly raw: string
  readonly size: number
  /** The frame's `t` when it is a JSON object with one. */
  readonly t?: string
  /** The frame as the hub parses it (parseSpokeMessage); undefined when the hub would drop it. */
  readonly parsed?: SpokeMessage
}

export interface Connection {
  readonly auth: string | null
  readonly openedAt: number
  closedAt?: number
}

export interface HubAnswer {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

export interface RecordingHub {
  url: string
  connections: Connection[]
  frames: RecordedFrame[]
  /** Sends a server request on the latest connection; resolves with the res, or undefined after timeoutMs. */
  request(req: ServerRequest | Record<string, unknown>, timeoutMs: number): Promise<HubAnswer | undefined>
  /** The first frame at index `from` (default 0) or later matching the predicate, waiting up to timeoutMs. */
  waitFor(predicate: (f: RecordedFrame) => boolean, timeoutMs: number, from?: number): Promise<RecordedFrame | undefined>
  /** Sends text as is on the latest connection. */
  sendRaw(text: string): void
  /** Sends a bye on the latest connection and closes it. */
  bye(reason: string, retryAfterMs?: number): void
  stop(): Promise<void>
}

type Socket = Bun.ServerWebSocket<{ conn: number }>

export function recordingHub(options: { hubFeatures?: readonly string[] } = {}): RecordingHub {
  const sockets: Socket[] = []
  const waiters = new Set<() => void>()
  const pending = new Map<string, (res: HubAnswer) => void>()
  let nextID = 0
  const wake = () => {
    for (const w of [...waiters]) w()
    waiters.clear()
  }
  const latest = () => sockets.at(-1)

  const hub: RecordingHub = {
    url: "",
    connections: [],
    frames: [],
    request(req, timeoutMs) {
      const id = `conf${++nextID}`
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve(undefined)
        }, timeoutMs)
        pending.set(id, (res) => {
          clearTimeout(timer)
          pending.delete(id)
          resolve(res)
        })
        hub.sendRaw(JSON.stringify({ t: "req", id, req }))
      })
    },
    async waitFor(predicate, timeoutMs, from = 0) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = hub.frames.slice(from).find(predicate)
        if (found) return found
        const left = deadline - Date.now()
        if (left <= 0) return undefined
        await new Promise<void>((resolve) => {
          waiters.add(resolve)
          setTimeout(resolve, left)
        })
      }
    },
    sendRaw(text) {
      try {
        latest()?.send(text)
      } catch {
        // closed meanwhile: the request times out
      }
    },
    bye(reason, retryAfterMs) {
      const socket = latest()
      if (!socket) return
      try {
        socket.send(encode(retryAfterMs === undefined ? { t: "bye", reason } : { t: "bye", reason, retryAfterMs }))
        socket.close(1001, reason)
      } catch {
        // already closed
      }
    },
    stop: async () => {},
  }

  const server = Bun.serve<{ conn: number }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/spoke/ws") return new Response("not found", { status: 404 })
      const conn = hub.connections.length
      hub.connections.push({ auth: req.headers.get("authorization"), openedAt: Date.now() })
      return srv.upgrade(req, { data: { conn } }) ? undefined : new Response("upgrade failed", { status: 400 })
    },
    websocket: {
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        sockets.push(ws)
      },
      close(ws) {
        const c = hub.connections[ws.data.conn]
        if (c) c.closedAt = Date.now()
        const i = sockets.indexOf(ws)
        if (i >= 0) sockets.splice(i, 1)
        wake()
      },
      message(ws, data) {
        const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8")
        const parsed = parseSpokeMessage(raw)
        hub.frames.push({ conn: ws.data.conn, at: Date.now(), raw, size: raw.length, t: frameType(raw), parsed })
        if (parsed?.t === "hello") {
          ws.send(encode({ t: "welcome", v: PROTOCOL_VERSION, machineID: "m_conformance", publicURL: hub.url, features: [...(options.hubFeatures ?? HUB_FEATURES)] }))
        }
        if (parsed?.t === "res") pending.get(parsed.id)?.({ ok: parsed.ok, ...(parsed.result !== undefined ? { result: parsed.result } : {}), ...(parsed.error !== undefined ? { error: parsed.error } : {}) })
        wake()
      },
    },
  })
  hub.url = `http://127.0.0.1:${server.port}`
  hub.stop = () => stopServer(server)
  return hub
}

/** The `t` of a JSON object frame, without trusting the rest of it. */
function frameType(raw: string): string | undefined {
  const match = /^\s*\{\s*"t"\s*:\s*"([a-z]{1,20})"/.exec(raw)
  if (match) return match[1]
  try {
    const value = JSON.parse(raw)
    return typeof value?.t === "string" ? value.t.slice(0, 20) : undefined
  } catch {
    return undefined
  }
}
