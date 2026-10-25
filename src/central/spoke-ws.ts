// Spoke WebSocket endpoint (/spoke/ws): bearer-token authentication, hello/welcome handshake, frame
// validation, heartbeats, server→spoke request/response correlation, and spoke→server requests.
// `hub node` daemons share the endpoint and the machine token but say hello with role "node" (design §6.3):
// they go to the NodeRegistry, never to the spoke Registry, and get node ops (requestNode) instead of spoke ops.
// A harness inside a sandbox (phase 5) authenticates with its launch's hlt1 token instead (./agent/launch-tokens.ts):
// accepted only while the launch is provisioning or running, only with a spoke hello naming that launch, one
// connection per launch (a reconnect replaces the old one), closed when the launch ends (closeLaunch) or the token
// expires; such a connection is bound to the launch in the Registry and gets no pairing or login codes.
// Source addresses (loopback included: a sandbox reaches a loopback hub through its host) are never trusted.
// Cluster mode (design §9, `cluster` option): each connection is recorded in the ConnDirectory (connID → pod); an op
// for a connection another pod holds goes there over pod RPC (./cluster/rpc.ts) with the same per-op timeout, and the
// owning pod re-checks the tenant before sending it. closeMachine / closeLaunch reach every pod. Session-token and
// act-token pushes are sent only by the pod holding the connection. Close notices are at most once, so every
// RECHECK_MS each pod also re-reads its sockets' machines and owners (Store.recheck) and closes the sockets of a
// revoked machine or a disabled owner itself. Without `cluster` everything is local.
// Draining (design §10, drain()): new upgrades are refused with 503, new requests to this pod's connections fail as
// offline, and each connection gets bye{reason:"draining", retryAfterMs} once its requests in flight are answered
// (at the deadline at the latest), so it reconnects (to another pod) after a short jittered delay.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun"
import {
  encode,
  helloRole,
  HUB_FEATURES,
  MAX_FRAME,
  NODE_ROLE,
  nodeResultProblem,
  parseNodeMessage,
  parseSpokeMessage,
  PROTOCOL_VERSION,
  type HelloRole,
  type NodeHello,
  type NodeOp,
  type NodeRequest,
  type NodeResultFor,
  type NodeServerMessage,
  type Req,
  type ResultFor,
  type ServerMessage,
  type ServerRequest,
  type SpokeRequest,
} from "../protocol"
import type { LaunchBinding, LaunchVerifyResult } from "./agent/launch-tokens"
import type { ConnDirectory } from "./cluster/directory"
import type { CloseNotice, PodRpc, RpcCall } from "./cluster/rpc"
import type { Auth } from "./auth"
import type { NodeRegistry } from "./nodes"
import type { NotificationKind, PushExtra } from "./push"
import type { Registry } from "./registry"
import { newID, type Store } from "./store"

/** Push notifications (implemented by Push in push.ts) to `ownerID`'s devices. Returns the number of devices notified. */
export interface Notifier {
  notify(kind: NotificationKind, sessionID: string, title: string, body?: string, ownerID?: string, extra?: PushExtra): Promise<number>
}

/** The spoke answered with an error, or disconnected before answering. */
export class SpokeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SpokeError"
  }
}

/** A node answered with an error or an invalid result, or disconnected before answering. */
export class NodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NodeError"
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
  constructor(op: string, who = "OpenCode") {
    super(`${who} did not answer the ${op} request in time`)
    this.name = "RequestTimeoutError"
  }
}

export interface SpokeSocketData {
  readonly connID: string
  readonly machineID: string
  readonly machineName: string
  ready: boolean
  /** What the hello said this connection is (set with the hello). */
  role?: HelloRole
  lastSeen: number
  helloTimer?: ReturnType<typeof setTimeout>
  /** The launch whose launch-bound token authenticated this connection (absent for machine tokens). */
  readonly launch?: LaunchBinding
  /** Closes a launch-bound connection when its token expires. */
  expiryTimer?: ReturnType<typeof setTimeout>
  /** Draining: the bye was sent. */
  drained?: boolean
}

type Socket = ServerWebSocket<SpokeSocketData>

export interface SpokeHubOptions {
  readonly store: Store
  readonly auth: Auth
  readonly registry: Registry
  /** Connected `hub node` daemons (role "node" hellos); nodes never enter `registry`. */
  readonly nodes: NodeRegistry
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
  /** Per node op request timeouts (defaults: NODE_TIMEOUTS_MS; cancel uses requestTimeoutMs). */
  readonly nodeTimeoutsMs?: Partial<Record<NodeOp, number>>
  /** Cluster mode: how often the sockets' machines and owners are re-checked (default RECHECK_MS). */
  readonly recheckMs?: number
  /** Verifies launch-bound (hlt1) tokens; without it only machine tokens are accepted. */
  readonly launchTokens?: LaunchVerifier
  /** Cluster mode: the shared connection directory and this pod's RPC (absent: every connection is local). */
  readonly cluster?: SpokeCluster
}

export interface SpokeCluster {
  readonly directory: ConnDirectory
  readonly rpc: PodRpc
}

/** Per-request options. */
export interface RequestOptions {
  /**
   * The user the caller acts for. For a connection on another pod, that pod refuses the op unless the connection's
   * machine belongs to this user (default: the machine's owner as this pod sees it) and the session, if any, is
   * not another user's.
   */
  readonly tenant?: string
}

/** Checks launch-bound tokens (implemented by LaunchTokens). */
export interface LaunchVerifier {
  verify(token: string): Promise<LaunchVerifyResult>
}

interface Pending {
  readonly connID: string
  readonly op: string
  /** A node request: errors are NodeErrors and the result is checked with nodeResultProblem. */
  readonly node?: boolean
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Extra time the hub waits past the turn timeout so the spoke's own timeout result arrives first. */
export const TURN_GRACE_MS = 15_000
/** Creating a session and opening it in a new Herdr tab (the spoke allows `herdr agent start` 20 s). */
export const CREATE_IN_HERDR_TIMEOUT_MS = 45_000
/** Auto-name: the spoke waits up to 20 s for OpenCode's generated title, then answers "pending". */
export const AUTO_NAME_TIMEOUT_MS = 30_000

/** Node op timeouts: prepare may clone a repository; collect and cleanup run git in an existing workspace. */
export const NODE_TIMEOUTS_MS: Readonly<Partial<Record<NodeOp, number>>> = { prepare: 600_000, collect: 60_000, cleanup: 120_000 }

const CLOSE_PROTOCOL = 4000
const CLOSE_REVOKED = 4001
const CLOSE_STALE = 4002
const CLOSE_REPLACED = 4003
const CLOSE_LAUNCH_ENDED = 4004
const CLOSE_LAUNCH_EXPIRED = 4005
/** Longest delay setTimeout takes; later expiries re-arm. */
const MAX_TIMER_MS = 2 ** 31 - 1
const LAUNCH_TOKEN = /^hlt1\./
/** How long stop() waits for the cluster directory and RPC to be cleaned up. */
const CLUSTER_STOP_MS = 1_000
/** How many closed launches are remembered (launch IDs are never reused). */
const CLOSED_LAUNCHES = 1000
/** How soon drained spokes and nodes are told to reconnect (they wait a random 0–this; design §10: 0–5 s). */
export const DRAIN_RETRY_AFTER_MS = 5_000
/** How long draining waits for requests in flight (k8s terminationGracePeriodSeconds is 60). */
export const DRAIN_TIMEOUT_MS = 50_000
/** Close code of a drained connection (a hub code: Bun 1.3.5 reports a server's 1001 to clients as 1000). */
const CLOSE_DRAINING = 4006
/** How often draining looks whether the requests in flight are done. */
const DRAIN_POLL_MS = 20

export interface DrainOptions {
  /** Sent in the bye: the peers reconnect after a random 0–retryAfterMs (default DRAIN_RETRY_AFTER_MS). */
  readonly retryAfterMs?: number
  /** How long to wait for requests in flight (default DRAIN_TIMEOUT_MS); the rest fail as offline. */
  readonly timeoutMs?: number
}

/** Cluster mode: how often a pod re-checks that its sockets' machines are not revoked and their owners not disabled. */
export const RECHECK_MS = 30_000

export class SpokeHub {
  private readonly sockets = new Map<string, Socket>()
  private readonly pending = new Map<string, Pending>()
  /**
   * Launches closed here, with the reason: a socket whose token was verified just before its launch ended opens
   * after closeLaunch ran, and is turned away then.
   */
  private readonly closedLaunches = new Map<string, string>()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly recheckTimer?: ReturnType<typeof setInterval>
  private seq = 0
  /** Set by drain(): the bye's retryAfterMs. */
  private draining?: { readonly retryAfterMs: number }
  private drained?: Promise<void>
  /** Calls this pod made to connections on other pods, not answered yet (draining waits for them). */
  private remoteCalls = 0
  /** Cluster mode: the directory heartbeat, RPC responder and close notices are set up. */
  private readonly started: Promise<void>
  readonly websocket: WebSocketHandler<SpokeSocketData>

  constructor(private readonly options: SpokeHubOptions) {
    const staleMs = options.staleMs ?? 60_000
    this.started = this.startCluster()
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      for (const ws of this.sockets.values()) {
        if (now - ws.data.lastSeen > staleMs) ws.close(CLOSE_STALE, "heartbeat timeout")
        else ws.ping()
      }
    }, options.heartbeatMs ?? 20_000)
    this.heartbeat.unref?.()
    if (options.cluster) {
      this.recheckTimer = setInterval(() => void this.recheck(), options.recheckMs ?? RECHECK_MS)
      this.recheckTimer.unref?.()
    }

    this.websocket = {
      open: (ws) => this.open(ws),
      message: (ws, raw) => this.message(ws, raw),
      close: (ws) => this.closed(ws),
      pong: (ws) => this.seen(ws),
      idleTimeout: 0,
    }
  }

  /**
   * Authenticates and upgrades /spoke/ws with a machine token or a launch-bound (hlt1) token. Resolves with a
   * Response on failure, undefined when upgraded.
   */
  async upgrade(request: Request, server: Server<SpokeSocketData>): Promise<Response | undefined> {
    if (this.draining) {
      const retryAfter = String(Math.max(1, Math.ceil(this.draining.retryAfterMs / 1000)))
      return Response.json({ error: "This hub server is shutting down; reconnect", code: "draining" }, { status: 503, headers: { "retry-after": retryAfter } })
    }
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")
    const token = match?.[1]
    if (token && LAUNCH_TOKEN.test(token)) return this.upgradeLaunch(request, server, token)
    const machine = token ? await this.options.store.findMachine(token) : undefined
    if (machine) await this.options.store.recheck({ users: [machine.ownerID] })
    const owner = machine && this.options.store.user(machine.ownerID)
    if (!machine || !owner || owner.disabled) return Response.json({ error: "Invalid or revoked machine token" }, { status: 401 })
    return this.accept(request, server, { connID: newID("conn"), machineID: machine.id, machineName: machine.name, ready: false, lastSeen: Date.now() })
  }

  private async upgradeLaunch(request: Request, server: Server<SpokeSocketData>, token: string): Promise<Response | undefined> {
    const refused = () => Response.json({ error: "Invalid or expired launch token" }, { status: 401 })
    const verifier = this.options.launchTokens
    if (!verifier) return refused()
    let binding: LaunchVerifyResult
    try {
      binding = await verifier.verify(token)
    } catch {
      return refused()
    }
    if (!binding || binding === "expired") return refused()
    const machine = this.options.store.machines().find((m) => m.id === binding.machineID)
    if (!machine) return refused()
    return this.accept(request, server, { connID: newID("conn"), machineID: machine.id, machineName: machine.name, ready: false, lastSeen: Date.now(), launch: binding })
  }

  private accept(request: Request, server: Server<SpokeSocketData>, data: SpokeSocketData): Response | undefined {
    if (server.upgrade(request, { data })) return undefined
    return Response.json({ error: "Expected a WebSocket upgrade" }, { status: 426 })
  }

  /** Resolves once cluster mode is set up (at once without it). */
  ready(): Promise<void> {
    return this.started
  }

  /**
   * Sends a request to a connected spoke and resolves with its result. In cluster mode a connection another pod
   * holds is reached over pod RPC.
   */
  request<R extends ServerRequest>(connID: string, req: R, options: RequestOptions = {}): Promise<ResultFor[R["op"]]> {
    const ws = this.sockets.get(connID)
    if (!ws && this.options.cluster) return this.remote({ kind: "spoke", connID, req, tenant: options.tenant ?? "" }) as Promise<ResultFor[R["op"]]>
    if (!ws?.data.ready || ws.data.role !== "spoke" || this.draining) return Promise.reject(new SpokeError("OpenCode process disconnected"))
    const id = `r${++this.seq}`
    const frame = encode({ t: "req", id, req })
    if (frame.length > MAX_FRAME) return Promise.reject(new RequestTooLargeError(req.op))
    const timeoutMs = this.spokeTimeoutMs(req)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RequestTimeoutError(req.op))
        this.released(connID)
      }, timeoutMs)
      this.pending.set(id, { connID, op: req.op, resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(frame)
    })
  }

  /**
   * Sends an op to a connected node and resolves with its result, checked with nodeResultProblem. In cluster mode a
   * node another pod holds is reached over pod RPC.
   */
  requestNode<R extends NodeRequest>(connID: string, req: R, options: RequestOptions = {}): Promise<NodeResultFor[R["op"]]> {
    const ws = this.sockets.get(connID)
    if (!ws && this.options.cluster) return this.remote({ kind: "node", connID, req, tenant: options.tenant ?? "" }) as Promise<NodeResultFor[R["op"]]>
    if (!ws?.data.ready || ws.data.role !== NODE_ROLE || this.draining) return Promise.reject(new NodeError("The node disconnected"))
    const id = `r${++this.seq}`
    const frame = encode({ t: "req", id, req } satisfies NodeServerMessage)
    if (frame.length > MAX_FRAME) return Promise.reject(new NodeError(`The ${req.op} request is too large to send to the node`))
    const timeoutMs = this.nodeTimeoutMs(req)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RequestTimeoutError(req.op, "The node"))
        this.released(connID)
      }, timeoutMs)
      this.pending.set(id, { connID, op: req.op, node: true, resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(frame)
    })
  }

  /** Disconnects the connections bound to a launch (when it ends), on every pod. */
  closeLaunch(launchID: string, reason = "launch ended"): void {
    this.closeLaunchHere(launchID, reason)
    this.publishClose({ kind: "launch", id: launchID, reason })
  }

  /** Disconnects every socket of a machine (after revocation), on every pod. */
  closeMachine(machineID: string, reason: string): void {
    this.closeMachineHere(machineID, reason)
    this.publishClose({ kind: "machine", id: machineID, reason })
  }

  /**
   * Draining (design §10): refuses new upgrades and requests, says bye{reason:"draining", retryAfterMs} to each
   * connection once its requests in flight are answered, and resolves when they all are (or at the deadline, when the
   * rest fail as offline and every connection gets its bye). Repeated calls share the first one.
   */
  drain(options: DrainOptions = {}): Promise<void> {
    this.drained ??= this.runDrain(options.retryAfterMs ?? DRAIN_RETRY_AFTER_MS, options.timeoutMs ?? DRAIN_TIMEOUT_MS)
    return this.drained
  }

  /** Whether drain() was called. */
  isDraining(): boolean {
    return this.draining !== undefined
  }

  private async runDrain(retryAfterMs: number, timeoutMs: number): Promise<void> {
    this.draining = { retryAfterMs }
    for (const ws of [...this.sockets.values()]) this.released(ws.data.connID)
    const deadline = Date.now() + timeoutMs
    while ((this.pending.size > 0 || this.remoteCalls > 0) && Date.now() < deadline) await Bun.sleep(Math.min(DRAIN_POLL_MS, Math.max(1, deadline - Date.now())))
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(pending.node ? new NodeError("The node disconnected") : new SpokeError("OpenCode process disconnected"))
    }
    for (const ws of [...this.sockets.values()]) this.byeDraining(ws)
  }

  /** Draining: a connection with no request in flight any more gets its bye. */
  private released(connID: string): void {
    if (!this.draining) return
    const ws = this.sockets.get(connID)
    if (!ws) return
    for (const pending of this.pending.values()) if (pending.connID === connID) return
    this.byeDraining(ws)
  }

  private byeDraining(ws: Socket): void {
    if (!this.draining || ws.data.drained) return
    ws.data.drained = true
    this.send(ws, { t: "bye", reason: "draining", retryAfterMs: this.draining.retryAfterMs })
    ws.close(CLOSE_DRAINING, "draining")
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat)
    clearInterval(this.recheckTimer)
    for (const ws of this.sockets.values()) if (!ws.data.drained) this.bye(ws, "server shutting down", 1001)
    const { cluster } = this.options
    if (!cluster) return
    // Best effort and bounded: the entries expire anyway, and an unreachable Valkey must not hold up shutdown.
    const cleanup = this.started.catch(() => undefined).then(() => Promise.allSettled([cluster.rpc.stop(), cluster.directory.stop()]))
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([cleanup, new Promise<void>((resolve) => (timer = setTimeout(resolve, CLUSTER_STOP_MS)))])
    clearTimeout(timer)
  }

  private closeLaunchHere(launchID: string, reason: string): void {
    this.closedLaunches.set(launchID, reason)
    if (this.closedLaunches.size > CLOSED_LAUNCHES) this.closedLaunches.delete(this.closedLaunches.keys().next().value!)
    for (const ws of this.sockets.values()) if (ws.data.launch?.launchID === launchID) this.bye(ws, reason, CLOSE_LAUNCH_ENDED)
  }

  private closeMachineHere(machineID: string, reason: string): void {
    for (const ws of this.sockets.values()) if (ws.data.machineID === machineID) this.bye(ws, reason, CLOSE_REVOKED)
  }

  /**
   * Cluster mode: re-reads the machines of this pod's ready sockets and their owners from the database and closes the
   * sockets of a revoked (or removed) machine or a disabled owner, in case the close notice from another pod was lost.
   */
  async recheck(): Promise<void> {
    const machineIDs = [...new Set([...this.sockets.values()].filter((ws) => ws.data.ready).map((ws) => ws.data.machineID))]
    if (!machineIDs.length) return
    const { store } = this.options
    try {
      await store.recheck({ machines: machineIDs, users: machineIDs.map((id) => this.ownerOf(id)) })
      // Ownership may have moved: the current owners too.
      await store.recheck({ users: machineIDs.map((id) => this.ownerOf(id)) })
    } catch (cause) {
      console.error(`[hub] machine re-check failed: ${cause instanceof Error ? cause.message : cause}`)
      return
    }
    for (const machineID of machineIDs) {
      const machine = store.machines().find((m) => m.id === machineID)
      const owner = machine && store.user(machine.ownerID)
      if (!machine || machine.revoked) this.closeMachineHere(machineID, "machine revoked")
      else if (!owner || owner.disabled) this.closeMachineHere(machineID, "account disabled")
    }
  }

  private publishClose(notice: Omit<CloseNotice, "from">): void {
    this.options.cluster?.rpc.publishClose(notice).catch((cause) => {
      console.error(`[hub] close notice not sent to the other pods: ${cause instanceof Error ? cause.message : cause}`)
    })
  }

  /** Cluster mode: heartbeat the directory, answer RPC for this pod's connections, apply other pods' close notices. */
  private async startCluster(): Promise<void> {
    const { cluster } = this.options
    if (!cluster) return
    await cluster.directory.start()
    await cluster.rpc.serve((call) => this.serveRpc(call))
    await cluster.rpc.onClose((notice) => {
      if (notice.from === cluster.directory.podID) return
      if (notice.kind === "machine") this.closeMachineHere(notice.id, notice.reason)
      else this.closeLaunchHere(notice.id, notice.reason)
    })
  }

  /** The hub-side wait for a spoke op. */
  private spokeTimeoutMs(req: ServerRequest): number {
    const base = this.options.requestTimeoutMs ?? 15_000
    return req.op === "turn"
      ? this.options.turnTimeoutMs + (this.options.turnGraceMs ?? TURN_GRACE_MS)
      : req.op === "create" && req.herdrWorkspace
        ? Math.max(base, CREATE_IN_HERDR_TIMEOUT_MS) // the spoke waits for OpenCode to start in the new tab
        : req.op === "autoName"
          ? Math.max(base, AUTO_NAME_TIMEOUT_MS)
          : base
  }

  private nodeTimeoutMs(req: NodeRequest): number {
    return this.options.nodeTimeoutsMs?.[req.op] ?? NODE_TIMEOUTS_MS[req.op] ?? this.options.requestTimeoutMs ?? 15_000
  }

  /** An op for a connection this pod does not hold: to the pod the directory names, over RPC. */
  private async remote(call: RpcCall): Promise<unknown> {
    const { directory, rpc } = this.options.cluster!
    if (encode({ t: "req", id: "r0", req: call.req } as ServerMessage).length > MAX_FRAME) {
      throw call.kind === "node" ? new NodeError(`The ${call.req.op} request is too large to send to the node`) : new RequestTooLargeError(call.req.op)
    }
    const entry = await directory.lookup(call.connID)
    if (!entry || entry.pod === directory.podID) throw offlineError(call.kind)
    const tenant = call.tenant || this.ownerOf(entry.machineID)
    if (!tenant) throw offlineError(call.kind)
    const timeoutMs = call.kind === "node" ? this.nodeTimeoutMs(call.req) : this.spokeTimeoutMs(call.req)
    this.remoteCalls++
    try {
      return await rpc.call(entry.pod, { ...call, tenant } as RpcCall, timeoutMs, {
        onGone: () => void directory.forget(call.connID, entry.pod).catch(() => undefined),
      })
    } finally {
      this.remoteCalls--
    }
  }

  /** An op from another pod for a connection here: re-check the tenant, then send it like a local one. */
  private async serveRpc(call: RpcCall): Promise<unknown> {
    const ws = this.sockets.get(call.connID)
    if (!ws?.data.ready) throw offlineError(call.kind)
    const machine = this.options.store.machines().find((m) => m.id === ws.data.machineID)
    if (!machine || machine.revoked || machine.ownerID !== call.tenant) throw offlineError(call.kind)
    const sessionID = (call.req as { sessionID?: unknown }).sessionID
    if (typeof sessionID === "string") {
      const owner = this.options.registry.sessionTenant(sessionID)
      if (owner !== undefined && owner !== call.tenant) throw new SpokeError("Unknown session")
    }
    return call.kind === "node" ? this.requestNode(call.connID, call.req) : this.request(call.connID, call.req)
  }

  private open(ws: Socket): void {
    this.sockets.set(ws.data.connID, ws)
    // Upgraded just before drain(): send it on its way too.
    if (this.draining) return this.byeDraining(ws)
    if (ws.data.launch) {
      const closed = this.closedLaunches.get(ws.data.launch.launchID)
      if (closed !== undefined) return this.bye(ws, closed, CLOSE_LAUNCH_ENDED)
      this.armExpiry(ws, ws.data.launch.exp)
    }
    ws.data.helloTimer = setTimeout(() => {
      if (!ws.data.ready) this.bye(ws, "hello timeout")
    }, this.options.helloTimeoutMs ?? 10_000)
  }

  /** Closes a launch-bound connection at its token's expiry. */
  private armExpiry(ws: Socket, exp: number): void {
    const left = exp - Date.now()
    if (left <= 0) return this.bye(ws, "launch token expired", CLOSE_LAUNCH_EXPIRED)
    ws.data.expiryTimer = setTimeout(() => this.armExpiry(ws, exp), Math.min(left, MAX_TIMER_MS))
    ws.data.expiryTimer.unref?.()
  }

  private seen(ws: Socket): void {
    ws.data.lastSeen = Date.now()
    if (!ws.data.ready) return
    if (ws.data.role === NODE_ROLE) this.options.nodes.touch(ws.data.connID)
    else this.options.registry.touch(ws.data.connID)
  }

  private message(ws: Socket, raw: string | Buffer): void {
    this.seen(ws)
    if (ws.data.ready ? ws.data.role === NODE_ROLE : helloRole(raw) === NODE_ROLE) {
      // A launch token is for that launch's spoke only.
      if (ws.data.launch) return this.bye(ws, "protocol error")
      return this.nodeMessage(ws, raw)
    }
    const message = parseSpokeMessage(raw)
    if (!message) return this.bye(ws, "protocol error")
    const { registry } = this.options
    const { connID } = ws.data

    if (!ws.data.ready) {
      if (message.t !== "hello") return this.bye(ws, "protocol error")
      if (message.v !== PROTOCOL_VERSION) {
        return this.bye(ws, `unsupported protocol version ${message.v}; server speaks version ${PROTOCOL_VERSION}`)
      }
      const { launch } = ws.data
      if (launch) {
        if (message.launchID !== launch.launchID) return this.bye(ws, "the hello does not name the launch of this token")
        // One connection per launch: a reconnect (the old socket may be half-open) replaces the old one.
        const old = registry.launchConn(launch.launchID)
        if (old !== undefined) {
          registry.disconnect(old)
          const oldWs = this.sockets.get(old)
          if (oldWs) this.bye(oldWs, "replaced by a new connection of this launch", CLOSE_REPLACED)
        }
      }
      clearTimeout(ws.data.helloTimer)
      ws.data.ready = true
      ws.data.role = "spoke"
      registry.connect(connID, { id: ws.data.machineID, name: ws.data.machineName }, message, launch ? { launchID: launch.launchID } : {})
      this.registerConn(ws)
      void this.options.store.touchMachine(ws.data.machineID)
      // Older spokes ignore `features`; newer ones send a request a feature adds only when it is listed here.
      this.send(ws, { t: "welcome", v: PROTOCOL_VERSION, machineID: ws.data.machineID, publicURL: this.options.publicURL, features: [...HUB_FEATURES] })
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
      case "res":
        return this.settle(connID, message)
      case "bye":
        ws.close(1000, "bye")
        return
    }
  }

  /** A frame from a node (or a node hello). */
  private nodeMessage(ws: Socket, raw: string | Buffer): void {
    const message = parseNodeMessage(raw)
    if (!message) return this.bye(ws, "protocol error")
    const { nodes } = this.options
    const { connID } = ws.data
    if (!ws.data.ready) {
      if (message.t !== "hello") return this.bye(ws, "protocol error")
      return this.nodeHello(ws, message)
    }
    switch (message.t) {
      case "hello":
        return this.bye(ws, "protocol error")
      case "capacity":
        return nodes.setCapacity(connID, message)
      case "progress":
        return nodes.progress(connID, message)
      case "res":
        return this.settle(connID, message)
      case "bye":
        ws.close(1000, "bye")
        return
    }
  }

  private nodeHello(ws: Socket, hello: NodeHello): void {
    if (hello.v !== PROTOCOL_VERSION) return this.bye(ws, `unsupported protocol version ${hello.v}; server speaks version ${PROTOCOL_VERSION}`)
    const { nodes } = this.options
    // This pod's node of the machine only: a stale entry of another pod expires with its slice.
    const existing = nodes.localForMachine(ws.data.machineID)
    if (existing) {
      // One node per machine. The same daemon run reconnecting (its old socket may be half-open) replaces it.
      if (existing.instanceID !== hello.instanceID) return this.bye(ws, "another node is already connected for this machine")
      nodes.disconnect(existing.connID)
      const old = this.sockets.get(existing.connID)
      if (old) this.bye(old, "replaced by a new connection of this node", CLOSE_REPLACED)
    }
    clearTimeout(ws.data.helloTimer)
    ws.data.ready = true
    ws.data.role = NODE_ROLE
    nodes.connect(ws.data.connID, { id: ws.data.machineID, name: ws.data.machineName }, hello)
    this.registerConn(ws)
    void this.options.store.touchMachine(ws.data.machineID)
    this.send(ws, { t: "welcome", v: PROTOCOL_VERSION, machineID: ws.data.machineID, publicURL: this.options.publicURL, features: [...HUB_FEATURES] })
  }

  /** Resolves or rejects the pending request a `res` frame answers. */
  private settle(connID: string, message: { readonly id: string; readonly ok: boolean; readonly result?: unknown; readonly error?: string }): void {
    const pending = this.pending.get(message.id)
    if (!pending || pending.connID !== connID) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    // Draining: once the result is handed on, this connection may get its bye.
    queueMicrotask(() => this.released(connID))
    if (pending.node) {
      if (!message.ok) return pending.reject(new NodeError(message.error || `The node's ${pending.op} request failed`))
      const problem = nodeResultProblem(pending.op as NodeOp, message.result)
      if (problem) return pending.reject(new NodeError(`The node sent an invalid ${pending.op} result: ${problem}`))
      return pending.resolve(message.result)
    }
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new SpokeError(message.error || `OpenCode ${pending.op} request failed`))
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
    // A sandboxed harness never gets credentials for the owner's devices or console.
    if (ws.data.launch && (req.op === "pairCode" || req.op === "openLink")) throw new Error("Not available to a launch-bound session")
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
        return { notified: await this.options.notifier.notify("handoff", req.sessionID, title, undefined, owner) }
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
    clearTimeout(ws.data.expiryTimer)
    const { connID } = ws.data
    this.sockets.delete(connID)
    for (const [id, pending] of this.pending) {
      if (pending.connID !== connID) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(pending.node ? new NodeError("The node disconnected") : new SpokeError("OpenCode process disconnected"))
    }
    if (!ws.data.ready) return
    this.options.cluster?.directory.unregister(connID).catch((cause) => {
      console.error(`[hub] directory entry not removed: ${cause instanceof Error ? cause.message : cause}`)
    })
    if (ws.data.role === NODE_ROLE) this.options.nodes.disconnect(connID)
    else this.options.registry.disconnect(connID)
  }

  /** Cluster mode: records a ready connection in the directory, so other pods route its ops here. */
  private registerConn(ws: Socket): void {
    this.options.cluster?.directory.register(ws.data.connID, ws.data.machineID).catch((cause) => {
      console.error(`[hub] directory entry not written: ${cause instanceof Error ? cause.message : cause}`)
    })
  }

  private bye(ws: Socket, reason: string, code = CLOSE_PROTOCOL): void {
    this.send(ws, { t: "bye", reason })
    ws.close(code, reason)
  }

  private send(ws: Socket, message: ServerMessage | NodeServerMessage): void {
    ws.send(encode(message))
  }
}

/** What a request to a connection that is gone rejects with. */
function offlineError(kind: RpcCall["kind"]): Error {
  return kind === "node" ? new NodeError("The node disconnected") : new SpokeError("OpenCode process disconnected")
}
