// Credentials issued by the central server:
// - machine enrollment (device-code flow): a spoke asks, the owner approves in the web UI, the spoke polls for its token
// - device pairing: short single-use numeric codes, shown in the /hub dialog or logged at startup
// - login links: long single-use codes opened from the terminal to sign a browser in
// Pending codes live in memory only; a restart invalidates them.
import { randomBytes, randomInt } from "node:crypto"
import type { EnrollPoll, EnrollStart } from "../protocol"
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

/** Sliding-window counter. */
export class Limiter {
  private hits: number[] = []

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when another hit is allowed right now (does not record one). */
  allowed(): boolean {
    const cutoff = this.now() - this.windowMs
    this.hits = this.hits.filter((t) => t > cutoff)
    return this.hits.length < this.max
  }

  hit(): void {
    this.hits.push(this.now())
  }

  /** Records a hit if allowed. */
  tryHit(): boolean {
    if (!this.allowed()) return false
    this.hit()
    return true
  }
}

export const ENROLL_TTL_MS = 10 * 60_000
export const ENROLL_INTERVAL_MS = 2000
export const PAIR_TTL_MS = 5 * 60_000
export const LOGIN_TTL_MS = 2 * 60_000

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

interface Enrollment {
  userCode: string
  deviceCode: string
  machineName: string
  created: number
  expiresAt: number
  status: "pending" | "approved" | "denied"
  /** The approver: owner of the machine created on the next poll. */
  ownerID?: string
}

/** A pending pairing code or login link and the user its device will belong to. */
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
}

export class Auth {
  private readonly store: Store
  private readonly publicURL: string
  private readonly now: () => number
  private readonly enrollments = new Map<string, Enrollment>() // by deviceCode
  private readonly pairCodes = new Map<string, Grant>()
  private readonly loginCodes = new Map<string, Grant>()
  private readonly mode: "pairing" | "oidc"
  private readonly enrollLimiter: Limiter
  private readonly pairFailures: Limiter

  constructor(options: AuthOptions) {
    this.store = options.store
    this.publicURL = options.publicURL
    this.now = options.now ?? Date.now
    this.mode = options.mode ?? "pairing"
    this.enrollLimiter = new Limiter(5, 60_000, this.now)
    this.pairFailures = new Limiter(10, 60_000, this.now)
  }

  // ---------- machine enrollment ----------

  startEnrollment(machineName: unknown): EnrollStart {
    const machine = name(machineName, "machine name")
    if (!this.enrollLimiter.tryHit()) throw new RateLimitError("Too many enrollment requests; try again in a minute")
    this.sweep()
    const taken = new Set([...this.enrollments.values()].map((e) => e.userCode))
    let code = userCode()
    while (taken.has(code)) code = userCode()
    const created = this.now()
    const enrollment: Enrollment = {
      userCode: code,
      deviceCode: newToken(),
      machineName: machine,
      created,
      expiresAt: created + ENROLL_TTL_MS,
      status: "pending",
    }
    this.enrollments.set(enrollment.deviceCode, enrollment)
    return {
      userCode: code,
      deviceCode: enrollment.deviceCode,
      approveURL: `${this.publicURL}/approve?code=${code}`,
      intervalMs: ENROLL_INTERVAL_MS,
      expiresAt: enrollment.expiresAt,
    }
  }

  /** Approved and denied results are delivered once; afterwards the code reads as expired. */
  pollEnrollment(deviceCode: unknown): EnrollPoll {
    this.sweep()
    const enrollment = typeof deviceCode === "string" ? this.enrollments.get(deviceCode) : undefined
    if (!enrollment) return { status: "expired" }
    if (enrollment.status === "pending") return { status: "pending" }
    this.enrollments.delete(enrollment.deviceCode)
    if (enrollment.status === "denied") return { status: "denied" }
    const { machine, token } = this.store.addMachine(enrollment.machineName, enrollment.ownerID ?? LOCAL_USER)
    return { status: "approved", machineID: machine.id, machineToken: token }
  }

  pendingEnrollments(): PendingEnrollment[] {
    this.sweep()
    return [...this.enrollments.values()]
      .filter((e) => e.status === "pending")
      .map(({ userCode, machineName, created, expiresAt }) => ({ userCode, machineName, created, expiresAt }))
  }

  /** Approves a pending enrollment; `ownerID` (the approver) will own the machine. */
  approveEnrollment(code: string, ownerID: string = LOCAL_USER): boolean {
    return this.decide(code, "approved", ownerID) !== undefined
  }

  denyEnrollment(code: string): boolean {
    return this.decide(code, "denied") !== undefined
  }

  /** Approves or denies a pending enrollment; the machine name, or undefined when no such code is pending. */
  decide(code: string, status: "approved" | "denied", ownerID: string = LOCAL_USER): string | undefined {
    this.sweep()
    const wanted = normalizeUserCode(code)
    for (const enrollment of this.enrollments.values()) {
      if (enrollment.userCode === wanted && enrollment.status === "pending") {
        enrollment.status = status
        if (status === "approved") enrollment.ownerID = ownerID
        return enrollment.machineName
      }
    }
    return undefined
  }

  // ---------- device pairing ----------

  /** A pairing code; the device it pairs belongs to `ownerID`. */
  issuePairCode(ownerID: string = LOCAL_USER): { code: string; expiresAt: number } {
    this.sweep()
    let code = String(randomInt(1_000_000)).padStart(6, "0")
    while (this.pairCodes.has(code)) code = String(randomInt(1_000_000)).padStart(6, "0")
    const expiresAt = this.now() + PAIR_TTL_MS
    this.pairCodes.set(code, { expiresAt, ownerID })
    return { code, expiresAt }
  }

  /** A pairing code for the first device (pairing mode only), or undefined once any device exists. */
  bootstrapCode(): { code: string; expiresAt: number } | undefined {
    return this.mode === "pairing" && this.store.devices().length === 0 ? this.issuePairCode(LOCAL_USER) : undefined
  }

  /**
   * Redeems a pairing code. Throws RateLimitError after too many recent failures. A code whose owner
   * is gone or disabled counts as invalid.
   */
  pair(code: unknown, deviceName: unknown): { device: DeviceRecord; token: string } | undefined {
    if (!this.pairFailures.allowed()) throw new RateLimitError()
    this.sweep()
    const key = typeof code === "string" ? code.trim() : ""
    const grant = this.pairCodes.get(key)
    if (!grant) {
      this.pairFailures.hit()
      return undefined
    }
    this.pairCodes.delete(key)
    if (!this.active(grant.ownerID)) return undefined
    return this.store.addDevice(name(deviceName, "device name", "Device"), grant.ownerID)
  }

  // ---------- login links ----------

  /** A single-use login link code; it signs a browser in as `ownerID`. */
  issueLoginCode(ownerID: string = LOCAL_USER): { code: string; expiresAt: number } {
    const code = randomBytes(32).toString("base64url")
    const expiresAt = this.now() + LOGIN_TTL_MS
    this.loginCodes.set(code, { expiresAt, ownerID })
    return { code, expiresAt }
  }

  /** Redeems a login code: the user to sign in as, or undefined (unknown, used, expired, or owner disabled). */
  redeemLogin(code: unknown): string | undefined {
    this.sweep()
    const grant = typeof code === "string" ? this.loginCodes.get(code) : undefined
    if (!grant) return undefined
    this.loginCodes.delete(code as string)
    return this.active(grant.ownerID) ? grant.ownerID : undefined
  }

  redeemLoginCode(code: unknown): boolean {
    return this.redeemLogin(code) !== undefined
  }

  private active(userID: string): boolean {
    const user = this.store.user(userID)
    return user !== undefined && !user.disabled
  }

  private sweep(): void {
    const t = this.now()
    for (const [key, e] of this.enrollments) if (e.expiresAt < t) this.enrollments.delete(key)
    for (const [key, grant] of this.pairCodes) if (grant.expiresAt < t) this.pairCodes.delete(key)
    for (const [key, grant] of this.loginCodes) if (grant.expiresAt < t) this.loginCodes.delete(key)
  }
}
