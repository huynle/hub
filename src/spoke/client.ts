// The spoke's single outbound WebSocket to the central server: hello/welcome handshake, request/
// response correlation in both directions, and reconnect with jittered exponential backoff.
import {
  encode,
  MAX_FRAME,
  parseServerMessage,
  PROTOCOL_VERSION,
  type Hello,
  type ResultFor,
  type ServerRequest,
  type SpokeMessage,
  type SpokeRequest,
  type Welcome,
} from "../protocol"

export type ConnectionState = "off" | "connecting" | "connected" | "revoked" | "error"

export interface Backoff {
  readonly minMs: number
  readonly maxMs: number
  readonly random?: () => number
}

/** Minimal WebSocket surface used here (Bun's WebSocket accepts `{ headers }` as a 2nd argument). */
export interface SocketLike {
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface ConnectionOptions {
  readonly server: string
  readonly token: string
  /** Hello fields, computed per attempt so mode/directory are current. */
  readonly hello: () => Omit<Hello, "t" | "v">
  /** Executes a server request; a thrown error becomes `{ ok: false, error }`. */
  readonly handle: (req: ServerRequest) => Promise<unknown>
  readonly onWelcome?: (welcome: Welcome) => void
  readonly onState?: (state: ConnectionState, error?: string) => void
  readonly backoff?: Backoff
  readonly requestTimeoutMs?: number
  readonly socket?: (url: string, headers: Record<string, string>) => SocketLike
}

export function backoffDelay(attempt: number, backoff: Backoff): number {
  const base = Math.min(backoff.maxMs, backoff.minMs * 2 ** Math.min(attempt, 30))
  const random = (backoff.random ?? Math.random)()
  return Math.round(base * (0.5 + 0.5 * random))
}

export function wsURL(server: string): string {
  return `${server.replace(/\/+$/, "").replace(/^http/, "ws")}/spoke/ws`
}

const defaultSocket = (url: string, headers: Record<string, string>): SocketLike =>
  new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => SocketLike)(url, { headers })

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SpokeConnection {
  state: ConnectionState = "off"
  lastError?: string
  publicURL?: string
  machineID?: string

  private socket?: SocketLike
  private welcomed = false
  private stopped = true
  private attempt = 0
  private retry?: ReturnType<typeof setTimeout>
  private nextID = 0
  private readonly pending = new Map<string, Pending>()
  private readonly backoff: Backoff

  constructor(private readonly options: ConnectionOptions) {
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
    this.failPending("disconnected")
    this.setState("off")
  }

  /** Reconnects at once (e.g. after a local hub was started) instead of waiting out the backoff. */
  retryNow(): void {
    if (this.stopped || this.state === "connected" || this.state === "revoked" || this.socket) return
    clearTimeout(this.retry)
    this.attempt = 0
    this.open()
  }

  /** Sends a frame once the server has welcomed us. Returns false when it could not be sent. */
  send(frame: SpokeMessage): boolean {
    if (!this.socket || !this.welcomed || this.socket.readyState !== 1) return false
    try {
      let text = encode(frame)
      if (text.length > MAX_FRAME) {
        // The hub drops the connection on an oversize frame; answer a request with an error instead.
        if (frame.t !== "res") return false
        text = encode({ t: "res", id: frame.id, ok: false, error: `Result too large to send (${text.length} characters, limit ${MAX_FRAME})` })
      }
      this.socket.send(text)
      return true
    } catch {
      return false
    }
  }

  request<R extends SpokeRequest>(req: R): Promise<ResultFor[R["op"]]> {
    const id = `s${++this.nextID}`
    return new Promise((resolve, reject) => {
      if (this.state !== "connected") return reject(new Error("Not connected to the hub"))
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("The hub timed out"))
      }, this.options.requestTimeoutMs ?? 15_000)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      if (!this.send({ t: "req", id, req })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error("Not connected to the hub"))
      }
    })
  }

  private open(): void {
    if (this.stopped) return
    this.setState(this.state === "error" ? "error" : "connecting")
    let socket: SocketLike
    try {
      socket = (this.options.socket ?? defaultSocket)(wsURL(this.options.server), {
        Authorization: `Bearer ${this.options.token}`,
      })
    } catch (cause) {
      this.fail(message(cause))
      return
    }
    this.socket = socket
    this.welcomed = false
    socket.onopen = () => {
      try {
        socket.send(encode({ t: "hello", v: PROTOCOL_VERSION, ...this.options.hello() }))
      } catch (cause) {
        this.lastError = message(cause)
      }
    }
    socket.onmessage = (ev) => this.receive(ev.data)
    socket.onerror = () => {
      this.lastError = this.welcomed ? "Connection error" : "Could not connect to the hub"
    }
    socket.onclose = (ev) => {
      if (this.socket !== socket) return
      this.socket = undefined
      const wasWelcomed = this.welcomed
      this.welcomed = false
      this.failPending("disconnected")
      if (this.stopped || this.state === "revoked") return
      this.fail(wasWelcomed ? `Connection closed${ev.reason ? `: ${ev.reason}` : ""}` : (this.lastError ?? "Could not connect"))
    }
  }

  private receive(data: unknown): void {
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : String(data)
    const frame = parseServerMessage(text)
    if (!frame) return
    switch (frame.t) {
      case "welcome":
        this.welcomed = true
        this.attempt = 0
        this.publicURL = frame.publicURL
        this.machineID = frame.machineID
        this.lastError = undefined
        this.setState("connected")
        try {
          this.options.onWelcome?.(frame)
        } catch (cause) {
          console.error("[hub] welcome handler failed", cause)
        }
        return
      case "bye":
        if (frame.reason === "revoked") {
          this.stopped = true
          clearTimeout(this.retry)
          this.lastError = "This machine was revoked on the hub"
          this.setState("revoked")
          this.drop(1000, "revoked")
          this.failPending("revoked")
        }
        return
      case "res": {
        const pending = this.pending.get(frame.id)
        if (!pending) return
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.ok) pending.resolve(frame.result)
        else pending.reject(new Error(frame.error ?? "Request failed"))
        return
      }
      case "req":
        void this.answer(frame.id, frame.req)
        return
    }
  }

  private async answer(id: string, req: ServerRequest): Promise<void> {
    let reply: SpokeMessage
    try {
      reply = { t: "res", id, ok: true, result: await this.options.handle(req) }
    } catch (cause) {
      reply = { t: "res", id, ok: false, error: message(cause) }
    }
    this.send(reply)
  }

  private fail(error: string): void {
    this.lastError = error
    this.setState("error")
    if (this.stopped) return
    clearTimeout(this.retry)
    this.retry = setTimeout(() => this.open(), backoffDelay(this.attempt++, this.backoff))
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

  private failPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`Hub ${reason}`))
      this.pending.delete(id)
    }
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return
    this.state = state
    try {
      this.options.onState?.(state, this.lastError)
    } catch {
      // observers must not break the connection
    }
  }
}
