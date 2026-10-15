// Central server ↔ spoke protocol, version 1. JSON text frames over a WebSocket at /spoke/ws.
// The spoke (OpenCode plugin) connects outbound with `Authorization: Bearer <machineToken>`.
// Every frame is one object with a `t` discriminator. Unknown or malformed frames are rejected.

export const PROTOCOL_VERSION = 1

export type SessionState = "idle" | "working" | "blocked" | "error"
export type ProcessKind = "service" | "standalone"
export type SpokeMode = "always" | "session"
export type PermissionDecision = "once" | "always" | "reject"

export interface ModelSelection {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export interface SessionModelPrefs {
  readonly voice?: ModelSelection
  readonly worker?: ModelSelection
}

export interface AvailableModel {
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly enabled: boolean
  readonly status: string
  readonly variants: readonly string[]
}

export interface TimelinePage {
  readonly items: readonly unknown[]
  readonly cursor?: string
}

export interface SessionInfo {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly parentID?: string
  /** ms epoch of last update */
  readonly updated: number
  /** True when this process currently owns the session: it viewed or executed it most recently. */
  readonly owned: boolean
  /**
   * Whether voice is enabled for this session (always true in mode "always"). Sessions with
   * exposed:false are listed for discovery only: no events are forwarded and no ops run on them.
   */
  readonly exposed?: boolean
  /** Workspace (project) root the session belongs to; differs from directory for worktrees/subfolders. */
  readonly project?: string
  readonly projectName?: string
  readonly archived?: boolean
  /** Open in a terminal right now (a Herdr pane or an OpenCode TUI showing it). */
  readonly open?: boolean
  readonly terminal?: TerminalInfo
}

export interface TerminalInfo {
  /** Where "open" was detected. */
  readonly source: "herdr" | "tui"
  /** Herdr workspace ID and label (e.g. "research"), when open in Herdr. */
  readonly workspaceID?: string
  readonly workspace?: string
  /** Pane/terminal title, e.g. "OC | Fix the login redirect". */
  readonly title?: string
  /** Herdr's agent status for the pane. */
  readonly status?: "idle" | "working" | "blocked" | "done" | "unknown"
}

/** A Herdr workspace on this machine (a target for new sessions). */
export interface HerdrWorkspace {
  readonly id: string
  readonly label: string
  /** Folders of the panes in this workspace, most used first (lets the phone suggest a directory). */
  readonly directories: readonly string[]
}

/** Machine-level terminal context, sent by one spoke per machine (the service spoke, else a standalone). */
export interface Terminals {
  readonly t: "terminals"
  readonly herdr?: { readonly workspaces: readonly HerdrWorkspace[] }
}

/** Subset of OpenCode events the spoke forwards (see FORWARDED_EVENTS). */
export interface ForwardedEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

export const FORWARDED_EVENTS: ReadonlySet<string> = new Set([
  "session.created",
  "session.renamed",
  "session.deleted",
  "session.viewed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.text.delta",
  "session.text.ended",
  "session.inbox.delivered",
  "session.agent.selected",
  // Activity feed. The spoke sends these in compact form (see compactActivity): tool inputs are
  // reduced to a short summary and results to ok/error, never full file contents or outputs.
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.reasoning.started",
  // Reasoning text streams to the phone's "Thinking" block (deltas capped at REASONING_DELTA_MAX); the
  // ended event's full text is dropped.
  "session.reasoning.delta",
  "session.reasoning.ended",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
])

// ---------- spoke → server ----------

export interface Hello {
  readonly t: "hello"
  readonly v: number
  readonly processID: string
  readonly kind: ProcessKind
  readonly directory: string
  readonly pid: number
  readonly mode: SpokeMode
  readonly opencodeVersion: string
  readonly pluginVersion: string
}

export interface Sessions {
  readonly t: "sessions"
  readonly sessions: readonly SessionInfo[]
}

export interface Event {
  readonly t: "event"
  readonly event: ForwardedEvent
}

/** Requests the spoke makes of the server on the user's behalf (from the /hub dialog). */
export type SpokeRequest =
  | { readonly op: "pairCode" }
  | { readonly op: "handoff"; readonly sessionID: string }
  /** A one-time sign-in link to a session's page, or to the home page without a session. */
  | { readonly op: "openLink"; readonly sessionID?: string }

// ---------- server → spoke ----------

export interface Welcome {
  readonly t: "welcome"
  readonly v: number
  readonly machineID: string
  readonly publicURL: string
}

export type ServerRequest =
  | { readonly op: "turn"; readonly sessionID: string; readonly text: string; readonly voiceStyle: boolean }
  | { readonly op: "permission"; readonly sessionID: string; readonly requestID: string; readonly decision: PermissionDecision }
  | { readonly op: "context"; readonly sessionID: string }
  /** Conversation mode: deliver an utterance with delivery "steer" and return at once (replies arrive as events). */
  | { readonly op: "steer"; readonly sessionID: string; readonly text: string }
  | { readonly op: "interrupt"; readonly sessionID: string }
  /** Interrupt the session's whole tree: running descendants deepest first, then the root. */
  | { readonly op: "stop"; readonly sessionID: string }
  /** Right-rail data: context usage, MCP servers, branch and working-tree change stats. */
  | { readonly op: "summary"; readonly sessionID: string }
  /** One changed file's patch in the session's directory. */
  | { readonly op: "diff"; readonly sessionID: string; readonly file: string }
  /** Switch the session to the voice orchestrator agent (on) or back to its previous agent (off). */
  | { readonly op: "conversation"; readonly sessionID: string; readonly on: boolean }
  | { readonly op: "models"; readonly sessionID: string }
  | { readonly op: "modelPrefs"; readonly sessionID: string }
  | { readonly op: "setModelPrefs"; readonly sessionID: string; readonly voice?: ModelSelection | null; readonly worker?: ModelSelection | null }
  | { readonly op: "timeline"; readonly sessionID: string; readonly limit?: number; readonly cursor?: string }
  | { readonly op: "timelinePart"; readonly sessionID: string; readonly messageID: string; readonly partID: string }
  /** Enable or disable voice for one session (adds/removes it from the machine config's session list). */
  | { readonly op: "expose"; readonly sessionID: string; readonly on: boolean }
  /** Create a session in a workspace directory the spoke already reported. */
  /**
   * Create a session in a workspace directory the spoke already reported. With `herdrWorkspace`, also open
   * it in a new tab of that Herdr workspace (`opencode --session <id>` in the directory).
   */
  | { readonly op: "create"; readonly directory: string; readonly title?: string; readonly herdrWorkspace?: string }

export interface ContextUsage {
  /** Tokens of the latest assistant message (input + output + reasoning + cache). */
  readonly used: number
  readonly limit?: number
  readonly percent?: number
  readonly model?: string
}

export interface McpStatus {
  readonly name: string
  readonly status: "connected" | "pending" | "disabled" | "failed" | "needs_auth" | "unknown"
  readonly error?: string
}

export interface ChangedFile {
  readonly file: string
  readonly status: "added" | "deleted" | "modified"
  readonly additions: number
  readonly deletions: number
}

export interface SessionChanges {
  /** The listed files: all of them, or (when `truncated`) the most-changed ones that fit the limits. */
  readonly files: readonly ChangedFile[]
  /** Line totals over every changed file, listed or not. */
  readonly additions: number
  readonly deletions: number
  /** Number of changed files, listed or not. */
  readonly totalFiles: number
  /** True when `files` lists fewer than `totalFiles`. */
  readonly truncated: boolean
}

export interface FilePatch extends ChangedFile {
  readonly patch: string
  readonly truncated: boolean
}

/** Right-rail data for a session; each part is absent when OpenCode could not provide it. */
export interface SessionSummary {
  readonly directory: string
  readonly branch?: string
  readonly context?: ContextUsage
  readonly mcp?: readonly McpStatus[]
  readonly changes?: SessionChanges
}

export type TurnResult =
  | { readonly outcome: "succeeded"; readonly reply: string }
  | { readonly outcome: "failed" | "interrupted"; readonly message: string; readonly reply: string }
  | { readonly outcome: "timeout"; readonly reply: string }

/** Result payloads, keyed by op. */
export interface ResultFor {
  turn: TurnResult
  permission: Record<string, never>
  context: { readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }> }
  pairCode: { readonly code: string; readonly url: string; readonly expiresAt: number }
  handoff: { readonly notified: number }
  openLink: { readonly url: string }
  steer: { readonly inboxID: string }
  interrupt: Record<string, never>
  stop: { readonly stopped: readonly string[] }
  summary: SessionSummary
  diff: { readonly patch?: FilePatch }
  conversation: { readonly agent: string }
  models: { readonly models: readonly AvailableModel[] }
  modelPrefs: { readonly prefs: SessionModelPrefs; readonly defaults: SessionModelPrefs }
  setModelPrefs: { readonly prefs: SessionModelPrefs; readonly defaults: SessionModelPrefs }
  timeline: TimelinePage
  timelinePart: { readonly detail: unknown }
  expose: { readonly exposed: boolean }
  create: { readonly sessionID: string; readonly openedIn?: "herdr" }
}

// ---------- both directions ----------

export interface Req<R = SpokeRequest | ServerRequest> {
  readonly t: "req"
  readonly id: string
  readonly req: R
}

export interface Res {
  readonly t: "res"
  readonly id: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

export interface Bye {
  readonly t: "bye"
  readonly reason: string
}

export type SpokeMessage = Hello | Sessions | Terminals | Event | Req<SpokeRequest> | Res | Bye
export type ServerMessage = Welcome | Req<ServerRequest> | Res | Bye

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === "string"
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const ID = /^[A-Za-z0-9_.:@/+~-]{1,300}$/
const isModelSelection = (v: unknown): v is ModelSelection =>
  isObj(v) && typeof v.providerID === "string" && ID.test(v.providerID) && typeof v.modelID === "string" && ID.test(v.modelID) && (v.variant === undefined || (typeof v.variant === "string" && ID.test(v.variant)))

/** Largest frame (in characters) either side accepts; a larger one is a protocol error. */
export const MAX_FRAME = 1_000_000

function isSession(v: unknown): v is SessionInfo {
  return (
    isObj(v) &&
    nonEmpty(v.id) &&
    str(v.title) &&
    str(v.directory) &&
    num(v.updated) &&
    typeof v.owned === "boolean" &&
    (v.parentID === undefined || str(v.parentID)) &&
    (v.exposed === undefined || typeof v.exposed === "boolean") &&
    (v.project === undefined || str(v.project)) &&
    (v.projectName === undefined || str(v.projectName)) &&
    (v.archived === undefined || typeof v.archived === "boolean") &&
    (v.open === undefined || typeof v.open === "boolean") &&
    (v.terminal === undefined || isTerminal(v.terminal))
  )
}

const TERMINAL_STATUS = new Set(["idle", "working", "blocked", "done", "unknown"])

function isTerminal(v: unknown): v is TerminalInfo {
  return (
    isObj(v) &&
    (v.source === "herdr" || v.source === "tui") &&
    (v.workspaceID === undefined || str(v.workspaceID)) &&
    (v.workspace === undefined || str(v.workspace)) &&
    (v.title === undefined || str(v.title)) &&
    (v.status === undefined || TERMINAL_STATUS.has(v.status as string))
  )
}

function isHerdrInfo(v: unknown): boolean {
  return (
    isObj(v) &&
    Array.isArray(v.workspaces) &&
    v.workspaces.length <= 200 &&
    v.workspaces.every((w) => isObj(w) && nonEmpty(w.id) && str(w.label) && Array.isArray(w.directories) && w.directories.every(str))
  )
}

function isSpokeRequest(v: unknown): v is SpokeRequest {
  if (!isObj(v)) return false
  if (v.op === "pairCode") return true
  if (v.op === "handoff") return nonEmpty(v.sessionID)
  if (v.op === "openLink") return v.sessionID === undefined || nonEmpty(v.sessionID)
  return false
}

function isServerRequest(v: unknown): v is ServerRequest {
  if (!isObj(v)) return false
  switch (v.op) {
    case "turn":
      return nonEmpty(v.sessionID) && nonEmpty(v.text) && typeof v.voiceStyle === "boolean"
    case "permission":
      return nonEmpty(v.sessionID) && nonEmpty(v.requestID) && ["once", "always", "reject"].includes(v.decision as string)
    case "context":
    case "interrupt":
    case "stop":
    case "summary":
    case "models":
    case "modelPrefs":
      return nonEmpty(v.sessionID)
    case "setModelPrefs":
      return (
        nonEmpty(v.sessionID) &&
        (v.voice === undefined || v.voice === null || isModelSelection(v.voice)) &&
        (v.worker === undefined || v.worker === null || isModelSelection(v.worker)) &&
        (v.voice !== undefined || v.worker !== undefined)
      )
    case "timeline":
      return (
        nonEmpty(v.sessionID) &&
        (v.limit === undefined || (Number.isInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 200)) &&
        (v.cursor === undefined || (str(v.cursor) && v.cursor.length <= 4096))
      )
    case "timelinePart":
      return nonEmpty(v.sessionID) && nonEmpty(v.messageID) && v.messageID.length <= 300 && nonEmpty(v.partID) && v.partID.length <= 300
    case "steer":
      return nonEmpty(v.sessionID) && nonEmpty(v.text)
    case "diff":
      return nonEmpty(v.sessionID) && nonEmpty(v.file) && v.file.length <= 4096
    case "conversation":
    case "expose":
      return nonEmpty(v.sessionID) && typeof v.on === "boolean"
    case "create":
      return (
        nonEmpty(v.directory) &&
        v.directory.startsWith("/") &&
        v.directory.length <= 4096 &&
        (v.title === undefined || (str(v.title) && v.title.length <= 200)) &&
        (v.herdrWorkspace === undefined || (nonEmpty(v.herdrWorkspace) && v.herdrWorkspace.length <= 100))
      )
    default:
      return false
  }
}

const isRes = (v: Record<string, unknown>) =>
  nonEmpty(v.id) && typeof v.ok === "boolean" && (v.error === undefined || str(v.error))
const isBye = (v: Record<string, unknown>) => str(v.reason)

function parse(raw: string | Buffer): Record<string, unknown> | undefined {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  if (text.length > MAX_FRAME) return undefined
  try {
    const value = JSON.parse(text)
    return isObj(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Parses a frame received by the server. Returns undefined for anything invalid. */
export function parseSpokeMessage(raw: string | Buffer): SpokeMessage | undefined {
  const m = parse(raw)
  if (!m) return undefined
  switch (m.t) {
    case "hello":
      return num(m.v) &&
        nonEmpty(m.processID) &&
        (m.kind === "service" || m.kind === "standalone") &&
        str(m.directory) &&
        num(m.pid) &&
        (m.mode === "always" || m.mode === "session") &&
        str(m.opencodeVersion) &&
        str(m.pluginVersion)
        ? (m as unknown as Hello)
        : undefined
    case "sessions":
      return Array.isArray(m.sessions) && m.sessions.every(isSession) ? (m as unknown as Sessions) : undefined
    case "terminals":
      return m.herdr === undefined || isHerdrInfo(m.herdr) ? (m as unknown as Terminals) : undefined
    case "event":
      return isObj(m.event) && nonEmpty(m.event.type) && FORWARDED_EVENTS.has(m.event.type) && isObj(m.event.data)
        ? (m as unknown as Event)
        : undefined
    case "req":
      return nonEmpty(m.id) && isSpokeRequest(m.req) ? (m as unknown as Req<SpokeRequest>) : undefined
    case "res":
      return isRes(m) ? (m as unknown as Res) : undefined
    case "bye":
      return isBye(m) ? (m as unknown as Bye) : undefined
    default:
      return undefined
  }
}

/** Parses a frame received by the spoke. Returns undefined for anything invalid. */
export function parseServerMessage(raw: string | Buffer): ServerMessage | undefined {
  const m = parse(raw)
  if (!m) return undefined
  switch (m.t) {
    case "welcome":
      return num(m.v) && nonEmpty(m.machineID) && str(m.publicURL) ? (m as unknown as Welcome) : undefined
    case "req":
      return nonEmpty(m.id) && isServerRequest(m.req) ? (m as unknown as Req<ServerRequest>) : undefined
    case "res":
      return isRes(m) ? (m as unknown as Res) : undefined
    case "bye":
      return isBye(m) ? (m as unknown as Bye) : undefined
    default:
      return undefined
  }
}

export const encode = (message: SpokeMessage | ServerMessage): string => JSON.stringify(message)

// ---------- HTTP enrollment (spoke ↔ server, before a machine token exists) ----------

/** POST /spoke/enroll  body: { machineName }  → EnrollStart */
export interface EnrollStart {
  readonly userCode: string
  readonly deviceCode: string
  readonly approveURL: string
  readonly intervalMs: number
  readonly expiresAt: number
  /** A local hub approved this first machine already; the next poll returns the token. */
  readonly autoApproved?: boolean
}

/** POST /spoke/enroll/poll  body: { deviceCode }  → EnrollPoll */
export type EnrollPoll =
  | { readonly status: "pending" }
  | { readonly status: "denied" | "expired" }
  | { readonly status: "approved"; readonly machineID: string; readonly machineToken: string }

// ---------- activity feed ----------

const SUMMARY_KEYS = ["description", "command", "filePath", "path", "pattern", "url", "query", "agent", "prompt"] as const
export const ACTIVITY_SUMMARY_MAX = 160
/** Longest reasoning delta forwarded; longer deltas are cut (they are normally a few tokens). */
export const REASONING_DELTA_MAX = 2000

/** Short human summary of a tool input, e.g. the shell command or file path. Never the full input. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      const line = value.trim().split("\n")[0]!
      return line.length > ACTIVITY_SUMMARY_MAX ? `${line.slice(0, ACTIVITY_SUMMARY_MAX - 1)}…` : line
    }
  }
  return ""
}

/**
 * Reduces activity events to what the activity feed needs. Returns the event unchanged when it is
 * not an activity event, or undefined when it should be dropped.
 */
export function compactActivity(event: ForwardedEvent): ForwardedEvent | undefined {
  const d = event.data
  const base = { sessionID: d.sessionID, assistantMessageID: d.assistantMessageID, id: d.id }
  switch (event.type) {
    case "session.tool.input.started":
      return { type: event.type, data: { ...base, name: d.name } }
    case "session.tool.called":
      return { type: event.type, data: { ...base, summary: summarizeToolInput(d.input), background: (d.input as any)?.background === true } }
    case "session.tool.success":
      return { type: event.type, data: base }
    case "session.tool.failed": {
      const message = typeof (d.error as any)?.message === "string" ? String((d.error as any).message).slice(0, ACTIVITY_SUMMARY_MAX) : "failed"
      return { type: event.type, data: { ...base, error: message } }
    }
    case "session.reasoning.started":
    case "session.reasoning.ended":
      return { type: event.type, data: { sessionID: d.sessionID, assistantMessageID: d.assistantMessageID } }
    case "session.reasoning.delta":
      return {
        type: event.type,
        data: { sessionID: d.sessionID, assistantMessageID: d.assistantMessageID, delta: typeof d.delta === "string" ? d.delta.slice(0, REASONING_DELTA_MAX) : "" },
      }
    default:
      return event
  }
}
