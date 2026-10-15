// Multi-user hub helpers, pure and DOM-free: who is signed in and what the account menu shows, the sign-in
// link, per-user speech settings inherited from the server default, and the admin screens' users table, user
// actions, error messages and audit labels. Contract: docs/multi-user.md.

export type Role = "admin" | "user"
export type AuthMode = "pairing" | "oidc"

export interface Me {
  readonly device: { readonly id: string; readonly name: string }
  readonly user?: { readonly id: string; readonly email?: string; readonly name?: string; readonly role: Role }
  readonly auth?: AuthMode
  readonly publicURL?: string
  readonly version?: string
}

export interface AuthInfo {
  readonly mode: AuthMode
  readonly signIn: string | null
}

export interface Account {
  readonly mode: AuthMode
  readonly admin: boolean
  readonly title: string
  readonly subtitle?: string
  readonly initial: string
  readonly badge?: string
}

export type MenuID = "devices" | "speech" | "admin" | "signout"
export interface MenuItem {
  readonly id: MenuID
  readonly label: string
}

export type SpeechKind = "stt" | "tts"
export interface FieldInheritance {
  readonly inherited: boolean
  readonly note?: string
}
export type SttField = "provider" | "model" | "baseURL" | "language"
export type TtsField = "provider" | "model" | "voice" | "baseURL" | "speed"
export interface SpeechInheritance {
  readonly stt: Readonly<Record<SttField | "apiKey", FieldInheritance>>
  readonly tts: Readonly<Record<TtsField | "apiKey", FieldInheritance>>
  /** Number of the user's own values (fields + key) per section. */
  readonly own: { readonly stt: number; readonly tts: number }
}

export interface AdminUser {
  readonly id: string
  readonly email?: string
  readonly name?: string
  readonly role: Role
  readonly disabled?: boolean
  readonly created: number
  readonly lastSeen: number
  readonly machines: number
  readonly devices: number
}

export type UserSort = "role" | "email" | "lastSeen"
export type UserFilter = "all" | "admins" | "active" | "disabled"

export interface UserAction {
  readonly label: string
  readonly change: { readonly role?: Role; readonly disabled?: boolean }
  readonly confirm: string
  readonly danger?: true
  readonly lastAdmin?: true
}

export interface AuditEntry {
  readonly at: number
  readonly actor: string
  readonly action: string
  readonly target?: string
  readonly detail?: string
}
export type AuditRow = AuditEntry

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim())

export const USER_SORTS: ReadonlyArray<readonly [UserSort, string]> = Object.freeze([
  ["role", "Admins first"],
  ["email", "Email"],
  ["lastSeen", "Last seen"],
] as const)

export const USER_FILTERS: ReadonlyArray<readonly [UserFilter, string]> = Object.freeze([
  ["all", "All"],
  ["admins", "Admins"],
  ["active", "Active"],
  ["disabled", "Disabled"],
] as const)

export const AUDIT_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  signin: "Signed in",
  "signin.denied": "Sign-in refused",
  "device.pair": "Paired a device",
  "device.revoke": "Revoked a device",
  "machine.approve": "Approved a machine",
  "machine.deny": "Denied a machine",
  "machine.revoke": "Revoked a machine",
  "user.role": "Changed a role",
  "user.disable": "Disabled a user",
  "user.enable": "Enabled a user",
  "speech.default": "Changed the server speech default",
  "migrate.local": "Moved the hub owner's machines and devices to the first admin",
})

// ---------- account ----------

export function isAdmin(me: Me | undefined): boolean {
  return me?.user?.role === "admin"
}

/** Header/menu identity: oidc shows name and email; pairing mode (and older hubs) show "This hub". */
export function account(me: Me | undefined): Account {
  const user = me?.user
  const mode: AuthMode = me?.auth === "oidc" ? "oidc" : "pairing"
  const admin = isAdmin(me)
  if (mode !== "oidc") return { mode, admin, title: "This hub", initial: "H" }
  const name = str(user?.name)
  const email = str(user?.email)
  const title = name || email || "Signed in"
  return {
    mode,
    admin,
    title,
    ...(name && email ? { subtitle: email } : {}),
    initial: (title.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase(),
    ...(admin ? { badge: "Admin" } : {}),
  }
}

/** The account menu: My devices, Speech, Admin (admins only), Sign out. */
export function menuItems(me: Me | undefined): MenuItem[] {
  return [
    { id: "devices", label: "My devices" },
    { id: "speech", label: "Speech" },
    ...(isAdmin(me) ? [{ id: "admin" as const, label: "Admin" }] : []),
    { id: "signout", label: "Sign out" },
  ]
}

export type AdminTab = "users" | "machines" | "approvals" | "audit"
const ADMIN_TABS: ReadonlyArray<readonly [AdminTab, string]> = Object.freeze([
  ["users", "Users"],
  ["machines", "Machines"],
  ["approvals", "Approvals"],
  ["audit", "Audit log"],
] as const)

/** Admin screens: none for users; no Users tab in pairing mode (one implicit owner). */
export function adminTabs(me: Me | undefined): Array<readonly [AdminTab, string]> {
  if (!isAdmin(me)) return []
  return ADMIN_TABS.filter(([id]) => id !== "users" || me?.auth === "oidc")
}

/** Speech settings tabs: the user's own, plus the server default for admins on a per-user hub. */
export function speechTabs(me: Me | undefined, settings: { scope?: string } | undefined): Array<"user" | "default"> {
  return isAdmin(me) && settings?.scope === "user" ? ["user", "default"] : ["user"]
}

/** Only same-site absolute paths are allowed as a post-sign-in destination. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/"
}

/** "Sign in with Google" link (GET /api/auth signIn + ?next=); undefined when the hub only pairs. */
export function signInURL(auth: AuthInfo | undefined, next: string | undefined | null): string | undefined {
  if (auth?.mode !== "oidc" || typeof auth.signIn !== "string" || !auth.signIn) return undefined
  return `${auth.signIn}?next=${encodeURIComponent(safeNext(next))}`
}

export function approveOwner(me: Me | undefined): string {
  const email = me?.auth === "oidc" ? str(me?.user?.email) : ""
  return email ? `This machine will belong to you (${email}).` : "This machine will belong to you."
}

// ---------- speech: own values vs the server default ----------

const SPEECH_FIELDS: { stt: SttField[]; tts: TtsField[] } = {
  stt: ["provider", "model", "baseURL", "language"],
  tts: ["provider", "model", "voice", "baseURL", "speed"],
}

type Loose = Record<string, any>

/**
 * Per field of GET /api/settings/speech (scope "user"): whether the value comes from the server default, with the
 * note to show ("Using server default: <value>", "Key: server default"). Uses the user's own values (`user`) when
 * the hub sends them; otherwise a value equal to the default counts as inherited and a key is the user's own only
 * with source "user". Undefined for responses that are not per-user (older hubs, the default scope).
 */
export function speechInheritance(settings: unknown): SpeechInheritance | undefined {
  const s = settings as Loose | undefined
  if (s?.scope !== "user") return undefined
  const defaults: Loose = s.default ?? {}
  const own: Loose | undefined = s.user && typeof s.user === "object" ? s.user : undefined
  const out: Loose = { own: { stt: 0, tts: 0 } }
  for (const kind of ["stt", "tts"] as const) {
    const effective: Loose = s[kind] ?? {}
    const fallback: Loose = defaults[kind] ?? {}
    const mine: Loose = own?.[kind] ?? {}
    const section: Record<string, FieldInheritance> = {}
    for (const field of SPEECH_FIELDS[kind]) {
      const inherited = own ? mine[field] === undefined || mine[field] === null : str(effective[field]) === str(fallback[field])
      const value = str(fallback[field])
      section[field] = inherited ? { inherited, note: value ? `Using server default: ${value}` : "Server default: not set" } : { inherited }
      if (!inherited) out.own[kind]++
    }
    const ownKey = own ? !!mine.apiKey?.set : effective.apiKey?.source === "user"
    section.apiKey = ownKey
      ? { inherited: false }
      : { inherited: true, note: fallback.apiKey?.set === false ? "Key: server default (none set)" : "Key: server default" }
    if (ownKey) out.own[kind]++
    out[kind] = section
  }
  return out as SpeechInheritance
}

/** PUT body that drops every own value of one section (the server default applies again). */
export function resetPatch(kind: SpeechKind): Record<string, Record<string, null>> {
  return { [kind]: Object.fromEntries([...SPEECH_FIELDS[kind], "apiKey"].map((f) => [f, null])) }
}

// ---------- audit ----------

export function auditLabel(action: string): string {
  const a = str(action)
  if (!a) return "Unknown action"
  if (AUDIT_ACTIONS[a]) return AUDIT_ACTIONS[a]
  const words = a.replace(/[._-]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Audit entries newest first, actor and user targets shown by email (or name). */
export function auditRows(
  entries: readonly AuditEntry[],
  users: ReadonlyArray<{ id: string; email?: string; name?: string }> = [],
): AuditRow[] {
  const who = new Map(users.map((u) => [u.id, str(u.email) || str(u.name) || u.id]))
  const person = (id: string) => (id === "system" ? "System" : (who.get(id) ?? id))
  return [...(entries ?? [])]
    .sort((a, b) => b.at - a.at)
    .map((e) => ({
      at: e.at,
      actor: person(e.actor),
      action: auditLabel(e.action),
      target: e.target === undefined ? undefined : (who.get(e.target) ?? e.target),
      detail: e.detail,
    }))
}

// ---------- users ----------

const userKey = (u: AdminUser) => (str(u.email) || str(u.name) || u.id).toLowerCase()

/** The admin users table: filtered by text (email/name) and status, sorted. */
export function usersView(
  users: readonly AdminUser[],
  { query = "", filter = "all", sort = "role" }: { query?: string; filter?: UserFilter; sort?: UserSort } = {},
): AdminUser[] {
  const q = str(query).toLowerCase()
  const keep = (u: AdminUser) =>
    (!q || `${str(u.email)} ${str(u.name)}`.toLowerCase().includes(q)) &&
    (filter === "admins" ? u.role === "admin" : filter === "disabled" ? !!u.disabled : filter === "active" ? !u.disabled : true)
  const byKey = (a: AdminUser, b: AdminUser) => userKey(a).localeCompare(userKey(b))
  const compare =
    sort === "lastSeen"
      ? (a: AdminUser, b: AdminUser) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || byKey(a, b)
      : sort === "email"
        ? byKey
        : (a: AdminUser, b: AdminUser) =>
            Number(!!a.disabled) - Number(!!b.disabled) || Number(b.role === "admin") - Number(a.role === "admin") || byKey(a, b)
  return (users ?? []).filter(keep).sort(compare)
}

/**
 * Role and enable/disable actions for one user, with confirm texts. `lastAdmin` marks a change the server will
 * refuse (the last active admin); the UI still asks the server and shows its error.
 */
export function userActions(user: AdminUser, users: readonly AdminUser[], meID: string | undefined): UserAction[] {
  const label = str(user.email) || str(user.name) || user.id
  const self = user.id === meID
  const activeAdmins = (users ?? []).filter((u) => u.role === "admin" && !u.disabled).length
  const last = user.role === "admin" && !user.disabled && activeAdmins <= 1
  const role: UserAction =
    user.role === "admin"
      ? {
          label: "Remove admin",
          change: { role: "user" },
          danger: true,
          ...(last ? { lastAdmin: true as const } : {}),
          confirm: self ? "Remove your own admin role? You will lose access to the admin screens." : `Remove admin from ${label}?`,
        }
      : { label: "Make admin", change: { role: "admin" }, confirm: `Make ${label} an admin? Admins manage users, machines and the server speech default.` }
  const access: UserAction = user.disabled
    ? { label: "Enable", change: { disabled: false }, confirm: `Enable ${label}?` }
    : {
        label: "Disable",
        change: { disabled: true },
        danger: true,
        ...(last ? { lastAdmin: true as const } : {}),
        confirm: self
          ? "Disable your own account? This device is signed out."
          : `Disable ${label}? Their phones and machines are disconnected until you enable them again.`,
      }
  return [role, access]
}

/** The message for a failed admin action: the server's own words when it gave any. */
export function adminError(error: { status?: number; message?: string } | undefined): string {
  const message = str(error?.message)
  if (message && !/^HTTP \d+$/.test(message)) return message
  if (error?.status === 403) return "Only admins can do that."
  return `The server refused the change (HTTP ${error?.status ?? "?"}).`
}
