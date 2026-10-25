// The shapes of the hub's /api/agent answers (src/central/agent/*). Fields are those the hub sends today; clients
// should ignore unknown ones, and later hubs may add fields.

/** The caller, as whoami and status (`you`) report it. */
export type Actor =
  | { readonly kind: "user"; readonly userID: string; readonly deviceID: string; readonly via: "cookie" | "device-token" }
  | { readonly kind: "session"; readonly userID: string; readonly machineID: string; readonly sessionID: string }
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
