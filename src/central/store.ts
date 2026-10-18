// Persisted central server state: enrolled machines, paired devices, web push keys and subscriptions,
// speech settings. Only sha256 hashes of tokens are stored; speech provider API keys are stored as given
// (they must be sent upstream) and never returned by the API. The file is private (dir 0700, file 0600)
// and written atomically.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { StoredSpeech } from "./speech/settings"
import type { ModelSelection, SessionModelPrefs } from "../protocol"

/** Owner of everything in pairing mode, and of records from before 0.3.0. */
export const LOCAL_USER = "local"
/** Audit entries kept (oldest dropped first). */
export const AUDIT_LIMIT = 500
/** Audit entries returned by auditLog(). */
export const AUDIT_VIEW_LIMIT = 200
/** Per-user sessions with explicit Voice/Worker model choices. */
export const MODEL_PREFS_LIMIT = 500
/** Most sessions with a read mark kept per user (oldest marks dropped first). */
export const READS_LIMIT = 1000

export type Role = "admin" | "user"

export interface UserRecord {
  /** "local" for the pairing-mode owner; random base64url otherwise. */
  id: string
  /** Lowercased; absent for "local". */
  email?: string
  name?: string
  role: Role
  created: number
  lastSeen: number
  disabled?: boolean
  /** Per-user speech settings (same shape as the server default in StateData.speech). */
  speech?: StoredSpeech
  /** The phone's session view: hidden and pinned sessions and workspaces (synced across devices). */
  viewPrefs?: ViewPrefs
  /** Session ID → per-session Voice and complex-worker model overrides, oldest first. */
  modelPrefs?: Record<string, SessionModelPrefs>
  /** Session ID → when the user last read it (ms), least recently marked first. */
  reads?: Record<string, number>
  /** Sessions whose notifications the user muted, oldest first. */
  mutedSessions?: string[]
}

/** Workspace keys are the phone's group keys: `herdr:<workspaceID>` or a folder path. */
export interface ViewPrefs {
  hiddenSessions: string[]
  hiddenWorkspaces: string[]
  pinnedSessions: string[]
  pinnedWorkspaces: string[]
}

export const VIEW_PREF_KEYS = ["hiddenSessions", "hiddenWorkspaces", "pinnedSessions", "pinnedWorkspaces"] as const

export interface AuditEntry {
  at: number
  /** User ID or "system". */
  actor: string
  action: string
  target?: string
  detail?: string
}

export interface MachineRecord {
  id: string
  name: string
  tokenHash: string
  created: number
  lastSeen: number
  revoked?: boolean
  ownerID: string
}

/** Which notifications a device wants. */
export interface PushPrefs {
  /** A session sent to the phone from the terminal. */
  handoff: boolean
  /** A session asks a question (form). */
  question: boolean
  /** A session waits for a permission. */
  permission: boolean
  /** A root session's run succeeded. */
  finished: boolean
  /** A root session's run failed. */
  failed: boolean
  /** Conversation mode replies while no device is watching the session. */
  say: boolean
}

export const PUSH_PREF_KEYS = ["handoff", "question", "permission", "finished", "failed", "say"] as const satisfies readonly (keyof PushPrefs)[]

/** Defaults as in 0.5.0: hand-offs and anything blocking on, finished (which covered failures) off. */
export const DEFAULT_PUSH_PREFS: Readonly<PushPrefs> = Object.freeze({
  handoff: true,
  question: true,
  permission: true,
  finished: false,
  failed: false,
  say: true,
})

/** 0.5.0's prefs: one toggle for questions and permissions, one for every finished run. */
export interface LegacyPushPrefs {
  blocked?: boolean
}

/** A device's quiet hours: local "HH:MM" times in an IANA time zone; start > end spans midnight. */
export interface QuietHours {
  start: string
  end: string
  timeZone: string
}

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** A valid IANA time zone name for Intl. */
export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** Quiet hours from untrusted input, or undefined when invalid. */
export function quietHoursInput(value: unknown): QuietHours | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { start, end, timeZone } = value as Record<string, unknown>
  if (typeof start !== "string" || typeof end !== "string" || !CLOCK_TIME.test(start) || !CLOCK_TIME.test(end)) return undefined
  if (!validTimeZone(timeZone)) return undefined
  return { start, end, timeZone }
}

/** Most sessions a user can mute (oldest are forgotten first). */
export const MUTED_SESSIONS_LIMIT = 500

/** Current prefs from a stored (possibly 0.5.0) record. */
function normalizePushPrefs(stored: (Partial<PushPrefs> & LegacyPushPrefs) | undefined): PushPrefs {
  const out: PushPrefs = { ...DEFAULT_PUSH_PREFS }
  if (!stored) return out
  if (typeof stored.blocked === "boolean") {
    out.question = stored.blocked
    out.permission = stored.blocked
    // 0.5.0's "finished" covered failed runs too.
    if (typeof stored.finished === "boolean" && typeof stored.failed !== "boolean") out.failed = stored.finished
  }
  for (const key of PUSH_PREF_KEYS) if (typeof stored[key] === "boolean") out[key] = stored[key]
  return out
}

export interface DeviceRecord {
  id: string
  name: string
  tokenHash: string
  created: number
  lastSeen: number
  pushPrefs?: Partial<PushPrefs> & LegacyPushPrefs
  quietHours?: QuietHours
  ownerID: string
}

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

export interface PushTarget {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushSubscriptionRecord {
  deviceID: string
  endpoint: string
  keys: { p256dh: string; auth: string }
  created: number
}

export interface StateData {
  machines: MachineRecord[]
  devices: DeviceRecord[]
  vapid?: VapidKeys
  push: PushSubscriptionRecord[]
  /** Server default speech settings (below each user's own, above hub.json and the env). */
  speech?: StoredSpeech
  users: UserRecord[]
  /** Newest last, at most AUDIT_LIMIT. */
  audit: AuditEntry[]
}

export interface StoreOptions {
  /** pairing: the local user is (re-)enabled as admin on open. */
  readonly mode?: "pairing" | "oidc"
  /** chmod of the state directory (injected in tests). */
  readonly chmodDir?: (dir: string, mode: number) => void
  /** Whether the process can write into the state directory (injected in tests). */
  readonly writable?: (dir: string) => boolean
  /** One-line warnings (default console.warn). */
  readonly warn?: (message: string) => void
}

const canWrite = (dir: string): boolean => {
  try {
    accessSync(dir, fsConstants.W_OK | fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Creates the state directory and restricts it to the owner. A volume mount root owned by another user
 * (a fresh Kubernetes PVC: root-owned, group-writable through fsGroup) cannot be chmod-ed by the hub;
 * that is only a warning while the directory is writable, since every file in it is written 0600.
 */
function prepareStateDir(dir: string, options: StoreOptions): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    ;(options.chmodDir ?? chmodSync)(dir, 0o700)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code
    if ((code !== "EPERM" && code !== "EACCES") || !(options.writable ?? canWrite)(dir)) throw cause
    ;(options.warn ?? console.warn)(
      `[hub] cannot restrict ${dir} to mode 0700 (${code}; not its owner); continuing, state files are written 0600`,
    )
  }
}

/** Writes of lastSeen alone are throttled to this interval. */
const TOUCH_PERSIST_MS = 60_000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export const newToken = (): string => randomBytes(32).toString("base64url")
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")
export const newID = (prefix: string): string => `${prefix}_${randomBytes(9).toString("base64url")}`
const newUserID = (): string => randomBytes(12).toString("base64url")

/** Constant-time comparison of two hex digests. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex")
  const y = Buffer.from(b, "hex")
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

function findByToken<T extends { tokenHash: string }>(records: readonly T[], token: string): T | undefined {
  if (!token) return undefined
  const hash = hashToken(token)
  let found: T | undefined
  // Compare against every record so timing does not reveal the position of a match.
  for (const record of records) if (sameHash(record.tokenHash, hash)) found = record
  return found
}

export class Store {
  private constructor(
    private readonly file: string,
    private readonly state: StateData,
    private readonly now: () => number,
  ) {}

  static open(dir: string, now: () => number = Date.now, options: StoreOptions = {}): Store {
    prepareStateDir(dir, options)
    const file = path.join(dir, "state.json")
    let state: StateData = { machines: [], devices: [], push: [], users: [], audit: [] }
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StateData>
        state = {
          machines: Array.isArray(raw.machines) ? raw.machines : [],
          devices: Array.isArray(raw.devices) ? raw.devices : [],
          ...(raw.vapid ? { vapid: raw.vapid } : {}),
          push: Array.isArray(raw.push) ? raw.push : [],
          ...(isRecord(raw.speech) ? { speech: raw.speech } : {}),
          users: Array.isArray(raw.users) ? raw.users : [],
          audit: Array.isArray(raw.audit) ? raw.audit : [],
        }
      } catch (cause) {
        throw new Error(`Cannot read ${file}: ${cause instanceof Error ? cause.message : cause}. Fix or move it away.`)
      }
    }
    migrate(state, now(), options)
    const store = new Store(file, state, now)
    store.save()
    return store
  }

  data(): Readonly<StateData> {
    return this.state
  }

  machines(): readonly MachineRecord[] {
    return this.state.machines
  }

  devices(): readonly DeviceRecord[] {
    return this.state.devices
  }

  addMachine(name: string, ownerID: string = LOCAL_USER): { machine: MachineRecord; token: string } {
    const token = newToken()
    const t = this.now()
    const machine: MachineRecord = { id: newID("mch"), name, tokenHash: hashToken(token), created: t, lastSeen: t, ownerID }
    this.state.machines.push(machine)
    this.save()
    return { machine, token }
  }

  /** Non-revoked machine for a bearer token. */
  findMachine(token: string): MachineRecord | undefined {
    return findByToken(
      this.state.machines.filter((machine) => !machine.revoked),
      token,
    )
  }

  revokeMachine(id: string): boolean {
    const machine = this.state.machines.find((m) => m.id === id)
    if (!machine || machine.revoked) return false
    machine.revoked = true
    this.save()
    return true
  }

  touchMachine(id: string): void {
    this.touch(this.state.machines.find((m) => m.id === id))
  }

  addDevice(name: string, ownerID: string = LOCAL_USER): { device: DeviceRecord; token: string } {
    const token = newToken()
    const t = this.now()
    const device: DeviceRecord = { id: newID("dev"), name, tokenHash: hashToken(token), created: t, lastSeen: t, ownerID }
    this.state.devices.push(device)
    this.save()
    return { device, token }
  }

  findDevice(token: string): DeviceRecord | undefined {
    return findByToken(this.state.devices, token)
  }

  removeDevice(id: string): boolean {
    const before = this.state.devices.length
    this.state.devices = this.state.devices.filter((d) => d.id !== id)
    if (this.state.devices.length === before) return false
    this.state.push = this.state.push.filter((p) => p.deviceID !== id)
    this.save()
    return true
  }

  // ---------- web push ----------

  vapid(): VapidKeys | undefined {
    return this.state.vapid
  }

  setVapid(keys: VapidKeys): void {
    this.state.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey }
    this.save()
  }

  pushSubscriptions(): readonly PushSubscriptionRecord[] {
    return this.state.push
  }

  /** Adds or replaces (by endpoint) a subscription; an endpoint belongs to one device. */
  addPushSubscription(deviceID: string, target: PushTarget): PushSubscriptionRecord {
    const record: PushSubscriptionRecord = {
      deviceID,
      endpoint: target.endpoint,
      keys: { p256dh: target.keys.p256dh, auth: target.keys.auth },
      created: this.now(),
    }
    const index = this.state.push.findIndex((p) => p.endpoint === target.endpoint)
    if (index >= 0) this.state.push[index] = record
    else this.state.push.push(record)
    this.save()
    return record
  }

  /** Removes a device's own subscription. */
  removePushSubscription(deviceID: string, endpoint: string): boolean {
    return this.dropPush((p) => p.deviceID === deviceID && p.endpoint === endpoint)
  }

  /** Removes a subscription the push service reported as gone. */
  dropPushSubscription(endpoint: string): boolean {
    return this.dropPush((p) => p.endpoint === endpoint)
  }

  pushPrefs(deviceID: string): PushPrefs {
    const device = this.state.devices.find((d) => d.id === deviceID)
    return normalizePushPrefs(device?.pushPrefs)
  }

  /** Applies the boolean toggles given; a legacy `blocked` sets question and permission. */
  setPushPrefs(deviceID: string, prefs: Partial<PushPrefs> & LegacyPushPrefs): PushPrefs {
    const device = this.state.devices.find((d) => d.id === deviceID)
    if (!device) return { ...DEFAULT_PUSH_PREFS }
    const next = this.pushPrefs(deviceID)
    if (typeof prefs.blocked === "boolean") next.question = next.permission = prefs.blocked
    for (const key of PUSH_PREF_KEYS) if (typeof prefs[key] === "boolean") next[key] = prefs[key]
    device.pushPrefs = next
    this.save()
    return { ...next }
  }

  quietHours(deviceID: string): QuietHours | undefined {
    const quiet = this.state.devices.find((d) => d.id === deviceID)?.quietHours
    return quiet ? { ...quiet } : undefined
  }

  /** Sets (validated by the caller) or clears (null) a device's quiet hours. */
  setQuietHours(deviceID: string, quiet: QuietHours | null): QuietHours | undefined {
    const device = this.state.devices.find((d) => d.id === deviceID)
    if (!device) return undefined
    if (quiet) device.quietHours = { start: quiet.start, end: quiet.end, timeZone: quiet.timeZone }
    else delete device.quietHours
    this.save()
    return this.quietHours(deviceID)
  }

  mutedSessions(userID: string): string[] {
    return [...(this.user(userID)?.mutedSessions ?? [])]
  }

  setSessionMuted(userID: string, sessionID: string, muted: boolean): string[] {
    const user = this.user(userID)
    if (!user) return []
    const list = (user.mutedSessions ?? []).filter((id) => id !== sessionID)
    if (muted) list.push(sessionID)
    while (list.length > MUTED_SESSIONS_LIMIT) list.shift()
    user.mutedSessions = list
    this.save()
    return [...list]
  }

  private dropPush(match: (record: PushSubscriptionRecord) => boolean): boolean {
    const before = this.state.push.length
    this.state.push = this.state.push.filter((p) => !match(p))
    if (this.state.push.length === before) return false
    this.save()
    return true
  }

  // ---------- speech settings ----------

  /** A copy of the stored speech settings (callers may not mutate the state). */
  speechSettings(): StoredSpeech {
    return structuredClone(this.state.speech ?? {})
  }

  setSpeechSettings(settings: StoredSpeech): void {
    this.state.speech = structuredClone(settings)
    this.save()
  }

  // ---------- users ----------

  users(): readonly UserRecord[] {
    return this.state.users
  }

  user(id: string): UserRecord | undefined {
    return this.state.users.find((u) => u.id === id)
  }

  userByEmail(email: string): UserRecord | undefined {
    const wanted = email.trim().toLowerCase()
    return this.state.users.find((u) => u.email === wanted)
  }

  /**
   * Creates the user for a (verified, lowercased) email, or updates its name and lastSeen. Role
   * "admin" promotes an existing user (admins come from the config); "user" never demotes.
   */
  upsertUser(input: { email: string; name?: string; role: Role }): UserRecord {
    const email = input.email.trim().toLowerCase()
    const t = this.now()
    let user = this.userByEmail(email)
    if (!user) {
      user = { id: newUserID(), email, ...(input.name ? { name: input.name } : {}), role: input.role, created: t, lastSeen: t }
      this.state.users.push(user)
    } else {
      if (input.name) user.name = input.name
      if (input.role === "admin") user.role = "admin"
      user.lastSeen = t
    }
    this.save()
    return user
  }

  setUser(id: string, change: { role?: Role; disabled?: boolean }): UserRecord | undefined {
    const user = this.user(id)
    if (!user) return undefined
    if (change.role) user.role = change.role
    if (change.disabled === true) user.disabled = true
    else if (change.disabled === false) delete user.disabled
    this.save()
    return user
  }

  touchUser(id: string): void {
    this.touch(this.user(id))
  }

  /**
   * First admin sign-in in oidc mode: every record owned by "local" moves to the admin and "local" is
   * disabled. False (nothing changed) once done.
   */
  migrateLocal(adminID: string): boolean {
    const local = this.user(LOCAL_USER)
    if (!local || local.disabled || adminID === LOCAL_USER) return false
    for (const record of [...this.state.machines, ...this.state.devices]) if (record.ownerID === LOCAL_USER) record.ownerID = adminID
    local.disabled = true
    this.audit({ actor: "system", action: "migrate.local", target: adminID })
    return true
  }

  // ---------- audit ----------

  /** Appends an audit entry. Never pass tokens, codes, keys or session content. */
  audit(entry: Omit<AuditEntry, "at">): void {
    this.state.audit.push({ at: this.now(), ...entry })
    if (this.state.audit.length > AUDIT_LIMIT) this.state.audit.splice(0, this.state.audit.length - AUDIT_LIMIT)
    this.save()
  }

  /** Newest first, at most AUDIT_VIEW_LIMIT. */
  auditLog(): AuditEntry[] {
    return this.state.audit.slice(-AUDIT_VIEW_LIMIT).reverse().map((entry) => ({ ...entry }))
  }

  // ---------- per-user speech ----------

  userSpeech(id: string): StoredSpeech {
    return structuredClone(this.user(id)?.speech ?? {})
  }

  setUserSpeech(id: string, settings: StoredSpeech): void {
    const user = this.user(id)
    if (!user) return
    user.speech = structuredClone(settings)
    this.save()
  }

  // ---------- per-user view preferences ----------

  viewPrefs(id: string): ViewPrefs {
    const stored = this.user(id)?.viewPrefs
    const out = {} as ViewPrefs
    for (const key of VIEW_PREF_KEYS) out[key] = Array.isArray(stored?.[key]) ? [...stored[key]] : []
    return out
  }

  /** Replaces the lists given (callers validate); returns the result. */
  setViewPrefs(id: string, change: Partial<ViewPrefs>): ViewPrefs {
    const user = this.user(id)
    if (!user) return this.viewPrefs(id)
    const next = this.viewPrefs(id)
    for (const key of VIEW_PREF_KEYS) if (change[key]) next[key] = [...change[key]]
    user.viewPrefs = next
    this.save()
    return this.viewPrefs(id)
  }

  // ---------- per-user, per-session model preferences ----------

  modelPrefs(id: string, sessionID: string): SessionModelPrefs {
    const prefs = this.user(id)?.modelPrefs?.[sessionID]
    return prefs ? structuredClone(prefs) : {}
  }

  setModelPrefs(id: string, sessionID: string, change: { voice?: ModelSelection | null; worker?: ModelSelection | null }): SessionModelPrefs {
    const user = this.user(id)
    if (!user) return {}
    const all = user.modelPrefs ?? (user.modelPrefs = {})
    const next: { voice?: ModelSelection; worker?: ModelSelection } = this.modelPrefs(id, sessionID)
    for (const key of ["voice", "worker"] as const) {
      if (!(key in change)) continue
      const value = change[key]
      if (value === null) delete next[key]
      else if (value !== undefined) next[key] = structuredClone(value)
    }
    delete all[sessionID]
    if (next.voice || next.worker) all[sessionID] = next
    while (Object.keys(all).length > MODEL_PREFS_LIMIT) delete all[Object.keys(all)[0]!]
    this.save()
    return this.modelPrefs(id, sessionID)
  }

  // ---------- per-user read marks (unread dots) ----------

  reads(id: string): Record<string, number> {
    return { ...this.user(id)?.reads }
  }

  /** Marks a session read at `at`; a mark never moves back. Returns all marks. */
  markRead(id: string, sessionID: string, at: number): Record<string, number> {
    const user = this.user(id)
    if (!user) return {}
    const all = user.reads ?? (user.reads = {})
    const next = Math.max(all[sessionID] ?? 0, at)
    delete all[sessionID]
    all[sessionID] = next
    while (Object.keys(all).length > READS_LIMIT) delete all[Object.keys(all)[0]!]
    this.save()
    return this.reads(id)
  }

  touchDevice(id: string): void {
    this.touch(this.state.devices.find((d) => d.id === id))
  }

  private touch(record: { lastSeen: number } | undefined): void {
    if (!record) return
    const t = this.now()
    if (t - record.lastSeen < TOUCH_PERSIST_MS) return
    record.lastSeen = t
    this.save()
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}

/** Idempotent upgrade of older states: the local user exists, every machine and device has an owner. */
function migrate(state: StateData, t: number, options: StoreOptions): void {
  let local = state.users.find((u) => u.id === LOCAL_USER)
  if (!local) {
    local = { id: LOCAL_USER, role: "admin", created: t, lastSeen: t }
    state.users.unshift(local)
  }
  if (options.mode === "pairing") {
    // Pairing mode has exactly one owner, and it must be able to sign in and manage the hub.
    local.role = "admin"
    delete local.disabled
  }
  for (const record of [...state.machines, ...state.devices]) {
    if (typeof record.ownerID !== "string" || !record.ownerID) record.ownerID = LOCAL_USER
  }
  // 0.5.0 push prefs ({handoff, blocked, finished, say}) → the split toggles.
  for (const device of state.devices) {
    if (device.pushPrefs && "blocked" in device.pushPrefs) device.pushPrefs = normalizePushPrefs(device.pushPrefs)
  }
}
