// The shapes of the hub's /api/agent answers (src/central/agent/*). Fields are those the hub sends today; clients
// should ignore unknown ones, and later hubs may add fields.

/** The caller, as whoami and status (`you`) report it. */
export type Actor =
  | { readonly kind: "user"; readonly userID: string; readonly deviceID: string; readonly via: "cookie" | "device-token" }
  | {
      readonly kind: "session"
      readonly userID: string
      readonly machineID: string
      readonly sessionID: string
      /** Which of the session's tokens: its shell token, or the act token only the hub tool has (missing: shell). */
      readonly via?: "shell" | "act"
    }
  | { readonly kind: "app"; readonly userID: string; readonly tokenID: string; readonly scopes: readonly string[]; readonly label?: string }

export interface UserView {
  readonly id: string
  readonly name?: string
  readonly email?: string
  readonly role?: string
}

export interface Whoami {
  readonly actor: Actor
  readonly user: UserView
}

export interface Blocker {
  readonly kind: string
  readonly id?: string
  readonly summary: string
  readonly sessionID?: string
}

/** One session in status and sessions answers. */
export interface SessionView {
  readonly id: string
  readonly name?: string
  readonly roles?: readonly string[]
  readonly title?: string
  readonly state: string
  readonly harness?: string
  readonly parentID?: string
  readonly busySince?: number
  readonly now?: string
  readonly blockers?: readonly Blocker[]
  readonly children?: number
  readonly labels?: Readonly<Record<string, string>>
  /** In sessions answers. */
  readonly machineID?: string
  readonly project?: string
}

export interface AttentionItem {
  readonly kind: string
  readonly sessionID: string
  readonly name?: string
  readonly id?: string
  readonly summary: string
}

/** GET /api/agent/status: machines → projects → sessions, and what needs attention. */
export interface Status {
  readonly machines: readonly {
    readonly id: string
    readonly name?: string
    readonly online: boolean
    readonly harnesses?: readonly string[]
    readonly projects: readonly { readonly root: string; readonly name: string; readonly sessions: readonly SessionView[] }[]
  }[]
  readonly attention: readonly AttentionItem[]
  readonly you?: Actor
}

/** GET /api/agent/sessions/:addr: one session in detail. */
export interface SessionDetail extends SessionView {
  readonly online?: boolean
  readonly directory?: string
  readonly lastSeen?: number
  readonly summary?: {
    readonly branch?: string
    readonly context?: { readonly used: number; readonly limit?: number; readonly percent?: number; readonly model?: string }
    readonly changes?: { readonly additions: number; readonly deletions: number; readonly totalFiles: number }
    readonly mcp?: readonly { readonly name: string; readonly status: string }[]
  }
  readonly unsupported?: readonly { readonly feature?: string; readonly harness?: string }[]
  readonly failed?: readonly { readonly feature?: string }[]
}

/** One timeline row (newest first). */
export interface LogRow {
  readonly kind: string
  readonly text?: string
  readonly name?: string
  readonly state?: string
  readonly title?: string
  readonly at?: number
}

export interface RoleView {
  readonly role: string
  readonly project?: string
  readonly generation?: number
  readonly exclusive?: boolean
}

/** One session in directory answers (who). */
export interface DirectoryEntry {
  readonly sessionID: string
  readonly name?: string
  readonly aliases?: readonly string[]
  readonly machineID?: string
  readonly parentID?: string
  readonly project?: string
  readonly title?: string
  readonly state?: string
  readonly online: boolean
  readonly lastSeen?: number
  readonly archived?: boolean
  readonly roles: readonly RoleView[]
}

export interface Named {
  readonly sessionID: string
  readonly name: string
  /** The previous name, kept as an alias for 24 h. */
  readonly alias?: string
}

export interface RoleClaim extends RoleView {
  readonly sessionID: string
}

export interface RoleRelease {
  readonly sessionID: string
  readonly role: string
  readonly project?: string
  readonly released?: boolean
}

export interface AppTokenView {
  readonly id: string
  readonly label?: string
  readonly scopes: readonly string[]
  readonly created?: number
}

/** POST /api/agent/app-tokens: the token is shown once. */
export interface CreatedAppToken extends AppTokenView {
  readonly token: string
}

/** Who sends or receives a message: a session, the user (`@me`), or an app token. */
export type Party =
  | { readonly kind: "session"; readonly sessionID: string; readonly name?: string; readonly harness?: string; readonly machine?: string }
  | { readonly kind: "user" }
  | { readonly kind: "app"; readonly tokenID: string; readonly label?: string }

export type MessageKind = "msg" | "ask" | "reply" | "decline"
/** `sent` for msg/reply/decline; asks are open until answered, declined or expired. */
export type MessageState = "sent" | "open" | "answered" | "declined" | "expired"
/** How a message reached its recipient session. */
export type MessageDelivery = "steer" | "turn" | "queued" | "retained" | "pending"

/** A stored agent message. */
export interface AgentMessage {
  readonly id: string
  readonly kind: MessageKind
  /** The authenticated sender. */
  readonly from: Party
  /** The address as the sender wrote it. */
  readonly to: string
  /** The party it reached. */
  readonly recipient: Party
  /** The role holder generation it reached (role addresses). */
  readonly generation?: number
  readonly text: string
  readonly replyTo?: string
  readonly state: MessageState
  readonly at: number
  readonly hop: number
  readonly expiresAt?: number
  readonly delivery?: MessageDelivery
  readonly deliveredAt?: number
  /** The reply or decline that closed an ask. */
  readonly answer?: { readonly id: string; readonly at: number }
}

/** POST /api/agent/msg and /ask: the stored message and how it was delivered (none: stored only). */
export interface Sent {
  readonly message: AgentMessage
  readonly delivery?: MessageDelivery
}

/** POST /api/agent/msg or /ask with all: one per session. */
export interface SentAll {
  readonly sent: readonly Sent[]
}

/** POST /api/agent/ask (after any wait) and GET /api/agent/messages/:id: the message and, once closed, its answer. */
export interface Asked extends Sent {
  readonly answer?: AgentMessage
  /** An ask to @me: the Decision it opened. */
  readonly decision?: Decision
}

/** One choice a Decision offers; onTimeout may pick only a safe one. */
export interface DecisionOption {
  readonly id: string
  readonly label: string
  readonly safe?: boolean
}

export type DecisionUrgency = "low" | "normal" | "high"
/** confirm: any of the user's devices; tap: only the signed-in console. */
export type DecisionTier = "confirm" | "tap"
/** closed: ended without an answer because what it asked about went away (answered elsewhere, ended). */
export type DecisionState = "open" | "answered" | "expired" | "closed"

/** What an ask to @me opens (design §12.1); only the user answers it. */
export interface Decision {
  readonly id: string
  /** The ask (to @me) carrying it. */
  readonly messageID: string
  readonly from: Party
  /** Session IDs it concerns. */
  readonly about: readonly string[]
  readonly sessionID?: string
  readonly question: string
  readonly options: readonly DecisionOption[]
  readonly recommendation?: { readonly option: string; readonly why?: string }
  readonly urgency: DecisionUrgency
  readonly tier: DecisionTier
  readonly deadline?: number
  readonly onTimeout?: string
  readonly state: DecisionState
  readonly at: number
  readonly expiresAt: number
  readonly escalatedAt?: number
  readonly answer?: { readonly option?: string; readonly text?: string; readonly answeredBy: "user" | "timeout"; readonly at: number; readonly deviceID?: string }
  /** Why it closed without an answer (state closed). */
  readonly closed?: { readonly at: number; readonly reason: string }
}

/** POST /api/decisions/:id/answer. */
export interface DecisionAnswered {
  readonly decision: Decision
  /** The user's reply to the asker. */
  readonly reply?: AgentMessage
}

/** POST /api/agent/reply and /decline: the answer and the message it answered. */
export interface Replied extends Sent {
  readonly original: AgentMessage
}

/** GET /api/agent/inbox. */
export interface Inbox {
  /** Open asks to the caller, newest first. */
  readonly asks: readonly AgentMessage[]
  /** The caller's own open asks. */
  readonly waiting: readonly AgentMessage[]
  /** Recent messages to the caller. */
  readonly messages: readonly AgentMessage[]
  /** Session IDs the caller muted. */
  readonly muted: readonly string[]
}

/** One server-sent event of GET /api/agent/watch (data is the raw text, JSON for hub events). */
export interface WatchEvent {
  readonly event: string
  readonly data: string
}

// Acting (POST /api/agent/sessions/:addr/{approve,deny,answer,prompt,stop}; src/central/agent/acting.ts).

/** OpenCode's reply to a permission request. */
export type PermissionDecision = "once" | "always" | "reject"

/** How an agent's prompt enters a busy session (the spoke picks when unset). */
export type PromptDelivery = "queue" | "steer"

/** An answer to a form (question): field key → value. */
export type FormAnswer = Readonly<Record<string, string | number | boolean | readonly string[]>>

/** Why an act verb needs the user (the needs_user envelope's `evaluation`). */
export interface Evaluation {
  readonly verdict: "outside"
  readonly reason: string
  /** Set by the hub: confirm (any of the user's devices) or tap (the signed-in console). */
  readonly tier: DecisionTier
  /** The usable grants it was evaluated against. */
  readonly grants: readonly string[]
}

export interface Approved {
  readonly sessionID: string
  readonly requestID: string
  readonly decision: PermissionDecision
  /** The grant it acted under (agents). */
  readonly grant?: string
}

export interface Denied {
  readonly sessionID: string
  readonly requestID: string
  readonly grant?: string
  /** With a why: whether the harness got the reason. */
  readonly reasonSent?: boolean
}

export interface FormAnswered {
  readonly sessionID: string
  readonly formID: string
  readonly grant?: string
}

export interface Stopped {
  readonly sessionID: string
  readonly grant?: string
  /** The spoke's answer. */
  readonly result: unknown
}

/** An agent's prompt (delivered under its provenance), or the user's (steered into the tree, or a new turn). */
export type Prompted =
  | { readonly sessionID: string; readonly messageID: string; readonly delivered: string; readonly inboxID?: string; readonly grant: string }
  | { readonly sessionID: string; readonly mode: "steer"; readonly inboxID: string }
  | { readonly sessionID: string; readonly mode: "turn" }

// Grants (/api/agent/grants; src/central/agent/grants.ts): created, edited and revoked only by the user.

export type GrantVerb = "approve" | "deny" | "answer" | "prompt" | "stop" | "roles" | "launch"
export type GrantState = "active" | "expired" | "revoked"

/** What the user grants (create and update bodies). */
export interface GrantSpec {
  /** A session (ses_… or @name, pinned at creation), a reserved role (@@orchestrator…), or app:<token id>. */
  readonly holder: string
  readonly scope: { readonly projects: readonly string[] }
  readonly allow: readonly GrantVerb[]
  readonly permissions?: { readonly allow?: readonly string[]; readonly never?: readonly string[] }
  readonly allowAlways?: boolean
  /** Seconds, or 30m, 8h, 2d (1 minute to 30 days). */
  readonly expires?: number | string
  readonly maxActionsPerHour?: number
}

export interface Grant {
  readonly id: string
  readonly holder: string
  readonly holderSessionID?: string
  readonly scope: { readonly projects: readonly string[] }
  readonly allow: readonly GrantVerb[]
  readonly permissions: { readonly allow: readonly string[]; readonly never: readonly string[] }
  readonly allowAlways: boolean
  readonly maxActionsPerHour: number
  readonly created: number
  readonly expiresAt: number
  readonly updated?: number
  readonly revokedAt?: number
  readonly state: GrantState
}

/** POST /api/agent/grants/requests: what an agent asks the user for (the holder defaults to the requester). */
export type GrantRequestSpec = Omit<GrantSpec, "holder"> & {
  /** Only the requester itself (ses_…, its @name, app:<own token id>) or a reserved @@role the session holds. */
  readonly holder?: string
}

/** POST /api/agent/grants/requests: the ask to @me and the tap Decision it opened (approve creates the grant). */
export interface GrantRequested {
  readonly message: AgentMessage
  readonly decision: Decision
}

// Launches (design §6.1; packages/protocol/src/launch.ts is the wire source of truth, kept in step by the tests).

export type LaunchState = "queued" | "placing" | "provisioning" | "running" | "ended"
export type LaunchOutcome = "idle" | "needs_user" | "failed" | "timeout" | "stopped" | "lost"
export type WorkspaceMode = "worktree" | "checkout" | "clone"
export type RuntimeKind = "host" | "openshell"
export type PlacementMode = "require" | "prefer"
export type LaunchEndWhen = "idle" | "asked" | "never"
export type CleanupPolicy = "keep" | "remove"

/** POST /api/agent/launches: what to start, where, and when it ends. Unset fields take the hub's defaults. */
export interface LaunchSpec {
  /** Idempotency key: the same key and body return the same launch (another body: invalid). */
  readonly key?: string
  /** The session's @name (without the @). */
  readonly name?: string
  readonly roles?: readonly string[]
  /** Default opencode. */
  readonly harness?: string
  readonly agent?: string
  /** "provider/model". */
  readonly model?: string
  readonly workspace: {
    /** Absolute path on the node: the repository (worktree, checkout) or where the clone goes. */
    readonly repo: string
    /** Default worktree (`<repo>/.worktrees/<branch>`; needs branch). */
    readonly mode?: WorkspaceMode
    readonly branch?: string
    readonly base?: string
    /** https or ssh; required for clone. */
    readonly remote?: string
  }
  readonly runtime?: { readonly kind: RuntimeKind; readonly profile?: string }
  readonly placement?: { readonly labels?: Readonly<Record<string, string>>; readonly machine?: string; readonly mode?: PlacementMode }
  readonly prompt?: string
  /** Free-form; never interpreted by the hub (find launches and sessions by them). */
  readonly labels?: Readonly<Record<string, string>>
  readonly end?: { readonly when?: LaunchEndWhen; readonly timeout?: string; readonly cleanup?: CleanupPolicy }
}

export interface LaunchStep {
  readonly state: LaunchState
  readonly reason: string
  readonly at: number
  readonly outcome?: LaunchOutcome
}

export interface LaunchArtifacts {
  readonly branch?: string
  readonly base?: string
  readonly head?: string
  readonly commits?: number
  readonly dirty?: boolean
}

/** A launch as the hub reports it (the spec with its defaults filled in). */
export interface LaunchView {
  readonly id: string
  readonly state: LaunchState
  readonly reason: string
  readonly spec: LaunchSpec
  /** ms epoch */
  readonly created: number
  /** When it entered its state. */
  readonly updated: number
  /** Who launched it: `user`, `app:<token id>` or a session ID. */
  readonly by?: string
  readonly machineID?: string
  readonly directory?: string
  readonly sessionID?: string
  readonly name?: string
  readonly outcome?: LaunchOutcome
  readonly artifacts?: LaunchArtifacts
  readonly history: readonly LaunchStep[]
}

/** POST /api/agent/launches: the launch, and whether it is new (false: the same key again). */
export interface LaunchCreated {
  readonly launch: LaunchView
  readonly created: boolean
}
