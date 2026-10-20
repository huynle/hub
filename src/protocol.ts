// Central server ↔ spoke protocol, version 1. JSON text frames over a WebSocket at /spoke/ws.
// The spoke (OpenCode plugin) connects outbound with `Authorization: Bearer <machineToken>`.
// Every frame is one object with a `t` discriminator. Unknown or malformed frames are rejected.

export const PROTOCOL_VERSION = 1

export type SessionState = "idle" | "working" | "blocked" | "error"
export type ProcessKind = "service" | "standalone"
export type SpokeMode = "always" | "session"
export type PermissionDecision = "once" | "always" | "reject"

/** An answer to an OpenCode form (question): field key → value, like OpenCode's FormAnswer. */
export type FormAnswer = Readonly<Record<string, string | number | boolean | readonly string[]>>

export const FORM_ANSWER_MAX_KEYS = 50
export const FORM_ANSWER_MAX_CHARS = 20_000
export const FORM_ANSWER_MAX_ITEMS = 100

/** Why an answer object is not acceptable, or undefined when it is. */
export function formAnswerProblem(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "answer must be an object"
  const entries = Object.entries(v)
  if (entries.length > FORM_ANSWER_MAX_KEYS) return `answer has more than ${FORM_ANSWER_MAX_KEYS} fields`
  for (const [key, value] of entries) {
    if (!key || key.length > 300) return "answer keys must be 1–300 characters"
    if (typeof value === "string" && value.length <= FORM_ANSWER_MAX_CHARS) continue
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) continue
    if (
      Array.isArray(value) &&
      value.length <= FORM_ANSWER_MAX_ITEMS &&
      value.every((item) => typeof item === "string" && item.length <= FORM_ANSWER_MAX_CHARS)
    ) continue
    return `answer.${key} must be text, a number, true/false or a list of texts`
  }
  return undefined
}

export interface ModelSelection {
  readonly providerID: string
  /** OpenCode's catalog id of the model (Model.Info `id`, what switchModel takes), not its upstream `modelID`. */
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
  // Running detection (compact form, see compactActivity): OpenCode's session status (busy/retry/idle) and the
  // shells and terminals a session started, with the command (≤ JOB_COMMAND_MAX), status and exit code only.
  "session.status",
  "session.shell.started",
  "session.shell.ended",
  "shell.created",
  "shell.exited",
  "shell.deleted",
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted",
  // Hub-defined: a session's status and running jobs as the spoke found them (startup, stream reconnect).
  "session.seed",
])

/** Longest job command forwarded. */
export const JOB_COMMAND_MAX = 200
/** Longest retry reason forwarded. */
export const RETRY_MESSAGE_MAX = 200
/** Most running jobs one seed event carries. */
export const SEED_JOBS_MAX = 20

export type JobKind = "shell" | "pty"
export type JobStatus = "running" | "exited" | "timeout" | "killed"

/** A shell or terminal a session started, as forwarded (no output, no environment). */
export interface JobInfo {
  readonly id: string
  readonly kind: JobKind
  readonly command?: string
  readonly status: JobStatus
  readonly exit?: number
  readonly background?: true
  readonly started?: number
  readonly ended?: number
}

/** OpenCode's session status, compact. */
export type CompactSessionStatus = { readonly type: "idle" | "busy" } | { readonly type: "retry"; readonly attempt?: number; readonly message?: string }

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
  /** `voice`: land on the session with Voice mode starting (`?voice=1`). */
  | { readonly op: "openLink"; readonly sessionID?: string; readonly voice?: boolean }

// ---------- server → spoke ----------

export interface Welcome {
  readonly t: "welcome"
  readonly v: number
  readonly machineID: string
  readonly publicURL: string
}

/** An image attached to a typed prompt: base64 bytes of a PNG, JPEG, WebP or GIF (see promptImagesProblem). */
export interface PromptImage {
  readonly mime: string
  readonly data: string
  readonly name?: string
}

export type ServerRequest =
  /** `text` may be empty when `images` are attached. */
  | { readonly op: "turn"; readonly sessionID: string; readonly text: string; readonly voiceStyle: boolean; readonly images?: readonly PromptImage[] }
  | { readonly op: "permission"; readonly sessionID: string; readonly requestID: string; readonly decision: PermissionDecision }
  /** Answer (or cancel) a pending form (question) in the session that asked it. */
  | { readonly op: "form"; readonly sessionID: string; readonly formID: string; readonly answer: FormAnswer }
  | { readonly op: "form"; readonly sessionID: string; readonly formID: string; readonly cancel: true }
  | { readonly op: "context"; readonly sessionID: string }
  /** Conversation mode: deliver an utterance with delivery "steer" and return at once (replies arrive as events). */
  | { readonly op: "steer"; readonly sessionID: string; readonly text: string; readonly images?: readonly PromptImage[] }
  | { readonly op: "interrupt"; readonly sessionID: string }
  /** Rename the session in OpenCode; the spoke trims the title and requires 1–200 characters. */
  | { readonly op: "rename"; readonly sessionID: string; readonly title: string }
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
  /** One image attached to a user message (its position in the message's files). */
  | { readonly op: "timelineFile"; readonly sessionID: string; readonly messageID: string; readonly index: number }
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
  /** `gone`: the request is not pending in this process any more (answered elsewhere, expired). */
  permission: { readonly gone?: true }
  /** `gone`: the form is not pending in this process any more (answered elsewhere, cancelled, expired). */
  form: { readonly gone?: true }
  context: { readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }> }
  pairCode: { readonly code: string; readonly url: string; readonly expiresAt: number }
  handoff: { readonly notified: number }
  openLink: { readonly url: string }
  steer: { readonly inboxID: string }
  interrupt: Record<string, never>
  rename: { readonly title: string }
  stop: { readonly stopped: readonly string[] }
  summary: SessionSummary
  diff: { readonly patch?: FilePatch }
  conversation: { readonly agent: string }
  models: { readonly models: readonly AvailableModel[] }
  modelPrefs: { readonly prefs: SessionModelPrefs; readonly defaults: SessionModelPrefs }
  setModelPrefs: { readonly prefs: SessionModelPrefs; readonly defaults: SessionModelPrefs }
  timeline: TimelinePage
  timelinePart: { readonly detail: unknown }
  /** No `file` when the message has no image at that index; `tooLarge` when its bytes would not fit in a frame. */
  timelineFile: { readonly file?: PromptImage; readonly tooLarge?: boolean }
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
  if (v.op === "openLink") return (v.sessionID === undefined || nonEmpty(v.sessionID)) && (v.voice === undefined || typeof v.voice === "boolean")
  return false
}

// ---------- prompt images ----------

/** Image types a prompt may carry. */
export const PROMPT_IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"]
export const MAX_PROMPT_IMAGES = 4
/** Largest decoded image accepted. */
export const MAX_PROMPT_IMAGE_BYTES = 512 * 1024
/** Largest total base64 length of a prompt's images, so they fit in one frame with the text. */
export const MAX_PROMPT_IMAGES_BASE64 = 750_000
export const MAX_PROMPT_IMAGE_NAME_CHARS = 200

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Leading bytes of each accepted type (WebP: "RIFF" ... "WEBP"). */
function sniffImage(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg"
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"
  return undefined
}

/**
 * Why `value` is not an acceptable list of prompt images, or undefined when it is: at most
 * MAX_PROMPT_IMAGES, each a known image type whose bytes match it, canonical base64 (OpenCode refuses
 * anything else) of at most MAX_PROMPT_IMAGE_BYTES, together at most MAX_PROMPT_IMAGES_BASE64 characters.
 */
export function promptImagesProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "images must be an array"
  if (value.length > MAX_PROMPT_IMAGES) return `Attach at most ${MAX_PROMPT_IMAGES} images`
  let total = 0
  for (const [i, image] of value.entries()) {
    const label = `Image ${i + 1}`
    if (!isObj(image)) return `${label} must be {mime, data, name?}`
    if (typeof image.mime !== "string" || !PROMPT_IMAGE_MIMES.includes(image.mime)) return `${label}: type must be one of ${PROMPT_IMAGE_MIMES.join(", ")}`
    if (image.name !== undefined && (typeof image.name !== "string" || image.name.length > MAX_PROMPT_IMAGE_NAME_CHARS)) {
      return `${label}: name must be a string of at most ${MAX_PROMPT_IMAGE_NAME_CHARS} characters`
    }
    const data = image.data
    if (typeof data !== "string" || !data || data.length % 4 !== 0 || !BASE64.test(data)) return `${label}: data must be non-empty base64`
    total += data.length
    if (total > MAX_PROMPT_IMAGES_BASE64) return `Images together are larger than ${MAX_PROMPT_IMAGES_BASE64} base64 characters`
    if ((data.length / 4) * 3 > MAX_PROMPT_IMAGE_BYTES + 2) return `${label} is larger than ${MAX_PROMPT_IMAGE_BYTES / 1024} KB`
    const bytes = Buffer.from(data, "base64")
    if (bytes.toString("base64") !== data) return `${label}: data must be canonical base64`
    if (bytes.length > MAX_PROMPT_IMAGE_BYTES) return `${label} is larger than ${MAX_PROMPT_IMAGE_BYTES / 1024} KB`
    if (sniffImage(bytes) !== image.mime) return `${label}: content does not match ${image.mime}`
  }
  return undefined
}

/** Text, plus optional images; the text may be empty only when images are attached. */
function promptBody(v: Record<string, unknown>): boolean {
  if (!str(v.text)) return false
  if (v.images === undefined) return v.text.length > 0
  return Array.isArray(v.images) && v.images.length > 0 && promptImagesProblem(v.images) === undefined
}

function isServerRequest(v: unknown): v is ServerRequest {
  if (!isObj(v)) return false
  switch (v.op) {
    case "turn":
      return nonEmpty(v.sessionID) && promptBody(v) && typeof v.voiceStyle === "boolean"
    case "permission":
      return nonEmpty(v.sessionID) && nonEmpty(v.requestID) && ["once", "always", "reject"].includes(v.decision as string)
    case "form":
      if (!nonEmpty(v.sessionID) || !nonEmpty(v.formID) || v.formID.length > 300) return false
      return v.cancel === true ? v.answer === undefined : v.cancel === undefined && formAnswerProblem(v.answer) === undefined
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
      return nonEmpty(v.sessionID) && promptBody(v)
    case "timelineFile":
      return nonEmpty(v.sessionID) && nonEmpty(v.messageID) && v.messageID.length <= 300 && Number.isInteger(v.index) && Number(v.index) >= 0 && Number(v.index) < 1000
    case "diff":
      return nonEmpty(v.sessionID) && nonEmpty(v.file) && v.file.length <= 4096
    case "rename":
      return nonEmpty(v.sessionID) && str(v.title) && v.title.length <= 1000
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
export function compactActivity(event: ForwardedEvent, sessionOf?: (jobID: string) => string | undefined, now: number = Date.now()): ForwardedEvent | undefined {
  const d = event.data
  if (JOB_EVENTS.has(event.type) || event.type === "session.status") return compactJob(event, sessionOf, now)
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

const JOB_EVENTS = new Set(["session.shell.started", "session.shell.ended", "shell.created", "shell.exited", "shell.deleted", "pty.created", "pty.updated", "pty.exited", "pty.deleted"])
const JOB_STATUSES = new Set<string>(["running", "exited", "timeout", "killed"])

function clipText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const line = value.replace(/\s+/g, " ").trim()
  if (!line) return undefined
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/** OpenCode's SessionStatus reduced to its type and (retry) attempt and short reason. */
export function compactStatus(raw: unknown): CompactSessionStatus | undefined {
  const status = raw as Record<string, unknown> | null
  if (!status || typeof status !== "object") return undefined
  if (status.type === "idle" || status.type === "busy") return { type: status.type }
  if (status.type !== "retry") return undefined
  const attempt = finite(status.attempt)
  const message = clipText(status.message, RETRY_MESSAGE_MAX)
  return { type: "retry", ...(attempt !== undefined ? { attempt } : {}), ...(message ? { message } : {}) }
}

/** A ShellInfo or Pty (OpenCode) as a JobInfo. */
export function jobFromInfo(raw: unknown, kind: JobKind): (JobInfo & { sessionID?: string }) | undefined {
  const info = raw as Record<string, any> | null
  if (!info || typeof info !== "object" || typeof info.id !== "string" || !info.id) return undefined
  const status: JobStatus = JOB_STATUSES.has(info.status) ? info.status : "running"
  const commandLine = kind === "pty" ? [info.command, ...(Array.isArray(info.args) ? info.args : [])].filter((x) => typeof x === "string" && x).join(" ") || info.title : info.command
  const command = clipText(commandLine, JOB_COMMAND_MAX)
  const exit = finite(kind === "pty" ? info.exitCode : info.exit)
  const sessionID = typeof info.sessionID === "string" ? info.sessionID : typeof info.metadata?.sessionID === "string" ? info.metadata.sessionID : undefined
  const started = finite(info.time?.started)
  const ended = finite(info.time?.completed)
  return {
    ...(sessionID ? { sessionID } : {}),
    id: info.id,
    kind,
    ...(command ? { command } : {}),
    status,
    ...(exit !== undefined ? { exit } : {}),
    ...(info.metadata?.background === true ? { background: true as const } : {}),
    ...(started !== undefined ? { started } : {}),
    ...(ended !== undefined ? { ended } : {}),
  }
}

function compactJob(event: ForwardedEvent, sessionOf: ((jobID: string) => string | undefined) | undefined, now: number): ForwardedEvent | undefined {
  const d = event.data as Record<string, any>
  const type = event.type
  if (type === "session.status") {
    const status = compactStatus(d.status)
    return typeof d.sessionID === "string" && status ? { type, data: { sessionID: d.sessionID, status } } : undefined
  }
  const kind: JobKind = type.startsWith("pty.") ? "pty" : "shell"
  const session = (id: unknown, own?: unknown) => (typeof own === "string" && own ? own : typeof id === "string" ? sessionOf?.(id) : undefined)
  let data: Record<string, unknown> | undefined
  if (type === "shell.created" || type === "session.shell.started" || type === "pty.created" || type === "pty.updated") {
    const job = jobFromInfo(type === "session.shell.started" ? d.shell : d.info, kind)
    if (!job) return undefined
    const sessionID = session(job.id, type === "session.shell.started" ? d.sessionID : job.sessionID)
    const { started, ended: _ended, sessionID: _session, ...rest } = job
    data = sessionID ? { sessionID, ...rest, at: started ?? now } : undefined
  } else if (type === "session.shell.ended") {
    const job = jobFromInfo(d.shell, "shell")
    if (!job) return undefined
    const sessionID = session(job.id, d.sessionID)
    data = sessionID ? { sessionID, id: job.id, kind, status: job.status === "running" ? "exited" : job.status, ...(job.exit !== undefined ? { exit: job.exit } : {}), at: job.ended ?? now } : undefined
  } else if (type === "shell.exited" || type === "pty.exited") {
    const sessionID = session(d.id, d.sessionID)
    const exit = finite(kind === "pty" ? d.exitCode : d.exit)
    const status = kind === "pty" ? "exited" : JOB_STATUSES.has(d.status) && d.status !== "running" ? d.status : "exited"
    data = sessionID ? { sessionID, id: d.id, kind, status, ...(exit !== undefined ? { exit } : {}), at: now } : undefined
  } else {
    const sessionID = session(d.id, d.sessionID)
    data = sessionID && typeof d.id === "string" ? { sessionID, id: d.id, kind } : undefined
  }
  return data ? { type, data } : undefined
}
