// JSON-RPC as Codex's app-server speaks it (codex app-server, P7-T0 spike v0hsdqhm): one JSON object per message,
// without a "jsonrpc" member. Requests both ways: the client calls methods (thread/start, turn/start …) and the
// server asks its clients (approvals), each side numbering its own ids. Notifications carry the thread's events.
// The channel is any transport of whole text messages: lines over a child's stdio (stdio.ts) or WebSocket text frames
// over the shared daemon's Unix socket (websocket.ts).

/** A transport of whole text messages. */
export interface Channel {
  send(text: string): void
  close(): void
  onMessage(cb: (text: string) => void): void
  /** Called once, when the channel closed (either side). */
  onClose(cb: (reason: string) => void): void
}

export type RpcID = number | string

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly method?: string,
  ) {
    super(message)
    this.name = "RpcError"
  }
}

/** JSON-RPC's code for a request that could not be sent or answered (this side's own failures). */
export const LOCAL_ERROR = -32000

export interface PeerHandlers {
  onNotification?(method: string, params: unknown): void
  onRequest?(id: RpcID, method: string, params: unknown): void
}

const DEFAULT_TIMEOUT_MS = 60_000

interface Pending {
  readonly method: string
  resolve(value: unknown): void
  reject(error: Error): void
  readonly timer: ReturnType<typeof setTimeout>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isID = (v: unknown): v is RpcID => typeof v === "number" || typeof v === "string"

export class JsonRpcPeer {
  readonly closed: Promise<string>
  #closedReason: string | undefined
  #next = 0
  readonly #pending = new Map<RpcID, Pending>()
  readonly #channel: Channel
  readonly #handlers: PeerHandlers

  constructor(channel: Channel, handlers: PeerHandlers = {}) {
    this.#channel = channel
    this.#handlers = handlers
    let done!: (reason: string) => void
    this.closed = new Promise((resolve) => (done = resolve))
    channel.onMessage((text) => this.#receive(text))
    channel.onClose((reason) => {
      if (this.#closedReason !== undefined) return
      this.#closedReason = reason || "closed"
      for (const [id, call] of this.#pending) {
        clearTimeout(call.timer)
        call.reject(new RpcError(`The app-server connection closed before it answered ${call.method} (${this.#closedReason})`, LOCAL_ERROR, call.method))
        this.#pending.delete(id)
      }
      done(this.#closedReason)
    })
  }

  get isClosed(): boolean {
    return this.#closedReason !== undefined
  }

  request(method: string, params?: unknown, options: { readonly timeoutMs?: number } = {}): Promise<any> {
    if (this.#closedReason !== undefined) return Promise.reject(new RpcError(`The app-server connection is closed (${this.#closedReason})`, LOCAL_ERROR, method))
    const id = ++this.#next
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new RpcError(`${method}: the app-server did not answer within ${timeoutMs} ms`, LOCAL_ERROR, method))
      }, timeoutMs)
      this.#pending.set(id, { method, resolve, reject, timer })
      this.#send(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params })
  }

  /** Answers a server request. */
  respond(id: RpcID, result: unknown): void {
    this.#send({ id, result })
  }

  respondError(id: RpcID, code: number, message: string): void {
    this.#send({ id, error: { code, message } })
  }

  close(): void {
    this.#channel.close()
  }

  #send(message: object): void {
    if (this.#closedReason !== undefined) return
    try {
      this.#channel.send(JSON.stringify(message))
    } catch {
      // The channel reports its own close; a request then fails there.
    }
  }

  #receive(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!isObj(message)) return
    if (typeof message.method === "string") {
      if (isID(message.id)) this.#handlers.onRequest?.(message.id, message.method, message.params)
      else this.#handlers.onNotification?.(message.method, message.params)
      return
    }
    if (!isID(message.id)) return
    const call = this.#pending.get(message.id)
    if (!call) return
    this.#pending.delete(message.id)
    clearTimeout(call.timer)
    if (isObj(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : LOCAL_ERROR
      call.reject(new RpcError(`${call.method}: ${typeof message.error.message === "string" ? message.error.message : "error"}`, code, call.method))
    } else call.resolve(message.result)
  }
}

/** Two connected in-memory channels (tests, and in-process fakes). */
export function memoryChannelPair(): [Channel, Channel] {
  type End = { listeners: ((t: string) => void)[]; closers: ((r: string) => void)[]; closed: boolean }
  const ends: [End, End] = [
    { listeners: [], closers: [], closed: false },
    { listeners: [], closers: [], closed: false },
  ]
  const close = (reason: string) => {
    for (const end of ends) {
      if (end.closed) continue
      end.closed = true
      for (const cb of end.closers) cb(reason)
    }
  }
  const channel = (self: End, other: End): Channel => ({
    send(text) {
      if (self.closed) throw new Error("channel closed")
      for (const cb of other.listeners) cb(text)
    },
    close: () => close("closed"),
    onMessage: (cb) => void self.listeners.push(cb),
    onClose: (cb) => void self.closers.push(cb),
  })
  return [channel(ends[0], ends[1]), channel(ends[1], ends[0])]
}
