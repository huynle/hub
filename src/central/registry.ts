// Connected spokes and what they report: a catalog of machines → processes → sessions, one live
// StatusBoard per root session (fed by forwarded events from any process), owner selection for turns,
// a per-session turn lock, permission routing back to the process that asked, and conversation mode
// (which sessions speak their replies on the phone).
//
// Cluster mode (design §9, decision vkxkqiuf §5): the Registry is the single writer of this pod's connections and
// exports, per tenant, a RegistrySlice of them (connections and what they report, status boards with their activity,
// pending permissions and forms, presence, sessions with a turn running); ./cluster/view.ts publishes it to the
// Catalog and the Bus and applies other pods' slices here (setRemote). The synchronous reads (sessionTenant,
// owner, catalog, permissionTargets, …) answer over local and remote state, so a route on any pod finds a spoke on
// another one and reaches it through SpokeHub.request (pod RPC). Events, alerts and speech stay with the pod that
// holds the connection; remote state is never re-exported.
import path from "node:path"
import { HARNESS_OPENCODE, helloHarness, spokeFeatures, type EvidenceLevel, type ForwardedEvent, type Hello, type HerdrWorkspace, type ProcessKind, type SessionInfo, type SpokeFeature, type SpokeMode, type TerminalInfo, type Terminals } from "../protocol"
import { StatusBoard, permissionRequest, type Blocker, type BlockerRecommendation, type PermissionRequest, type SessionStatus } from "../status"
import { sanitizeLabel } from "./agent/envelope"
import { DoneWatch } from "./done"
import { SentenceStream } from "./say-stream"
import type { ActivityStep, NotificationKind } from "./push"

export { ACTIVITY_INTERVAL_MINUTES } from "./store"
/** A tool call that took at least this long is named in activity updates (shorter ones are only counted). */
export const LONG_TOOL_MS = 30_000

export class BusyError extends Error {
  constructor() {
    super("A turn is already running for this session")
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
  /** Assistant text streamed in a root or subagent session (rootID: its root session; ordinal: its text part). */
  | { readonly type: "delta"; readonly sessionID: string; readonly rootID: string; readonly messageID?: string; readonly ordinal?: number; readonly text: string }
  /** Reasoning text streamed in a root or subagent session. */
  | { readonly type: "reasoning"; readonly sessionID: string; readonly rootID: string; readonly messageID?: string; readonly delta: string }
  | { readonly type: "conversation"; readonly sessionID: string; readonly on: boolean }
  /**
   * Assistant text of a root session in conversation mode, to be spoken. Root text is spoken while it streams:
   * one say per completed sentence, `seq` counting the sentences of the message's text part (`ordinal`) from 0.
   * A subagent's final result is one say for the whole text part (no `seq`).
   */
  | { readonly type: "say"; readonly sessionID: string; readonly messageID: string; readonly ordinal: number; readonly seq?: number; readonly text: string }
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
  /** A subagent tool: the child session it runs (once the tool reported it). */
  readonly childSessionID?: string
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
/** A worker result is prefixed with its task's title while another worker runs or was announced within this window. */
export const ANNOUNCE_GROUP_MS = 60_000
/** Root speech within this window counts as heard: a worker result it already contained is not read again. */
export const HEARD_WINDOW_MS = 2 * 60_000
/** Another process forwarding the same worker failure within this window is not announced again. */
const FAILURE_DEDUPE_MS = 30_000
const ANNOUNCE_REASON_MAX = 150

/** Lowercase words only, for "was this already said" checks. */
const spokenForm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/** Push-worthy transitions of a root session. Kept off the SSE stream. */
export interface Alert {
  /**
   * The notification kind (docs/notifications.md); activity: a step of interest for activity updates (`step`), the
   * push layer collects and throttles them.
   */
  readonly kind: NotificationKind | "activity"
  /** Root session of the tree the event happened in. */
  readonly sessionID: string
  /** Root session title. */
  readonly title: string
  /** The body: the spoken text (say), a reason (failed, stopped, retry), a command (scripts), the parent session. */
  readonly text?: string
  /** permission: the request ID. */
  readonly requestID?: string
  /** What it is about, for the title: a subagent's title, a job's outcome ("exited 1"), a duration ("45s"). */
  readonly subject?: string
  /** Identity of the thing that ended (subagent session, job, tool call): one notification each, whatever the cooldown. */
  readonly key?: string
  /** Tenant (user ID) that owns the session; push goes to this user's devices only. */
  readonly owner?: string
  readonly step?: ActivityStep
}

/** Notifications that reach a session even while some device shows it. */
const ALWAYS_ALERT: ReadonlySet<NotificationKind> = new Set(["handoff", "question", "permission", "say"])

/** Interruptions worth a "stopped" notification (a user stop or a newer turn superseding it are not). */
const STOP_REASONS: Readonly<Record<string, string>> = { shutdown: "OpenCode shut down", inactivity: "Stopped after inactivity" }

/** Machine ID → tenant (owning user ID). Every machine belongs to exactly one tenant. */
export type TenantOf = (machineID: string) => string | undefined

/** A pending permission: where it was asked, every connection that forwarded it, what it asks. */
interface PendingPermission {
  connIDs: string[]
  readonly sessionID: string
  readonly tenant?: string
  readonly request?: PermissionRequest
  recommendation?: BlockerRecommendation
}

/** Characters of a recommendation's author and reason on a blocker. */
const RECOMMENDATION_BY_MAX = 200
const RECOMMENDATION_WHY_MAX = 1_000
const DECISION_ID = /^dec_[A-Za-z0-9]{1,64}$/

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
  /** Voice is enabled for the session. Inspection and control do not depend on it; speech does. */
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
  /** OpenCode's version as the hello sent it (kept for older consoles; see harnessVersion). */
  readonly opencodeVersion: string
  readonly pluginVersion: string
  /** Harness id ("opencode" for hellos that predate harness), its version and the declared evidence level. */
  readonly harness: string
  readonly harnessVersion: string
  readonly evidence: EvidenceLevel | "unknown"
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
  /** What the process serves: announced features ∪ the implied v1 set for an old OpenCode hello. */
  readonly features: ReadonlySet<string>
  readonly connected: number
  readonly seq: number
  lastSeen: number
  sessions: Map<string, SessionInfo>
  /** The last sessions frame as JSON, to skip unchanged snapshots. */
  sessionsKey: string
  /** sessionID → activity sequence number of the last event this process sent for it. */
  activity: Map<string, number>
  /**
   * The launch this connection is bound to (it authenticated with that launch's token, phase 5). Such a
   * connection is never the machine's service nor an exposure target.
   */
  readonly launchID?: string
  /** A connection another pod holds (from its slice): its tenant as that pod saw it. */
  readonly remote?: { readonly pod: string; readonly tenant: string }
}

/** A connection in a RegistrySlice. */
export interface SliceConn {
  readonly id: string
  readonly machine: MachineRef
  readonly hello: Hello
  readonly connected: number
  readonly seq: number
  readonly lastSeen: number
  readonly sessions: SessionInfo[]
  /** sessionID → recency (comparable across pods: clock-based). */
  readonly activity: Array<[string, number]>
  readonly launchID?: string
  /** The machine's terminal context, when this connection sent the latest one. */
  readonly terminals?: MachineTerminals
}

/** A root session's status tree (live: run starts and recommendations included) and activity feed. */
export interface SliceBoard {
  readonly rootID: string
  readonly sessions: LiveStatus[]
  readonly activity: ActivityItem[]
}

export interface SlicePermission {
  readonly requestID: string
  readonly sessionID: string
  readonly connIDs: string[]
  readonly request?: PermissionRequest
  readonly recommendation?: BlockerRecommendation
}

export interface SliceForm {
  readonly formID: string
  readonly sessionID: string
  readonly connIDs: string[]
}

/** One tenant's state on one pod, as other pods mirror it (JSON-compatible). */
export interface RegistrySlice {
  readonly conns: SliceConn[]
  readonly boards: SliceBoard[]
  readonly permissions: SlicePermission[]
  readonly forms: SliceForm[]
  readonly presence: Array<{ readonly deviceID: string; readonly sessionID: string; readonly at: number }>
  /** Sessions with a hub turn running on that pod. */
  readonly busy: string[]
}

/** How a connection was authenticated, beyond its machine. */
export interface ConnectOptions {
  /** The launch whose launch-bound token the connection presented (checked by /spoke/ws). */
  readonly launchID?: string
}

/** Streamed text of one session waiting for its next send window. */
interface Stream {
  last: number
  timer?: unknown
  pending: Array<{ kind: "delta" | "reasoning"; rootID: string; messageID?: string; ordinal?: number; text: string }>
}

/** Latest assistant message of a child run, paired with its successful completion for direct speech. */
/** A root text part being spoken while it streams (deltas from the first process that streamed it). */
interface RootSpeech {
  readonly sessionID: string
  readonly connID: string
  readonly stream: SentenceStream
  seq: number
}

/** Root text parts being spoken at once (more are dropped oldest first). */
const ROOT_SPEECH_LIMIT = 100

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
  /**
   * permission requestID → its session and every connection that forwarded it, first first. Usually one
   * process holds it, but several may report the session; a reply tries them in order.
   */
  private readonly permissions = new Map<string, PendingPermission>()
  /** Told when a pending permission goes away (replied, dropped, its processes gone). */
  private readonly permissionClosedListeners = new Set<(requestID: string, sessionID: string, tenant: string | undefined) => void>()
  /** Sessions with a hub turn in flight, with how to end the waiting request early (stop/interrupt). */
  private readonly active = new Map<string, { readonly cancel?: () => void }>()
  private readonly listeners = new Set<(message: RegistryMessage, tenant?: string) => void>()
  private readonly alertListeners = new Set<(alert: Alert) => void>()
  /** Called after every sessions frame (unchanged snapshots too), e.g. to push session tokens. */
  private readonly sessionsListeners = new Set<(connID: string) => void>()
  /** Called when the user's own prompt reached a session's inbox (typed or spoken in the harness). */
  private readonly humanTurnListeners = new Set<(sessionID: string, tenant?: string) => void>()
  /** Pending form ID → its session and every connection that forwarded it, first first (like permissions). */
  private readonly forms = new Map<string, { connIDs: string[]; sessionID: string }>()
  /** Form IDs already alerted (forms may be forwarded by several processes). */
  private readonly alertedForms = new Set<string>()
  /** Sessions in conversation mode → the connection last told so (re-sent when another one takes over). */
  private readonly conversations = new Map<string, string | undefined>()
  /** `messageID ordinal` of texts already sent as say events (several processes forward the same text). */
  private readonly spoken = new Map<string, true>()
  /** `messageID ordinal` → a root text part being spoken sentence by sentence as it streams. */
  private readonly rootSpeech = new Map<string, RootSpeech>()
  /** Child session → latest text and completion state, while its root is in conversation mode. */
  private readonly workerSpeech = new Map<string, WorkerSpeech>()
  /** Root → what it said lately (spokenForm), so a worker result the voice agent already relayed is skipped. */
  private readonly rootHeard = new Map<string, Array<{ text: string; at: number }>>()
  /** Root → when a worker announcement of its tree was last spoken. */
  private readonly lastAnnounced = new Map<string, number>()
  /** Worker → when its failure was announced; permission/form ID → announced. */
  private readonly announcedFailures = new Map<string, number>()
  private readonly announcedBlockers = new Map<string, true>()
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
  private readonly doneWatch: DoneWatch
  /** Told when this pod's state of a tenant changed (undefined: any tenant). */
  private readonly localChangeListeners = new Set<(tenant: string | undefined) => void>()
  /** Other pods' slices: pod → tenant → slice; the maps below index them (see reindex). */
  private readonly remoteSlices = new Map<string, Map<string, RegistrySlice>>()
  private remoteConns = new Map<string, Conn>()
  private remoteBoards = new Map<string, SliceBoard>()
  private remotePermissions = new Map<string, { sessionID: string; tenant: string; connIDs: string[]; request?: PermissionRequest; recommendation?: BlockerRecommendation }>()
  private remoteForms = new Map<string, { sessionID: string; connIDs: string[] }>()
  private remotePresence: Array<{ sessionID: string; at: number }> = []
  private remoteBusy = new Set<string>()
  private remoteTerminals = new Map<string, MachineTerminals>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = realTimers,
    /** Single tenant unless given (pairing mode, tests). */
    private readonly tenantOf: TenantOf = () => "",
  ) {
    this.doneWatch = new DoneWatch(timers, (rootID) => this.settledTree(rootID), (rootID) => this.alert("done", rootID))
  }

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
    return conn.remote ? conn.remote.tenant : (this.tenantOf(conn.machine.id) ?? `?${conn.machine.id}`)
  }

  /** A connection of this pod or (remote) of another one. */
  private conn(connID: string): Conn | undefined {
    return this.conns.get(connID) ?? this.remoteConns.get(connID)
  }

  /** Every connection: this pod's, then other pods'. */
  private all(): Conn[] {
    return this.remoteConns.size ? [...this.conns.values(), ...this.remoteConns.values()] : [...this.conns.values()]
  }

  /** A sequence number that also orders across pods (clock-based, strictly increasing here). */
  private tick(): number {
    this.seq = Math.max(this.seq + 1, this.now())
    return this.seq
  }

  /** Tenant of a reported session, or of the status board that contains it; undefined when unknown. */
  sessionTenant(sessionID: string): string | undefined {
    let first: Conn | undefined
    for (const conn of this.all()) if (conn.sessions.has(sessionID) && (!first || conn.seq < first.seq)) first = conn
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
    const conn = this.conn(connID)
    return conn && this.tenant(conn)
  }

  /** IDs of the sessions the connection reports for its own tenant (subagents included); empty when unknown. */
  reportedSessions(connID: string): string[] {
    const conn = this.conn(connID)
    return conn ? this.visible(conn).map((s) => s.id) : []
  }

  /** The machine of a connected process. */
  connMachine(connID: string): string | undefined {
    return this.conn(connID)?.machine.id
  }

  /** Whether a connected process of the machine reports the session for the machine's tenant. */
  machineReports(machineID: string, sessionID: string): boolean {
    for (const conn of this.all()) if (conn.machine.id === machineID && this.reports(conn, sessionID)) return true
    return false
  }

  /** Listens to every sessions frame (after it is applied, unchanged snapshots included). */
  onSessions(listener: (connID: string) => void): () => void {
    this.sessionsListeners.add(listener)
    return () => this.sessionsListeners.delete(listener)
  }

  /**
   * Listens to human turns the spokes report: a prompt the user put into a session's inbox
   * (session.inbox.delivered with origin "user"); `tenant` owns the session.
   */
  onHumanTurn(listener: (sessionID: string, tenant?: string) => void): () => void {
    this.humanTurnListeners.add(listener)
    return () => this.humanTurnListeners.delete(listener)
  }

  connect(connID: string, machine: MachineRef, hello: Hello, options: ConnectOptions = {}): void {
    const t = this.now()
    this.conns.set(connID, {
      ...(options.launchID !== undefined ? { launchID: options.launchID } : {}),
      id: connID,
      machine,
      hello,
      features: spokeFeatures(hello),
      connected: t,
      seq: this.tick(),
      lastSeen: t,
      sessions: new Map(),
      sessionsKey: "[]",
      activity: new Map(),
    })
    this.changed(this.tenant(this.conns.get(connID)!))
    this.emit({ type: "catalog" })
  }

  disconnect(connID: string): void {
    const conn = this.conns.get(connID)
    if (!conn || !this.conns.delete(connID)) return
    if (this.machineTerminals.get(conn.machine.id)?.connID === connID) this.machineTerminals.delete(conn.machine.id)
    // Nobody can answer permissions asked by a process that is gone.
    for (const [requestID, origin] of this.permissions) {
      if (!origin.connIDs.includes(connID)) continue
      origin.connIDs = origin.connIDs.filter((id) => id !== connID)
      if (origin.connIDs.length) continue
      this.permissions.delete(requestID)
      this.observeBoards({ type: "permission.replied", data: { sessionID: origin.sessionID, requestID } })
      this.permissionClosed(requestID, origin)
    }
    for (const [formID, origin] of this.forms) {
      if (!origin.connIDs.includes(connID)) continue
      origin.connIDs = origin.connIDs.filter((id) => id !== connID)
      if (origin.connIDs.length) continue
      this.forms.delete(formID)
      this.observeBoards({ type: "form.cancelled", data: { sessionID: origin.sessionID, id: formID } })
    }
    this.syncBoards()
    this.changed(this.tenant(conn))
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
    if (key !== conn.sessionsKey) {
      conn.sessionsKey = key
      conn.sessions = new Map(sessions.map((s) => [s.id, s]))
      this.syncBoards()
      this.changed(this.tenant(conn))
      this.emit({ type: "catalog" })
    }
    for (const listener of [...this.sessionsListeners]) listener(connID)
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
    if (previous?.key === key) return
    this.changed(this.tenant(conn))
    this.emit({ type: "catalog" })
  }

  /** The machine's terminal context, while the process that sent it is connected. */
  terminals(machineID: string): MachineTerminals | undefined {
    return this.machineTerminals.get(machineID)?.terminals ?? this.remoteTerminals.get(machineID)
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
    if (sessionID) conn.activity.set(sessionID, this.tick())
    const streamed = event.type === "session.text.delta" || event.type === "session.reasoning.delta"
    // Streamed text changes nothing other pods mirror (its recency goes out with the next change).
    if (!streamed) this.changed(tenant)
    // Anything else in a session (text ended → say, run ended → status) goes out after its streamed text.
    if (sessionID && !streamed) this.flushStream(this.streams.get(sessionID), sessionID)

    if (event.type === "permission.asked" && typeof data.id === "string" && sessionID) {
      const known = this.permissions.get(data.id)
      if (known) {
        // The same request forwarded by another process: one more place to answer it.
        if (!known.connIDs.includes(connID)) known.connIDs.push(connID)
        return
      }
      const request = permissionRequest(data)
      this.permissions.set(data.id, { connIDs: [connID], sessionID, tenant, ...(request ? { request } : {}) })
      this.alert("permission", sessionID, { requestID: data.id })
    }
    if (event.type === "form.created" && sessionID) {
      const formID = (data.form as Record<string, unknown> | undefined)?.id
      if (typeof formID === "string") {
        const known = this.forms.get(formID)
        if (known && !known.connIDs.includes(connID)) known.connIDs.push(connID)
        else if (!known) remember(this.forms, formID, { connIDs: [connID], sessionID })
      }
      if (typeof formID === "string" && !this.alertedForms.has(formID)) {
        this.alertedForms.add(formID)
        if (this.alertedForms.size > 1000) this.alertedForms.delete(this.alertedForms.values().next().value!)
        this.alert("question", sessionID)
      }
    }
    let closedPermission: [string, PendingPermission] | undefined
    if (event.type === "permission.replied" && typeof data.requestID === "string") {
      const origin = this.permissions.get(data.requestID)
      if (origin && this.permissions.delete(data.requestID)) closedPermission = [data.requestID, origin]
    }
    if ((event.type === "form.replied" || event.type === "form.cancelled") && typeof data.id === "string") {
      this.forms.delete(data.id)
    }

    if (sessionID) this.trackRun(event.type, sessionID)
    const before = sessionID ? this.status(sessionID)?.find((s) => s.id === sessionID) : undefined
    this.observeBoards(event, tenant)
    if (sessionID) this.activitySteps(event.type, sessionID, data, before)
    if (sessionID) this.notifications(event.type, sessionID, data, before)
    if (sessionID) this.observeActivity(event, sessionID, data)
    if (sessionID) this.observeWorkerSpeech(event.type, sessionID, data)
    if (sessionID) this.observeWorkerBlockers(event.type, sessionID, data)

    if (streamed && sessionID) {
      const rootID = this.rootOf(sessionID)
      if (rootID) this.stream(sessionID, rootID, event.type === "session.text.delta" ? "delta" : "reasoning", data)
    }
    if (event.type === "session.text.delta" && sessionID) this.speakDelta(connID, sessionID, data)
    if (event.type === "session.text.ended" && sessionID) this.say(sessionID, data)
    if ((event.type === "session.execution.interrupted" || event.type === "session.execution.failed") && sessionID) this.dropRootSpeech(sessionID)
    if (event.type === "session.inbox.delivered" && typeof data.inboxID === "string") this.delivered(data.inboxID)
    if (event.type === "session.inbox.delivered" && data.origin === "user" && sessionID) {
      const tenant = this.sessionTenant(sessionID)
      for (const listener of [...this.humanTurnListeners]) listener(sessionID, tenant)
    }
    if (event.type === "session.deleted" && sessionID) this.setConversation(sessionID, false)
    if (closedPermission) this.permissionClosed(...closedPermission)
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
    const ordinal = kind === "delta" && Number.isInteger(data.ordinal) && (data.ordinal as number) >= 0 ? (data.ordinal as number) : undefined
    let stream = this.streams.get(sessionID)
    if (!stream) remember(this.streams, sessionID, (stream = { last: -Infinity, pending: [] }))
    const tail = stream.pending.at(-1)
    if (tail && tail.kind === kind && tail.messageID === messageID && tail.ordinal === ordinal && tail.rootID === rootID) tail.text += text
    else stream.pending.push({ kind, rootID, messageID, ...(ordinal === undefined ? {} : { ordinal }), text })
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
    for (const { kind, rootID, messageID, ordinal, text } of chunks) {
      const message = { sessionID, rootID, ...(messageID ? { messageID } : {}) }
      this.emit(kind === "delta" ? { type: "delta", ...message, ...(ordinal === undefined ? {} : { ordinal }), text } : { type: "reasoning", ...message, delta: text })
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

  /** Root text streaming in conversation mode: each sentence is spoken as soon as it is complete. */
  private speakDelta(connID: string, sessionID: string, data: Record<string, unknown>): void {
    if (this.rootOf(sessionID) !== sessionID || !this.conversations.has(sessionID) || !this.boards.has(sessionID)) return
    const { assistantMessageID: messageID, ordinal, delta } = data
    if (typeof messageID !== "string" || typeof ordinal !== "number" || typeof delta !== "string") return
    const key = `${messageID} ${ordinal}`
    if (this.spoken.has(key)) return
    let state = this.rootSpeech.get(key)
    if (!state) remember(this.rootSpeech, key, (state = { sessionID, connID, stream: new SentenceStream(), seq: 0 }), ROOT_SPEECH_LIMIT)
    // Other processes forward the same deltas: one stream per text part.
    if (state.connID !== connID) return
    const sentences = state.stream.push(delta)
    // The sentence's own text goes out first, so a say never overtakes its bubble.
    if (sentences.length) this.flushStream(this.streams.get(sessionID), sessionID)
    for (const text of sentences) this.emitSentence(state, messageID, ordinal, text)
  }

  /** A root text part ended: speaks what the deltas did not (the ended text is authoritative), once. */
  private say(sessionID: string, data: Record<string, unknown>): void {
    if (this.rootOf(sessionID) !== sessionID) return
    const { assistantMessageID: messageID, ordinal, text } = data
    if (!this.conversations.has(sessionID) || !this.boards.has(sessionID)) return
    if (typeof messageID !== "string" || typeof ordinal !== "number" || typeof text !== "string") return
    const key = `${messageID} ${ordinal}`
    if (this.spoken.has(key)) return
    remember(this.spoken, key, true)
    const state = this.rootSpeech.get(key) ?? { sessionID, connID: "", stream: new SentenceStream(), seq: 0 }
    this.rootSpeech.delete(key)
    for (const sentence of state.stream.end(text)) this.emitSentence(state, messageID, ordinal, sentence)
    // Nobody is listening on a phone: push the whole reply so it reaches a locked screen.
    if (text.trim() && !this.watched(sessionID)) this.alert("say", sessionID, { text })
  }

  private emitSentence(state: RootSpeech, messageID: string, ordinal: number, text: string): void {
    this.heardFrom(state.sessionID, text)
    this.emit({ type: "say", sessionID: state.sessionID, messageID, ordinal, seq: state.seq++, text })
  }

  /** The run stopped or conversation mode ended: the rest of its text parts is not spoken. */
  private dropRootSpeech(sessionID: string): void {
    for (const [key, state] of this.rootSpeech) {
      if (state.sessionID !== sessionID) continue
      this.rootSpeech.delete(key)
      remember(this.spoken, key, true)
    }
  }

  /** Emits one subagent result part through its root, deduped across processes. */
  private emitSay(sessionID: string, data: Record<string, unknown>): void {
    const { assistantMessageID: messageID, ordinal, text } = data
    if (!this.conversations.has(sessionID) || !this.boards.has(sessionID)) return
    if (typeof messageID !== "string" || typeof ordinal !== "number" || typeof text !== "string" || !text.trim()) return
    const key = `${messageID} ${ordinal}`
    if (this.spoken.has(key)) return
    remember(this.spoken, key, true)
    this.emit({ type: "say", sessionID, messageID, ordinal, text })
    // Nobody is listening on a phone: push the reply so it reaches a locked screen.
    if (!this.watched(sessionID)) this.alert("say", sessionID, { text })
  }

  /** Records root speech for `alreadyHeard`, keeping the last few minutes. */
  private heardFrom(rootID: string, text: string): void {
    const now = this.now()
    const recent = (this.rootHeard.get(rootID) ?? []).filter((entry) => now - entry.at <= HEARD_WINDOW_MS).slice(-30)
    recent.push({ text: spokenForm(text), at: now })
    remember(this.rootHeard, rootID, recent, ACTIVITY_ROOTS)
  }

  /** True when the root's recent speech already contained this text (the voice agent relayed the result). */
  private alreadyHeard(rootID: string, text: string): boolean {
    const wanted = spokenForm(text)
    if (wanted.length < 8) return false
    const now = this.now()
    const said = (this.rootHeard.get(rootID) ?? []).filter((entry) => now - entry.at <= HEARD_WINDOW_MS).map((entry) => entry.text)
    return said.join(" ").includes(wanted)
  }

  /** A worker's task title (its session title on the root's status board). */
  private workerTitle(rootID: string, childID: string): string {
    return this.status(rootID)?.find((s) => s.id === childID)?.title?.trim() || "A worker"
  }

  /** Several workers are in play: another one runs (or waits) now, or one was announced a moment ago. */
  private severalWorkers(rootID: string, childID: string): boolean {
    const others = (this.status(rootID) ?? []).filter((s) => s.id !== rootID && s.id !== childID)
    if (others.some((s) => s.state === "working" || s.state === "blocked")) return true
    const last = this.lastAnnounced.get(rootID)
    return last !== undefined && this.now() - last <= ANNOUNCE_GROUP_MS
  }

  /** Speaks a hub-made announcement through the conversation root (pushed when nobody watches, if asked). */
  private announce(rootID: string, messageID: string, text: string, push: boolean): void {
    remember(this.lastAnnounced, rootID, this.now(), ACTIVITY_ROOTS)
    this.emit({ type: "say", sessionID: rootID, messageID, ordinal: 0, text })
    if (push && !this.watched(rootID)) this.alert("say", rootID, { text })
  }

  /** The conversation root of a worker session, if it is one. */
  private conversationRootOf(sessionID: string): string | undefined {
    const rootID = this.rootOf(sessionID)
    return rootID && rootID !== sessionID && this.conversations.has(rootID) && this.boards.has(rootID) ? rootID : undefined
  }

  /** A worker that fails, needs a permission or asks a question is announced once ("Deploy check failed: …"). */
  private observeWorkerBlockers(type: string, sessionID: string, data: Record<string, unknown>): void {
    if (type !== "session.execution.failed" && type !== "permission.asked" && type !== "form.created") return
    const rootID = this.conversationRootOf(sessionID)
    if (!rootID) return
    const title = this.workerTitle(rootID, sessionID)
    if (type === "session.execution.failed") {
      const at = this.announcedFailures.get(sessionID)
      if (at !== undefined && this.now() - at <= FAILURE_DEDUPE_MS) return
      remember(this.announcedFailures, sessionID, this.now())
      const message = (data.error as { message?: unknown } | undefined)?.message
      const reason = (typeof message === "string" ? message : "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "").slice(0, ANNOUNCE_REASON_MAX)
      return this.announce(rootID, `announce:failed:${sessionID}`, reason ? `${title} failed: ${reason}.` : `${title} failed.`, true)
    }
    const id = type === "permission.asked" ? data.id : (data.form as { id?: unknown } | undefined)?.id
    if (typeof id !== "string") return
    const key = `${type} ${id}`
    if (this.announcedBlockers.has(key)) return
    remember(this.announcedBlockers, key, true)
    // "blocked" is pushed already; this is for the ears of whoever is in Voice mode.
    if (type === "permission.asked") this.announce(rootID, `announce:permission:${id}`, `${title} needs your permission.`, false)
    else this.announce(rootID, `announce:form:${id}`, `${title} has a question.`, false)
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
        if (this.workerSpeech.get(sessionID) === held) this.flushWorkerSpeech(sessionID, held)
      }, STREAM_INTERVAL_MS)
      return
    }
    this.flushWorkerSpeech(sessionID, state)
  }

  /**
   * Speaks a successful worker's result: prefixed with its task's title when several workers are in play, not at
   * all when the voice agent already said it.
   */
  private flushWorkerSpeech(childID: string, state: WorkerSpeech): void {
    if (!state.succeeded || !state.messageID || state.parts.size === 0 || !this.conversations.has(state.rootID)) return
    const parts = [...state.parts].sort(([a], [b]) => a - b).filter(([ordinal]) => !this.spoken.has(`${state.messageID} ${ordinal}`))
    state.parts.clear()
    if (!parts.length) return
    if (this.alreadyHeard(state.rootID, parts.map(([, text]) => text).join(" "))) {
      for (const [ordinal] of parts) remember(this.spoken, `${state.messageID} ${ordinal}`, true)
      return
    }
    const prefix = this.severalWorkers(state.rootID, childID) ? `${this.workerTitle(state.rootID, childID)} finished: ` : ""
    parts.forEach(([ordinal, text], index) => {
      this.emitSay(state.rootID, { assistantMessageID: state.messageID, ordinal, text: index === 0 ? prefix + text : text })
    })
    remember(this.lastAnnounced, state.rootID, this.now(), ACTIVITY_ROOTS)
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
    else if (!this.presence.delete(key)) return
    this.changed(this.sessionTenant(sessionID))
  }

  /** True while some device reported the session's tree visible within PRESENCE_WINDOW_MS. */
  watched(sessionID: string): boolean {
    const rootID = this.rootOf(sessionID) ?? sessionID
    const t = this.now()
    for (const entry of [...this.presence.values(), ...this.remotePresence]) {
      if (t - entry.at <= PRESENCE_WINDOW_MS && (this.rootOf(entry.sessionID) ?? entry.sessionID) === rootID) return true
    }
    return false
  }

  /** Whether any process exposes the session to voice; undefined when no process reports it. */
  exposed(sessionID: string): boolean | undefined {
    let reported = false
    for (const conn of this.all()) {
      const s = this.reports(conn, sessionID)
      if (!s) continue
      if (isOn(s)) return true
      reported = true
    }
    return reported ? false : undefined
  }

  /** Process to change a session's exposure: a reporting service process, else the most recent reporter (never launch-bound). */
  exposeTarget(sessionID: string): string | undefined {
    const reporters = this.all().filter((c) => c.launchID === undefined && this.reports(c, sessionID))
    const services = reporters.filter((c) => c.hello.kind === "service")
    return this.recent(services.length ? services : reporters, sessionID)
  }

  /** The launch a connection is bound to (undefined for ordinary connections and unknown ones). */
  launchOf(connID: string): string | undefined {
    return this.conn(connID)?.launchID
  }

  /** The (most recent) connection bound to a launch. */
  launchConn(launchID: string): string | undefined {
    let found: Conn | undefined
    for (const conn of this.all()) if (conn.launchID === launchID && (!found || conn.seq > found.seq)) found = conn
    return found?.id
  }

  /**
   * The machine's (most recently connected) background service process of a harness (default OpenCode); never a
   * launch-bound connection. Each harness has its own service: a Claude Code service never hides the OpenCode one.
   */
  serviceFor(machineID: string, harness: string = HARNESS_OPENCODE): string | undefined {
    const services = this.services(machineID).filter((c) => helloHarness(c.hello).harness === harness)
    return services.sort((a, b) => b.seq - a.seq)[0]?.id
  }

  /** The harnesses that have a background service process (serviceFor) on the machine. */
  serviceHarnesses(machineID: string): string[] {
    return [...new Set(this.services(machineID).map((c) => helloHarness(c.hello).harness))]
  }

  /** A connection's harness ("opencode" for hellos that predate harness); undefined for an unknown connection. */
  harnessOf(connID: string): string | undefined {
    const conn = this.conn(connID)
    return conn && helloHarness(conn.hello).harness
  }

  private services(machineID: string): Conn[] {
    return this.all().filter((c) => c.machine.id === machineID && c.hello.kind === "service" && c.launchID === undefined)
  }

  /**
   * True when the process reported a session in, or a workspace root equal to, the directory, or its
   * machine has a Herdr pane in it.
   */
  reportsWorkspace(connID: string, directory: string): boolean {
    const conn = this.conn(connID)
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
    for (const conn of this.all()) if (conn.sessions.has(sessionID)) return true
    return false
  }

  /**
   * Idle by real evidence (message re-wakes): the owner process observes the harness natively or through hooks,
   * nothing in the session's tree is working or blocked, and no hub turn holds it.
   */
  idle(sessionID: string): boolean {
    const owner = this.owner(sessionID)
    const conn = owner === undefined ? undefined : this.conn(owner)
    if (!conn) return false
    const { evidence } = helloHarness(conn.hello)
    if (evidence !== "native" && evidence !== "hooks") return false
    return !this.busy(sessionID) && this.browserFields(sessionID).state === "idle"
  }

  /** How recently a process sent an event for the session (higher: more recent; 0: never). */
  recency(sessionID: string): number {
    let latest = 0
    for (const conn of this.all()) latest = Math.max(latest, conn.activity.get(sessionID) ?? 0)
    return latest
  }

  /** Something in the session's tree is working or waiting for the user (typed input steers then). */
  running(sessionID: string): boolean {
    const state = this.browserFields(sessionID).state
    return state === "working" || state === "blocked"
  }

  /** Status tree of the root session that contains `sessionID`. */
  status(sessionID: string): LiveStatus[] | undefined {
    const board = this.boards.get(sessionID) ?? [...this.boards.values()].find((b) => b.get(sessionID))
    if (board) return this.live(board.snapshot().sessions)
    return this.remoteBoard(sessionID)?.sessions.map((s) => structuredClone(s))
  }

  /** Another pod's status board that contains the session. */
  private remoteBoard(sessionID: string): SliceBoard | undefined {
    if (!this.remoteBoards.size) return undefined
    const board = this.remoteBoards.get(sessionID)
    if (board) return board
    for (const candidate of this.remoteBoards.values()) if (candidate.sessions.some((s) => s.id === sessionID)) return candidate
    return undefined
  }

  /** A root's activity feed, here or (remote) on another pod. */
  private feed(rootID: string): readonly ActivityItem[] | undefined {
    return this.feeds.get(rootID) ?? (this.boards.has(rootID) ? undefined : this.remoteBoards.get(rootID)?.activity)
  }

  /** A hub turn runs for the session, on this pod or another. */
  private busy(sessionID: string): boolean {
    return this.active.has(sessionID) || this.remoteBusy.has(sessionID)
  }

  /** Adds `since` (run start) to working entries and agents' recommendations to permission blockers. */
  private live(sessions: SessionStatus[]): LiveStatus[] {
    return sessions.map((s) => {
      const since = s.state === "working" ? this.since.get(s.id) : undefined
      const recommended = s.blockers.some((b) => b.kind === "permission" && this.permissions.get(b.id)?.recommendation)
      const blockers = recommended
        ? s.blockers.map((b) => {
            const recommendation = b.kind === "permission" ? this.permissions.get(b.id)?.recommendation : undefined
            return recommendation ? { ...b, recommendation } : b
          })
        : s.blockers
      const entry = recommended ? { ...s, blockers } : s
      return since === undefined ? entry : { ...entry, since }
    })
  }

  catalog(): CatalogMachine[] {
    const machines = new Map<string, { id: string; name: string; processes: CatalogProcess[] }>()
    for (const conn of this.all().sort((a, b) => a.seq - b.seq)) {
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
        opencodeVersion: opencodeVersion ?? "",
        pluginVersion,
        ...helloHarness(conn.hello),
        connected: conn.connected,
        lastSeen: conn.lastSeen,
        sessions: this.visible(conn).map((s) => {
          const fields = this.browserFields(s.id)
          return {
            ...s,
            ...fields,
            processID,
            machineID: conn.machine.id,
            status: this.status(s.id) ?? [],
            busy: this.busy(s.id),
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
    for (const conn of this.all()) {
      const s = this.reports(conn, sessionID)
      if (s && (!info || s.updated > info.updated)) info = s
      if (s?.open && s.terminal && (!terminal || (terminal.source !== "herdr" && s.terminal.source === "herdr"))) terminal = s.terminal
    }
    if (!info) return this.childView(sessionID)
    const fields = this.browserFields(sessionID)
    const status = this.status(sessionID) ?? []
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
      busy: this.busy(sessionID),
      conversation: this.conversations.has(sessionID),
      status,
      activity: this.activity(sessionID),
    }
  }

  /**
   * A subagent session no process lists (it is known from its root's status tree, e.g. created by a run
   * the hub watched): its view, with the root's directory and workspace. Undefined for anything else.
   */
  private childView(sessionID: string): SessionView | undefined {
    const rootID = this.rootOf(sessionID)
    if (!rootID || rootID === sessionID) return undefined
    const root = this.session(rootID)
    const own = root?.status.find((s) => s.id === sessionID)
    if (!root || !own) return undefined
    return {
      id: sessionID,
      title: own.title,
      directory: root.directory,
      ...(own.parentID ? { parentID: own.parentID } : {}),
      ...(root.project ? { project: root.project } : {}),
      ...(root.projectName ? { projectName: root.projectName } : {}),
      updated: root.updated,
      ...this.browserFields(sessionID),
      busy: this.busy(sessionID),
      conversation: this.conversations.has(sessionID),
      status: root.status,
      activity: root.activity,
    }
  }

  /** Exposure, overall state, pending blockers and current activity of a session and its subtree. */
  private browserFields(sessionID: string): BrowserFields {
    const exposed = this.exposed(sessionID) === true
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
    const item = [...((rootID && this.feed(rootID)) || [])].reverse().find((i) => i.state === "running" && tree.has(i.sessionID))
    const now = item && { kind: item.kind, ...(item.tool ? { tool: item.tool } : {}), ...(item.summary ? { summary: item.summary } : {}) }
    return { exposed, state, blockers, ...(now ? { now } : {}) }
  }

  /** Recent activity of the root session that contains `sessionID`, newest last. */
  activity(sessionID: string): ActivityItem[] {
    const rootID = this.rootOf(sessionID)
    return rootID ? (this.feed(rootID) ?? []).map((item) => ({ ...item })) : []
  }

  /** Root session of the status board that contains `sessionID`. */
  rootOf(sessionID: string): string | undefined {
    if (this.boards.has(sessionID)) return sessionID
    for (const [rootID, board] of this.boards) if (board.get(sessionID)) return rootID
    return this.remoteBoard(sessionID)?.rootID
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
        const childSessionID = text(data.childSessionID)
        // A compact progress event (childSessionID only) adds the child to the item without touching the rest.
        const details = childSessionID && !("summary" in data)
          ? { childSessionID }
          : { ...(summary ? { summary } : {}), ...(data.background === true ? { background: true as const } : {}), ...(childSessionID ? { childSessionID } : {}) }
        const existing = find(id)
        if (!existing) return add({ id, sessionID, kind: "tool", ...details, state: "running", at })
        const next: ActivityItem = { ...existing, ...details }
        if (next.summary === existing.summary && next.background === existing.background && next.childSessionID === existing.childSessionID) return
        return this.replace(rootID, existing, next)
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const existing = find(data.id)
        if (!existing || existing.state !== "running") return
        const failed = event.type === "session.tool.failed"
        const error = failed ? (text(data.error) ?? "failed") : undefined
        const childSessionID = existing.childSessionID ?? text(data.childSessionID)
        const took = at - existing.at
        const name = existing.summary ?? existing.tool ?? "tool"
        if (took >= LONG_TOOL_MS) {
          this.step(rootID, "long", `${name} ${failed ? "failed" : "done"} (${Math.round(took / 1000)}s)`)
          // A subagent's tool call ends with the subagent (its own kinds).
          if (!childSessionID) this.alert("longTool", rootID, { subject: `${Math.round(took / 1000)}s`, text: `${name} ${failed ? "failed" : "done"}`, key: existing.id })
        } else this.step(rootID, "tool", name)
        return this.replace(rootID, existing, { ...existing, state: failed ? "failed" : "done", ...(error ? { error } : {}), ...(childSessionID ? { childSessionID } : {}), at })
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

  /**
   * Steps of interest for activity updates: a subagent starting or ending, a background job ending (with how), the
   * root's run ending. `before` is the session's status entry before the event (several processes forward the
   * same events: only actual changes count). Tool calls are reported from observeActivity.
   */
  private activitySteps(type: string, sessionID: string, data: Record<string, unknown>, before: LiveStatus | undefined): void {
    const rootID = this.rootOf(sessionID)
    if (!rootID || !before) return
    const child = rootID !== sessionID
    const title = before.title?.trim() || "A subagent"
    if (type === "session.execution.started" && child && before.state !== "working") return this.step(rootID, "subagent", `${title} started`)
    if (type.startsWith("session.execution.") && type !== "session.execution.started") {
      const ended = { succeeded: "finished", failed: "failed", interrupted: "stopped" }[type.slice("session.execution.".length)]
      if (!ended || before.state !== "working") return
      if (child) return this.step(rootID, "subagent", `${title} ${ended}`)
      return this.step(rootID, "idle", ended === "finished" ? "Finished" : ended === "failed" ? "Failed" : "Stopped")
    }
    if (type === "shell.exited" || type === "session.shell.ended" || type === "pty.exited") {
      const job = before.jobs?.find((j) => j.id === data.id)
      if (!job || job.status !== "running") return
      const exit = typeof data.exit === "number" ? data.exit : undefined
      const how = data.status === "killed" ? "was killed" : data.status === "timeout" ? "timed out" : exit !== undefined ? `exited ${exit}` : "exited"
      return this.step(rootID, "job", `${job.command ?? (job.kind === "pty" ? "terminal" : "shell")} ${how}`)
    }
  }

  /**
   * Notifications from run, subagent, job and status events (docs/notifications.md). `before` is the session's status
   * entry before the event: several processes forward the same events, so subagent and job notifications need an
   * actual change; root outcomes are deduped by the push cooldown.
   */
  private notifications(type: string, sessionID: string, data: Record<string, unknown>, before: LiveStatus | undefined): void {
    const rootID = this.rootOf(sessionID)
    if (!rootID) return
    const root = rootID === sessionID
    const wasRunning = before?.state === "working" || before?.state === "blocked"
    if (type === "session.execution.started") return this.doneWatch.started(rootID, root)
    if (type === "session.text.delta" || type === "session.reasoning.delta") return
    const ended = type === "session.execution.succeeded" ? "succeeded" : type === "session.execution.failed" ? "failed" : type === "session.execution.interrupted" ? "interrupted" : undefined
    const reason = (data.error as { message?: unknown } | undefined)?.message
    const error = typeof reason === "string" && reason.trim() ? reason : undefined
    if (ended && root) {
      this.doneWatch.rootEnded(rootID, ended, wasRunning)
      if (ended === "succeeded" && wasRunning && !this.active.has(rootID)) this.alert("turn", rootID)
      if (ended === "failed") this.alert("failed", rootID, error ? { text: error } : {})
      const stopped = ended === "interrupted" ? STOP_REASONS[String(data.reason)] : undefined
      if (stopped) this.alert("stopped", rootID, { text: stopped })
      return
    }
    this.doneWatch.poke(rootID)
    if (ended && wasRunning && ended !== "interrupted") {
      const subject = before!.title?.trim() || "subagent"
      const parent = (before!.parentID && this.status(rootID)?.find((s) => s.id === before!.parentID)?.title?.trim()) || "the session"
      if (ended === "succeeded") this.alert("subagentDone", rootID, { subject, text: `In ${parent}`, key: sessionID })
      else this.alert("subagentFailed", rootID, { subject, text: error ?? `In ${parent}`, key: sessionID })
      return
    }
    if (type === "session.status" && root && !before?.retry) {
      const retry = this.status(rootID)?.find((s) => s.id === rootID)?.retry
      if (retry) this.alert("retry", rootID, { text: [retry.attempt !== undefined ? `Attempt ${retry.attempt}` : "", retry.message ?? ""].filter(Boolean).join(": ") || "Retrying" })
      return
    }
    if (type === "shell.exited" || type === "session.shell.ended" || type === "pty.exited") {
      const job = before?.jobs?.find((j) => j.id === data.id)
      if (!job || job.status !== "running") return
      const exit = typeof data.exit === "number" ? data.exit : undefined
      const how = data.status === "killed" ? "was killed" : data.status === "timeout" ? "timed out" : exit !== undefined ? `exited ${exit}` : "exited"
      const failed = data.status === "killed" || data.status === "timeout" || (exit !== undefined && exit !== 0)
      this.alert(failed ? "jobFailed" : "jobDone", rootID, { subject: how, text: job.command ?? (job.kind === "pty" ? "terminal" : "shell"), key: job.id })
    }
  }

  /** Fires when a root's tree stayed settled after its run (DoneWatch). */
  private settledTree(rootID: string): boolean {
    const board = this.boards.get(rootID)
    if (!board?.settled()) return false
    for (const id of this.active.keys()) if ((this.rootOf(id) ?? id) === rootID) return false
    return true
  }

  /** Reports an activity step of a root session (not while a device shows it). */
  private step(rootID: string, kind: ActivityStep["kind"], text: string): void {
    if (this.watched(rootID)) return
    const board = this.boards.get(rootID)
    if (!board) return
    const owner = this.sessionTenant(rootID)
    const alert: Alert = { kind: "activity", sessionID: rootID, title: board.get(rootID)?.title ?? rootID, step: { kind, text } }
    for (const listener of this.alertListeners) listener(owner ? { ...alert, owner } : alert)
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
      this.dropRootSpeech(sessionID)
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
  /**
   * Whether a connected process serves an optional feature: it announced it in its hello, or it is an OpenCode
   * spoke that predates harness and the feature is in IMPLIED_OPENCODE_FEATURES.
   */
  supports(connID: string, feature: SpokeFeature): boolean {
    return this.conn(connID)?.features.has(feature) === true
  }

  owner(sessionID: string): string | undefined {
    const tenant = this.sessionTenant(sessionID)
    const all = this.all().filter((c) => this.tenant(c) === tenant)
    const reporters = all.filter((c) => this.reports(c, sessionID))
    if (reporters.length === 0) {
      // A subagent session no process lists runs in the process that runs its root.
      const rootID = this.rootOf(sessionID)
      return rootID && rootID !== sessionID ? this.owner(rootID) : undefined
    }
    const recent = (list: Conn[]) => this.recent(list, sessionID)
    const owned = reporters.filter((c) => this.reports(c, sessionID)?.owned)
    if (owned.length) return recent(owned)
    const services = reporters.filter((c) => c.hello.kind === "service")
    if (services.length) return recent(services)
    const machines = new Set(reporters.map((c) => c.machine.id))
    return recent(all.filter((c) => c.hello.kind === "service" && machines.has(c.machine.id))) ?? recent(reporters)
  }

  /**
   * Connections to try for a session op that any reporter can carry out (e.g. rename): the owner first, then
   * the other processes of the session's tenant that report it, most recent activity first.
   */
  sessionTargets(sessionID: string): string[] {
    const owner = this.owner(sessionID)
    if (!owner) return []
    const tenant = this.sessionTenant(sessionID)
    const others = this.all()
      .filter((c) => c.id !== owner && this.tenant(c) === tenant && this.reports(c, sessionID))
      .sort((a, b) => (b.activity.get(sessionID) ?? 0) - (a.activity.get(sessionID) ?? 0) || b.seq - a.seq)
    return [owner, ...others.map((c) => c.id)]
  }

  /** The connection with the most recent activity for the session, then the most recently connected. */
  private recent(list: Conn[], sessionID: string): string | undefined {
    return [...list].sort((a, b) => (b.activity.get(sessionID) ?? 0) - (a.activity.get(sessionID) ?? 0) || b.seq - a.seq)[0]?.id
  }

  /** Where to send a reply for a permission that is pending in the session's status tree (the first place). */
  permissionTarget(rootID: string, requestID: string): { connID: string; sessionID: string } | undefined {
    return this.permissionTargets(rootID, requestID)[0]
  }

  /** Every connected process of the session's tenant that forwarded the pending permission, first first. */
  permissionTargets(rootID: string, requestID: string): Array<{ connID: string; sessionID: string }> {
    const pending = this.status(rootID)?.some((s) =>
      s.blockers.some((b) => b.kind === "permission" && b.id === requestID),
    )
    const local = this.permissions.get(requestID)
    const remote = this.remotePermissions.get(requestID)
    const origin = local ?? remote
    if (!pending || !origin) return []
    const tenant = this.sessionTenant(rootID)
    return [...new Set([...(local?.connIDs ?? []), ...(remote?.connIDs ?? [])])]
      .filter((connID) => this.conn(connID) !== undefined && this.connTenant(connID) === tenant)
      .map((connID) => ({ connID, sessionID: origin.sessionID }))
  }

  /**
   * A pending permission: the session that asked and what it asks (bounded, without metadata; absent when the
   * request had no usable action). Callers check tenancy (owns) and that it is still pending in the tree.
   */
  permissionRequest(requestID: string): { sessionID: string; request?: PermissionRequest } | undefined {
    const origin = this.permissions.get(requestID) ?? this.remotePermissions.get(requestID)
    if (!origin) return undefined
    return { sessionID: origin.sessionID, ...(origin.request ? { request: structuredClone(origin.request) } : {}) }
  }

  /** Every connected process of the session's tenant that forwarded the pending form, first first. */
  formTargets(rootID: string, formID: string): Array<{ connID: string; sessionID: string }> {
    const pending = this.status(rootID)?.some((s) => s.blockers.some((b) => b.kind === "form" && b.id === formID))
    const local = this.forms.get(formID)
    const remote = this.remoteForms.get(formID)
    const origin = local ?? remote
    if (!pending || !origin) return []
    const tenant = this.sessionTenant(rootID)
    return [...new Set([...(local?.connIDs ?? []), ...(remote?.connIDs ?? [])])]
      .filter((connID) => this.conn(connID) !== undefined && this.connTenant(connID) === tenant)
      .map((connID) => ({ connID, sessionID: origin.sessionID }))
  }

  /** A form no process holds any more: drop it and its blocker. */
  dropForm(formID: string): void {
    const origin = this.forms.get(formID)
    if (!origin) return
    this.forms.delete(formID)
    this.observeBoards({ type: "form.cancelled", data: { sessionID: origin.sessionID, id: formID } })
    this.changed(this.sessionTenant(origin.sessionID))
  }

  /** A permission no process holds any more (answered elsewhere, expired): drop it and its blocker. */
  dropPermission(requestID: string): void {
    const origin = this.permissions.get(requestID)
    if (!origin) return
    this.permissions.delete(requestID)
    this.observeBoards({ type: "permission.replied", data: { sessionID: origin.sessionID, requestID } })
    this.changed(origin.tenant ?? this.sessionTenant(origin.sessionID))
    this.permissionClosed(requestID, origin)
  }

  /** Listens for pending permissions going away (replied, dropped, every process holding one gone). */
  onPermissionClosed(listener: (requestID: string, sessionID: string, tenant: string | undefined) => void): () => void {
    this.permissionClosedListeners.add(listener)
    return () => this.permissionClosedListeners.delete(listener)
  }

  /**
   * Shows an agent's recommendation on a pending permission's blocker (sanitised; the status goes out again);
   * false when no such request is pending. It goes with the request.
   */
  recommend(requestID: string, recommendation: BlockerRecommendation): boolean {
    const origin = this.permissions.get(requestID)
    if (!origin) return false
    const why = recommendation.why === undefined ? "" : sanitizeLabel(recommendation.why, RECOMMENDATION_WHY_MAX)
    origin.recommendation = {
      by: sanitizeLabel(recommendation.by, RECOMMENDATION_BY_MAX) || "An agent",
      recommends: "approve",
      ...(why ? { why } : {}),
      ...(recommendation.decisionID && DECISION_ID.test(recommendation.decisionID) ? { decisionID: recommendation.decisionID } : {}),
    }
    const rootID = this.rootOf(origin.sessionID)
    const board = rootID === undefined ? undefined : this.boards.get(rootID)
    if (rootID !== undefined && board) this.emit({ type: "status", sessionID: rootID, sessions: this.live(board.snapshot().sessions) })
    this.changed(origin.tenant ?? this.sessionTenant(origin.sessionID))
    return true
  }

  private permissionClosed(requestID: string, origin: PendingPermission): void {
    for (const listener of [...this.permissionClosedListeners]) {
      try {
        listener(requestID, origin.sessionID, origin.tenant)
      } catch (cause) {
        console.error(`[hub] permission ${requestID}: closed listener failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
  }

  /**
   * Takes the session's turn lock; call the returned function to release it. `onCancel` runs when a stop or
   * interrupt releases the lock first (see cancelTurns), so the waiting request can end.
   */
  beginTurn(sessionID: string, onCancel?: () => void): () => void {
    if (this.busy(sessionID)) throw new BusyError()
    const turn = { cancel: onCancel }
    this.active.set(sessionID, turn)
    this.changed(this.sessionTenant(sessionID))
    this.emit({ type: "catalog" })
    return () => {
      if (this.active.get(sessionID) !== turn) return // already released, or cancelled and taken by a newer turn
      this.active.delete(sessionID)
      this.changed(this.sessionTenant(sessionID))
      this.emit({ type: "catalog" })
      this.doneWatch.poke(this.rootOf(sessionID) ?? sessionID)
    }
  }

  /** After a stop or interrupt: releases the turn locks in the session's tree and ends their waiting requests. */
  cancelTurns(sessionID: string): void {
    const rootID = this.rootOf(sessionID) ?? sessionID
    const ended = [...this.active].filter(([id]) => id === sessionID || (this.rootOf(id) ?? id) === rootID)
    if (!ended.length) return
    for (const [id] of ended) this.active.delete(id)
    this.changed(this.sessionTenant(sessionID))
    this.emit({ type: "catalog" })
    for (const [, turn] of ended) {
      try {
        turn.cancel?.()
      } catch {
        // a waiting request that cannot be told still lost its lock
      }
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
    // Every reported session gets a status board, Voice or not: spokes forward events for all of them.
    const reported = new Map<string, SessionInfo>()
    for (const conn of this.conns.values()) for (const s of this.visible(conn)) reported.set(s.id, s)

    const rootOf = (id: string): string => {
      const seen = new Set<string>()
      let current = id
      for (;;) {
        const parent = reported.get(current)?.parentID
        // Never nest a session under another tenant's session.
        if (!parent || !reported.has(parent) || seen.has(parent) || this.sessionTenant(parent) !== this.sessionTenant(current)) return current
        seen.add(current)
        current = parent
      }
    }

    for (const id of this.boards.keys()) {
      if (reported.has(id) && rootOf(id) === id) continue
      this.boards.delete(id)
      this.doneWatch.forget(id)
    }

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

  // ---------- cluster (design §9) ----------

  /** Listens for changes to this pod's state of a tenant (undefined: any tenant may have changed). */
  onLocalChange(listener: (tenant: string | undefined) => void): () => void {
    this.localChangeListeners.add(listener)
    return () => this.localChangeListeners.delete(listener)
  }

  private changed(tenant: string | undefined): void {
    for (const listener of [...this.localChangeListeners]) {
      try {
        listener(tenant)
      } catch (cause) {
        console.error(`[hub] registry change listener failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
  }

  /** Tenants this pod holds state of (connections, boards, pending permissions and forms, presence, turns). */
  clusterTenants(): string[] {
    const tenants = new Set<string>()
    for (const conn of this.conns.values()) tenants.add(this.tenant(conn))
    const add = (tenant: string | undefined) => tenant !== undefined && tenants.add(tenant)
    for (const rootID of this.boards.keys()) add(this.sessionTenant(rootID))
    for (const origin of this.permissions.values()) add(origin.tenant ?? this.sessionTenant(origin.sessionID))
    for (const origin of this.forms.values()) add(this.sessionTenant(origin.sessionID))
    for (const entry of this.presence.values()) add(this.sessionTenant(entry.sessionID))
    for (const sessionID of this.active.keys()) add(this.sessionTenant(sessionID))
    return [...tenants]
  }

  /** This pod's state of a tenant for other pods (undefined when there is none). Remote state is not included. */
  clusterSlice(tenant: string): RegistrySlice | undefined {
    const conns: SliceConn[] = [...this.conns.values()]
      .filter((conn) => this.tenant(conn) === tenant)
      .map((conn) => {
        const terminals = this.machineTerminals.get(conn.machine.id)
        return {
          id: conn.id,
          machine: { id: conn.machine.id, name: conn.machine.name },
          hello: conn.hello,
          connected: conn.connected,
          seq: conn.seq,
          lastSeen: conn.lastSeen,
          sessions: [...conn.sessions.values()],
          activity: [...conn.activity],
          ...(conn.launchID !== undefined ? { launchID: conn.launchID } : {}),
          ...(terminals?.connID === conn.id ? { terminals: terminals.terminals } : {}),
        }
      })
    const boards: SliceBoard[] = [...this.boards]
      .filter(([rootID]) => this.sessionTenant(rootID) === tenant)
      .map(([rootID, board]) => ({ rootID, sessions: this.live(board.snapshot().sessions), activity: this.feeds.get(rootID) ?? [] }))
    const permissions: SlicePermission[] = [...this.permissions]
      .filter(([, origin]) => (origin.tenant ?? this.sessionTenant(origin.sessionID)) === tenant)
      .map(([requestID, origin]) => ({
        requestID,
        sessionID: origin.sessionID,
        connIDs: [...origin.connIDs],
        ...(origin.request ? { request: origin.request } : {}),
        ...(origin.recommendation ? { recommendation: origin.recommendation } : {}),
      }))
    const forms: SliceForm[] = [...this.forms]
      .filter(([, origin]) => this.sessionTenant(origin.sessionID) === tenant)
      .map(([formID, origin]) => ({ formID, sessionID: origin.sessionID, connIDs: [...origin.connIDs] }))
    const t = this.now()
    const presence = [...this.presence]
      .filter(([, entry]) => t - entry.at <= PRESENCE_WINDOW_MS && this.sessionTenant(entry.sessionID) === tenant)
      .map(([key, entry]) => ({ deviceID: key.slice(0, key.lastIndexOf(` ${entry.sessionID}`)), sessionID: entry.sessionID, at: entry.at }))
    const busy = [...this.active.keys()].filter((sessionID) => this.sessionTenant(sessionID) === tenant)
    if (!conns.length && !boards.length && !permissions.length && !forms.length && !presence.length && !busy.length) return undefined
    return structuredClone({ conns, boards, permissions, forms, presence, busy })
  }

  /**
   * Applies another pod's slice of a tenant (undefined: it has none any more, e.g. the pod is gone). Remote
   * connections answer the reads like local ones; listeners get a catalog message.
   */
  setRemote(pod: string, tenant: string, slice: RegistrySlice | undefined): void {
    let slices = this.remoteSlices.get(pod)
    if (slice) {
      if (!slices) this.remoteSlices.set(pod, (slices = new Map()))
      slices.set(tenant, slice)
    } else {
      if (!slices?.delete(tenant)) return
      if (!slices.size) this.remoteSlices.delete(pod)
    }
    this.reindex()
    this.emit({ type: "catalog" })
  }

  /** The pods whose slices are applied here, with their tenants. */
  remotePods(): Map<string, string[]> {
    return new Map([...this.remoteSlices].map(([pod, slices]) => [pod, [...slices.keys()]]))
  }

  /** Rebuilds the indexes of the remote slices. */
  private reindex(): void {
    const conns = new Map<string, Conn>()
    const boards = new Map<string, SliceBoard>()
    const permissions = new Map<string, { sessionID: string; tenant: string; connIDs: string[]; request?: PermissionRequest; recommendation?: BlockerRecommendation }>()
    const forms = new Map<string, { sessionID: string; connIDs: string[] }>()
    const presence: Array<{ sessionID: string; at: number }> = []
    const busy = new Set<string>()
    const terminals = new Map<string, MachineTerminals>()
    for (const [pod, slices] of this.remoteSlices) {
      for (const [tenant, slice] of slices) {
        for (const c of slice.conns ?? []) {
          if (this.conns.has(c.id)) continue
          conns.set(c.id, {
            id: c.id,
            machine: c.machine,
            hello: c.hello,
            features: spokeFeatures(c.hello),
            connected: c.connected,
            seq: c.seq,
            lastSeen: c.lastSeen,
            sessions: new Map((c.sessions ?? []).map((s) => [s.id, s])),
            sessionsKey: "",
            activity: new Map(c.activity ?? []),
            ...(c.launchID !== undefined ? { launchID: c.launchID } : {}),
            remote: { pod, tenant },
          })
          if (c.terminals) terminals.set(c.machine.id, c.terminals)
        }
        for (const board of slice.boards ?? []) boards.set(board.rootID, board)
        for (const p of slice.permissions ?? []) {
          const known = permissions.get(p.requestID)
          if (known) known.connIDs.push(...p.connIDs.filter((id) => !known.connIDs.includes(id)))
          else permissions.set(p.requestID, { sessionID: p.sessionID, tenant, connIDs: [...p.connIDs], ...(p.request ? { request: p.request } : {}), ...(p.recommendation ? { recommendation: p.recommendation } : {}) })
        }
        for (const f of slice.forms ?? []) {
          const known = forms.get(f.formID)
          if (known) known.connIDs.push(...f.connIDs.filter((id) => !known.connIDs.includes(id)))
          else forms.set(f.formID, { sessionID: f.sessionID, connIDs: [...f.connIDs] })
        }
        for (const entry of slice.presence ?? []) presence.push({ sessionID: entry.sessionID, at: entry.at })
        for (const sessionID of slice.busy ?? []) busy.add(sessionID)
      }
    }
    this.remoteConns = conns
    this.remoteBoards = boards
    this.remotePermissions = permissions
    this.remoteForms = forms
    this.remotePresence = presence
    this.remoteBusy = busy
    this.remoteTerminals = terminals
  }

  /** Raises a notification about the session for its user (e.g. the delivery engine's unanswered asks). */
  alertUser(kind: NotificationKind, sessionID: string, fields: { text?: string; subject?: string; key?: string } = {}): void {
    this.alert(kind, sessionID, fields)
  }

  /**
   * Raises a notification for the root of `sessionID`'s tree. Only hand-offs, questions and permissions reach a
   * session some device shows (spoken replies check that themselves: the watching device speaks them).
   */
  private alert(kind: NotificationKind, sessionID: string, fields: { text?: string; requestID?: string; subject?: string; key?: string } = {}): void {
    const entry = [...this.boards].find(([, board]) => board.get(sessionID))
    if (!entry) return
    const [rootID, board] = entry
    if (!ALWAYS_ALERT.has(kind) && this.watched(rootID)) return
    const alert: Alert = {
      kind,
      sessionID: rootID,
      title: board.get(rootID)?.title ?? rootID,
      ...(fields.subject !== undefined ? { subject: fields.subject } : {}),
      ...(fields.text !== undefined ? { text: fields.text } : {}),
      ...(fields.requestID !== undefined ? { requestID: fields.requestID } : {}),
      ...(fields.key !== undefined ? { key: fields.key } : {}),
    }
    const owner = this.sessionTenant(rootID)
    for (const listener of this.alertListeners) listener(owner ? { ...alert, owner } : alert)
  }

  private emit(message: RegistryMessage): void {
    const tenant = message.type === "catalog" ? undefined : this.sessionTenant("rootID" in message ? message.rootID : message.sessionID)
    for (const listener of this.listeners) listener(message, tenant)
  }
}
