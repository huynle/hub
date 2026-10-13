// Connected spokes and what they report: a catalog of machines → processes → sessions, one live
// StatusBoard per root session (fed by forwarded events from any process), owner selection for turns,
// a per-session turn lock, permission routing back to the process that asked, and conversation mode
// (which sessions speak their replies on the phone).
import path from "node:path"
import type { ForwardedEvent, Hello, HerdrWorkspace, ProcessKind, SessionInfo, SpokeMode, TerminalInfo, Terminals } from "../protocol"
import { StatusBoard, type Blocker, type SessionStatus } from "../status"

export class BusyError extends Error {
  constructor() {
    super("A voice turn is already running for this session")
    this.name = "BusyError"
  }
}

export interface MachineRef {
  readonly id: string
  readonly name: string
}

/** A status tree entry as the hub reports it: working sessions carry when their current run started. */
export type LiveStatus = SessionStatus & { readonly since?: number }

/** Timer functions (injectable for tests). */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Streamed text and reasoning are sent to phones at most once per this interval per session: the first
 * delta goes out at once, later ones within the window are joined and sent when it ends.
 */
export const STREAM_INTERVAL_MS = 100

export type RegistryMessage =
  | { readonly type: "catalog" }
  | { readonly type: "status"; readonly sessionID: string; readonly sessions: LiveStatus[] }
  /** Assistant text streamed in a root or subagent session (rootID: its root session). */
  | { readonly type: "delta"; readonly sessionID: string; readonly rootID: string; readonly messageID?: string; readonly text: string }
  /** Reasoning text streamed in a root or subagent session. */
  | { readonly type: "reasoning"; readonly sessionID: string; readonly rootID: string; readonly messageID?: string; readonly delta: string }
  | { readonly type: "conversation"; readonly sessionID: string; readonly on: boolean }
  /** A finished piece of assistant text in a root session in conversation mode, to be spoken. */
  | { readonly type: "say"; readonly sessionID: string; readonly messageID: string; readonly ordinal: number; readonly text: string }
  /** An utterance sent from the phone reached the agent. */
  | { readonly type: "heard"; readonly sessionID: string; readonly inboxID: string }
  /** An activity item was created or changed state (sessionID: where it happened; rootID: its root). */
  | { readonly type: "activity"; readonly sessionID: string; readonly rootID: string; readonly item: ActivityItem }

export type ActivityState = "running" | "done" | "failed"

/** One entry of a root session's activity feed: a tool call or a stretch of reasoning. */
export interface ActivityItem {
  /** Tool call ID, or `thinking:<assistantMessageID>`. */
  readonly id: string
  /** Session the activity happened in (the root or one of its subagent sessions). */
  readonly sessionID: string
  readonly kind: "tool" | "thinking"
  readonly tool?: string
  /** Short summary of the tool input (a command, a path); never the full input. */
  readonly summary?: string
  /** The tool was started in the background (e.g. a background subagent). */
  readonly background?: true
  readonly state: ActivityState
  readonly error?: string
  /** ms epoch of creation, then of the last state change. */
  readonly at: number
}

/** Activity items kept per root session. */
export const ACTIVITY_LIMIT = 30
/** Root sessions whose activity is remembered. */
const ACTIVITY_ROOTS = 200

/** A session counts as watched while a device reported it visible within this window. */
export const PRESENCE_WINDOW_MS = 45_000
/** Child completion text is useful only while its matching run completion is still nearby. */
export const WORKER_SPEECH_TTL_MS = 5 * 60_000

/** Push-worthy transitions of a root session. Kept off the SSE stream. */
export interface Alert {
  readonly kind: "blocked" | "finished" | "say"
  /** Root session of the tree the event happened in. */
  readonly sessionID: string
  /** Root session title. */
  readonly title: string
  readonly detail?: "permission" | "form" | "succeeded" | "failed"
  /** say: the spoken text. */
  readonly text?: string
  /** Tenant (user ID) that owns the session; push goes to this user's devices only. */
  readonly owner?: string
}

/** Machine ID → tenant (owning user ID). Every machine belongs to exactly one tenant. */
export type TenantOf = (machineID: string) => string | undefined

/** A pending permission or question somewhere in a session's tree, with where it was asked. */
export interface TreeBlocker extends Blocker {
  readonly sessionID: string
  readonly sessionTitle: string
}

/** What a session is doing right now: its latest running activity item. */
export interface NowActivity {
  readonly kind: ActivityItem["kind"]
  readonly tool?: string
  readonly summary?: string
}

/** Session browser fields, computed for a session and the subagent sessions below it. */
interface BrowserFields {
  /** Voice is enabled for the session (false: listed for discovery only; session ops answer 403). */
  readonly exposed: boolean
  /** blocked if anything in the tree waits for the user, else error/working/idle. */
  readonly state: SessionStatus["state"]
  readonly blockers: TreeBlocker[]
  readonly now?: NowActivity
}

export interface CatalogSession extends Omit<SessionInfo, "exposed">, BrowserFields {
  readonly processID: string
  readonly machineID: string
  /** The root session's status tree (root first, then subagent sessions). */
  readonly status: SessionStatus[]
  readonly busy: boolean
  /** Conversation mode is on: assistant text is spoken on the phone. */
  readonly conversation: boolean
}

/** One session as seen by the phone (GET /api/sessions/:id). */
export interface SessionView extends BrowserFields {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly parentID?: string
  readonly project?: string
  readonly projectName?: string
  readonly updated: number
  /** Open in a terminal (any reporting process says so); where. */
  readonly open?: boolean
  readonly terminal?: TerminalInfo
  readonly busy: boolean
  readonly conversation: boolean
  /** Status tree of the root session that contains this session. */
  readonly status: SessionStatus[]
  /** Recent activity of the root session and its subagent sessions, newest last. */
  readonly activity: ActivityItem[]
}

export interface CatalogProcess {
  readonly id: string
  readonly kind: ProcessKind
  readonly directory: string
  readonly pid: number
  readonly mode: SpokeMode
  readonly opencodeVersion: string
  readonly pluginVersion: string
  readonly connected: number
  readonly lastSeen: number
  readonly sessions: CatalogSession[]
}

/** A machine's terminal context: its Herdr workspaces (latest terminals frame of the machine). */
export interface MachineTerminals {
  readonly herdr?: { readonly workspaces: readonly HerdrWorkspace[] }
}

export interface CatalogMachine {
  readonly id: string
  readonly name: string
  readonly processes: CatalogProcess[]
  readonly terminals?: MachineTerminals
}

interface Conn {
  readonly id: string
  readonly machine: MachineRef
  readonly hello: Hello
  readonly connected: number
  readonly seq: number
  lastSeen: number
  sessions: Map<string, SessionInfo>
  /** The last sessions frame as JSON, to skip unchanged snapshots. */
  sessionsKey: string
  /** sessionID → activity sequence number of the last event this process sent for it. */
  activity: Map<string, number>
}

/** Streamed text of one session waiting for its next send window. */
interface Stream {
  last: number
  timer?: unknown
  pending: Array<{ kind: "delta" | "reasoning"; rootID: string; messageID?: string; text: string }>
}

/** Latest assistant message of a child run, paired with its successful completion for direct speech. */
interface WorkerSpeech {
  readonly rootID: string
  succeeded: boolean
  messageID?: string
  readonly parts: Map<number, string>
  at: number
  timer?: unknown
}

/** How many spoken texts, utterances and early deliveries are remembered for dedupe and matching. */
const MEMORY = 1000

/** Adds to a bounded insertion-ordered map, dropping the oldest entry when full. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, limit = MEMORY): void {
  map.set(key, value)
  if (map.size > limit) map.delete(map.keys().next().value!)
}

const eventSessionID = (event: ForwardedEvent): string | undefined => {
  const data = event.data as Record<string, any>
  const id = event.type === "form.created" ? data.form?.sessionID : data.sessionID
  return typeof id === "string" ? id : undefined
}

/** Older spokes reported exposed sessions only, without the field. */
const isOn = (s: SessionInfo) => s.exposed !== false

export class Registry {
  private readonly conns = new Map<string, Conn>()
  private readonly boards = new Map<string, StatusBoard>()
  /** permission requestID → where it was asked. */
  private readonly permissions = new Map<string, { connID: string; sessionID: string }>()
  private readonly active = new Set<string>()
  private readonly listeners = new Set<(message: RegistryMessage, tenant?: string) => void>()
  private readonly alertListeners = new Set<(alert: Alert) => void>()
  /** Form IDs already alerted (forms may be forwarded by several processes). */
  private readonly alertedForms = new Set<string>()
  /** Sessions in conversation mode → the connection last told so (re-sent when another one takes over). */
  private readonly conversations = new Map<string, string | undefined>()
  /** `messageID ordinal` of texts already sent as say events (several processes forward the same text). */
  private readonly spoken = new Map<string, true>()
  /** Child session → latest text and completion state, while its root is in conversation mode. */
  private readonly workerSpeech = new Map<string, WorkerSpeech>()
  /** Utterance inboxID → session, until OpenCode reports it delivered. */
  private readonly utterances = new Map<string, string>()
  /** Deliveries not (yet) matched to an utterance: the steer result can arrive after the event. */
  private readonly deliveries = new Map<string, true>()
  /** Root session → its activity feed, oldest first. */
  private readonly feeds = new Map<string, ActivityItem[]>()
  /** `deviceID sessionID` → last visible report of a session page. */
  private readonly presence = new Map<string, { sessionID: string; at: number }>()
  /** Session → start time of its current run (session.execution.started). */
  private readonly since = new Map<string, number>()
  /** Session → streamed text waiting for its send window. */
  private readonly streams = new Map<string, Stream>()
  /** Machine → its latest terminals frame and the connection that sent it. */
  private readonly machineTerminals = new Map<string, { connID: string; terminals: MachineTerminals; key: string }>()
  private seq = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = realTimers,
    /** Single tenant unless given (pairing mode, tests). */
    private readonly tenantOf: TenantOf = () => "",
  ) {}

  /**
   * Listens to registry messages. `tenant` is the user that owns the message's session (undefined for
   * catalog changes, which concern everyone, and for sessions nobody reports).
   */
  subscribe(listener: (message: RegistryMessage, tenant?: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeAlerts(listener: (alert: Alert) => void): () => void {
    this.alertListeners.add(listener)
    return () => this.alertListeners.delete(listener)
  }

  connections(): number {
    return this.conns.size
  }

  connectionsFor(machineID: string): string[] {
    return [...this.conns.values()].filter((c) => c.machine.id === machineID).map((c) => c.id)
  }

  // ---------- tenancy ----------
  // A session belongs to the tenant of the earliest connected process reporting it. Processes of other
  // tenants reporting the same ID are ignored for it (no listing, routing or events), so a spoke cannot
  // claim, read or inject into another user's session by reusing its ID.

  private tenant(conn: Conn): string {
    return this.tenantOf(conn.machine.id) ?? `?${conn.machine.id}`
  }

  /** Tenant of a reported session, or of the status board that contains it; undefined when unknown. */
  sessionTenant(sessionID: string): string | undefined {
    let first: Conn | undefined
    for (const conn of this.conns.values()) if (conn.sessions.has(sessionID) && (!first || conn.seq < first.seq)) first = conn
    if (first) return this.tenant(first)
    const rootID = this.rootOf(sessionID)
    return rootID && rootID !== sessionID ? this.sessionTenant(rootID) : undefined
  }

  /** The session as `conn` reports it, unless another tenant owns that ID. */
  private reports(conn: Conn, sessionID: string): SessionInfo | undefined {
    const info = conn.sessions.get(sessionID)
    return info && this.sessionTenant(sessionID) === this.tenant(conn) ? info : undefined
  }

  /** Sessions `conn` reports that belong to its tenant. */
  private visible(conn: Conn): SessionInfo[] {
    return [...conn.sessions.values()].filter((s) => this.reports(conn, s.id))
  }

  /** True when the tenant owns the session (reported by one of its processes, or a subagent of such a session). */
  owns(tenant: string, sessionID: string): boolean {
    return this.sessionTenant(sessionID) === tenant
  }

  /** Whether the connection's process belongs to the tenant. */
  connTenant(connID: string): string | undefined {
    const conn = this.conns.get(connID)
    return conn && this.tenant(conn)
  }

  connect(connID: string, machine: MachineRef, hello: Hello): void {
    const t = this.now()
    this.conns.set(connID, {
      id: connID,
      machine,
      hello,
      connected: t,
      seq: ++this.seq,
      lastSeen: t,
      sessions: new Map(),
      sessionsKey: "[]",
      activity: new Map(),
    })
    this.emit({ type: "catalog" })
  }

  disconnect(connID: string): void {
    const conn = this.conns.get(connID)
    if (!conn || !this.conns.delete(connID)) return
    if (this.machineTerminals.get(conn.machine.id)?.connID === connID) this.machineTerminals.delete(conn.machine.id)
    // Nobody can answer permissions asked by a process that is gone.
    for (const [requestID, origin] of this.permissions) {
      if (origin.connID !== connID) continue
      this.permissions.delete(requestID)
      this.observeBoards({ type: "permission.replied", data: { sessionID: origin.sessionID, requestID } })
    }
    this.syncBoards()
    this.emit({ type: "catalog" })
  }

  touch(connID: string): void {
    const conn = this.conns.get(connID)
    if (conn) conn.lastSeen = this.now()
  }

  setSessions(connID: string, sessions: readonly SessionInfo[]): void {
    const conn = this.conns.get(connID)
    if (!conn) return
    conn.lastSeen = this.now()
    // Spokes re-send their snapshot periodically; only changes reach the phones.
    const key = JSON.stringify(sessions)
    if (key === conn.sessionsKey) return
    conn.sessionsKey = key
    conn.sessions = new Map(sessions.map((s) => [s.id, s]))
    this.syncBoards()
    this.emit({ type: "catalog" })
  }

  /** Records a machine's terminal context (sent by one process per machine); catalog on change. */
  setTerminals(connID: string, frame: Terminals): void {
    const conn = this.conns.get(connID)
    if (!conn) return
    conn.lastSeen = this.now()
    const terminals: MachineTerminals = frame.herdr ? { herdr: { workspaces: frame.herdr.workspaces.map((w) => ({ id: w.id, label: w.label, directories: [...w.directories] })) } } : {}
    const key = JSON.stringify(terminals)
    const previous = this.machineTerminals.get(conn.machine.id)
    this.machineTerminals.set(conn.machine.id, { connID, terminals, key })
    if (previous?.key !== key) this.emit({ type: "catalog" })
  }

  /** The machine's terminal context, while the process that sent it is connected. */
  terminals(machineID: string): MachineTerminals | undefined {
    return this.machineTerminals.get(machineID)?.terminals
  }

  observe(connID: string, event: ForwardedEvent): void {
    const conn = this.conns.get(connID)
    if (!conn) return
    conn.lastSeen = this.now()
    const sessionID = eventSessionID(event)
    const data = event.data as Record<string, unknown>
    // Events about another tenant's session (or nesting under one) are dropped.
    const tenant = this.tenant(conn)
    for (const id of [sessionID, data.parentID]) {
      if (typeof id !== "string") continue
      const owner = this.sessionTenant(id)
      if (owner !== undefined && owner !== tenant) return
    }
    if (sessionID) conn.activity.set(sessionID, ++this.seq)
    const streamed = event.type === "session.text.delta" || event.type === "session.reasoning.delta"
    // Anything else in a session (text ended → say, run ended → status) goes out after its streamed text.
    if (sessionID && !streamed) this.flushStream(this.streams.get(sessionID), sessionID)

    if (event.type === "permission.asked" && typeof data.id === "string" && sessionID) {
      if (this.permissions.has(data.id)) return // the same request forwarded by another process
      this.permissions.set(data.id, { connID, sessionID })
      this.alert("blocked", sessionID, "permission")
    }
    if (event.type === "form.created" && sessionID) {
      const formID = (data.form as Record<string, unknown> | undefined)?.id
      if (typeof formID === "string" && !this.alertedForms.has(formID)) {
        this.alertedForms.add(formID)
        if (this.alertedForms.size > 1000) this.alertedForms.delete(this.alertedForms.values().next().value!)
        this.alert("blocked", sessionID, "form")
      }
    }
    if (
      (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") &&
      sessionID &&
      this.boards.has(sessionID) &&
      !this.active.has(sessionID) &&
      !(this.conversations.has(sessionID) && this.watched(sessionID))
    ) {
      this.alert("finished", sessionID, event.type.endsWith("succeeded") ? "succeeded" : "failed")
    }
    if (event.type === "permission.replied" && typeof data.requestID === "string") {
      this.permissions.delete(data.requestID)
    }

    if (sessionID) this.trackRun(event.type, sessionID)
    this.observeBoards(event, tenant)
    if (sessionID) this.observeActivity(event, sessionID, data)
    if (sessionID) this.observeWorkerSpeech(event.type, sessionID, data)

    if (streamed && sessionID) {
      const rootID = this.rootOf(sessionID)
      if (rootID) this.stream(sessionID, rootID, event.type === "session.text.delta" ? "delta" : "reasoning", data)
    }
    if (event.type === "session.text.ended" && sessionID) this.say(sessionID, data)
    if (event.type === "session.inbox.delivered" && typeof data.inboxID === "string") this.delivered(data.inboxID)
    if (event.type === "session.deleted" && sessionID) this.setConversation(sessionID, false)
  }

  /** Records when a session's run started (kept by the first process to report it while it runs). */
  private trackRun(type: string, sessionID: string): void {
    if (type === "session.execution.started") {
      const running = this.status(sessionID)?.find((s) => s.id === sessionID)?.state === "working"
      if (!running || !this.since.has(sessionID)) remember(this.since, sessionID, this.now())
    } else if (type.startsWith("session.execution.") || type === "session.deleted") {
      this.since.delete(sessionID)
    }
  }

  /** Queues streamed text; sends at once when the session's window is free, else when it ends. */
  private stream(sessionID: string, rootID: string, kind: "delta" | "reasoning", data: Record<string, unknown>): void {
    const text = typeof data.delta === "string" ? data.delta : ""
    if (!text) return
    const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
    let stream = this.streams.get(sessionID)
    if (!stream) remember(this.streams, sessionID, (stream = { last: -Infinity, pending: [] }))
    const tail = stream.pending.at(-1)
    if (tail && tail.kind === kind && tail.messageID === messageID && tail.rootID === rootID) tail.text += text
    else stream.pending.push({ kind, rootID, messageID, text })
    if (stream.timer !== undefined) return
    const wait = stream.last + STREAM_INTERVAL_MS - this.now()
    if (wait <= 0) return this.flushStream(stream, sessionID)
    const held = stream
    held.timer = this.timers.set(() => {
      held.timer = undefined
      this.flushStream(held, sessionID)
    }, wait)
  }

  /** Sends a session's held text now, in arrival order. */
  private flushStream(stream: Stream | undefined, sessionID: string): void {
    if (!stream?.pending.length) return
    if (stream.timer !== undefined) this.timers.clear(stream.timer)
    stream.timer = undefined
    const chunks = stream.pending
    stream.pending = []
    stream.last = this.now()
    for (const { kind, rootID, messageID, text } of chunks) {
      const message = { sessionID, rootID, ...(messageID ? { messageID } : {}) }
      this.emit(kind === "delta" ? { type: "delta", ...message, text } : { type: "reasoning", ...message, delta: text })
    }
  }

  /** Remembers an utterance's inbox item so its delivery is reported as a heard event. */
  trackUtterance(sessionID: string, inboxID: string): void {
    if (this.deliveries.delete(inboxID)) this.emit({ type: "heard", sessionID, inboxID })
    else remember(this.utterances, inboxID, sessionID)
  }

  /**
   * Sessions in conversation mode that `connID` reports and owns but was not told about yet (it
   * reconnected or took over ownership). Marks them as told.
   */
  conversationResends(connID: string): string[] {
    const conn = this.conns.get(connID)
    if (!conn) return []
    const resend: string[] = []
    for (const [sessionID, told] of this.conversations) {
      if (told === connID || !this.reports(conn, sessionID) || this.owner(sessionID) !== connID) continue
      this.conversations.set(sessionID, connID)
      resend.push(sessionID)
    }
    return resend
  }

  private delivered(inboxID: string): void {
    const sessionID = this.utterances.get(inboxID)
    if (sessionID === undefined) return remember(this.deliveries, inboxID, true)
    this.utterances.delete(inboxID)
    this.emit({ type: "heard", sessionID, inboxID })
  }

  private say(sessionID: string, data: Record<string, unknown>): void {
    if (this.rootOf(sessionID) !== sessionID) return
    this.emitSay(sessionID, data)
  }

  /** Emits one root-session speech part, deduped across processes. */
  private emitSay(sessionID: string, data: Record<string, unknown>): void {
    const { assistantMessageID: messageID, ordinal, text } = data
    if (!this.conversations.has(sessionID) || !this.boards.has(sessionID)) return
    if (typeof messageID !== "string" || typeof ordinal !== "number" || typeof text !== "string" || !text.trim()) return
    const key = `${messageID} ${ordinal}`
    if (this.spoken.has(key)) return
    remember(this.spoken, key, true)
    this.emit({ type: "say", sessionID, messageID, ordinal, text })
    // Nobody is listening on a phone: push the reply so it reaches a locked screen.
    if (!this.watched(sessionID)) this.alert("say", sessionID, undefined, text)
  }

  /** Pairs a child session's latest assistant message with successful execution and speaks it once. */
  private observeWorkerSpeech(type: string, sessionID: string, data: Record<string, unknown>): void {
    const now = this.now()
    for (const [childID, state] of this.workerSpeech) {
      if (now - state.at > WORKER_SPEECH_TTL_MS) this.clearWorkerSpeech(childID)
    }
    const rootID = this.rootOf(sessionID)
    if (!rootID || rootID === sessionID || !this.conversations.has(rootID)) {
      this.clearWorkerSpeech(sessionID)
      return
    }
    if (type === "session.execution.started") {
      this.clearWorkerSpeech(sessionID)
      remember(this.workerSpeech, sessionID, { rootID, succeeded: false, parts: new Map(), at: now })
      return
    }
    if (type === "session.execution.failed" || type === "session.execution.interrupted" || type === "session.deleted") {
      this.clearWorkerSpeech(sessionID)
      return
    }
    if (type !== "session.execution.succeeded" && type !== "session.text.ended") return

    let state = this.workerSpeech.get(sessionID)
    if (!state || state.rootID !== rootID) {
      state = { rootID, succeeded: false, parts: new Map(), at: now }
      remember(this.workerSpeech, sessionID, state)
    }
    state.at = now
    if (type === "session.execution.succeeded") state.succeeded = true
    else {
      const { assistantMessageID, ordinal, text } = data
      if (typeof assistantMessageID !== "string" || typeof ordinal !== "number" || typeof text !== "string" || !text.trim()) return
      if (state.messageID !== assistantMessageID) {
        state.messageID = assistantMessageID
        state.parts.clear()
      }
      state.parts.set(ordinal, text)
    }
    if (!state.succeeded || !state.messageID || state.parts.size === 0) return
    // Success normally follows every text event, so flush immediately. If another process reports
    // success first, briefly debounce late text so an earlier assistant message is not spoken.
    if (type === "session.text.ended") {
      if (state.timer !== undefined) this.timers.clear(state.timer)
      const held = state
      state.timer = this.timers.set(() => {
        held.timer = undefined
        if (this.workerSpeech.get(sessionID) === held) this.flushWorkerSpeech(held)
      }, STREAM_INTERVAL_MS)
      return
    }
    this.flushWorkerSpeech(state)
  }

  private flushWorkerSpeech(state: WorkerSpeech): void {
    if (!state.succeeded || !state.messageID || state.parts.size === 0 || !this.conversations.has(state.rootID)) return
    for (const [ordinal, text] of [...state.parts].sort(([a], [b]) => a - b)) {
      this.emitSay(state.rootID, { assistantMessageID: state.messageID, ordinal, text })
    }
    state.parts.clear()
  }

  private clearWorkerSpeech(sessionID: string): void {
    const state = this.workerSpeech.get(sessionID)
    if (state?.timer !== undefined) this.timers.clear(state.timer)
    this.workerSpeech.delete(sessionID)
  }

  /** Records whether a device shows a session page (reported on visibility changes and every 30 s). */
  setPresence(deviceID: string, sessionID: string, visible: boolean): void {
    const key = `${deviceID} ${sessionID}`
    if (visible) remember(this.presence, key, { sessionID, at: this.now() })
    else this.presence.delete(key)
  }

  /** True while some device reported the session's tree visible within PRESENCE_WINDOW_MS. */
  watched(sessionID: string): boolean {
    const rootID = this.rootOf(sessionID) ?? sessionID
    const t = this.now()
    for (const entry of this.presence.values()) {
      if (t - entry.at <= PRESENCE_WINDOW_MS && (this.rootOf(entry.sessionID) ?? entry.sessionID) === rootID) return true
    }
    return false
  }

  /** Whether any process exposes the session to voice; undefined when no process reports it. */
  exposed(sessionID: string): boolean | undefined {
    let reported = false
    for (const conn of this.conns.values()) {
      const s = this.reports(conn, sessionID)
      if (!s) continue
      if (isOn(s)) return true
      reported = true
    }
    return reported ? false : undefined
  }

  /** Process to change a session's exposure: a reporting service process, else the most recent reporter. */
  exposeTarget(sessionID: string): string | undefined {
    const reporters = [...this.conns.values()].filter((c) => this.reports(c, sessionID))
    const services = reporters.filter((c) => c.hello.kind === "service")
    return this.recent(services.length ? services : reporters, sessionID)
  }

  /** The machine's (most recently connected) background service process. */
  serviceFor(machineID: string): string | undefined {
    const services = [...this.conns.values()].filter((c) => c.machine.id === machineID && c.hello.kind === "service")
    return services.sort((a, b) => b.seq - a.seq)[0]?.id
  }

  /**
   * True when the process reported a session in, or a workspace root equal to, the directory, or its
   * machine has a Herdr pane in it.
   */
  reportsWorkspace(connID: string, directory: string): boolean {
    const conn = this.conns.get(connID)
    if (!conn || !directory.startsWith("/")) return false
    const target = path.posix.resolve(directory)
    const herdr = this.terminals(conn.machine.id)?.herdr
    if (herdr?.workspaces.some((w) => w.directories.some((d) => d.startsWith("/") && path.posix.resolve(d) === target))) return true
    for (const s of this.visible(conn)) {
      if (s.project?.startsWith("/") && path.posix.resolve(s.project) === target) return true
      if (s.directory.startsWith("/") && path.posix.resolve(s.directory) === target) return true
    }
    return false
  }

  hasSession(sessionID: string): boolean {
    for (const conn of this.conns.values()) if (conn.sessions.has(sessionID)) return true
    return false
  }

  /** Status tree of the root session that contains `sessionID`. */
  status(sessionID: string): LiveStatus[] | undefined {
    const board = this.boards.get(sessionID) ?? [...this.boards.values()].find((b) => b.get(sessionID))
    return board && this.live(board.snapshot().sessions)
  }

  /** Adds `since` (run start) to working entries. */
  private live(sessions: SessionStatus[]): LiveStatus[] {
    return sessions.map((s) => {
      const since = s.state === "working" ? this.since.get(s.id) : undefined
      return since === undefined ? s : { ...s, since }
    })
  }

  catalog(): CatalogMachine[] {
    const machines = new Map<string, { id: string; name: string; processes: CatalogProcess[] }>()
    for (const conn of [...this.conns.values()].sort((a, b) => a.seq - b.seq)) {
      const machine = machines.get(conn.machine.id) ?? { id: conn.machine.id, name: conn.machine.name, processes: [] }
      machines.set(conn.machine.id, machine)
      const terminals = this.terminals(conn.machine.id)
      if (terminals) Object.assign(machine, { terminals })
      const { processID, kind, directory, pid, mode, opencodeVersion, pluginVersion } = conn.hello
      machine.processes.push({
        id: processID,
        kind,
        directory,
        pid,
        mode,
        opencodeVersion,
        pluginVersion,
        connected: conn.connected,
        lastSeen: conn.lastSeen,
        sessions: this.visible(conn).map((s) => {
          const fields = this.browserFields(s.id)
          return {
            ...s,
            ...fields,
            processID,
            machineID: conn.machine.id,
            status: fields.exposed ? (this.status(s.id) ?? []) : [],
            busy: this.active.has(s.id),
            conversation: this.conversations.has(s.id),
          }
        }),
      })
    }
    return [...machines.values()]
  }

  /** The session as reported by any process plus its live status; undefined when nobody reports it. */
  session(sessionID: string): SessionView | undefined {
    let info: SessionInfo | undefined
    /** Open from any reporting process; a Herdr pane wins over a TUI. */
    let terminal: TerminalInfo | undefined
    for (const conn of this.conns.values()) {
      const s = this.reports(conn, sessionID)
      if (s && (!info || s.updated > info.updated)) info = s
      if (s?.open && s.terminal && (!terminal || (terminal.source !== "herdr" && s.terminal.source === "herdr"))) terminal = s.terminal
    }
    if (!info) return undefined
    const fields = this.browserFields(sessionID)
    const status = fields.exposed ? (this.status(sessionID) ?? []) : []
    const own = status.find((s) => s.id === sessionID)
    return {
      id: info.id,
      title: own?.title ?? info.title,
      directory: info.directory,
      ...(info.parentID ? { parentID: info.parentID } : {}),
      ...(info.project ? { project: info.project } : {}),
      ...(info.projectName ? { projectName: info.projectName } : {}),
      updated: info.updated,
      ...(terminal ? { open: true, terminal } : {}),
      ...fields,
      busy: this.active.has(sessionID),
      conversation: this.conversations.has(sessionID),
      status,
      activity: fields.exposed ? this.activity(sessionID) : [],
    }
  }

  /** Exposure, overall state, pending blockers and current activity of a session and its subtree. */
  private browserFields(sessionID: string): BrowserFields {
    const exposed = this.exposed(sessionID) === true
    if (!exposed) return { exposed, state: "idle", blockers: [] }
    const status = this.status(sessionID) ?? []
    const tree = new Set([sessionID])
    for (let grew = true; grew; ) {
      grew = false
      for (const entry of status) {
        if (entry.parentID && tree.has(entry.parentID) && !tree.has(entry.id)) {
          tree.add(entry.id)
          grew = true
        }
      }
    }
    const entries = status.filter((entry) => tree.has(entry.id))
    const own = entries.find((entry) => entry.id === sessionID)
    const state: SessionStatus["state"] = entries.some((e) => e.state === "blocked")
      ? "blocked"
      : own?.state === "error"
        ? "error"
        : entries.some((e) => e.state === "working")
          ? "working"
          : "idle"
    const blockers = entries.flatMap((e) => e.blockers.map((b) => ({ ...b, sessionID: e.id, sessionTitle: e.title })))
    const rootID = this.rootOf(sessionID)
    const item = [...((rootID && this.feeds.get(rootID)) || [])].reverse().find((i) => i.state === "running" && tree.has(i.sessionID))
    const now = item && { kind: item.kind, ...(item.tool ? { tool: item.tool } : {}), ...(item.summary ? { summary: item.summary } : {}) }
    return { exposed, state, blockers, ...(now ? { now } : {}) }
  }

  /** Recent activity of the root session that contains `sessionID`, newest last. */
  activity(sessionID: string): ActivityItem[] {
    const rootID = this.rootOf(sessionID)
    return rootID ? (this.feeds.get(rootID) ?? []).map((item) => ({ ...item })) : []
  }

  /** Root session of the status board that contains `sessionID`. */
  private rootOf(sessionID: string): string | undefined {
    if (this.boards.has(sessionID)) return sessionID
    for (const [rootID, board] of this.boards) if (board.get(sessionID)) return rootID
    return undefined
  }

  /**
   * Builds the activity feed from compact activity events. Idempotent: several processes may forward
   * the same events, so only creations and actual changes are emitted.
   */
  private observeActivity(event: ForwardedEvent, sessionID: string, data: Record<string, unknown>): void {
    const rootID = this.rootOf(sessionID)
    if (!rootID) return
    let feed = this.feeds.get(rootID)
    const find = (id: unknown) => (typeof id === "string" ? feed?.find((item) => item.id === id) : undefined)
    const add = (item: ActivityItem) => {
      if (!feed) remember(this.feeds, rootID, (feed = []), ACTIVITY_ROOTS)
      this.closeThinking(rootID, sessionID)
      feed.push(item)
      if (feed.length > ACTIVITY_LIMIT) feed.shift()
      this.emitActivity(rootID, item)
    }
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined)
    const at = this.now()

    switch (event.type) {
      case "session.tool.input.started": {
        const id = text(data.id)
        const tool = text(data.name)
        if (!id || find(id)) return
        return add({ id, sessionID, kind: "tool", ...(tool ? { tool } : {}), state: "running", at })
      }
      case "session.tool.called": {
        const id = text(data.id)
        if (!id) return
        const summary = text(data.summary)
        const details = { ...(summary ? { summary } : {}), ...(data.background === true ? { background: true as const } : {}) }
        const existing = find(id)
        if (!existing) return add({ id, sessionID, kind: "tool", ...details, state: "running", at })
        if (existing.summary === details.summary && existing.background === details.background) return
        return this.replace(rootID, existing, { ...existing, ...details })
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const existing = find(data.id)
        if (!existing || existing.state !== "running") return
        const failed = event.type === "session.tool.failed"
        const error = failed ? (text(data.error) ?? "failed") : undefined
        return this.replace(rootID, existing, { ...existing, state: failed ? "failed" : "done", ...(error ? { error } : {}), at })
      }
      case "session.reasoning.started":
      case "session.reasoning.delta": {
        // A delta opens the item too, in case the start was missed; a finished one is not reopened.
        const messageID = text(data.assistantMessageID)
        if (!messageID || find(`thinking:${messageID}`)) return
        return add({ id: `thinking:${messageID}`, sessionID, kind: "thinking", state: "running", at })
      }
      case "session.reasoning.ended": {
        const existing = find(`thinking:${text(data.assistantMessageID)}`)
        if (!existing || existing.state !== "running") return
        return this.replace(rootID, existing, { ...existing, state: "done", at })
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        return this.closeThinking(rootID, sessionID)
    }
  }

  /** Thinking also ends when something else happens in the same session (older spokes send no reasoning.ended). */
  private closeThinking(rootID: string, sessionID: string): void {
    for (const item of this.feeds.get(rootID) ?? []) {
      if (item.kind === "thinking" && item.sessionID === sessionID && item.state === "running") {
        this.replace(rootID, item, { ...item, state: "done", at: this.now() })
      }
    }
  }

  private replace(rootID: string, previous: ActivityItem, next: ActivityItem): void {
    const feed = this.feeds.get(rootID)
    const index = feed?.indexOf(previous) ?? -1
    if (!feed || index < 0) return
    feed[index] = next
    this.emitActivity(rootID, next)
  }

  private emitActivity(rootID: string, item: ActivityItem): void {
    this.emit({ type: "activity", sessionID: item.sessionID, rootID, item: { ...item } })
  }

  conversation(sessionID: string): boolean {
    return this.conversations.has(sessionID)
  }

  /** Records conversation mode for a session; `connID` is the process that was just told. */
  setConversation(sessionID: string, on: boolean, connID?: string): void {
    const changed = on !== this.conversations.has(sessionID)
    if (on) this.conversations.set(sessionID, connID)
    else {
      this.conversations.delete(sessionID)
      for (const [childID, state] of this.workerSpeech) if (state.rootID === sessionID) this.clearWorkerSpeech(childID)
    }
    if (!changed) return
    this.emit({ type: "conversation", sessionID, on })
    this.emit({ type: "catalog" })
  }

  /**
   * Connection that should run a turn for the session:
   * 1. a process reporting it as owned, most recent activity first;
   * 2. else a service process that reports it;
   * 3. else the service process of a machine that reports it;
   * 4. else any process that reports it, most recent activity first;
   * 5. else none.
   */
  owner(sessionID: string): string | undefined {
    // Processes that report the session without exposing it would refuse the request.
    const tenant = this.sessionTenant(sessionID)
    const all = [...this.conns.values()].filter((c) => this.tenant(c) === tenant && c.sessions.get(sessionID)?.exposed !== false)
    const reporters = all.filter((c) => this.reports(c, sessionID))
    if (reporters.length === 0) return undefined
    const recent = (list: Conn[]) => this.recent(list, sessionID)
    const owned = reporters.filter((c) => this.reports(c, sessionID)?.owned)
    if (owned.length) return recent(owned)
    const services = reporters.filter((c) => c.hello.kind === "service")
    if (services.length) return recent(services)
    const machines = new Set(reporters.map((c) => c.machine.id))
    return recent(all.filter((c) => c.hello.kind === "service" && machines.has(c.machine.id))) ?? recent(reporters)
  }

  /** The connection with the most recent activity for the session, then the most recently connected. */
  private recent(list: Conn[], sessionID: string): string | undefined {
    return [...list].sort((a, b) => (b.activity.get(sessionID) ?? 0) - (a.activity.get(sessionID) ?? 0) || b.seq - a.seq)[0]?.id
  }

  /** Where to send a reply for a permission that is pending in the session's status tree. */
  permissionTarget(rootID: string, requestID: string): { connID: string; sessionID: string } | undefined {
    const pending = this.status(rootID)?.some((s) =>
      s.blockers.some((b) => b.kind === "permission" && b.id === requestID),
    )
    const origin = this.permissions.get(requestID)
    if (!pending || !origin || !this.conns.has(origin.connID)) return undefined
    if (this.connTenant(origin.connID) !== this.sessionTenant(rootID)) return undefined
    return { ...origin }
  }

  /** Takes the session's turn lock; call the returned function to release it. */
  beginTurn(sessionID: string): () => void {
    if (this.active.has(sessionID)) throw new BusyError()
    this.active.add(sessionID)
    this.emit({ type: "catalog" })
    let released = false
    return () => {
      if (released) return
      released = true
      this.active.delete(sessionID)
      this.emit({ type: "catalog" })
    }
  }

  /** Feeds an event to the status boards; with a tenant, only to that tenant's boards. */
  private observeBoards(event: ForwardedEvent, tenant?: string): void {
    for (const [rootID, board] of this.boards) {
      if (tenant !== undefined && this.sessionTenant(rootID) !== tenant) continue
      if (board.observe(event)) this.emit({ type: "status", sessionID: rootID, sessions: this.live(board.snapshot().sessions) })
    }
  }

  /** Creates boards for newly reported root sessions, nests reported children, drops boards nobody reports. */
  private syncBoards(): void {
    // Only exposed sessions get status boards: nothing is forwarded for the others.
    const reported = new Map<string, SessionInfo>()
    for (const conn of this.conns.values()) for (const s of this.visible(conn)) if (isOn(s)) reported.set(s.id, s)

    const rootOf = (id: string): string => {
      const seen = new Set<string>()
      let current = id
      for (;;) {
        const parent = reported.get(current)?.parentID
        if (!parent || !reported.has(parent) || seen.has(parent)) return current
        seen.add(current)
        current = parent
      }
    }

    for (const id of this.boards.keys()) if (!reported.has(id) || rootOf(id) !== id) this.boards.delete(id)

    const children: SessionInfo[] = []
    for (const s of reported.values()) {
      if (rootOf(s.id) !== s.id) {
        children.push(s)
        continue
      }
      const board = this.boards.get(s.id)
      if (!board) this.boards.set(s.id, new StatusBoard(s.id, s.title))
      else if (board.get(s.id)?.title !== s.title) {
        board.observe({ type: "session.renamed", data: { sessionID: s.id, title: s.title } })
      }
    }

    // Nest children parent-first; repeat until no more can be placed.
    let pending = children
    while (pending.length) {
      const next: SessionInfo[] = []
      for (const child of pending) {
        const board = this.boards.get(rootOf(child.id))
        if (!board || board.get(child.id)) continue
        const placed = board.observe({
          type: "session.created",
          data: { sessionID: child.id, parentID: child.parentID, title: child.title },
        })
        if (!placed) next.push(child)
      }
      if (next.length === pending.length) break
      pending = next
    }
  }

  private alert(kind: Alert["kind"], sessionID: string, detail: Alert["detail"], text?: string): void {
    const entry = [...this.boards].find(([, board]) => board.get(sessionID))
    if (!entry) return
    const [rootID, board] = entry
    const alert: Alert = {
      kind,
      sessionID: rootID,
      title: board.get(rootID)?.title ?? rootID,
      ...(detail ? { detail } : {}),
      ...(text !== undefined ? { text } : {}),
    }
    const owner = this.sessionTenant(rootID)
    for (const listener of this.alertListeners) listener(owner ? { ...alert, owner } : alert)
  }

  private emit(message: RegistryMessage): void {
    const tenant = message.type === "catalog" ? undefined : this.sessionTenant("rootID" in message ? message.rootID : message.sessionID)
    for (const listener of this.listeners) listener(message, tenant)
  }
}
