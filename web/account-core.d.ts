// Types for web/account-core.js (plain ES module used by the PWA without a build step).

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
export interface AuditRow {
  readonly at: number
  readonly actor: string
  readonly action: string
  readonly target?: string
  readonly detail?: string
}

export const USER_SORTS: ReadonlyArray<readonly [UserSort, string]>
export const USER_FILTERS: ReadonlyArray<readonly [UserFilter, string]>
export const AUDIT_ACTIONS: Readonly<Record<string, string>>

export function isAdmin(me: Me | undefined): boolean
export function account(me: Me | undefined): Account
export function menuItems(me: Me | undefined): MenuItem[]
export function speechTabs(me: Me | undefined, settings: { scope?: string } | undefined): Array<"user" | "default">
export function signInURL(auth: AuthInfo | undefined, next: string | undefined | null): string | undefined
export function speechInheritance(settings: unknown): SpeechInheritance | undefined
export function resetPatch(kind: SpeechKind): Record<string, Record<string, null>>
export function auditLabel(action: string): string
export function auditRows(entries: readonly AuditEntry[], users?: ReadonlyArray<{ id: string; email?: string; name?: string }>): AuditRow[]
export function usersView(users: readonly AdminUser[], opts?: { query?: string; filter?: UserFilter; sort?: UserSort }): AdminUser[]
export function userActions(user: AdminUser, users: readonly AdminUser[], meID: string | undefined): UserAction[]
export function adminError(error: { status?: number; message?: string }): string
export function approveOwner(me: Me | undefined): string
