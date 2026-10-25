// The node's single outbound WebSocket to the hub (design §6.3): /spoke/ws with the machine token (spoke and node
// share one machine record), a hello with role "node", then the hub's prepare/collect/cleanup/cancel requests
// answered in order of arrival. Reconnects with jittered exponential backoff; a hub that does not serve nodes (its
// welcome lacks "nodes", or it rejects the node hello before any welcome, as a hub older than nodes does) is
// retried only after a long wait, so an old hub is not hammered. A revoked machine stops for good. A bye carrying
// retryAfterMs (a hub pod draining, design §10) is followed by one short jittered reconnect (0–retryAfterMs) instead.
//
// The WebSocket is the runtime's global one with an Authorization header: Bun's accepts `{ headers }`, and so does
// Node's (undici, Node 22+), so this runs on both (bundled for node, or from source on bun).
import {
  hubServesNodes,
  MAX_FRAME,
  NODE_ROLE,
  parseNodeServerMessage,
  PROTOCOL_VERSION,
  type NodeCapacityFrame,
  type NodeHello,
  type NodeProgress,
  type NodeRequest,
  type Welcome,
} from "../../protocol/src/index.ts"

export type NodeConnectionState = "off" | "connecting" | "connected" | "unsupported" | "revoked" | "error"

export interface Backoff {
  readonly minMs: number
  readonly maxMs: number
  readonly random?: () => number
}

/** Minimal WebSocket surface used here. */
export interface SocketLike {
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface NodeConnectionOptions {
  readonly server: string
  readonly token: string
  /** Hello fields, computed per attempt so capacity, use and launches are current. */
  readonly hello: () => Omit<NodeHello, "t" | "v" | "role">
  /** Serves a hub request; a thrown error becomes `{ ok: false, error }`. */
  readonly handle: (req: NodeRequest) => Promise<unknown>
  readonly onWelcome?: (welcome: Welcome) => void
  readonly onState?: (state: NodeConnectionState, error?: string) => void
  readonly backoff?: Backoff
  /** Wait before retrying a hub that does not serve nodes (default 30 minutes). */
  readonly unsupportedRetryMs?: number
  readonly socket?: (url: string, headers: Record<string, string>) => SocketLike
}

export const UNSUPPORTED_RETRY_MS = 30 * 60_000

export function backoffDelay(attempt: number, backoff: Backoff): number {
  const base = Math.min(backoff.maxMs, backoff.minMs * 2 ** Math.min(attempt, 30))
  return Math.round(base * (0.5 + 0.5 * (backoff.random ?? Math.random)()))
}

/** The reconnect delay a bye's retryAfterMs asks for: uniformly jittered over 0–retryAfterMs, so peers spread out. */
export function retryAfterDelay(retryAfterMs: number, random: () => number = Math.random): number {
  return Math.round(retryAfterMs * random())
}

export function wsURL(server: string): string {
  return `${server.replace(/\/+$/, "").replace(/^http/, "ws")}/spoke/ws`
}

const defaultSocket = (url: string, headers: Record<string, string>): SocketLike =>
  new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => SocketLike)(url, { headers })

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

function text(data: unknown): string {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
  return String(data)
}

/** The id of a frame that is a request, valid or not (so an invalid request still gets an answer). */
function requestID(raw: string): string | undefined {
  if (raw.length > MAX_FRAME) return undefined
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && v.t === "req" && typeof v.id === "string" && v.id.length > 0 && v.id.length <= 300 ? v.id : undefined
  } catch {
    return undefined
  }
}

export class NodeConnection {
  state: NodeConnectionState = "off"
  lastError?: string
  machineID?: string
  publicURL?: string

  private socket?: SocketLike
  private welcomed = false
  private stopped = true
  private attempt = 0
  private retry?: ReturnType<typeof setTimeout>
  /** The last bye's retryAfterMs (a draining hub): the next reconnect waits about this instead of the backoff. */
  private retryAfterMs?: number
  private readonly backoff: Backoff

  constructor(private readonly options: NodeConnectionOptions) {
    this.backoff = options.backoff ?? { minMs: 1000, maxMs: 60_000 }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retry)
    this.drop(1000, "stop")
    this.setState("off")
  }

  /** Sends a capacity or progress frame once the hub has welcomed us. Returns false when it could not be sent. */
  send(frame: NodeCapacityFrame | NodeProgress): boolean {
    return this.write(frame)
  }

  private write(frame: unknown): boolean {
    if (!this.socket || !this.welcomed || this.socket.readyState !== 1) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  private open(): void {
    if (this.stopped) return
    this.setState(this.state === "error" || this.state === "unsupported" ? this.state : "connecting")
    let socket: SocketLike
    try {
      socket = (this.options.socket ?? defaultSocket)(wsURL(this.options.server), { Authorization: `Bearer ${this.options.token}` })
    } catch (cause) {
      return this.fail(message(cause))
    }
    this.socket = socket
    this.welcomed = false
    let opened = false
    let rejected = false
    socket.onopen = () => {
      opened = true
      try {
        socket.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, role: NODE_ROLE, ...this.options.hello() }))
      } catch (cause) {
        this.lastError = message(cause)
      }
    }
    socket.onmessage = (ev) => {
      const raw = text(ev.data)
      const frame = parseNodeServerMessage(raw)
      if (!frame) {
        const id = this.welcomed ? requestID(raw) : undefined
        if (id) this.write({ t: "res", id, ok: false, error: "invalid request" })
        return
      }
      switch (frame.t) {
        case "welcome":
          return this.welcome(frame)
        case "bye":
          if (frame.reason === "revoked") return this.revoked()
          // A draining hub is no hub refusing nodes: come back soon (to another pod).
          if (frame.retryAfterMs !== undefined) this.retryAfterMs = frame.retryAfterMs
          else if (!this.welcomed) rejected = true
          this.lastError = frame.reason
          return
        case "req":
          if (this.welcomed) void this.answer(frame.id, frame.req)
          return
        case "res":
          return // the node makes no requests of the hub
      }
    }
    socket.onerror = () => {
      this.lastError = this.welcomed ? "Connection error" : "Could not connect to the hub"
    }
    socket.onclose = (ev) => {
      if (this.socket !== socket) return
      this.socket = undefined
      const wasWelcomed = this.welcomed
      this.welcomed = false
      if (this.stopped || this.state === "revoked") return
      // Opened, then closed by the hub before any welcome: the hub refused the node hello.
      if (!wasWelcomed && opened && (rejected || ev.code === 4000) && this.retryAfterMs === undefined) return this.unsupported(`The hub does not accept nodes${this.lastError ? ` (${this.lastError})` : ""}`)
      this.fail(wasWelcomed ? `Connection closed${ev.reason ? `: ${ev.reason}` : ""}` : (this.lastError ?? "Could not connect"))
    }
  }

  private welcome(frame: Welcome): void {
    if (!hubServesNodes(frame)) {
      this.drop(1000, "hub does not serve nodes")
      return this.unsupported("The hub does not serve nodes (upgrade the hub)")
    }
    this.welcomed = true
    this.attempt = 0
    this.machineID = frame.machineID
    this.publicURL = frame.publicURL
    this.lastError = undefined
    this.setState("connected")
    try {
      this.options.onWelcome?.(frame)
    } catch (cause) {
      console.error("[hub node] welcome handler failed", cause)
    }
  }

  private async answer(id: string, req: NodeRequest): Promise<void> {
    let reply: unknown
    try {
      reply = { t: "res", id, ok: true, result: await this.options.handle(req) }
    } catch (cause) {
      reply = { t: "res", id, ok: false, error: message(cause) }
    }
    if (JSON.stringify(reply).length > MAX_FRAME) reply = { t: "res", id, ok: false, error: "result too large to send" }
    this.write(reply)
  }

  private revoked(): void {
    this.stopped = true
    clearTimeout(this.retry)
    this.lastError = "This machine was revoked on the hub"
    this.setState("revoked")
    this.drop(1000, "revoked")
  }

  private unsupported(error: string): void {
    this.lastError = error
    this.setState("unsupported")
    this.schedule(this.options.unsupportedRetryMs ?? UNSUPPORTED_RETRY_MS)
  }

  private fail(error: string): void {
    this.lastError = error
    this.setState("error")
    const retryAfterMs = this.retryAfterMs
    this.retryAfterMs = undefined
    this.schedule(retryAfterMs !== undefined ? retryAfterDelay(retryAfterMs, this.backoff.random) : backoffDelay(this.attempt++, this.backoff))
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    clearTimeout(this.retry)
    this.retry = setTimeout(() => this.open(), ms)
  }

  private drop(code: number, reason: string): void {
    const socket = this.socket
    this.socket = undefined
    this.welcomed = false
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
    try {
      socket.close(code, reason)
    } catch {
      // already closed
    }
  }

  private setState(state: NodeConnectionState): void {
    if (state === this.state) return
    this.state = state
    try {
      this.options.onState?.(state, this.lastError)
    } catch {
      // observers must not break the connection
    }
  }
}
