// Credentials issued by the central server:
// - machine enrollment (device-code flow): a spoke asks, the owner approves in the web UI, the spoke polls for its token
// - device pairing: short single-use numeric codes, shown in the /hub dialog or logged at startup
// - login links: long single-use codes opened from the terminal to sign a browser in
// - app link codes: long single-use codes (QR / hubapp:// deep link) a native app redeems for a device token
// Pending codes, enrollments and the limiters live in the Kv / Counters backends (process memory by default, so a
// restart invalidates them; Valkey in a cluster, so a code issued on one pod is redeemed on any). Codes are spent
// with GETDEL: exactly one redeem wins, on any pod.
import { randomBytes, randomInt } from "node:crypto"
import type { EnrollPoll, EnrollStart } from "../protocol"
import { MemoryCounters } from "./backend/memory-counters"
import { MemoryKv } from "./backend/memory-kv"
import type { Counters, Kv } from "./backend/types"
import { LOCAL_USER, newToken, type DeviceRecord, type Store } from "./store"

export class RateLimitError extends Error {
  constructor(message = "Too many attempts; try again in a minute") {
    super(message)
    this.name = "RateLimitError"
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationError"
  }
}

export const ENROLL_TTL_MS = 10 * 60_000
export const ENROLL_INTERVAL_MS = 2000
export const PAIR_TTL_MS = 5 * 60_000
export const LOGIN_TTL_MS = 2 * 60_000
export const LINK_TTL_MS = 5 * 60_000
/** Longest device public key accepted at link time (characters). */
export const MAX_PUBLIC_KEY = 4096

/** RFC 8628 base-20 alphabet: no vowels, no look-alike characters. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"

function userCode(): string {
  let out = ""
  for (let i = 0; i < 8; i++) out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/** Accepts "abcd-efgh", "ABCDEFGH", " abcd efgh ". */
function normalizeUserCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z]/g, "")
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

function name(value: unknown, what: string, fallback?: string): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""
  if (!text && fallback !== undefined) return fallback
  if (!text || text.length > 64) throw new ValidationError(`Invalid ${what}: 1-64 characters required`)
  return text
}

/** A device name from a client: control and format characters dropped, whitespace collapsed, ≤ 64 characters. */
function deviceLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().replace(/\s+/g, " ") : ""
  return text ? [...text].slice(0, 64).join("").trim() : fallback
}

const PEM = /^-----BEGIN PUBLIC KEY-----([\s\S]*)-----END PUBLIC KEY-----$/
const KEY_BODY = /^[A-Za-z0-9+/_-]{16,}={0,2}$/

/** An optional device public key: PEM ("PUBLIC KEY") or bare base64/base64url; undefined when absent. */
function publicKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > MAX_PUBLIC_KEY) throw new ValidationError("Invalid public key")
  const key = value.trim()
  const body = (PEM.exec(key)?.[1] ?? key).replace(/\s+/g, "")
  if (!KEY_BODY.test(body)) throw new ValidationError("Invalid public key")
  return key
}

interface Enrollment {
  readonly userCode: string
  readonly deviceCode: string
  readonly machineName: string
  readonly created: number
  readonly expiresAt: number
  readonly status: "pending" | "approved" | "denied"
  /** The approver: owner of the machine created on the next poll. */
  readonly ownerID?: string
}

/** A pending pairing code, login link or app link code and the user its device will belong to. */
interface Grant {
  readonly expiresAt: number
  readonly ownerID: string
}

export interface PendingEnrollment {
  readonly userCode: string
  readonly machineName: string
  readonly created: number
  readonly expiresAt: number
}

export interface AuthOptions {
  readonly store: Store
  readonly publicURL: string
  readonly now?: () => number
  /** oidc: no bootstrap pairing code (devices are created by sign-in or by a machine owner). */
  readonly mode?: "pairing" | "oidc"
  /** Pending codes and enrollments (default: in this process, on `now`). */
  readonly kv?: Kv
  /** The enrollment and pairing-failure limits (default: in this process, on `now`). */
  readonly counters?: Counters
}

/** Enrollments started per window (every pod together). */
const ENROLL_MAX = 5
const ENROLL_WINDOW_MS = 60_000
/** Failed pairing attempts per window before /api/pair refuses (every pod together). */
const PAIR_FAILURES_MAX = 10
const PAIR_FAILURES_WINDOW_MS = 60_000
/**
 * Enrollment slots the pending list reads back: more than the rate limit lets live at once (a fixed window admits
 * up to twice its limit across a window boundary).
 */
const ENROLL_SLOTS = 2 * ENROLL_MAX * (ENROLL_TTL_MS / ENROLL_WINDOW_MS + 1)
/** The enrollment sequence's window: it never resets in practice. */
const ENROLL_SEQ_TTL_MS = 100 * 365 * 24 * 3_600_000

type CodeKind = "pair" | "login" | "link"

const KEYS = {
  enroll: (deviceCode: string) => `auth:enroll:${deviceCode}`,
  enrollCode: (userCode: string) => `auth:enroll-code:${userCode}`,
  enrollDecided: (deviceCode: string) => `auth:enroll-decided:${deviceCode}`,
  enrollSlot: (slot: number) => `auth:enroll-slot:${slot}`,
  enrollSeq: "auth:enroll-seq",
  enrollRate: "auth:enroll-rate",
  pairFailures: "auth:pair-failures",
  code: (kind: CodeKind, code: string) => `auth:${kind}:${code}`,
}

function parse<T>(raw: string | undefined): T | undefined {
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export class Auth {
  private readonly store: Store
  private readonly publicURL: string
  private readonly now: () => number
  private readonly mode: "pairing" | "oidc"
  private readonly kv: Kv
  private readonly counters: Counters
  /** Pairing codes this process issued and their expiry: a new code never repeats one of them. */
  private readonly issuedPairCodes = new Map<string, number>()
  /** Code writes in flight (codes are issued synchronously); a redeem here waits for them. */
  private readonly writes = new Set<Promise<void>>()

  constructor(options: AuthOptions) {
    this.store = options.store
    this.publicURL = options.publicURL
    this.now = options.now ?? Date.now
    this.mode = options.mode ?? "pairing"
    this.kv = options.kv ?? new MemoryKv({ now: this.now })
    this.counters = options.counters ?? new MemoryCounters({ now: this.now })
  }

  // ---------- machine enrollment ----------

  async startEnrollment(machineName: unknown): Promise<EnrollStart> {
    const machine = name(machineName, "machine name")
    if ((await this.counters.incr(KEYS.enrollRate, ENROLL_WINDOW_MS)) > ENROLL_MAX) {
      throw new RateLimitError("Too many enrollment requests; try again in a minute")
    }
    const created = this.now()
    const expiresAt = created + ENROLL_TTL_MS
    const px = ENROLL_TTL_MS + 1
    const deviceCode = newToken()
    let code = userCode()
    while (!(await this.kv.set(KEYS.enrollCode(code), deviceCode, { px, nx: true }))) code = userCode()
    const enrollment: Enrollment = { userCode: code, deviceCode, machineName: machine, created, expiresAt, status: "pending" }
    await this.kv.set(KEYS.enroll(deviceCode), JSON.stringify(enrollment), { px })
    const slot = await this.counters.incr(KEYS.enrollSeq, ENROLL_SEQ_TTL_MS)
    await this.kv.set(KEYS.enrollSlot(slot), deviceCode, { px })
    return {
      userCode: code,
      deviceCode,
      approveURL: `${this.publicURL}/approve?code=${code}`,
      intervalMs: ENROLL_INTERVAL_MS,
      expiresAt,
    }
  }

  /** Approved and denied results are delivered once (GETDEL); afterwards the code reads as expired. */
  async pollEnrollment(deviceCode: unknown): Promise<EnrollPoll> {
    const enrollment = typeof deviceCode === "string" ? await this.enrollment(deviceCode) : undefined
    if (!enrollment) return { status: "expired" }
    if (enrollment.status === "pending") return { status: "pending" }
    const taken = parse<Enrollment>(await this.kv.getdel(KEYS.enroll(enrollment.deviceCode)))
    if (!taken || taken.status === "pending") return { status: "expired" }
    await this.kv.del(KEYS.enrollCode(taken.userCode))
    if (taken.status === "denied") return { status: "denied" }
    const { machine, token } = await this.store.addMachine(taken.machineName, taken.ownerID ?? LOCAL_USER)
    return { status: "approved", machineID: machine.id, machineToken: token }
  }

  /** Pending enrollments, oldest first. */
  async pendingEnrollments(): Promise<PendingEnrollment[]> {
    const last = await this.counters.get(KEYS.enrollSeq)
    const slots: number[] = []
    for (let slot = Math.max(1, last - ENROLL_SLOTS + 1); slot <= last; slot++) slots.push(slot)
    const deviceCodes = await Promise.all(slots.map((slot) => this.kv.get(KEYS.enrollSlot(slot))))
    const unique = [...new Set(deviceCodes.filter((code): code is string => code !== undefined))]
    const enrollments = await Promise.all(unique.map((code) => this.enrollment(code)))
    return enrollments
      .filter((e): e is Enrollment => e?.status === "pending")
      .map(({ userCode, machineName, created, expiresAt }) => ({ userCode, machineName, created, expiresAt }))
  }

  /** Approves a pending enrollment; `ownerID` (the approver) will own the machine. */
  async approveEnrollment(code: string, ownerID: string = LOCAL_USER): Promise<boolean> {
    return (await this.decide(code, "approved", ownerID)) !== undefined
  }

  async denyEnrollment(code: string): Promise<boolean> {
    return (await this.decide(code, "denied")) !== undefined
  }

  /**
   * Approves or denies a pending enrollment; the machine name, or undefined when no such code is pending. The
   * first decision wins (SET NX), on any pod.
   */
  async decide(code: string, status: "approved" | "denied", ownerID: string = LOCAL_USER): Promise<string | undefined> {
    const deviceCode = await this.kv.get(KEYS.enrollCode(normalizeUserCode(code)))
    const enrollment = deviceCode === undefined ? undefined : await this.enrollment(deviceCode)
    if (!enrollment || enrollment.status !== "pending") return undefined
    const px = this.remaining(enrollment.expiresAt)
    if (!(await this.kv.set(KEYS.enrollDecided(enrollment.deviceCode), status, { px, nx: true }))) return undefined
    const decided: Enrollment = { ...enrollment, status, ...(status === "approved" ? { ownerID } : {}) }
    await this.kv.set(KEYS.enroll(enrollment.deviceCode), JSON.stringify(decided), { px })
    return enrollment.machineName
  }

  /** The enrollment of a device code, unless it expired. */
  private async enrollment(deviceCode: string): Promise<Enrollment | undefined> {
    const enrollment = parse<Enrollment>(await this.kv.get(KEYS.enroll(deviceCode)))
    return enrollment && this.remaining(enrollment.expiresAt) > 0 ? enrollment : undefined
  }

  /** Milliseconds a record expiring at `expiresAt` is still valid for (valid through expiresAt itself). */
  private remaining(expiresAt: number): number {
    return expiresAt - this.now() + 1
  }

  // ---------- device pairing ----------

  /** A pairing code; the device it pairs belongs to `ownerID`. */
  issuePairCode(ownerID: string = LOCAL_USER): { code: string; expiresAt: number } {
    const t = this.now()
    for (const [code, expiresAt] of this.issuedPairCodes) if (expiresAt < t) this.issuedPairCodes.delete(code)
    let code = String(randomInt(1_000_000)).padStart(6, "0")
    while (this.issuedPairCodes.has(code)) code = String(randomInt(1_000_000)).padStart(6, "0")
    const issued = this.issue("pair", code, ownerID, PAIR_TTL_MS)
    this.issuedPairCodes.set(code, issued.expiresAt)
    return issued
  }

  /** A pairing code for the first device (pairing mode only), or undefined once any device exists. */
  bootstrapCode(): { code: string; expiresAt: number } | undefined {
    return this.mode === "pairing" && this.store.devices().length === 0 ? this.issuePairCode(LOCAL_USER) : undefined
  }

  /**
   * Redeems a pairing code. Throws RateLimitError after too many recent failures. A code whose owner
   * is gone or disabled counts as invalid.
   */
  async pair(code: unknown, deviceName: unknown): Promise<{ device: DeviceRecord; token: string } | undefined> {
    if ((await this.counters.get(KEYS.pairFailures)) >= PAIR_FAILURES_MAX) throw new RateLimitError()
    const grant = await this.redeem("pair", typeof code === "string" ? code.trim() : "")
    if (!grant) {
      await this.counters.incr(KEYS.pairFailures, PAIR_FAILURES_WINDOW_MS)
      return undefined
    }
    if (!this.active(grant.ownerID)) return undefined
    return await this.store.addDevice(name(deviceName, "device name", "Device"), grant.ownerID)
  }

  // ---------- login links ----------

  /** A single-use login link code; it signs a browser in as `ownerID`. */
  issueLoginCode(ownerID: string = LOCAL_USER): { code: string; expiresAt: number } {
    return this.issue("login", randomBytes(32).toString("base64url"), ownerID, LOGIN_TTL_MS)
  }

  /** Redeems a login code: the user to sign in as, or undefined (unknown, used, expired, or owner disabled). */
  async redeemLogin(code: unknown): Promise<string | undefined> {
    const grant = await this.redeem("login", code)
    return grant && this.active(grant.ownerID) ? grant.ownerID : undefined
  }

  async redeemLoginCode(code: unknown): Promise<boolean> {
    return (await this.redeemLogin(code)) !== undefined
  }

  // ---------- app link codes ----------

  /** A single-use app link code; the device it links belongs to `ownerID`. Never valid at /login or /api/pair. */
  issueLinkCode(ownerID: string = LOCAL_USER): { code: string; expiresAt: number } {
    return this.issue("link", randomBytes(32).toString("base64url"), ownerID, LINK_TTL_MS)
  }

  /**
   * Redeems an app link code for a new device and its token, or undefined (unknown, used, expired, or owner
   * gone or disabled). Throws ValidationError for a malformed public key (the code stays valid). The code is
   * deleted before the device is created. No rate limiter: 256-bit codes cannot be guessed, and a shared
   * limiter would let bad redeems lock out pairing.
   */
  async redeemLink(code: unknown, deviceName: unknown, key?: unknown): Promise<{ device: DeviceRecord; token: string } | undefined> {
    const label = deviceLabel(deviceName, "App")
    const pk = publicKey(key)
    const grant = await this.redeem("link", code)
    if (!grant || !this.active(grant.ownerID)) return undefined
    return await this.store.addDevice(label, grant.ownerID, pk ? { publicKey: pk } : {})
  }

  // ---------- pending codes ----------

  /**
   * Issues a code at once and stores it in the background (callers are synchronous); a redeem in this process
   * waits for the write, and another pod's redeem comes after a person typed or opened the code. Should the
   * code already exist (another pod issued the same pairing code), both are dropped: a code never signs anyone
   * in as someone else.
   */
  private issue(kind: CodeKind, code: string, ownerID: string, ttlMs: number): { code: string; expiresAt: number } {
    const expiresAt = this.now() + ttlMs
    const key = KEYS.code(kind, code)
    const grant: Grant = { expiresAt, ownerID }
    this.track(
      this.kv.set(key, JSON.stringify(grant), { px: ttlMs + 1, nx: true }).then(async (stored) => {
        if (stored) return
        await this.kv.del(key)
        console.warn(`[hub] a new ${kind} code collided with a pending one; both were dropped`)
      }),
    )
    return { code, expiresAt }
  }

  /** Spends a code (GETDEL): its grant, or undefined (unknown, used, expired). */
  private async redeem(kind: CodeKind, code: unknown): Promise<Grant | undefined> {
    if (typeof code !== "string" || !code) return undefined
    if (this.writes.size) await Promise.all([...this.writes])
    const grant = parse<Grant>(await this.kv.getdel(KEYS.code(kind, code)))
    return grant && this.remaining(grant.expiresAt) > 0 ? grant : undefined
  }

  private track(write: Promise<unknown>): void {
    const tracked: Promise<void> = write
      .then(
        () => {},
        (cause: unknown) => console.error(`[hub] pending code not stored: ${cause instanceof Error ? cause.message : cause}`),
      )
      .finally(() => this.writes.delete(tracked))
    this.writes.add(tracked)
  }

  private active(userID: string): boolean {
    const user = this.store.user(userID)
    return user !== undefined && !user.disabled
  }
}
