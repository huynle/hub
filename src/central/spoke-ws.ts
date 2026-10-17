// Spoke WebSocket endpoint (/spoke/ws): bearer-token authentication, hello/welcome handshake, frame
// validation, heartbeats, server→spoke request/response correlation, and spoke→server requests.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun"
import {
  encode,
  MAX_FRAME,
  parseSpokeMessage,
  PROTOCOL_VERSION,
  type Req,
  type ResultFor,
  type ServerMessage,
  type ServerRequest,
  type SpokeRequest,
} from "../protocol"
import type { Auth } from "./auth"
import type { PushDetail, PushExtra, PushKind } from "./push"
import type { Registry } from "./registry"
import { newID, type Store } from "./store"

/** Push notifications (implemented by Push in push.ts) to `ownerID`'s devices. Returns the number of devices notified. */
export interface Notifier {
  notify(kind: PushKind, sessionID: string, title: string, detail?: PushDetail, body?: string, ownerID?: string, extra?: PushExtra): Promise<number>
}

/** The spoke answered with an error, or disconnected before answering. */
export class SpokeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SpokeError"
  }
}

/** A request that would not fit in one protocol frame (the spoke would drop it and never answer). */
export class RequestTooLargeError extends Error {
  constructor(op: string) {
    super(`The ${op} request is too large to send to OpenCode`)
    this.name = "RequestTooLargeError"
  }
}

export class RequestTimeoutError extends Error {
  constructor(op: string) {
    super(`OpenCode did not answer the ${op} request in time`)
    this.name = "RequestTimeoutError"
  }
}

export interface SpokeSocketData {
  readonly connID: string
  readonly machineID: string
  readonly machineName: string
  ready: boolean
  lastSeen: number
  helloTimer?: ReturnType<typeof setTimeout>
}

type Socket = ServerWebSocket<SpokeSocketData>

export interface SpokeHubOptions {
  readonly store: Store
  readonly auth: Auth
  readonly registry: Registry
  readonly publicURL: string
  readonly notifier: Notifier
  /** Sends a message to the SSE subscribers of `tenant` (a user ID). */
  readonly broadcast: (message: { type: string; [key: string]: unknown }, tenant: string) => void
  readonly turnTimeoutMs: number
  /** Added to turnTimeoutMs for the hub-side wait (default TURN_GRACE_MS). */
  readonly turnGraceMs?: number
  readonly requestTimeoutMs?: number
  readonly helloTimeoutMs?: number
  readonly heartbeatMs?: number
  readonly staleMs?: number
}

interface Pending {
  readonly connID: string
  readonly op: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Extra time the hub waits past the turn timeout so the spoke's own timeout result arrives first. */
export const TURN_GRACE_MS = 15_000
/** Creating a session and opening it in a new Herdr tab (the spoke allows `herdr agent start` 20 s). */
export const CREATE_IN_HERDR_TIMEOUT_MS = 45_000

const CLOSE_PROTOCOL = 4000
const CLOSE_REVOKED = 4001
const CLOSE_STALE = 4002

export class SpokeHub {
  private readonly sockets = new Map<string, Socket>()
  private readonly pending = new Map<string, Pending>()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private seq = 0
  readonly websocket: WebSocketHandler<SpokeSocketData>

  constructor(private readonly options: SpokeHubOptions) {
    const staleMs = options.staleMs ?? 60_000
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      for (const ws of this.sockets.values()) {
        if (now - ws.data.lastSeen > staleMs) ws.close(CLOSE_STALE, "heartbeat timeout")
        else ws.ping()
      }
    }, options.heartbeatMs ?? 20_000)
    this.heartbeat.unref?.()

    this.websocket = {
      open: (ws) => this.open(ws),
      message: (ws, raw) => this.message(ws, raw),
      close: (ws) => this.closed(ws),
      pong: (ws) => this.seen(ws),
      idleTimeout: 0,
    }
  }

  /** Authenticates and upgrades /spoke/ws. Returns a Response on failure, undefined when upgraded. */
  upgrade(request: Request, server: Server<SpokeSocketData>): Response | undefined {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")
    const machine = match?.[1] ? this.options.store.findMachine(match[1]) : undefined
    const owner = machine && this.options.store.user(machine.ownerID)
    if (!machine || !owner || owner.disabled) return Response.json({ error: "Invalid or revoked machine token" }, { status: 401 })
    const data: SpokeSocketData = {
      connID: newID("conn"),
      machineID: machine.id,
      machineName: machine.name,
      ready: false,
      lastSeen: Date.now(),
    }
    if (server.upgrade(request, { data })) return undefined
    return Response.json({ error: "Expected a WebSocket upgrade" }, { status: 426 })
  }

  /** Sends a request to a connected spoke and resolves with its result. */
  request<R extends ServerRequest>(connID: string, req: R): Promise<ResultFor[R["op"]]> {
    const ws = this.sockets.get(connID)
    if (!ws?.data.ready) return Promise.reject(new SpokeError("OpenCode process disconnected"))
    const id = `r${++this.seq}`
    const frame = encode({ t: "req", id, req })
    if (frame.length > MAX_FRAME) return Promise.reject(new RequestTooLargeError(req.op))
    const base = this.options.requestTimeoutMs ?? 15_000
    const timeoutMs =
      req.op === "turn"
        ? this.options.turnTimeoutMs + (this.options.turnGraceMs ?? TURN_GRACE_MS)
        : req.op === "create" && req.herdrWorkspace
          ? Math.max(base, CREATE_IN_HERDR_TIMEOUT_MS) // the spoke waits for OpenCode to start in the new tab
          : base
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RequestTimeoutError(req.op))
      }, timeoutMs)
      this.pending.set(id, { connID, op: req.op, resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(frame)
    })
  }

  /** Disconnects every socket of a machine (after revocation). */
  closeMachine(machineID: string, reason: string): void {
    for (const ws of this.sockets.values()) if (ws.data.machineID === machineID) this.bye(ws, reason, CLOSE_REVOKED)
  }

  stop(): void {
    clearInterval(this.heartbeat)
    for (const ws of this.sockets.values()) this.bye(ws, "server shutting down", 1001)
  }

  private open(ws: Socket): void {
    this.sockets.set(ws.data.connID, ws)
    ws.data.helloTimer = setTimeout(() => {
      if (!ws.data.ready) this.bye(ws, "hello timeout")
    }, this.options.helloTimeoutMs ?? 10_000)
  }

  private seen(ws: Socket): void {
    ws.data.lastSeen = Date.now()
    if (ws.data.ready) this.options.registry.touch(ws.data.connID)
  }

  private message(ws: Socket, raw: string | Buffer): void {
    this.seen(ws)
    const message = parseSpokeMessage(raw)
    if (!message) return this.bye(ws, "protocol error")
    const { registry } = this.options
    const { connID } = ws.data

    if (!ws.data.ready) {
      if (message.t !== "hello") return this.bye(ws, "protocol error")
      if (message.v !== PROTOCOL_VERSION) {
        return this.bye(ws, `unsupported protocol version ${message.v}; server speaks version ${PROTOCOL_VERSION}`)
      }
      clearTimeout(ws.data.helloTimer)
      ws.data.ready = true
      registry.connect(connID, { id: ws.data.machineID, name: ws.data.machineName }, message)
      this.options.store.touchMachine(ws.data.machineID)
      this.send(ws, { t: "welcome", v: PROTOCOL_VERSION, machineID: ws.data.machineID, publicURL: this.options.publicURL })
      return
    }

    switch (message.t) {
      case "hello":
        return this.bye(ws, "protocol error")
      case "sessions":
        registry.setSessions(connID, message.sessions)
        return this.resendConversations(connID)
      case "terminals":
        return registry.setTerminals(connID, message)
      case "event":
        return registry.observe(connID, message.event)
      case "req":
        void this.answer(ws, message)
        return
      case "res": {
        const pending = this.pending.get(message.id)
        if (!pending || pending.connID !== connID) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new SpokeError(message.error || `OpenCode ${pending.op} request failed`))
        return
      }
      case "bye":
        ws.close(1000, "bye")
        return
    }
  }

  private async answer(ws: Socket, frame: Req<SpokeRequest>): Promise<void> {
    try {
      const result = await this.handle(ws, frame.req)
      this.send(ws, { t: "res", id: frame.id, ok: true, result })
    } catch (cause) {
      this.send(ws, { t: "res", id: frame.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  /** The machine's current owner (read live: ownership can move, e.g. on migration). */
  ownerOf(machineID: string): string | undefined {
    return this.options.store.machines().find((m) => m.id === machineID)?.ownerID
  }

  private async handle(ws: Socket, req: SpokeRequest): Promise<ResultFor[SpokeRequest["op"]]> {
    const { auth, publicURL } = this.options
    const owner = this.ownerOf(ws.data.machineID)
    if (!owner) throw new Error("This machine is no longer enrolled")
    switch (req.op) {
      case "pairCode": {
        const { code, expiresAt } = auth.issuePairCode(owner)
        return { code, url: `${publicURL}/pair`, expiresAt }
      }
      case "handoff": {
        // Only the machine owner's own (or not yet reported) sessions: never another user's title or ID.
        const tenant = this.options.registry.sessionTenant(req.sessionID)
        if (tenant !== undefined && tenant !== owner) throw new Error("Unknown session")
        this.options.broadcast({ type: "handoff", sessionID: req.sessionID }, owner)
        const title = (tenant && this.options.registry.status(req.sessionID)?.[0]?.title) || req.sessionID
        return { notified: await this.options.notifier.notify("handoff", req.sessionID, title, undefined, undefined, owner) }
      }
      case "openLink": {
        const { code } = auth.issueLoginCode(owner)
        const next = req.sessionID ? `/s/${encodeURIComponent(req.sessionID)}${req.voice ? "?voice=1" : ""}` : "/"
        return { url: `${publicURL}/login?code=${code}&next=${next}` }
      }
    }
  }

  /** Tells a (re)connected owner about sessions the phone has in conversation mode. */
  private resendConversations(connID: string): void {
    for (const sessionID of this.options.registry.conversationResends(connID)) {
      this.request(connID, { op: "conversation", sessionID, on: true }).catch((cause) => {
        console.error("[hub] re-sending conversation mode failed:", cause instanceof Error ? cause.message : cause)
      })
    }
  }

  private closed(ws: Socket): void {
    clearTimeout(ws.data.helloTimer)
    const { connID } = ws.data
    this.sockets.delete(connID)
    for (const [id, pending] of this.pending) {
      if (pending.connID !== connID) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new SpokeError("OpenCode process disconnected"))
    }
    if (ws.data.ready) this.options.registry.disconnect(connID)
  }

  private bye(ws: Socket, reason: string, code = CLOSE_PROTOCOL): void {
    this.send(ws, { t: "bye", reason })
    ws.close(code, reason)
  }

  private send(ws: Socket, message: ServerMessage): void {
    ws.send(encode(message))
  }
}
