// HarnessSpoke: the base of a spoke for a harness other than OpenCode (design §1.1, §13.2). It owns the hub
// connection (SpokeConnection) and does what every such spoke must do the same way:
//
// - hello: harness, version, evidence, and exactly the ops it has handlers for (core ops included: a non-OpenCode
//   hello implies none), so the hub sends only those;
// - op dispatch: an op (or an op option) it did not announce is refused with a clear error, as is an op for a
//   session it does not report (a hub that predates announced core ops sends them anyway);
// - sessions: the sessions frame on every change and after every welcome; with `livenessMs`, a session that
//   shows no sign of life (upsert, touch, emitted event) for that long is dropped by prune();
// - emit: only events of the harness subset with valid data (harnessEventProblem), never anything else;
// - tokens: the session and act tokens the hub sends, in memory, kept apart, for reported sessions only, dropped
//   when the session ends; no token (nor the machine token) is ever logged, serialised or inspected;
// - deliver: each hub message admitted once per messageID (DeliveryLedger), whatever the harness does with a retry.
//
// Session IDs are hub IDs: map native ones with hubSessionID first.
import {
  CORE_OPS,
  encode,
  featureForOp,
  harnessEventProblem,
  isHubSessionID,
  parseSpokeMessage,
  requestFeatures,
  type HarnessEvent,
  type ResultFor,
  type ServerRequest,
  type SessionInfo,
  type SessionToken,
  type SessionTokenSkipReason,
  type SpokeFeature,
} from "../../protocol/src/index.ts"
import { SpokeConnection, type ConnectionOptions, type ConnectionState } from "./connection.ts"
import { DeliveryLedger, type Admission } from "./delivery.ts"
import { buildHarnessHello, type HarnessHelloOptions } from "./harness-hello.ts"
import { SessionTokenStore } from "./session-tokens.ts"

const INSPECT = Symbol.for("nodejs.util.inspect.custom")

type Op = ServerRequest["op"]
/** Ops the spoke itself serves for every harness (tokens and deliver's idempotency); the rest need a handler. */
export type HandledOp = Exclude<Op, "sessionTokens" | "actTokens" | "deliver">
export type OpHandler<O extends HandledOp> = (req: Extract<ServerRequest, { op: O }>) => Promise<ResultFor[O]> | ResultFor[O]
export type OpHandlers = { readonly [O in HandledOp]?: OpHandler<O> }
export type DeliverRequest = Extract<ServerRequest, { op: "deliver" }>
/** Features that change how an op is served rather than adding one; each needs the op it modifies. */
export type ModifierFeature = "permissionMessage" | "launch" | "hubPrompt"

export interface HarnessSpokeOptions extends Omit<HarnessHelloOptions, "ops" | "features"> {
  readonly server: string
  /** The machine token. Sent only as the WebSocket's bearer; never logged or serialised. */
  readonly token: string
  readonly handlers?: OpHandlers
  /** Admits a hub message into a session (feature "deliver"); run once per messageID (DeliveryLedger). */
  readonly deliver?: (req: DeliverRequest) => Promise<Admission>
  readonly features?: readonly ModifierFeature[]
  /** Drop a session after this long without a sign of life (prune); 0 or absent: never. */
  readonly livenessMs?: number
  readonly now?: () => number
  readonly socket?: ConnectionOptions["socket"]
  readonly backoff?: ConnectionOptions["backoff"]
  readonly requestTimeoutMs?: number
  readonly onState?: ConnectionOptions["onState"]
}

const MODIFIER_NEEDS: Record<ModifierFeature, string> = { permissionMessage: "permission", launch: "create", hubPrompt: "deliver" }
const ALWAYS: readonly SpokeFeature[] = ["sessionTokens", "actTokens"]
const CORE: readonly string[] = CORE_OPS

export class HarnessSpoke {
  /** Every feature the hello announces (core ops first). */
  readonly features: readonly SpokeFeature[]
  readonly harness: string

  readonly #handlers: OpHandlers
  readonly #deliver?: HarnessSpokeOptions["deliver"]
  readonly #announced: ReadonlySet<string>
  readonly #connection: SpokeConnection
  readonly #sessions = new Map<string, { info: SessionInfo; seen: number }>()
  readonly #livenessMs: number
  readonly #now: () => number
  readonly #sessionTokens: SessionTokenStore
  readonly #actTokens: SessionTokenStore
  readonly #ledger = new DeliveryLedger()

  constructor(options: HarnessSpokeOptions) {
    this.harness = options.harness
    this.#handlers = options.handlers ?? {}
    this.#deliver = options.deliver
    this.#livenessMs = options.livenessMs ?? 0
    this.#now = options.now ?? Date.now
    this.#sessionTokens = new SessionTokenStore(this.#now)
    this.#actTokens = new SessionTokenStore(this.#now)
    const handled = (Object.keys(this.#handlers) as HandledOp[]).filter((op) => typeof this.#handlers[op] === "function")
    if (handled.includes("modelPrefs") !== handled.includes("setModelPrefs")) throw new Error("The modelPrefs feature needs both a modelPrefs and a setModelPrefs handler")
    const ops = handled.filter((op) => CORE.includes(op)) as (typeof CORE_OPS)[number][]
    const served = new Set<string>(handled)
    if (this.#deliver) served.add("deliver")
    const modifiers = [...new Set(options.features ?? [])]
    for (const feature of modifiers) {
      const needs = MODIFIER_NEEDS[feature]
      if (!needs) throw new Error(`Unknown modifier feature ${JSON.stringify(feature)}`)
      if (!served.has(needs)) throw new Error(`The ${feature} feature needs a ${needs} handler`)
    }
    const optional = [...new Set(handled.filter((op) => !CORE.includes(op)).map((op) => featureForOp(op)))]
    const hello = buildHarnessHello({ ...options, ops, features: [...optional, ...(this.#deliver ? ["deliver" as const] : []), ...ALWAYS, ...modifiers] })
    this.features = hello.features as SpokeFeature[]
    this.#announced = new Set(this.features)
    this.#connection = new SpokeConnection({
      server: options.server,
      token: options.token,
      hello: () => hello,
      handle: (req) => this.dispatch(req),
      onWelcome: () => this.#sendSessions(),
      ...(options.onState ? { onState: options.onState } : {}),
      ...(options.backoff ? { backoff: options.backoff } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.socket ? { socket: options.socket } : {}),
    })
  }

  get state(): ConnectionState {
    return this.#connection.state
  }

  start(): void {
    this.#connection.start()
  }

  stop(): void {
    this.#connection.stop()
  }

  retryNow(): void {
    this.#connection.retryNow()
  }

  /** Whether the connected hub announced `feature` in its welcome. */
  hubSupports(feature: string): boolean {
    return this.#connection.hubSupports(feature)
  }

  /** Runs a hub request: refuses unannounced ops and unknown sessions, then calls the op's handler. */
  async dispatch(req: ServerRequest): Promise<unknown> {
    for (const feature of requestFeatures(req)) {
      if (!this.#announced.has(feature)) throw new Error(`The ${this.harness} spoke does not serve "${feature}" (not announced in its hello)`)
    }
    if ("sessionID" in req && !this.#sessions.has(req.sessionID)) throw new Error(`Unknown session ${req.sessionID}: this ${this.harness} spoke does not report it`)
    switch (req.op) {
      case "sessionTokens":
        if (req.hubURL !== undefined) this.#sessionTokens.hubURL = req.hubURL
        return this.#storeTokens(this.#sessionTokens, req.tokens)
      case "actTokens":
        return this.#storeTokens(this.#actTokens, req.tokens)
      case "deliver": {
        const deliver = this.#deliver!
        return this.#ledger.run(req.messageID, req.wake, () => deliver(req))
      }
    }
    const handler = this.#handlers[req.op as HandledOp] as ((r: ServerRequest) => unknown) | undefined
    if (!handler) throw new Error(`The ${this.harness} spoke has no handler for "${req.op}"`)
    return await handler(req)
  }

  /** Reports a session (new or changed) and counts as a sign of life. Its IDs must be hub session IDs. */
  upsertSession(info: SessionInfo): void {
    if (!isHubSessionID(info?.id)) throw new Error(`Session id must be a hub session ID (ses_ + letters and digits; map native IDs with hubSessionID), got ${JSON.stringify(info?.id)}`)
    if (info.parentID !== undefined && !isHubSessionID(info.parentID)) throw new Error(`Session parentID must be a hub session ID, got ${JSON.stringify(info.parentID)}`)
    if (!parseSpokeMessage(encode({ t: "sessions", sessions: [info] }))) throw new Error(`Session ${info.id} is not a valid session for the hub (see the protocol's SessionInfo)`)
    this.#sessions.set(info.id, { info, seen: this.#now() })
    this.#sendSessions()
  }

  /** A sign of life from a session (keeps it from being pruned). */
  touch(sessionID: string): void {
    const entry = this.#sessions.get(sessionID)
    if (entry) entry.seen = this.#now()
  }

  /** The session ended: it is no longer reported and its tokens are dropped. */
  endSession(sessionID: string): void {
    this.#dropTokens(sessionID)
    if (this.#sessions.delete(sessionID)) this.#sendSessions()
  }

  /**
   * The session's current session token (for its shells: `hub` there acts as the session) and the URL they reach
   * the hub at. Hand it to the harness's process environment only, never to a log.
   */
  sessionToken(sessionID: string): { token: string; url?: string } | undefined {
    const entry = this.#sessionTokens.get(sessionID)
    if (!entry) return undefined
    const url = this.#sessionTokens.hubURL ?? this.#connection.publicURL
    return { token: entry.token, ...(url !== undefined ? { url } : {}) }
  }

  /** The session's act token (act verbs only; never in any environment) and the hub's URL. */
  actToken(sessionID: string): { token: string; url: string } | undefined {
    const entry = this.#actTokens.get(sessionID)
    const url = this.#sessionTokens.hubURL ?? this.#connection.publicURL
    return entry && url !== undefined ? { token: entry.token, url } : undefined
  }

  toJSON(): { harness: string; state: ConnectionState; sessions: number; features: readonly SpokeFeature[] } {
    return { harness: this.harness, state: this.state, sessions: this.#sessions.size, features: this.features }
  }

  toString(): string {
    return `HarnessSpoke(${this.harness}, ${this.state}, ${this.#sessions.size} sessions)`
  }

  [INSPECT](): string {
    return this.toString()
  }

  sessions(): SessionInfo[] {
    return [...this.#sessions.values()].map((e) => e.info)
  }

  /** Drops sessions without a sign of life for livenessMs (none when it is 0); returns their IDs. */
  prune(): string[] {
    if (this.#livenessMs <= 0) return []
    const cutoff = this.#now() - this.#livenessMs
    const dropped = [...this.#sessions].filter(([, e]) => e.seen < cutoff).map(([id]) => id)
    for (const id of dropped) {
      this.#sessions.delete(id)
      this.#dropTokens(id)
    }
    if (dropped.length) this.#sendSessions()
    return dropped
  }

  /** Sends a harness event (T1 subset, validated); throws on an invalid one. False when it could not be sent. */
  emit(event: HarnessEvent): boolean {
    const problem = harnessEventProblem(event)
    if (problem) throw new Error(`Invalid harness event${typeof (event as { type?: unknown })?.type === "string" ? ` ${(event as { type: string }).type}` : ""}: ${problem}`)
    const sessionID = (event.data as { sessionID?: unknown }).sessionID
    if (typeof sessionID === "string") this.touch(sessionID)
    return this.#connection.send({ t: "event", event })
  }

  #storeTokens(store: SessionTokenStore, tokens: readonly SessionToken[]): ResultFor["sessionTokens"] {
    const applied: string[] = []
    const skipped: { sessionID: string; reason: SessionTokenSkipReason }[] = []
    for (const { sessionID, token, exp } of tokens) {
      if (!this.#sessions.has(sessionID)) skipped.push({ sessionID, reason: "unknown" })
      else if (store.set(sessionID, token, exp)) applied.push(sessionID)
      else skipped.push({ sessionID, reason: "expired" })
    }
    return { applied, skipped }
  }

  #dropTokens(sessionID: string): void {
    this.#sessionTokens.delete(sessionID)
    this.#actTokens.delete(sessionID)
  }

  #sendSessions(): void {
    this.#connection.send({ t: "sessions", sessions: this.sessions() })
  }
}
