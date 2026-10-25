// Central server ↔ spoke protocol, version 1. JSON text frames over a WebSocket at /spoke/ws.
// A spoke (a harness plugin; OpenCode first) connects outbound with `Authorization: Bearer <machineToken>`.
// Every frame is one object with a `t` discriminator. Unknown or malformed frames are rejected.
//
// Core and features: every spoke serves the core ops (turn, steer, interrupt, stop, permission, form); the
// rest are features a spoke announces in its hello (SPOKE_FEATURES) and the hub uses only when announced.
// A hello without `harness` comes from an OpenCode spoke that predates this split and implies
// IMPLIED_OPENCODE_FEATURES. The hub announces its own features in the welcome (HUB_FEATURES), and a spoke
// sends a newer request only when the hub listed it. Neither side bumps PROTOCOL_VERSION for a new feature.
//
// Modules: launch.ts (launch vocabulary and workspace checks), node.ts (the `hub node` hello, frames and ops on the
// same socket), webhook.ts (webhook signature format), wire.ts (shared frame primitives). All are re-exported here.

import { featureList, ID, isByeFrame as isBye, isObj, isResFrame as isRes, isWelcomeFrame, MAX_FRAME, nonEmpty, num, parseFrame as parse, str, token, UNSAFE_CHARS } from "./wire.ts"
import type { NodeMessage, NodeServerMessage } from "./node.ts"

export * from "./launch.ts"
export * from "./node.ts"
export * from "./webhook.ts"
export { MAX_FRAME }

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

/**
 * A timeline page. Forward mode (`cursor`): oldest rows first, `cursor` for the next newer page. Newest-first
 * mode (`order: "desc"` or `before`): the newest rows (before `before`) in chronological order, `older` for the
 * page before them. Both cursors are opaque. Items are the spoke's rows (src/spoke/timeline.ts TimelineItem); newer
 * spokes add optional `pos` (ordering position), `callID`, `childSessionID`, `title` and `ordinal`.
 */
export interface TimelinePage {
  readonly items: readonly unknown[]
  readonly cursor?: string
  readonly older?: string
}

/** Timeline row kinds. "message": a hub message (src/spoke/timeline.ts has the others). */
export const TIMELINE_KINDS = ["user", "assistant", "reasoning", "tool", "message"] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]

/** A message row's direction from the session's point of view: delivered to it (in) or sent by it (out). */
export const MESSAGE_DIRECTIONS = ["in", "out"] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]

/**
 * A hub message as a timeline row. Inbound rows come from the spoke's timeline (a message the hub delivered,
 * `messageID` the deliver messageID); outbound rows come from the hub's message store. `text` is the body,
 * without the envelope.
 */
export interface TimelineMessageItem {
  readonly key: string
  readonly messageID: string
  readonly sessionID: string
  readonly kind: "message"
  readonly text: string
  readonly at?: number
  /** Ordering position, as for the other rows. */
  readonly pos?: number
  readonly direction: MessageDirection
  readonly message: Pick<DeliverMeta, "kind" | "from" | "to" | "replyTo">
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
  // data: InboxDeliveredData. Newer spokes add `origin` (who put the prompt in the inbox); the type is unchanged,
  // so older hubs keep accepting it.
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

/** Who put a prompt into a session's inbox: the user (a typed or voice prompt) or the hub (a delivered message). */
export const INBOX_ORIGINS = ["user", "hub"] as const
export type InboxOrigin = (typeof INBOX_ORIGINS)[number]

/** `session.inbox.delivered` data as forwarded. `origin` is optional: older spokes do not send it. */
export interface InboxDeliveredData {
  readonly sessionID: string
  readonly inboxID: string
  readonly origin?: InboxOrigin
}

/**
 * OpenCode events the spoke forwards only in another (compact) form: a subagent tool's progress, which names the
 * child session, goes out as a `session.tool.called` with `childSessionID` (a type every hub accepts).
 */
export const COMPACTED_EVENTS: ReadonlySet<string> = new Set(["session.tool.progress"])

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
  /**
   * OpenCode's version. Required by hubs that predate `harness`, so every spoke sends it: OpenCode spokes their
   * OpenCode version, other harnesses their own version (or "").
   */
  readonly opencodeVersion: string
  readonly pluginVersion: string
  /** Optional ops this spoke supports (see SPOKE_FEATURES); older spokes send none. */
  readonly features?: readonly string[]
  /** Harness id, e.g. "opencode" (HARNESS_OPENCODE). Absent in older OpenCode spokes; see helloHarness. */
  readonly harness?: string
  readonly harnessVersion?: string
  /** How the spoke observes activity (EVIDENCE_LEVELS); a level this hub does not know counts as "unknown". */
  readonly evidence?: string
}

export const HARNESS_OPENCODE = "opencode"

/**
 * How a spoke observes a session's activity: native harness events, lifecycle hooks, a harness RPC, or
 * sampling the terminal screen. A session whose evidence is "unknown" never counts as idle.
 */
export const EVIDENCE_LEVELS = ["native", "hooks", "rpc", "screen"] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

/**
 * Features an OpenCode spoke that predates `harness` serves without announcing them (every op it handled
 * then except autoName, which was always announced). Do not add features here: new ones must be announced.
 */
export const IMPLIED_OPENCODE_FEATURES = [
  "context",
  "rename",
  "summary",
  "diff",
  "conversation",
  "models",
  "modelPrefs",
  "timeline",
  "timelinePart",
  "timelineFile",
  "expose",
  "create",
] as const

/**
 * Features a spoke announces in its hello, so the hub can refuse an op an older spoke would ignore.
 * "sessionTokens": the spoke stores the session tokens the hub sends (sessionTokens op) for its sessions' shells.
 * "deliver": the spoke admits hub messages into its sessions (deliver op).
 * "hubPrompt": it admits deliver kind "prompt" (an agent's prompt under a grant) with a provenance header it renders.
 * "permissionMessage": it passes a permission reply's `message` (a deny reason) on to the harness.
 * "actTokens": it keeps the act tokens the hub sends (actTokens op) apart from session tokens, never in any
 * environment, for its own act verbs only (the OpenCode hub tool).
 * "launch": its create op takes a launch's `launchID`, `agent` and `model` (see isLaunchCreate); a launch create's
 * directory may be a new workspace under the machine's node workspace roots rather than one the spoke reported.
 */
export const KNOWN_SPOKE_FEATURES = [...IMPLIED_OPENCODE_FEATURES, "autoName", "sessionTokens", "deliver", "hubPrompt", "permissionMessage", "actTokens", "launch"] as const
export type SpokeFeature = (typeof KNOWN_SPOKE_FEATURES)[number]
/** What this package's OpenCode spoke announces (without "deliver" and "hubPrompt" when its OpenCode has no synthetic messages). */
/** What this package's OpenCode spoke announces: "launch" joins when the spoke serves launch creates (P4-T6). */
export const SPOKE_FEATURES: readonly SpokeFeature[] = KNOWN_SPOKE_FEATURES.filter((f) => f !== "launch")

/**
 * Features the hub announces in its welcome. "harness": it reads hello `harness`, `harnessVersion` and `evidence`.
 * "messaging": it routes messages between sessions (it sends deliver to spokes that announce that feature).
 * "nodes": it accepts a node hello (role "node", see node.ts) and sends node ops; a node backs off from a hub
 * without it. "launches": it launches sessions (it sends launch creates to spokes that announce "launch").
 */
export const KNOWN_HUB_FEATURES = ["harness", "messaging", "nodes", "launches"] as const
export type HubFeature = (typeof KNOWN_HUB_FEATURES)[number]
/** What this hub announces: "launches" joins with the launch routes (P4-T9). */
export const HUB_FEATURES: readonly HubFeature[] = ["harness", "messaging", "nodes"]

/** A spoke's harness, version and evidence level; a hello without `harness` is an OpenCode native spoke. */
export function helloHarness(hello: Hello): { readonly harness: string; readonly harnessVersion: string; readonly evidence: EvidenceLevel | "unknown" } {
  if (hello.harness === undefined) return { harness: HARNESS_OPENCODE, harnessVersion: hello.opencodeVersion, evidence: "native" }
  const evidence = (EVIDENCE_LEVELS as readonly string[]).includes(hello.evidence ?? "") ? (hello.evidence as EvidenceLevel) : "unknown"
  return { harness: hello.harness, harnessVersion: hello.harnessVersion ?? "", evidence }
}

/** The features a spoke serves: those it announced, plus IMPLIED_OPENCODE_FEATURES for a hello without `harness`. */
export function spokeFeatures(hello: Hello): ReadonlySet<string> {
  return new Set([...(hello.harness === undefined ? IMPLIED_OPENCODE_FEATURES : []), ...(hello.features ?? [])])
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
  /** The hub's features (see HUB_FEATURES); older hubs send none. */
  readonly features?: readonly string[]
}

/** An image attached to a typed prompt: base64 bytes of a PNG, JPEG, WebP or GIF (see promptImagesProblem). */
export interface PromptImage {
  readonly mime: string
  readonly data: string
  readonly name?: string
}

/** A hub-minted session token for one session (design §1.3); `exp` is its expiry in ms since the epoch. */
export interface SessionToken {
  readonly sessionID: string
  readonly token: string
  readonly exp: number
}

/** Most tokens one sessionTokens request carries (see batchSessionTokens). */
export const SESSION_TOKENS_MAX = 500
/** Longest session token: printable ASCII without whitespace. */
export const SESSION_TOKEN_MAX_CHARS = 4096
/** Longest hub URL a sessionTokens request carries. */
export const HUB_URL_MAX_CHARS = 2048

/** Why a spoke did not store a session token: it does not report the session, or the token has expired. */
export type SessionTokenSkipReason = "unknown" | "expired"

// ---------- messaging (deliver) ----------

/**
 * What a hub message is: a tell, an ask, its reply or decline, the identity primer, a Decision answer, or a prompt
 * an agent sends under a grant (feature "hubPrompt"; `meta.grant` names the grant).
 */
export const MESSAGE_KINDS = ["msg", "ask", "reply", "decline", "primer", "decision", "prompt"] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

/** How OpenCode admits a message into a busy session: after the running turn (queue) or into it (steer). */
export const DELIVERY_MODES = ["queue", "steer"] as const
export type DeliveryMode = (typeof DELIVERY_MODES)[number]

/**
 * How a spoke delivered a message: into the running turn (steer), as a new turn (turn), admitted without waking
 * or behind the running turn (queued), or held by the spoke for later, e.g. while a form is open (retained).
 */
export const DELIVERED = ["steer", "turn", "queued", "retained"] as const
export type Delivered = (typeof DELIVERED)[number]

/** Longest deliver text (the hub-rendered envelope included). */
export const DELIVER_TEXT_MAX = 16_000
/** Longest id or address in a deliver request. */
export const DELIVER_ID_MAX = 300

/** Who sent a message to whom, as the hub resolved them; the spoke never sets these. */
export interface DeliverMeta {
  readonly kind: MessageKind
  /** The authenticated sender's address, e.g. "@api-refactor". */
  readonly from: string
  /** The address the sender wrote, e.g. "@@reviewer". */
  readonly to: string
  /** The message a reply or decline answers (required for those kinds). */
  readonly replyTo?: string
  /** How to admit the message into a busy session; the spoke picks when absent. */
  readonly delivery?: DeliveryMode
  /** The grant a prompt acts under (required for kind "prompt", refused for the others). */
  readonly grant?: string
}

export type DeliverRequest = Extract<ServerRequest, { op: "deliver" }>

export interface DeliverResult {
  readonly delivered: Delivered
  /** The harness's inbox entry for the message, when it reports one. */
  readonly inboxID?: string
}

export type ServerRequest =
  /** `text` may be empty when `images` are attached. */
  | { readonly op: "turn"; readonly sessionID: string; readonly text: string; readonly voiceStyle: boolean; readonly images?: readonly PromptImage[] }
  /**
   * `message` (reject only, feature "permissionMessage"): why, passed to the harness (OpenCode's reply message, which
   * the model sees as the rejection's feedback).
   */
  | { readonly op: "permission"; readonly sessionID: string; readonly requestID: string; readonly decision: PermissionDecision; readonly message?: string }
  /** Answer (or cancel) a pending form (question) in the session that asked it. */
  | { readonly op: "form"; readonly sessionID: string; readonly formID: string; readonly answer: FormAnswer }
  | { readonly op: "form"; readonly sessionID: string; readonly formID: string; readonly cancel: true }
  | { readonly op: "context"; readonly sessionID: string }
  /** Conversation mode: deliver an utterance with delivery "steer" and return at once (replies arrive as events). */
  | { readonly op: "steer"; readonly sessionID: string; readonly text: string; readonly images?: readonly PromptImage[] }
  | { readonly op: "interrupt"; readonly sessionID: string }
  /** Rename the session in OpenCode; the spoke trims the title and requires 1–200 characters. */
  | { readonly op: "rename"; readonly sessionID: string; readonly title: string }
  /**
   * Have OpenCode regenerate the title with its title agent (session.update with an empty title). Only for
   * spokes whose hello lists the "autoName" feature (older spokes drop unknown ops).
   */
  | { readonly op: "autoName"; readonly sessionID: string }
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
  | { readonly op: "timeline"; readonly sessionID: string; readonly limit?: number; readonly cursor?: string; readonly order?: "asc" | "desc"; readonly before?: string }
  | { readonly op: "timelinePart"; readonly sessionID: string; readonly messageID: string; readonly partID: string }
  /** One image attached to a user message (its position in the message's files). */
  | { readonly op: "timelineFile"; readonly sessionID: string; readonly messageID: string; readonly index: number }
  /** Enable or disable voice for one session (adds/removes it from the machine config's session list). */
  | { readonly op: "expose"; readonly sessionID: string; readonly on: boolean }
  /**
   * Create a session in a workspace directory the spoke already reported. With `herdrWorkspace`, also open
   * it in a new tab of that Herdr workspace (`opencode --session <id>` in the directory).
   * Launch fields (feature "launch", see isLaunchCreate): `launchID` the launch the session is for, `agent` and
   * `model` the agent and model to start it with (the spoke refuses an agent or model its harness lacks).
   */
  | {
      readonly op: "create"
      readonly directory: string
      readonly title?: string
      readonly herdrWorkspace?: string
      readonly launchID?: string
      readonly agent?: string
      readonly model?: ModelSelection
    }
  /**
   * Session tokens for sessions the spoke reported (feature "sessionTokens"); each replaces the session's older
   * one. `hubURL`: the URL the sessions' shells reach the hub at. No session is adopted or exposed by this op.
   * Send through batchSessionTokens so every frame stays under MAX_FRAME.
   */
  | { readonly op: "sessionTokens"; readonly tokens: readonly SessionToken[]; readonly hubURL?: string }
  /**
   * Act tokens (typ "act") for sessions the spoke reported (feature "actTokens"): the credential for act verbs. A
   * separate op so a spoke that only knows sessionTokens never takes one for a shell token. The spoke keeps them
   * apart from session tokens and never puts them in any environment. Send through batchActTokens.
   */
  | { readonly op: "actTokens"; readonly tokens: readonly SessionToken[] }
  /**
   * Admit a hub message into a session (feature "deliver"). `text` is the envelope the hub rendered; `messageID`
   * is the idempotency key (spokes apply a message once). `wake: false` admits it without starting a turn.
   * Kind "prompt" (feature "hubPrompt"): `text` is the prompt's body; the spoke renders the provenance header from
   * `meta.from` and `meta.grant` around it, so the session never sees it as the user's prompt.
   */
  | { readonly op: "deliver"; readonly sessionID: string; readonly messageID: string; readonly text: string; readonly wake: boolean; readonly meta: DeliverMeta }

/** The feature a spoke must announce for the hub to send `op`, or undefined for a core op every spoke serves. */
export function featureForOp(op: ServerRequest["op"]): SpokeFeature | undefined {
  switch (op) {
    case "turn":
    case "steer":
    case "interrupt":
    case "stop":
    case "permission":
    case "form":
      return undefined
    case "setModelPrefs":
      return "modelPrefs"
    default:
      return op
  }
}

/** Every feature a spoke must announce for the hub to send `req`: its op's (featureForOp) and its options'. */
export function requestFeatures(req: ServerRequest): SpokeFeature[] {
  const op = featureForOp(req.op)
  const out: SpokeFeature[] = op ? [op] : []
  if (req.op === "deliver" && req.meta.kind === "prompt") out.push("hubPrompt")
  if (req.op === "permission" && req.message !== undefined) out.push("permissionMessage")
  if (isLaunchCreate(req)) out.push("launch")
  return out
}

export type CreateRequest = Extract<ServerRequest, { op: "create" }>

/** Whether `req` is a create carrying launch fields (feature "launch"). */
export function isLaunchCreate(req: ServerRequest): req is CreateRequest {
  return req.op === "create" && (req.launchID !== undefined || req.agent !== undefined || req.model !== undefined)
}

/** Longest agent name a launch create carries. */
export const AGENT_NAME_MAX = 100

/** Longest permission reply message (deny reason). */
export const PERMISSION_MESSAGE_MAX = 1000

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
  /**
   * `title`: the new title. `unchanged`: OpenCode kept the title (`title` is the current one). `pending`: still
   * generating after the spoke's wait; the catalog updates when it lands.
   */
  autoName: { readonly title?: string; readonly unchanged?: true; readonly pending?: true }
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
  /** `applied`: sessions whose token the spoke stored; `skipped`: the others, with the reason. */
  sessionTokens: { readonly applied: readonly string[]; readonly skipped: ReadonlyArray<{ readonly sessionID: string; readonly reason: SessionTokenSkipReason }> }
  /** As sessionTokens. */
  actTokens: { readonly applied: readonly string[]; readonly skipped: ReadonlyArray<{ readonly sessionID: string; readonly reason: SessionTokenSkipReason }> }
  deliver: DeliverResult
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

const isModelSelection = (v: unknown): v is ModelSelection =>
  isObj(v) && typeof v.providerID === "string" && ID.test(v.providerID) && typeof v.modelID === "string" && ID.test(v.modelID) && (v.variant === undefined || (typeof v.variant === "string" && ID.test(v.variant)))

const SESSION_TOKEN_TEXT = new RegExp(`^[\\x21-\\x7e]{1,${SESSION_TOKEN_MAX_CHARS}}$`)

function isSessionToken(v: unknown): v is SessionToken {
  return isObj(v) && nonEmpty(v.sessionID) && v.sessionID.length <= 300 && str(v.token) && SESSION_TOKEN_TEXT.test(v.token) && num(v.exp)
}

/** An http(s) URL of at most HUB_URL_MAX_CHARS characters. */
export function isHubURL(v: unknown): v is string {
  if (!nonEmpty(v) || v.length > HUB_URL_MAX_CHARS) return false
  try {
    const url = new URL(v)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** Characters batchSessionTokens leaves free in a frame for the `{"t":"req","id":…}` envelope around a request. */
export const SESSION_TOKENS_ENVELOPE_CHARS = 1024

export type SessionTokensRequest = Extract<ServerRequest, { op: "sessionTokens" }>
export type ActTokensRequest = Extract<ServerRequest, { op: "actTokens" }>

/**
 * Splits tokens into sessionTokens requests, in order, of at most SESSION_TOKENS_MAX tokens whose JSON is at most
 * `maxChars` characters (default: MAX_FRAME less SESSION_TOKENS_ENVELOPE_CHARS). Each request carries `hubURL`.
 * Throws a RangeError when one token alone does not fit `maxChars`.
 */
export function batchSessionTokens(tokens: readonly SessionToken[], options: { readonly hubURL?: string; readonly maxChars?: number } = {}): SessionTokensRequest[] {
  return batchTokens(tokens, (batch) => ({ op: "sessionTokens", tokens: batch, ...(options.hubURL !== undefined ? { hubURL: options.hubURL } : {}) }), options.maxChars)
}

/** Splits act tokens into actTokens requests, as batchSessionTokens does (no hub URL). */
export function batchActTokens(tokens: readonly SessionToken[], options: { readonly maxChars?: number } = {}): ActTokensRequest[] {
  return batchTokens(tokens, (batch) => ({ op: "actTokens", tokens: batch }), options.maxChars)
}

function batchTokens<R>(tokens: readonly SessionToken[], request: (batch: readonly SessionToken[]) => R, max?: number): R[] {
  const maxChars = max ?? MAX_FRAME - SESSION_TOKENS_ENVELOPE_CHARS
  const empty = JSON.stringify(request([])).length
  const out: R[] = []
  let batch: SessionToken[] = []
  let size = empty
  for (const { sessionID, token, exp } of tokens) {
    const entry = { sessionID, token, exp }
    const chars = JSON.stringify(entry).length
    if (empty + chars > maxChars) throw new RangeError(`A session token for ${sessionID} does not fit in ${maxChars} characters`)
    if (batch.length > 0 && (batch.length >= SESSION_TOKENS_MAX || size + 1 + chars > maxChars)) {
      out.push(request(batch))
      batch = []
      size = empty
    }
    size += chars + (batch.length > 0 ? 1 : 0)
    batch.push(entry)
  }
  if (batch.length > 0) out.push(request(batch))
  return out
}

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

/** A permission reply message: 1–PERMISSION_MESSAGE_MAX characters, newlines and tabs but no other unsafe characters. */
const permissionMessage = (v: unknown): v is string => nonEmpty(v) && v.length <= PERMISSION_MESSAGE_MAX && !UNSAFE_CHARS.test(v.replace(/[\n\t]/g, ""))

/** A non-empty address of at most DELIVER_ID_MAX characters without characters that could fake a header. */
const address = (v: unknown): v is string => nonEmpty(v) && v.length <= DELIVER_ID_MAX && !UNSAFE_CHARS.test(v)
const deliverID = (v: unknown): v is string => typeof v === "string" && v.length <= DELIVER_ID_MAX && ID.test(v)
/** An agent name: 1–AGENT_NAME_MAX printable characters, not starting with "-" or a space. */
const agentName = (v: unknown): v is string => nonEmpty(v) && v.length <= AGENT_NAME_MAX && !UNSAFE_CHARS.test(v) && !/^[-\s]/.test(v)

/** Why `v` is not an acceptable deliver request, or undefined when it is. */
export function deliverProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "deliver must be an object"
  if (!nonEmpty(v.sessionID) || v.sessionID.length > DELIVER_ID_MAX) return `sessionID must be 1–${DELIVER_ID_MAX} characters`
  if (!deliverID(v.messageID)) return `messageID must be 1–${DELIVER_ID_MAX} id characters`
  if (!nonEmpty(v.text) || v.text.length > DELIVER_TEXT_MAX) return `text must be 1–${DELIVER_TEXT_MAX} characters`
  if (typeof v.wake !== "boolean") return "wake must be true or false"
  const meta = v.meta
  if (!isObj(meta)) return "meta must be an object"
  if (!(MESSAGE_KINDS as readonly unknown[]).includes(meta.kind)) return `meta.kind must be one of ${MESSAGE_KINDS.join(", ")}`
  if (!address(meta.from)) return `meta.from must be an address of 1–${DELIVER_ID_MAX} printable characters`
  if (!address(meta.to)) return `meta.to must be an address of 1–${DELIVER_ID_MAX} printable characters`
  if (meta.replyTo !== undefined && !deliverID(meta.replyTo)) return `meta.replyTo must be 1–${DELIVER_ID_MAX} id characters`
  if ((meta.kind === "reply" || meta.kind === "decline") && meta.replyTo === undefined) return `meta.replyTo is required for a ${meta.kind}`
  if (meta.delivery !== undefined && !(DELIVERY_MODES as readonly unknown[]).includes(meta.delivery)) return `meta.delivery must be one of ${DELIVERY_MODES.join(", ")}`
  if (meta.kind === "prompt" && meta.grant === undefined) return "meta.grant is required for a prompt"
  if (meta.kind !== "prompt" && meta.grant !== undefined) return "meta.grant is only for a prompt"
  if (meta.grant !== undefined && !deliverID(meta.grant)) return `meta.grant must be 1–${DELIVER_ID_MAX} id characters`
  return undefined
}

/** Whether `v` is a well-formed deliver result (what the hub accepts back from a spoke). */
export function isDeliverResult(v: unknown): v is DeliverResult {
  return isObj(v) && (DELIVERED as readonly unknown[]).includes(v.delivered) && (v.inboxID === undefined || (nonEmpty(v.inboxID) && v.inboxID.length <= DELIVER_ID_MAX))
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
      return (
        nonEmpty(v.sessionID) &&
        nonEmpty(v.requestID) &&
        ["once", "always", "reject"].includes(v.decision as string) &&
        (v.message === undefined || (v.decision === "reject" && permissionMessage(v.message)))
      )
    case "form":
      if (!nonEmpty(v.sessionID) || !nonEmpty(v.formID) || v.formID.length > 300) return false
      return v.cancel === true ? v.answer === undefined : v.cancel === undefined && formAnswerProblem(v.answer) === undefined
    case "context":
    case "autoName":
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
        (v.cursor === undefined || (str(v.cursor) && v.cursor.length <= 4096)) &&
        (v.order === undefined || v.order === "asc" || v.order === "desc") &&
        (v.before === undefined || (nonEmpty(v.before) && v.before.length <= 4096)) &&
        // Newest-first paging (order desc, before) does not mix with the forward cursor.
        (v.cursor === undefined || (v.before === undefined && v.order !== "desc"))
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
        (v.herdrWorkspace === undefined || (nonEmpty(v.herdrWorkspace) && v.herdrWorkspace.length <= 100)) &&
        (v.launchID === undefined || deliverID(v.launchID)) &&
        (v.agent === undefined || agentName(v.agent)) &&
        (v.model === undefined || isModelSelection(v.model))
      )
    case "sessionTokens":
      return Array.isArray(v.tokens) && v.tokens.length <= SESSION_TOKENS_MAX && v.tokens.every(isSessionToken) && (v.hubURL === undefined || isHubURL(v.hubURL))
    case "actTokens":
      return Array.isArray(v.tokens) && v.tokens.length <= SESSION_TOKENS_MAX && v.tokens.every(isSessionToken) && !("hubURL" in v)
    case "deliver":
      return deliverProblem(v) === undefined
    default:
      return false
  }
}


/** Parses a frame received by the server. Returns undefined for anything invalid. */
export function parseSpokeMessage(raw: string | Buffer): SpokeMessage | undefined {
  const m = parse(raw)
  if (!m) return undefined
  switch (m.t) {
    case "hello":
      // A spoke hello has no role (v1) or role "spoke"; a node hello (role "node") is parsed by parseNodeMessage.
      return (m.role === undefined || m.role === "spoke") &&
        num(m.v) &&
        nonEmpty(m.processID) &&
        (m.kind === "service" || m.kind === "standalone") &&
        str(m.directory) &&
        num(m.pid) &&
        (m.mode === "always" || m.mode === "session") &&
        str(m.opencodeVersion) &&
        str(m.pluginVersion) &&
        (m.features === undefined || featureList(m.features)) &&
        (m.harness === undefined || token(m.harness, 64)) &&
        (m.harnessVersion === undefined || (str(m.harnessVersion) && m.harnessVersion.length <= 100)) &&
        (m.evidence === undefined || token(m.evidence, 32))
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
      return isWelcomeFrame(m) ? (m as unknown as Welcome) : undefined
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

export const encode = (message: SpokeMessage | ServerMessage | NodeMessage | NodeServerMessage): string => JSON.stringify(message)

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
    case "session.tool.progress": {
      const childSessionID = childSessionOf(d.metadata)
      return childSessionID ? { type: "session.tool.called", data: { ...base, childSessionID } } : undefined
    }
    case "session.tool.success": {
      const childSessionID = childSessionOf(d.metadata)
      return { type: event.type, data: childSessionID ? { ...base, childSessionID } : base }
    }
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

/** The child session a subagent tool reports in its metadata (`{sessionID: "ses_…"}`). */
function childSessionOf(metadata: unknown): string | undefined {
  const id = (metadata as { sessionID?: unknown } | undefined)?.sessionID
  return typeof id === "string" && /^ses_[A-Za-z0-9]+$/.test(id) ? id : undefined
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
