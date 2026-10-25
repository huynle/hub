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

/** One server-sent event of GET /api/agent/watch (data is the raw text, JSON for hub events). */
export interface WatchEvent {
  readonly event: string
  readonly data: string
}
