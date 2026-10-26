// CodexSessions: the Codex spoke's view of the threads it is attached to (P7-T7a; spike v0hsdqhm). The spoke is one
// client of a Codex app-server among others (the TUI, the desktop app): it reports each thread it attached to as a
// hub session (ses_cx<thread uuid>), turns the app-server's notifications into the harness event subset, and serves
// the hub's ops through app-server methods.
//
// Events (protocol harness-events.ts):
// - thread/status/changed active|idle → session.status busy|idle; turn/started → session.execution.started;
//   turn/completed → the reply (session.text.ended: the turn's last agent message), then succeeded, failed or
//   interrupted, as Codex confirms it (the spoke announces turnEvents: the hub trusts its rpc evidence for idle).
// - item/started userMessage → session.inbox.delivered: origin "hub" for input the spoke sent for a hub message
//   (matched by clientUserMessageId, which Codex echoes as the item's clientId), else "user" (typed in the TUI, or
//   the hub's own turn/steer ops, which are the user's).
// - tool items (commands, file changes, MCP and dynamic tools, web searches) → session.tool.called/success/failed,
//   compacted to an ID and a short summary.
// - thread/name/updated → session.renamed; thread/archived|deleted → session.deleted; closed → no longer reported.
//
// Permission: an approval request (item/commandExecution|fileChange/requestApproval) goes to every client of the
// thread and the first answer wins. The spoke asks the hub (permission.asked) and answers with the hub's decision;
// when another client answered first (serverRequest/resolved), the request is gone (permission.replied without a
// reply, and the hub's later answer gets {gone: true}). Other server requests (forms, MCP elicitations) are left to
// the other clients.
//
// Deliver (each messageID once: HarnessSpoke's DeliveryLedger, since Codex's queue does not deduplicate):
// wake false → thread/inject_items (into the context, no turn): "queued". Wake on a busy thread → turn/steer into
// the running turn ("steer"), or with delivery "queue" held until the turn ends and then started as the next turn
// ("queued"); on an idle thread → turn/start ("turn").
import { statSync } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import {
  HARNESS_ERROR_MAX,
  HARNESS_SUMMARY_MAX,
  HARNESS_TEXT_MAX,
  HARNESS_TITLE_MAX,
  type CreateRequest,
  type DeliverRequest,
  type HarnessEvent,
  type PermissionDecision,
  type PromptImage,
  type ResultFor,
  type ServerRequest,
  type SessionInfo,
  type TurnResult,
} from "../../protocol/src/index.ts"
import { deliverText, type Admission } from "../../spoke-sdk/src/index.ts"
import { codexSessionID, codexThreadID, plainID, requestKey } from "./ids.ts"
import { LOCAL_ERROR, RpcError, type RpcID } from "./jsonrpc.ts"

/** What CodexSessions needs of the hub connection (HarnessSpoke). */
export interface SpokePort {
  upsertSession(info: SessionInfo): void
  endSession(id: string): void
  emit(event: HarnessEvent): boolean
}

/** One app-server connection (initialized), named so its request IDs stay apart from another's. */
export interface AppServerPort {
  readonly name: string
  request(method: string, params?: unknown): Promise<any>
  respond(id: RpcID, result: unknown): void
}

/** A thread as the app-server describes it (Thread, from thread/start, thread/resume, thread/read). */
export interface ThreadDescription {
  readonly id: string
  readonly cwd?: string
  readonly name?: string | null
  readonly preview?: string | null
  readonly status?: unknown
}

export interface SessionsOptions {
  readonly spoke: SpokePort
  /** The app-server the spoke starts its own threads on (create). */
  readonly createServer: () => Promise<AppServerPort>
  /** Extra thread/start parameters for created threads (e.g. approvalPolicy in tests). */
  readonly threadDefaults?: Readonly<Record<string, unknown>>
  /** How long the turn op waits for the turn to end (default 10 min). */
  readonly turnTimeoutMs?: number
  /** The project (workspace root) of a directory; default: the nearest directory with .git. */
  readonly projectOf?: (cwd: string) => string | undefined
  readonly now?: () => number
  readonly log?: (line: string) => void
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000
const DEFAULT_TITLE = "Codex session"
const TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"])
const APPROVALS: Record<string, "shell" | "edit"> = { "item/commandExecution/requestApproval": "shell", "item/fileChange/requestApproval": "edit" }
const RECENT_TURNS = 50

type Origin = "user" | "hub"
type TurnEnd = { readonly status: string; readonly error?: string }

interface TurnWaiter {
  resolve(end: TurnEnd): void
}

interface Queued {
  readonly inboxID: string
  readonly text: string
}

interface Thread {
  readonly id: string
  readonly hubID: string
  readonly conn: AppServerPort
  readonly cwd: string
  title: string
  busy: boolean
  turnID?: string
  reply?: { readonly id: string; readonly text: string }
  /** Tool items of the running turns (for approvals' resources and the tools' end). */
  readonly items: Map<string, { readonly type: string; readonly paths: readonly string[] }>
  /** clientUserMessageIds of input the spoke sent → whose it is. */
  readonly inputs: Map<string, Origin>
  /** Hub messages waiting for the running turn to end (delivery "queue"). */
  readonly queue: Queued[]
  /** Hub messages injected without waking (messageID → inboxID). */
  readonly injected: Map<string, string>
  readonly waiters: Map<string, TurnWaiter>
  readonly ended: Map<string, TurnEnd>
}

interface Approval {
  readonly conn: AppServerPort
  readonly rpcID: RpcID
  readonly threadID: string
  readonly available?: readonly unknown[]
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const inboxID = () => `inb_${randomBytes(9).toString("hex")}`
const textInput = (text: string) => ({ type: "text", text, text_elements: [] })

/** The nearest directory from `cwd` up that holds .git (a repository or worktree root). */
export function gitRoot(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    try {
      statSync(path.join(dir, ".git"))
      return dir
    } catch {}
    if (path.dirname(dir) === dir) return undefined
  }
}

/** A command as the user typed it: Codex wraps it in `/bin/bash -lc '<command>'`. */
export function unwrapCommand(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+'([\s\S]*)'$/.exec(command.trim())
  return wrapped ? wrapped[1]!.replace(/'\\''/g, "'") : command.trim()
}

/** A tool item's short summary (no raw input or output). */
export function toolSummary(item: Record<string, any>): string | undefined {
  let summary: string | undefined
  switch (item.type) {
    case "commandExecution":
      summary = typeof item.command === "string" ? unwrapCommand(item.command) : undefined
      break
    case "fileChange":
      summary = changedPaths(item).join(", ") || undefined
      break
    case "mcpToolCall":
      summary = [str(item.server), str(item.tool)].filter(Boolean).join("_") || undefined
      break
    case "dynamicToolCall":
      summary = str(item.tool)
      break
    case "webSearch":
      summary = str(item.query)
      break
  }
  return summary === undefined ? undefined : cut(summary.replace(/\s+/g, " "), HARNESS_SUMMARY_MAX)
}

const changedPaths = (item: Record<string, any>): string[] =>
  Array.isArray(item.changes) ? item.changes.flatMap((c: unknown) => (isObj(c) && typeof c.path === "string" ? [c.path] : [])) : []

/** The approval decision for the hub's decision, among those the request offers (all, when it lists none). */
export function approvalDecision(decision: PermissionDecision, available: readonly unknown[] | undefined): unknown {
  const offers = (d: string) => !available || available.includes(d)
  switch (decision) {
    case "once":
      return "accept"
    case "always": {
      if (offers("acceptForSession")) return "acceptForSession"
      const amendment = available?.find((d) => isObj(d) && "acceptWithExecpolicyAmendment" in d)
      return amendment ?? "accept"
    }
    case "reject":
      return offers("decline") ? "decline" : "cancel"
  }
}

export class CodexSessions {
  readonly #spoke: SpokePort
  readonly #createServer: SessionsOptions["createServer"]
  readonly #threadDefaults: Readonly<Record<string, unknown>>
  readonly #turnTimeoutMs: number
  readonly #projectOf: (cwd: string) => string | undefined
  readonly #now: () => number
  readonly #log: (line: string) => void
  /** By native thread ID. */
  readonly #threads = new Map<string, Thread>()
  /** By hub request ID (requestKey). */
  readonly #approvals = new Map<string, Approval>()

  constructor(options: SessionsOptions) {
    this.#spoke = options.spoke
    this.#createServer = options.createServer
    this.#threadDefaults = options.threadDefaults ?? {}
    this.#turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.#projectOf = options.projectOf ?? gitRoot
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => {})
  }

  has(sessionID: string): boolean {
    const id = codexThreadID(sessionID)
    return id !== undefined && this.#threads.has(id)
  }

  /** Whether the spoke reports this thread (on any connection). */
  hasThread(threadID: string): boolean {
    return this.#threads.has(threadID.toLowerCase())
  }

  /** Reports a thread the spoke is subscribed to on `conn` (after thread/start or thread/resume). */
  attach(conn: AppServerPort, thread: ThreadDescription, title?: string): string {
    const id = thread.id.toLowerCase()
    const known = this.#threads.get(id)
    if (known) return known.hubID
    const entry: Thread = {
      id,
      hubID: codexSessionID(id),
      conn,
      cwd: thread.cwd || "/",
      title: cut((title ?? str(thread.name) ?? str(thread.preview)?.replace(/\s+/g, " ").trim()) || DEFAULT_TITLE, HARNESS_TITLE_MAX),
      busy: false,
      items: new Map(),
      inputs: new Map(),
      queue: [],
      injected: new Map(),
      waiters: new Map(),
      ended: new Map(),
    }
    this.#threads.set(id, entry)
    this.#report(entry)
    this.#emit({ type: "session.created", data: { sessionID: entry.hubID, title: entry.title } })
    if (isObj(thread.status) && thread.status.type === "active") this.#setBusy(entry, true)
    return entry.hubID
  }

  /** The connection closed: its threads are no longer reported, its requests are gone. */
  connectionClosed(conn: AppServerPort): void {
    for (const thread of [...this.#threads.values()]) if (thread.conn === conn) this.#end(thread, false)
    for (const [key, approval] of this.#approvals) if (approval.conn === conn) this.#approvals.delete(key)
  }

  notification(conn: AppServerPort, method: string, params: unknown): void {
    if (!isObj(params) || typeof params.threadId !== "string") return
    const thread = this.#threads.get(params.threadId.toLowerCase())
    if (!thread || thread.conn !== conn) return
    switch (method) {
      case "thread/status/changed": {
        const type = isObj(params.status) ? params.status.type : undefined
        if (type === "active") this.#setBusy(thread, true)
        else if (type === "idle" || type === "systemError") this.#setBusy(thread, false)
        else if (type === "notLoaded") this.#end(thread, false)
        return
      }
      case "turn/started": {
        const turnID = isObj(params.turn) ? str(params.turn.id) : undefined
        if (!turnID) return
        thread.turnID = turnID
        thread.reply = undefined
        this.#emit({ type: "session.execution.started", data: { sessionID: thread.hubID, turnID: plainID(turnID) } })
        return
      }
      case "turn/completed":
        return this.#turnCompleted(thread, params.turn)
      case "item/started":
        return this.#itemStarted(thread, params)
      case "item/completed":
        return this.#itemCompleted(thread, params)
      case "thread/name/updated": {
        const name = str(params.threadName)?.trim()
        if (!name) return
        thread.title = cut(name, HARNESS_TITLE_MAX)
        this.#report(thread)
        this.#emit({ type: "session.renamed", data: { sessionID: thread.hubID, title: thread.title } })
        return
      }
      case "thread/archived":
      case "thread/deleted":
        return this.#end(thread, true)
      case "thread/closed":
        return this.#end(thread, false)
      case "serverRequest/resolved": {
        const rpcID = params.requestId
        if (typeof rpcID !== "number" && typeof rpcID !== "string") return
        const key = requestKey(conn.name, rpcID)
        if (!this.#approvals.delete(key)) return
        this.#emit({ type: "permission.replied", data: { sessionID: thread.hubID, requestID: key } })
        return
      }
    }
  }

  /** A request the app-server sent its clients; true when the spoke took it up (an approval for a known thread). */
  serverRequest(conn: AppServerPort, rpcID: RpcID, method: string, params: unknown): boolean {
    const action = APPROVALS[method]
    if (!action || !isObj(params) || typeof params.threadId !== "string") return false
    const thread = this.#threads.get(params.threadId.toLowerCase())
    if (!thread || thread.conn !== conn) return false
    const key = requestKey(conn.name, rpcID)
    const itemID = str(params.itemId)
    const item = itemID ? thread.items.get(itemID) : undefined
    const resources =
      action === "shell"
        ? [typeof params.command === "string" ? params.command : ""].filter(Boolean)
        : item?.paths.length
          ? [...item.paths]
          : [str(params.grantRoot) ?? thread.cwd]
    this.#approvals.set(key, { conn, rpcID, threadID: thread.id, ...(Array.isArray(params.availableDecisions) ? { available: params.availableDecisions } : {}) })
    const turnID = str(params.turnId) ?? thread.turnID
    this.#emit({
      type: "permission.asked",
      data: {
        sessionID: thread.hubID,
        id: key,
        action,
        resources: resources.slice(0, 100).map((r) => cut(r, 4000)),
        ...(itemID && turnID ? { source: { type: "tool" as const, messageID: plainID(turnID), id: plainID(itemID) } } : {}),
      },
    })
    return true
  }

  // ---- ops ------------------------------------------------------------------------------------------------------

  async permission(req: Extract<ServerRequest, { op: "permission" }>): Promise<ResultFor["permission"]> {
    const approval = this.#approvals.get(req.requestID)
    const thread = this.#thread(req.sessionID)
    if (!approval || approval.threadID !== thread.id) return { gone: true }
    this.#approvals.delete(req.requestID)
    approval.conn.respond(approval.rpcID, { decision: approvalDecision(req.decision, approval.available) })
    this.#emit({ type: "permission.replied", data: { sessionID: thread.hubID, requestID: req.requestID, reply: req.decision } })
    return {}
  }

  async turn(req: Extract<ServerRequest, { op: "turn" }>): Promise<TurnResult> {
    const thread = this.#thread(req.sessionID)
    if (thread.turnID) throw new Error("The Codex session is busy (a turn is running); steer it instead")
    const turnID = await this.#startTurn(thread, input(req.text, req.images), "user")
    const end = await this.#waitTurn(thread, turnID)
    const reply = thread.reply?.text ?? ""
    if (!end) return { outcome: "timeout", reply }
    if (end.status === "completed") return { outcome: "succeeded", reply }
    return { outcome: end.status === "interrupted" ? "interrupted" : "failed", message: end.error ?? (end.status === "interrupted" ? "Interrupted" : "The turn failed"), reply }
  }

  async steer(req: Extract<ServerRequest, { op: "steer" }>): Promise<ResultFor["steer"]> {
    const thread = this.#thread(req.sessionID)
    const id = inboxID()
    await this.#steerOrStart(thread, input(req.text, req.images), "user", id)
    return { inboxID: id }
  }

  async interrupt(req: Extract<ServerRequest, { op: "interrupt" }>): Promise<ResultFor["interrupt"]> {
    const thread = this.#thread(req.sessionID)
    if (thread.turnID) await thread.conn.request("turn/interrupt", { threadId: thread.id, turnId: thread.turnID })
    return {}
  }

  async stop(req: Extract<ServerRequest, { op: "stop" }>): Promise<ResultFor["stop"]> {
    const thread = this.#thread(req.sessionID)
    if (!thread.turnID) return { stopped: [] }
    await thread.conn.request("turn/interrupt", { threadId: thread.id, turnId: thread.turnID })
    return { stopped: [thread.hubID] }
  }

  async deliver(req: DeliverRequest): Promise<Admission> {
    const thread = this.#thread(req.sessionID)
    const injected = thread.injected.get(req.messageID)
    const text = injected ? `[hub] Message ${req.messageID} was delivered to this session above; read it and act on it.` : deliverText(req)
    if (!req.wake) {
      const id = inboxID()
      await thread.conn.request("thread/inject_items", { threadId: thread.id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] })
      thread.injected.set(req.messageID, id)
      this.#emit({ type: "session.inbox.delivered", data: { sessionID: thread.hubID, inboxID: id, origin: "hub" } })
      return { result: { delivered: "queued", inboxID: id }, resumed: false }
    }
    const id = inboxID()
    if (thread.turnID && req.meta.delivery === "queue") {
      thread.queue.push({ inboxID: id, text })
      return { result: { delivered: "queued", inboxID: id }, resumed: true }
    }
    const how = await this.#steerOrStart(thread, [textInput(text)], "hub", id)
    return { result: { delivered: how, inboxID: id }, resumed: true }
  }

  async create(req: CreateRequest): Promise<ResultFor["create"]> {
    if (req.agent !== undefined) throw new Error(`Codex has no agents (asked for ${JSON.stringify(req.agent)})`)
    if (!path.isAbsolute(req.directory)) throw new Error(`The directory must be an absolute path (got ${JSON.stringify(req.directory)})`)
    let isDir = false
    try {
      isDir = statSync(req.directory).isDirectory()
    } catch {}
    if (!isDir) throw new Error(`${req.directory} does not exist or is not a directory`)
    const conn = await this.#createServer()
    const started = await conn.request("thread/start", { ...this.#threadDefaults, cwd: req.directory, ...(req.model ? { model: req.model.modelID } : {}) })
    const thread = isObj(started) && isObj(started.thread) ? (started.thread as unknown as ThreadDescription) : undefined
    if (!thread || typeof thread.id !== "string") throw new Error("Codex started no thread (thread/start answered without one)")
    const title = req.title?.trim() ? cut(req.title.trim(), HARNESS_TITLE_MAX) : undefined
    const sessionID = this.attach(conn, { ...thread, cwd: thread.cwd || req.directory }, title)
    if (title) await conn.request("thread/name/set", { threadId: thread.id, name: title }).catch((cause) => this.#log(`thread/name/set: ${message(cause)}`))
    return { sessionID }
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  #thread(sessionID: string): Thread {
    const id = codexThreadID(sessionID)
    const thread = id === undefined ? undefined : this.#threads.get(id)
    if (!thread) throw new Error(`Unknown Codex session ${sessionID}`)
    return thread
  }

  #emit(event: HarnessEvent): void {
    this.#spoke.emit(event)
  }

  #report(thread: Thread): void {
    const project = this.#projectOf(thread.cwd)
    this.#spoke.upsertSession({
      id: thread.hubID,
      title: thread.title,
      directory: thread.cwd,
      updated: this.#now(),
      owned: true,
      ...(project ? { project, projectName: path.basename(project) } : {}),
    })
  }

  #setBusy(thread: Thread, busy: boolean): void {
    if (thread.busy === busy) return
    thread.busy = busy
    this.#emit({ type: "session.status", data: { sessionID: thread.hubID, status: { type: busy ? "busy" : "idle" } } })
  }

  #end(thread: Thread, deleted: boolean): void {
    this.#threads.delete(thread.id)
    for (const [key, approval] of this.#approvals) if (approval.threadID === thread.id) this.#approvals.delete(key)
    for (const waiter of thread.waiters.values()) waiter.resolve({ status: "failed", error: "The Codex session ended" })
    thread.waiters.clear()
    if (deleted) this.#emit({ type: "session.deleted", data: { sessionID: thread.hubID } })
    this.#spoke.endSession(thread.hubID)
  }

  async #startTurn(thread: Thread, items: unknown[], origin: Origin, id = inboxID()): Promise<string> {
    thread.inputs.set(id, origin)
    let started: unknown
    try {
      started = await thread.conn.request("turn/start", { threadId: thread.id, input: items, clientUserMessageId: id })
    } catch (cause) {
      thread.inputs.delete(id)
      throw cause
    }
    const turnID = isObj(started) && isObj(started.turn) ? str(started.turn.id) : undefined
    if (!turnID) throw new Error("Codex started no turn (turn/start answered without one)")
    if (!thread.ended.has(turnID)) thread.turnID = turnID
    return turnID
  }

  /** Into the running turn when there is one ("steer"), else a new turn ("turn"); a lost race starts a turn. */
  async #steerOrStart(thread: Thread, items: unknown[], origin: Origin, id: string): Promise<"steer" | "turn"> {
    if (thread.turnID) {
      thread.inputs.set(id, origin)
      try {
        await thread.conn.request("turn/steer", { threadId: thread.id, expectedTurnId: thread.turnID, input: items, clientUserMessageId: id })
        return "steer"
      } catch (cause) {
        thread.inputs.delete(id)
        if (!(cause instanceof RpcError) || cause.code === LOCAL_ERROR) throw cause
        this.#log(`turn/steer refused (${cause.message}); starting a turn`)
      }
    }
    await this.#startTurn(thread, items, origin, id)
    return "turn"
  }

  #waitTurn(thread: Thread, turnID: string): Promise<TurnEnd | undefined> {
    const ended = thread.ended.get(turnID)
    if (ended) return Promise.resolve(ended)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        thread.waiters.delete(turnID)
        resolve(undefined)
      }, this.#turnTimeoutMs)
      thread.waiters.set(turnID, {
        resolve: (end) => {
          clearTimeout(timer)
          resolve(end)
        },
      })
    })
  }

  #turnCompleted(thread: Thread, turn: unknown): void {
    if (!isObj(turn)) return
    const turnID = str(turn.id)
    if (!turnID) return
    const status = typeof turn.status === "string" ? turn.status : "completed"
    const error = isObj(turn.error) && typeof turn.error.message === "string" ? cut(turn.error.message, HARNESS_ERROR_MAX) : undefined
    const end: TurnEnd = { status, ...(error !== undefined ? { error } : {}) }
    if (thread.turnID === turnID) thread.turnID = undefined
    thread.ended.set(turnID, end)
    while (thread.ended.size > RECENT_TURNS) thread.ended.delete(thread.ended.keys().next().value!)
    const sessionID = thread.hubID
    if (thread.reply) this.#emit({ type: "session.text.ended", data: { sessionID, assistantMessageID: plainID(thread.reply.id), ordinal: 0, text: cut(thread.reply.text, HARNESS_TEXT_MAX) } })
    const data = { sessionID, turnID: plainID(turnID) }
    if (status === "interrupted") this.#emit({ type: "session.execution.interrupted", data })
    else if (status === "failed") this.#emit({ type: "session.execution.failed", data: { ...data, ...(error !== undefined ? { error: { message: error } } : {}) } })
    else this.#emit({ type: "session.execution.succeeded", data })
    thread.items.clear()
    const waiter = thread.waiters.get(turnID)
    thread.waiters.delete(turnID)
    waiter?.resolve(end)
    const next = thread.queue.shift()
    if (next) this.#startTurn(thread, [textInput(next.text)], "hub", next.inboxID).catch((cause) => this.#log(`queued hub message ${next.inboxID}: ${message(cause)}`))
  }

  #itemStarted(thread: Thread, params: Record<string, any>): void {
    const item = params.item
    if (!isObj(item) || typeof item.id !== "string") return
    if (item.type === "userMessage") {
      const clientID = str(item.clientId)
      const origin = clientID ? thread.inputs.get(clientID) : undefined
      if (clientID) thread.inputs.delete(clientID)
      this.#emit({ type: "session.inbox.delivered", data: { sessionID: thread.hubID, inboxID: plainID(clientID && origin ? clientID : item.id), origin: origin ?? "user" } })
      return
    }
    if (!TOOL_ITEMS.has(item.type)) return
    thread.items.set(item.id, { type: item.type, paths: changedPaths(item) })
    const summary = toolSummary(item)
    const turnID = str(params.turnId)
    this.#emit({
      type: "session.tool.called",
      data: { sessionID: thread.hubID, id: plainID(item.id), ...(turnID ? { assistantMessageID: plainID(turnID) } : {}), ...(summary !== undefined ? { summary } : {}) },
    })
  }

  #itemCompleted(thread: Thread, params: Record<string, any>): void {
    const item = params.item
    if (!isObj(item) || typeof item.id !== "string") return
    if (item.type === "agentMessage") {
      if (typeof item.text === "string" && item.text !== "") thread.reply = { id: item.id, text: item.text }
      return
    }
    if (!TOOL_ITEMS.has(item.type)) return
    thread.items.delete(item.id)
    const id = plainID(item.id)
    if (item.status === "failed" || item.status === "declined") {
      const error = item.status === "declined" ? "declined" : typeof item.exitCode === "number" ? `exit code ${item.exitCode}` : "failed"
      this.#emit({ type: "session.tool.failed", data: { sessionID: thread.hubID, id, error } })
    } else this.#emit({ type: "session.tool.success", data: { sessionID: thread.hubID, id } })
  }
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The app-server input for a prompt: its text (when any) and its images as data URLs. */
function input(text: string, images: readonly PromptImage[] | undefined): unknown[] {
  return [...(text ? [textInput(text)] : []), ...(images ?? []).map((image) => ({ type: "image", url: `data:${image.mime};base64,${image.data}` }))]
}
