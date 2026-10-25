// Launch-bound tokens (phase 5, decision #6): the credential a harness inside a sandbox (OpenShell) uses to
// connect back to /spoke/ws for exactly one launch. The node passes it into the sandbox it provisions; it is
// accepted only while that launch is provisioning or running.
//
// Format: `hlt1.<b64url(payload JSON)>.<b64url(HMAC-SHA256(secret of kid, "hlt1." + payload part))>`, where the
// payload is {uid, mid, lid, exp (ms since the epoch), kid, ue (user epoch), me (machine epoch), aud (the hub's
// public URL)}. Signed with the same TokenKeys as session tokens (hst1); the prefix is part of the signed text,
// so neither kind can pass for the other.
//
// The verifier depends only on a LaunchLookup (state and machine of a user's launch), not on the launch engine;
// LaunchStore fits it as `{ launch: (userID, launchID) => launchStore.get(userID, launchID) }`. Holding a valid
// token is all this module checks: one connection per launch, and keeping launch-bound connections out of
// serviceFor/exposeTarget/launchService, are /spoke/ws's and the registry's job.
// Tokens and secrets are never logged and never appear in this object's JSON or inspect output.
import { createHmac, timingSafeEqual } from "node:crypto"
import type { Store } from "../store"
import type { TokenKeys } from "../token-keys"
import type { LaunchState } from "./launch-store"

export const LAUNCH_TOKEN_PREFIX = "hlt1"
/** How long a launch token is valid. */
export const LAUNCH_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000
/** Longest launch token accepted (the same bound as session tokens). */
export const LAUNCH_TOKEN_MAX_CHARS = 4096
/** The launch states in which a launch token is minted and accepted. */
export const LAUNCH_TOKEN_STATES: readonly LaunchState[] = ["provisioning", "running"]

/** What the tokens need to know about a launch (implemented by the launch store). */
export interface LaunchView {
  readonly state: LaunchState
  /** The machine (node) it is placed on. */
  readonly machineID?: string
}

/** Looks up a user's launch (undefined when the user has no such launch). */
export interface LaunchLookup {
  launch(userID: string, launchID: string): Promise<LaunchView | undefined> | LaunchView | undefined
}

export interface LaunchTokensOptions {
  readonly keys: TokenKeys
  readonly store: Store
  readonly launches: LaunchLookup
  /** The hub's public URL: the tokens' audience. */
  readonly publicURL: string
  readonly now?: () => number
  readonly lifetimeMs?: number
}

export interface MintedLaunchToken {
  readonly token: string
  /** Expiry, ms since the epoch. */
  readonly exp: number
}

/** What a valid launch token is bound to. */
export interface LaunchBinding {
  readonly userID: string
  readonly machineID: string
  readonly launchID: string
  /** The token's expiry, ms since the epoch. */
  readonly exp: number
}

/** The binding of a valid token, "expired" for a genuine token past its expiry, else undefined. */
export type LaunchVerifyResult = LaunchBinding | "expired" | undefined

interface Claims {
  readonly uid: string
  readonly mid: string
  readonly lid: string
  readonly exp: number
  readonly kid: string
  readonly ue: number
  readonly me: number
  readonly aud: string
}

const CLAIM_KEYS = ["uid", "mid", "lid", "exp", "kid", "ue", "me", "aud"].sort().join()
const B64URL = /^[A-Za-z0-9_-]+$/
/** HMAC-SHA256 output length. */
const SIG_BYTES = 32

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0

/** Canonical base64url only (no padding, no other alphabet, no non-zero trailing bits). */
function decode(part: string): Buffer | undefined {
  if (!B64URL.test(part)) return undefined
  const bytes = Buffer.from(part, "base64url")
  return bytes.toString("base64url") === part ? bytes : undefined
}

function parseClaims(bytes: Buffer): Claims | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString("utf8"))
  } catch {
    return undefined
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const c = raw as Record<string, unknown>
  if (Object.keys(c).sort().join() !== CLAIM_KEYS) return undefined
  if (!text(c.uid) || !text(c.mid) || !text(c.lid) || !text(c.kid) || !text(c.aud)) return undefined
  if (!count(c.exp) || !count(c.ue) || !count(c.me)) return undefined
  return c as unknown as Claims
}

const sign = (secret: Buffer, payload: string): Buffer => createHmac("sha256", secret).update(`${LAUNCH_TOKEN_PREFIX}.${payload}`).digest()

export class LaunchTokens {
  readonly lifetimeMs: number
  readonly #keys: TokenKeys
  readonly #store: Store
  readonly #launches: LaunchLookup
  readonly #aud: string
  readonly #now: () => number

  constructor(options: LaunchTokensOptions) {
    this.#keys = options.keys
    this.#store = options.store
    this.#launches = options.launches
    this.#aud = options.publicURL
    this.#now = options.now ?? Date.now
    this.lifetimeMs = options.lifetimeMs ?? LAUNCH_TOKEN_LIFETIME_MS
  }

  /** The owner of an enrolled, unrevoked machine whose user exists and is enabled. */
  #owner(machineID: string): string | undefined {
    const machine = this.#store.machines().find((m) => m.id === machineID)
    if (!machine || machine.revoked) return undefined
    const user = this.#store.user(machine.ownerID)
    return user && !user.disabled ? user.id : undefined
  }

  /** Whether the user's launch is provisioning or running on the machine (false when the lookup fails). */
  async #live(userID: string, launchID: string, machineID: string): Promise<boolean> {
    let launch: LaunchView | undefined
    try {
      launch = await this.#launches.launch(userID, launchID)
    } catch {
      return false
    }
    return launch !== undefined && LAUNCH_TOKEN_STATES.includes(launch.state) && launch.machineID === machineID
  }

  /**
   * A token for a launch of the machine's owner that is provisioning or running on that machine (undefined when
   * the machine is unknown, revoked or its owner disabled, or the launch is someone else's, elsewhere or not live).
   */
  async mint(machineID: string, launchID: string): Promise<MintedLaunchToken | undefined> {
    const uid = this.#owner(machineID)
    if (!uid || !(await this.#live(uid, launchID, machineID))) return undefined
    const { kid, secret } = this.#keys.active()
    const exp = this.#now() + this.lifetimeMs
    const claims: Claims = {
      uid,
      mid: machineID,
      lid: launchID,
      exp,
      kid,
      ue: this.#store.userEpoch(uid),
      me: this.#store.machineEpoch(machineID),
      aud: this.#aud,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return { token: `${LAUNCH_TOKEN_PREFIX}.${payload}.${sign(secret, payload).toString("base64url")}`, exp }
  }

  /**
   * What a token is bound to while all of this holds: signature (constant-time) under a known kid, audience,
   * expiry, the user's and machine's current token epochs, the machine exists, is not revoked and belongs to uid,
   * the user exists and is enabled, and uid's launch is provisioning or running on that machine.
   */
  async verify(token: string): Promise<LaunchVerifyResult> {
    if (typeof token !== "string" || token.length > LAUNCH_TOKEN_MAX_CHARS) return undefined
    const parts = token.split(".")
    if (parts.length !== 3 || parts[0] !== LAUNCH_TOKEN_PREFIX) return undefined
    const [, payload, sigPart] = parts as [string, string, string]
    const body = decode(payload)
    const sig = decode(sigPart)
    if (!body || !sig || sig.length !== SIG_BYTES) return undefined
    const claims = parseClaims(body)
    if (!claims) return undefined
    const secret = this.#keys.key(claims.kid)
    if (!secret) return undefined
    const expected = sign(secret, payload)
    if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) return undefined
    if (claims.aud !== this.#aud) return undefined
    if (this.#now() >= claims.exp) return "expired"
    if (claims.ue !== this.#store.userEpoch(claims.uid) || claims.me !== this.#store.machineEpoch(claims.mid)) return undefined
    if (this.#owner(claims.mid) !== claims.uid) return undefined
    if (!(await this.#live(claims.uid, claims.lid, claims.mid))) return undefined
    return { userID: claims.uid, machineID: claims.mid, launchID: claims.lid, exp: claims.exp }
  }

  toJSON(): { audience: string; lifetimeMs: number } {
    return { audience: this.#aud, lifetimeMs: this.lifetimeMs }
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `LaunchTokens(${this.#aud})`
  }
}
