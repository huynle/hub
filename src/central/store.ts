// Persisted central server state: enrolled machines, paired devices, web push keys and subscriptions,
// speech settings. Only sha256 hashes of tokens are stored; speech provider API keys are stored as given
// (they must be sent upstream) and never returned by the API. The file is private (dir 0700, file 0600)
// and written atomically.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type AgentData, mergeAgentData, normaliseAgentData, validEpoch } from "./agent-data"
import type { StoredSpeech } from "./speech/settings"
import { pushKey, SharedRows, StoreTx, type SharedStoreOptions } from "./store-shared"
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
  /** Agent control plane data (names, roles, sessions, app tokens); see agent-data.ts. */
  agent?: AgentData
  /** Bumped to invalidate every session token minted for this user (absent = 0). */
  tokenEpoch?: number
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
  /** Bumped to invalidate every session token minted for this machine (absent = 0). */
  tokenEpoch?: number
}

/**
 * Which notifications a device wants: one toggle per kind (see docs/notifications.md for what triggers each).
 */
export interface PushPrefs {
  /** A session sent to the phone from the terminal. */
  handoff: boolean
  /** A session asks a question (form). */
  question: boolean
  /** A session waits for a permission. */
  permission: boolean
  /** All done: a root session and its whole tree settled (nothing runs or waits), once per run. */
  done: boolean
  /** A root session's run failed (provider or tool error; not a user stop). */
  failed: boolean
  /** Every root turn finished (0.7's "finished": noisy with background subagents). */
  turn: boolean
  /** A root run stopped without the user asking (shutdown, inactivity). */
  stopped: boolean
  /** The provider is retrying a root session's request (once per retry streak). */
  retry: boolean
  /** A subagent session finished. */
  subagentDone: boolean
  /** A subagent session failed. */
  subagentFailed: boolean
  /** A shell job or terminal exited 0. */
  jobDone: boolean
  /** A shell job or terminal exited non-zero, was killed or timed out. */
  jobFailed: boolean
  /** A tool call that ran at least 30 s ended (subagent calls excluded). */
  longTool: boolean
  /** Conversation mode replies while no device is watching the session. */
  say: boolean
  /** Activity updates: a collapsing digest per session (subagents, long tools, jobs ending, idle), at most one per interval. */
  activity: boolean
  /** A session (or app) asks you to decide something (`hub ask @me`): a Decision waits for your answer. */
  decision: boolean
  /** Agent messaging needs you: a message to @me, an ask left unanswered after every re-wake, or a message loop. */
  message: boolean
}

export const PUSH_PREF_KEYS = [
  "handoff",
  "question",
  "permission",
  "done",
  "failed",
  "turn",
  "stopped",
  "retry",
  "subagentDone",
  "subagentFailed",
  "jobDone",
  "jobFailed",
  "longTool",
  "say",
  "activity",
  "decision",
  "message",
] as const satisfies readonly (keyof PushPrefs)[]

/** Defaults: anything that needs you, all done, failed, hand-offs and spoken replies; the finer kinds are opt-in. */
export const DEFAULT_PUSH_PREFS: Readonly<PushPrefs> = Object.freeze({
  handoff: true,
  question: true,
  permission: true,
  done: true,
  failed: true,
  turn: false,
  stopped: false,
  retry: false,
  subagentDone: false,
  subagentFailed: false,
  jobDone: false,
  jobFailed: false,
  longTool: false,
  say: true,
  // Opt-in per device (Settings → Notifications → Activity updates).
  activity: false,
  decision: true,
  message: true,
})

/** Default and allowed range of a device's activity update interval, in minutes. */
export const ACTIVITY_INTERVAL_MINUTES = 5
export const ACTIVITY_INTERVAL_MIN = 1
export const ACTIVITY_INTERVAL_MAX = 60

/**
 * Older prefs: 0.5.0's one toggle for questions and permissions (`blocked`), and up to 0.7 `finished` (every root
 * turn, which fired while background subagents still ran); it now means all done (`done`).
 */
export interface LegacyPushPrefs {
  blocked?: boolean
  finished?: boolean
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

/** Current prefs from a stored (possibly 0.5.0 or 0.7) record. */
function normalizePushPrefs(stored: (Partial<PushPrefs> & LegacyPushPrefs) | undefined): PushPrefs {
  const out: PushPrefs = { ...DEFAULT_PUSH_PREFS }
  if (!stored) return out
  if (typeof stored.blocked === "boolean") {
    out.question = stored.blocked
    out.permission = stored.blocked
    // 0.5.0's "finished" covered failed runs too.
    if (typeof stored.finished === "boolean" && typeof stored.failed !== "boolean") out.failed = stored.finished
  }
  if (typeof stored.finished === "boolean" && typeof stored.done !== "boolean") out.done = stored.finished
  for (const key of PUSH_PREF_KEYS) if (typeof stored[key] === "boolean") out[key] = stored[key]
  return out
}

/** True when stored prefs use a legacy key (rewritten on open). */
const legacyPushPrefs = (stored: object | undefined): boolean => !!stored && ("blocked" in stored || "finished" in stored)

export interface DeviceRecord {
  id: string
  name: string
  tokenHash: string
  created: number
  lastSeen: number
  pushPrefs?: Partial<PushPrefs> & LegacyPushPrefs
  quietHours?: QuietHours
  /** Minutes between two activity updates of one session (ACTIVITY_INTERVAL_MINUTES when absent). */
  activityMinutes?: number
  ownerID: string
  /** Public key a native app registered at link time (PEM or base64), for later strong approvals. */
  publicKey?: string
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
  /** The admin's hub-wide kill switch: every agent action is paused for every user (reading and messaging still work). */
  agentsActingPaused?: true
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

/** Shared persistence (cluster mode): see ./store-shared. */
export { HUB_ROWS, STORE_CACHE_TTL_MS, STORE_CHANGED_TOPIC, StoreConflictError, type SharedStoreOptions } from "./store-shared"

/** Records whose rows a security re-check reads again (Store.recheck). */
export interface RecheckRefs {
  readonly users?: readonly (string | undefined)[]
  readonly machines?: readonly (string | undefined)[]
  readonly devices?: readonly (string | undefined)[]
}

/**
 * The hub's records. Reads are synchronous (from memory); mutations are async. Two persistences:
 * - file (Store.open): state.json, written synchronously inside every mutation (a mutation's change is applied
 *   and saved before its promise is returned), for the single-process hub;
 * - shared (Store.shared): rows in a StateStore with a per-pod cache, for cluster mode (see ./store-shared).
 *   Token lookups and recheck() go to the database, so a revocation on another pod applies at once.
 */
export class Store {
  private constructor(
    private readonly file: string | undefined,
    private state: StateData,
    private readonly now: () => number,
    private readonly shared?: SharedRows,
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
          ...(raw.agentsActingPaused === true ? { agentsActingPaused: true as const } : {}),
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

  /**
   * A Store on shared backends (cluster mode). Nothing is read until ready() (mutations and async lookups call
   * it; the hub awaits it before serving). No data migration runs here: the schema and imports are
   * `hub-server migrate` / `import`'s job.
   */
  static shared(options: SharedStoreOptions): Store {
    let store: Store | undefined = undefined
    const rows = new SharedRows(options, {
      get: () => store!.state,
      set: (state) => {
        store!.state = state
      },
    })
    store = new Store(undefined, SharedRows.emptyState(), options.now ?? Date.now, rows)
    return store
  }

  /** Resolves once the records are loaded (at once for the file Store). */
  ready(): Promise<void> {
    return this.shared ? this.shared.ready() : Promise.resolve()
  }

  /** Stops listening for other pods' changes (shared); nothing to do for the file Store. */
  async close(): Promise<void> {
    await this.shared?.close()
  }

  /**
   * Reads these records again from the database (shared Store; a no-op for the file Store), so the synchronous
   * reads after it (revoked, epochs, disabled, owner) see other pods' latest writes.
   */
  async recheck(refs: RecheckRefs): Promise<void> {
    const shared = this.shared
    if (!shared) return
    await shared.ready()
    const all: Promise<void>[] = []
    for (const collection of ["users", "machines", "devices"] as const) {
      for (const key of new Set(refs[collection] ?? [])) if (key) all.push(shared.refresh({ collection, key }))
    }
    await Promise.all(all)
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

  addMachine(name: string, ownerID: string = LOCAL_USER): Promise<{ machine: MachineRecord; token: string }> {
    const token = newToken()
    const t = this.now()
    const machine: MachineRecord = { id: newID("mch"), name, tokenHash: hashToken(token), created: t, lastSeen: t, ownerID }
    return this.mutate((tx) => {
      if (!this.state.machines.some((m) => m.id === machine.id)) this.state.machines.push(machine)
      tx.touch("machines", machine.id)
      tx.touch("machine-tokens", machine.tokenHash)
      return { machine, token }
    })
  }

  /** Non-revoked machine for a bearer token (the shared Store re-reads it from the database). */
  async findMachine(token: string): Promise<MachineRecord | undefined> {
    if (this.shared && token) await this.recheckToken("machine", token)
    return this.cachedMachine(token)
  }

  /** findMachine from memory only (the file Store; or a shared Store's cache, possibly stale). */
  cachedMachine(token: string): MachineRecord | undefined {
    return findByToken(
      this.state.machines.filter((machine) => !machine.revoked),
      token,
    )
  }

  revokeMachine(id: string): Promise<boolean> {
    return this.mutate((tx) => {
      const machine = this.state.machines.find((m) => m.id === id)
      if (!machine || machine.revoked) return false
      machine.revoked = true
      tx.touch("machines", id)
      return true
    })
  }

  /** Records that the machine was seen (persisted at most once a minute; never rejects). */
  touchMachine(id: string): Promise<void> {
    return this.touch("machines", id, () => this.state.machines.find((m) => m.id === id))
  }

  addDevice(name: string, ownerID: string = LOCAL_USER, extra: { publicKey?: string } = {}): Promise<{ device: DeviceRecord; token: string }> {
    const token = newToken()
    const t = this.now()
    const device: DeviceRecord = { id: newID("dev"), name, tokenHash: hashToken(token), created: t, lastSeen: t, ownerID }
    if (extra.publicKey) device.publicKey = extra.publicKey
    return this.mutate((tx) => {
      if (!this.state.devices.some((d) => d.id === device.id)) this.state.devices.push(device)
      tx.touch("devices", device.id)
      tx.touch("device-tokens", device.tokenHash)
      return { device, token }
    })
  }

  /** The device for a bearer token (the shared Store re-reads it from the database). */
  async findDevice(token: string): Promise<DeviceRecord | undefined> {
    if (this.shared && token) await this.recheckToken("device", token)
    return this.cachedDevice(token)
  }

  /** findDevice from memory only (the file Store; or a shared Store's cache, possibly stale). */
  cachedDevice(token: string): DeviceRecord | undefined {
    return findByToken(this.state.devices, token)
  }

  /** Re-reads the record of a token: found in the cache by hash, else through its token-hash index row. */
  private async recheckToken(kind: "machine" | "device", token: string): Promise<void> {
    const shared = this.shared!
    await shared.ready()
    const hash = hashToken(token)
    const records: readonly { id: string; tokenHash: string }[] = kind === "machine" ? this.state.machines : this.state.devices
    const id = findByToken(records, token)?.id ?? (await shared.indexed(kind === "machine" ? "machine-tokens" : "device-tokens", hash))
    if (id) await shared.refresh({ collection: kind === "machine" ? "machines" : "devices", key: id })
  }

  removeDevice(id: string): Promise<boolean> {
    return this.mutate((tx) => {
      const device = this.state.devices.find((d) => d.id === id)
      if (!device) return false
      this.state.devices = this.state.devices.filter((d) => d.id !== id)
      tx.touch("devices", id)
      tx.touch("device-tokens", device.tokenHash)
      for (const p of this.state.push) if (p.deviceID === id) tx.touch("push", pushKey(p.endpoint))
      this.state.push = this.state.push.filter((p) => p.deviceID !== id)
      return true
    })
  }

  // ---------- web push ----------

  vapid(): VapidKeys | undefined {
    return this.state.vapid
  }

  /**
   * Stores the hub's VAPID keys unless some are stored already (by another pod too: the first write wins), and
   * returns the stored pair.
   */
  setVapid(keys: VapidKeys): Promise<VapidKeys> {
    return this.mutate((tx) => {
      if (this.state.vapid) return this.state.vapid
      this.state.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey }
      tx.touch("settings", "vapid")
      return this.state.vapid
    })
  }

  pushSubscriptions(): readonly PushSubscriptionRecord[] {
    return this.state.push
  }

  /** Adds or replaces (by endpoint) a subscription; an endpoint belongs to one device. */
  addPushSubscription(deviceID: string, target: PushTarget): Promise<PushSubscriptionRecord> {
    const record: PushSubscriptionRecord = {
      deviceID,
      endpoint: target.endpoint,
      keys: { p256dh: target.keys.p256dh, auth: target.keys.auth },
      created: this.now(),
    }
    return this.mutate((tx) => {
      const index = this.state.push.findIndex((p) => p.endpoint === target.endpoint)
      if (index >= 0) this.state.push[index] = record
      else this.state.push.push(record)
      tx.touch("push", pushKey(record.endpoint))
      return record
    })
  }

  /** Removes a device's own subscription. */
  removePushSubscription(deviceID: string, endpoint: string): Promise<boolean> {
    return this.dropPush((p) => p.deviceID === deviceID && p.endpoint === endpoint)
  }

  /** Removes a subscription the push service reported as gone. */
  dropPushSubscription(endpoint: string): Promise<boolean> {
    return this.dropPush((p) => p.endpoint === endpoint)
  }

  pushPrefs(deviceID: string): PushPrefs {
    const device = this.state.devices.find((d) => d.id === deviceID)
    return normalizePushPrefs(device?.pushPrefs)
  }

  /** Applies the boolean toggles given; a legacy `blocked` sets question and permission, a legacy `finished` all done. */
  setPushPrefs(deviceID: string, prefs: Partial<PushPrefs> & LegacyPushPrefs): Promise<PushPrefs> {
    return this.mutate((tx) => {
      const device = this.state.devices.find((d) => d.id === deviceID)
      if (!device) return { ...DEFAULT_PUSH_PREFS }
      const next = this.pushPrefs(deviceID)
      if (typeof prefs.blocked === "boolean") next.question = next.permission = prefs.blocked
      if (typeof prefs.finished === "boolean") next.done = prefs.finished
      for (const key of PUSH_PREF_KEYS) if (typeof prefs[key] === "boolean") next[key] = prefs[key]
      device.pushPrefs = next
      tx.touch("devices", deviceID)
      return { ...next }
    })
  }

  /** Minutes between two activity updates of one session on this device. */
  activityMinutes(deviceID: string): number {
    return this.state.devices.find((d) => d.id === deviceID)?.activityMinutes ?? ACTIVITY_INTERVAL_MINUTES
  }

  /** Sets a device's activity update interval (clamped to 1–60 whole minutes). */
  setActivityMinutes(deviceID: string, minutes: number): Promise<number> {
    return this.mutate((tx) => {
      const device = this.state.devices.find((d) => d.id === deviceID)
      if (!device) return ACTIVITY_INTERVAL_MINUTES
      device.activityMinutes = Math.min(ACTIVITY_INTERVAL_MAX, Math.max(ACTIVITY_INTERVAL_MIN, Math.round(minutes)))
      tx.touch("devices", deviceID)
      return device.activityMinutes
    })
  }

  quietHours(deviceID: string): QuietHours | undefined {
    const quiet = this.state.devices.find((d) => d.id === deviceID)?.quietHours
    return quiet ? { ...quiet } : undefined
  }

  /** Sets (validated by the caller) or clears (null) a device's quiet hours. */
  setQuietHours(deviceID: string, quiet: QuietHours | null): Promise<QuietHours | undefined> {
    return this.mutate((tx) => {
      const device = this.state.devices.find((d) => d.id === deviceID)
      if (!device) return undefined
      if (quiet) device.quietHours = { start: quiet.start, end: quiet.end, timeZone: quiet.timeZone }
      else delete device.quietHours
      tx.touch("devices", deviceID)
      return this.quietHours(deviceID)
    })
  }

  mutedSessions(userID: string): string[] {
    return [...(this.user(userID)?.mutedSessions ?? [])]
  }

  setSessionMuted(userID: string, sessionID: string, muted: boolean): Promise<string[]> {
    return this.mutate((tx) => {
      const user = this.user(userID)
      if (!user) return []
      const list = (user.mutedSessions ?? []).filter((id) => id !== sessionID)
      if (muted) list.push(sessionID)
      while (list.length > MUTED_SESSIONS_LIMIT) list.shift()
      user.mutedSessions = list
      tx.touch("users", userID)
      return [...list]
    })
  }

  private dropPush(match: (record: PushSubscriptionRecord) => boolean): Promise<boolean> {
    return this.mutate((tx) => {
      const gone = this.state.push.filter(match)
      if (!gone.length) return false
      this.state.push = this.state.push.filter((p) => !match(p))
      for (const p of gone) tx.touch("push", pushKey(p.endpoint))
      return true
    })
  }

  // ---------- speech settings ----------

  /** A copy of the stored speech settings (callers may not mutate the state). */
  speechSettings(): StoredSpeech {
    return structuredClone(this.state.speech ?? {})
  }

  setSpeechSettings(settings: StoredSpeech): Promise<void> {
    return this.mutate((tx) => {
      this.state.speech = structuredClone(settings)
      tx.touch("settings", "speech")
    })
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
  upsertUser(input: { email: string; name?: string; role: Role }): Promise<UserRecord> {
    const email = input.email.trim().toLowerCase()
    const id = newUserID()
    return this.mutate((tx) => {
      const t = this.now()
      let user = this.userByEmail(email)
      if (!user) {
        user = { id, email, ...(input.name ? { name: input.name } : {}), role: input.role, created: t, lastSeen: t }
        this.state.users.push(user)
        tx.touch("user-emails", email)
      } else {
        if (input.name) user.name = input.name
        if (input.role === "admin") user.role = "admin"
        user.lastSeen = t
      }
      tx.touch("users", user.id)
      return user
    })
  }

  setUser(id: string, change: { role?: Role; disabled?: boolean }): Promise<UserRecord | undefined> {
    return this.mutate((tx) => {
      const user = this.user(id)
      if (!user) return undefined
      if (change.role) user.role = change.role
      if (change.disabled === true) user.disabled = true
      else if (change.disabled === false) delete user.disabled
      tx.touch("users", id)
      return user
    })
  }

  /** Records that the user was seen (persisted at most once a minute; never rejects). */
  touchUser(id: string): Promise<void> {
    return this.touch("users", id, () => this.user(id))
  }

  /**
   * First admin sign-in in oidc mode: every record owned by "local" moves to the admin and "local" is
   * disabled. False (nothing changed) once done.
   */
  migrateLocal(adminID: string): Promise<boolean> {
    return this.mutate((tx) => {
      const local = this.user(LOCAL_USER)
      if (!local || local.disabled || adminID === LOCAL_USER) return false
      for (const machine of this.state.machines) {
        if (machine.ownerID !== LOCAL_USER) continue
        machine.ownerID = adminID
        machine.tokenEpoch = (machine.tokenEpoch ?? 0) + 1
        tx.touch("machines", machine.id)
      }
      for (const device of this.state.devices) {
        if (device.ownerID !== LOCAL_USER) continue
        device.ownerID = adminID
        tx.touch("devices", device.id)
      }
      const admin = this.user(adminID)
      if (local.agent && admin) {
        admin.agent = mergeAgentData(admin.agent ?? {}, local.agent)
        tx.touch("users", adminID)
      }
      delete local.agent
      local.tokenEpoch = (local.tokenEpoch ?? 0) + 1
      local.disabled = true
      tx.touch("users", LOCAL_USER)
      this.appendAudit(tx, { actor: "system", action: "migrate.local", target: adminID })
      return true
    })
  }

  // ---------- agent data and token epochs ----------

  /** A copy of the user's agent data ({} when none). */
  agentData(userID: string): AgentData {
    return structuredClone(this.user(userID)?.agent ?? {})
  }

  /**
   * Changes a user's agent data: `change` edits a copy in place or returns a replacement; the result is
   * normalised and saved only when it differs. Undefined for an unknown user. On a shared Store, `change` runs
   * again on fresh data when another pod changed the user meanwhile (so it may run more than once).
   */
  updateAgentData(userID: string, change: (data: AgentData) => AgentData | void): Promise<AgentData | undefined> {
    return this.mutate((tx) => {
      const user = this.user(userID)
      if (!user) return undefined
      const draft = this.agentData(userID)
      const next = normaliseAgentData(change(draft) ?? draft) ?? {}
      if (JSON.stringify(next) !== JSON.stringify(user.agent ?? {})) {
        if (Object.keys(next).length) user.agent = next
        else delete user.agent
        tx.touch("users", userID)
      }
      return this.agentData(userID)
    })
  }

  userEpoch(userID: string): number {
    return this.user(userID)?.tokenEpoch ?? 0
  }

  machineEpoch(machineID: string): number {
    return this.state.machines.find((m) => m.id === machineID)?.tokenEpoch ?? 0
  }

  /** Invalidates the user's session tokens; returns the new epoch (undefined for an unknown user). */
  bumpUserEpoch(userID: string): Promise<number | undefined> {
    return this.mutate((tx) => this.bumpEpoch(tx, "users", userID, this.user(userID)))
  }

  /** Invalidates the machine's session tokens; returns the new epoch (undefined for an unknown machine). */
  bumpMachineEpoch(machineID: string): Promise<number | undefined> {
    return this.mutate((tx) => this.bumpEpoch(tx, "machines", machineID, this.state.machines.find((m) => m.id === machineID)))
  }

  private bumpEpoch(tx: StoreTx, collection: "users" | "machines", id: string, record: { tokenEpoch?: number } | undefined): number | undefined {
    if (!record) return undefined
    record.tokenEpoch = (record.tokenEpoch ?? 0) + 1
    tx.touch(collection, id)
    return record.tokenEpoch
  }

  // ---------- hub-wide agent acting switch ----------

  /** True while the admin has paused agent actions hub-wide. */
  actingPaused(): boolean {
    return this.state.agentsActingPaused === true
  }

  /** Pauses or resumes agent actions hub-wide; true when that changed something (saved only then). */
  setActingPaused(paused: boolean): Promise<boolean> {
    return this.mutate((tx) => {
      if (paused === this.actingPaused()) return false
      if (paused) this.state.agentsActingPaused = true
      else delete this.state.agentsActingPaused
      tx.touch("settings", "agentsActingPaused")
      return true
    })
  }

  // ---------- audit ----------

  /** Appends an audit entry. Never pass tokens, codes, keys or session content. */
  audit(entry: Omit<AuditEntry, "at">): Promise<void> {
    return this.mutate((tx) => this.appendAudit(tx, entry))
  }

  private appendAudit(tx: StoreTx, entry: Omit<AuditEntry, "at">): void {
    const record: AuditEntry = { at: this.now(), ...entry }
    this.state.audit.push(record)
    if (this.shared) tx.touch("audit", this.shared.keyAudit(record))
    else tx.touch("audit", "")
    if (this.state.audit.length > AUDIT_LIMIT) {
      const dropped = this.state.audit.splice(0, this.state.audit.length - AUDIT_LIMIT)
      for (const old of dropped) {
        const key = this.shared?.auditKey(old)
        if (key) tx.touch("audit", key)
      }
    }
  }

  /** Newest first, at most AUDIT_VIEW_LIMIT. */
  auditLog(): AuditEntry[] {
    return this.state.audit.slice(-AUDIT_VIEW_LIMIT).reverse().map((entry) => ({ ...entry }))
  }

  // ---------- per-user speech ----------

  userSpeech(id: string): StoredSpeech {
    return structuredClone(this.user(id)?.speech ?? {})
  }

  setUserSpeech(id: string, settings: StoredSpeech): Promise<void> {
    return this.mutate((tx) => {
      const user = this.user(id)
      if (!user) return
      user.speech = structuredClone(settings)
      tx.touch("users", id)
    })
  }

  // ---------- per-user view preferences ----------

  viewPrefs(id: string): ViewPrefs {
    const stored = this.user(id)?.viewPrefs
    const out = {} as ViewPrefs
    for (const key of VIEW_PREF_KEYS) out[key] = Array.isArray(stored?.[key]) ? [...stored[key]] : []
    return out
  }

  /** Replaces the lists given (callers validate); returns the result. */
  setViewPrefs(id: string, change: Partial<ViewPrefs>): Promise<ViewPrefs> {
    return this.mutate((tx) => {
      const user = this.user(id)
      if (!user) return this.viewPrefs(id)
      const next = this.viewPrefs(id)
      for (const key of VIEW_PREF_KEYS) if (change[key]) next[key] = [...change[key]]
      user.viewPrefs = next
      tx.touch("users", id)
      return this.viewPrefs(id)
    })
  }

  // ---------- per-user, per-session model preferences ----------

  modelPrefs(id: string, sessionID: string): SessionModelPrefs {
    const prefs = this.user(id)?.modelPrefs?.[sessionID]
    return prefs ? structuredClone(prefs) : {}
  }

  setModelPrefs(id: string, sessionID: string, change: { voice?: ModelSelection | null; worker?: ModelSelection | null }): Promise<SessionModelPrefs> {
    return this.mutate((tx) => {
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
      tx.touch("users", id)
      return this.modelPrefs(id, sessionID)
    })
  }

  // ---------- per-user read marks (unread dots) ----------

  reads(id: string): Record<string, number> {
    return { ...this.user(id)?.reads }
  }

  /** Marks a session read at `at`; a mark never moves back. Returns all marks. */
  markRead(id: string, sessionID: string, at: number): Promise<Record<string, number>> {
    return this.mutate((tx) => {
      const user = this.user(id)
      if (!user) return {}
      const all = user.reads ?? (user.reads = {})
      const next = Math.max(all[sessionID] ?? 0, at)
      delete all[sessionID]
      all[sessionID] = next
      while (Object.keys(all).length > READS_LIMIT) delete all[Object.keys(all)[0]!]
      tx.touch("users", id)
      return this.reads(id)
    })
  }

  /** Records that the device was seen (persisted at most once a minute; never rejects). */
  touchDevice(id: string): Promise<void> {
    return this.touch("devices", id, () => this.state.devices.find((d) => d.id === id))
  }

  private touch(collection: "users" | "machines" | "devices", id: string, find: () => { lastSeen: number } | undefined): Promise<void> {
    return this.mutate((tx) => {
      const record = find()
      if (!record) return
      const t = this.now()
      if (t - record.lastSeen < TOUCH_PERSIST_MS) return
      record.lastSeen = t
      tx.touch(collection, id)
    }).catch((cause: unknown) => console.warn(`[hub] lastSeen not saved: ${(cause as Error)?.message ?? cause}`))
  }

  /**
   * Runs a change. File Store: the change and its save happen synchronously, before the promise is returned (a
   * failed save rejects it). Shared Store: see SharedRows.mutate.
   */
  private mutate<T>(fn: (tx: StoreTx) => T): Promise<T> {
    if (this.shared) return this.shared.mutate(fn)
    try {
      const tx = new StoreTx()
      const result = fn(tx)
      if (tx.dirty) this.save()
      return Promise.resolve(result)
    } catch (cause) {
      return Promise.reject(cause)
    }
  }

  private save(): void {
    const file = this.file!
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  }
}

/**
 * Idempotent upgrade of older states: the local user exists, every machine and device has an owner, agent data
 * and token epochs are valid.
 */
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
  // Agent data and token epochs are optional: invalid values are normalised or dropped (epochs read as 0).
  for (const user of state.users) {
    if ("agent" in user) {
      const agent = normaliseAgentData(user.agent)
      if (agent) user.agent = agent
      else delete user.agent
    }
  }
  for (const record of [...state.users, ...state.machines]) {
    if ("tokenEpoch" in record && !validEpoch(record.tokenEpoch)) delete record.tokenEpoch
  }
  // 0.5.0 ({handoff, blocked, finished, say}) and 0.7 (finished = every turn) push prefs → the current toggles.
  for (const device of state.devices) {
    if (legacyPushPrefs(device.pushPrefs)) device.pushPrefs = normalizePushPrefs(device.pushPrefs)
  }
}
