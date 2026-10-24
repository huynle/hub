// Hub-minted session tokens (design §1.3): a bearer credential for one session of one machine, which the hub
// pushes to the spoke reporting the session (sessionTokens op, see ../session-token-push.ts) and the spoke hands
// to the session's shells.
//
// Format: `hst1.<b64url(payload JSON)>.<b64url(HMAC-SHA256(secret of kid, "hst1." + payload part))>`, where the
// payload is {typ: "session", uid, mid, sid, exp (ms since the epoch), kid, ue (user epoch), me (machine
// epoch), aud (the hub's public URL)}. One algorithm, one prefix; anything else is not a session token.
//
// A token is accepted while all of this holds: signature (constant-time) under a known kid, audience, expiry,
// the user's and machine's current token epochs, the machine exists, is not revoked and still belongs to uid,
// the user exists (the resolver refuses disabled users), and that machine still reports the session for uid.
// Tokens and secrets are never logged and never appear in this object's JSON or inspect output.
import { createHmac, timingSafeEqual } from "node:crypto"
import { SESSION_TOKEN_MAX_CHARS } from "../../protocol"
import type { Store } from "../store"
import type { TokenKeys } from "../token-keys"
import type { BearerVerifier, SessionActor, VerifyResult } from "./actor"

export const SESSION_TOKEN_PREFIX = "hst1"
/** How long a session token is valid. */
export const SESSION_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000

/** What the verifier needs to know about live sessions (implemented by the registry). */
export interface SessionLiveness {
  /** Tenant (user ID) of a reported session (Registry.sessionTenant). */
  sessionTenant(sessionID: string): string | undefined
  /** Whether a connected process of the machine reports the session (for the machine's tenant). */
  machineReports(machineID: string, sessionID: string): boolean
}

export interface SessionTokensOptions {
  readonly keys: TokenKeys
  readonly store: Store
  readonly sessions: SessionLiveness
  /** The hub's public URL: the tokens' audience. */
  readonly publicURL: string
  readonly now?: () => number
  readonly lifetimeMs?: number
}

export interface MintedSessionToken {
  readonly token: string
  /** Expiry, ms since the epoch. */
  readonly exp: number
  /** The machine's stamp when minted (see SessionTokens.stamp). */
  readonly stamp: string
}

interface Claims {
  readonly typ: "session"
  readonly uid: string
  readonly mid: string
  readonly sid: string
  readonly exp: number
  readonly kid: string
  readonly ue: number
  readonly me: number
  readonly aud: string
}

const CLAIM_KEYS = ["typ", "uid", "mid", "sid", "exp", "kid", "ue", "me", "aud"].sort().join()
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
  if (c.typ !== "session" || !text(c.uid) || !text(c.mid) || !text(c.sid) || !text(c.kid) || !text(c.aud)) return undefined
  if (!count(c.exp) || !count(c.ue) || !count(c.me)) return undefined
  return c as unknown as Claims
}

const sign = (secret: Buffer, payload: string): Buffer => createHmac("sha256", secret).update(`${SESSION_TOKEN_PREFIX}.${payload}`).digest()

export class SessionTokens {
  readonly lifetimeMs: number
  readonly verifier: BearerVerifier
  readonly #keys: TokenKeys
  readonly #store: Store
  readonly #sessions: SessionLiveness
  readonly #aud: string
  readonly #now: () => number

  constructor(options: SessionTokensOptions) {
    this.#keys = options.keys
    this.#store = options.store
    this.#sessions = options.sessions
    this.#aud = options.publicURL
    this.#now = options.now ?? Date.now
    this.lifetimeMs = options.lifetimeMs ?? SESSION_TOKEN_LIFETIME_MS
    this.verifier = { kind: "session", verify: (token) => this.verify(token) }
  }

  /** The owner of an enrolled, unrevoked machine whose user exists and is enabled. */
  #owner(machineID: string): string | undefined {
    const machine = this.#store.machines().find((m) => m.id === machineID)
    if (!machine || machine.revoked) return undefined
    const user = this.#store.user(machine.ownerID)
    return user && !user.disabled ? user.id : undefined
  }

  /**
   * What a machine's tokens depend on besides the session: owner, active kid, user and machine epochs. Tokens
   * minted under another stamp are stale (resend them); undefined when the machine cannot get tokens.
   */
  stamp(machineID: string): string | undefined {
    const uid = this.#owner(machineID)
    if (!uid) return undefined
    return JSON.stringify([uid, this.#keys.active().kid, this.#store.userEpoch(uid), this.#store.machineEpoch(machineID)])
  }

  /**
   * A token for a session of the machine's owner (undefined when the machine is unknown, revoked or its owner
   * disabled, or the session belongs to another tenant or to nobody).
   */
  mint(machineID: string, sessionID: string): MintedSessionToken | undefined {
    const uid = this.#owner(machineID)
    if (!uid || this.#sessions.sessionTenant(sessionID) !== uid) return undefined
    const { kid, secret } = this.#keys.active()
    const exp = this.#now() + this.lifetimeMs
    const claims: Claims = {
      typ: "session",
      uid,
      mid: machineID,
      sid: sessionID,
      exp,
      kid,
      ue: this.#store.userEpoch(uid),
      me: this.#store.machineEpoch(machineID),
      aud: this.#aud,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    const stamp = JSON.stringify([uid, kid, claims.ue, claims.me])
    return { token: `${SESSION_TOKEN_PREFIX}.${payload}.${sign(secret, payload).toString("base64url")}`, exp, stamp }
  }

  /** The session actor of a valid token, "expired" for a genuine token past its expiry, else undefined. */
  verify(token: string): VerifyResult {
    if (typeof token !== "string" || token.length > SESSION_TOKEN_MAX_CHARS) return undefined
    const parts = token.split(".")
    if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_PREFIX) return undefined
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
    const machine = this.#store.machines().find((m) => m.id === claims.mid)
    if (!machine || machine.revoked || machine.ownerID !== claims.uid) return undefined
    if (!this.#store.user(claims.uid)) return undefined
    if (this.#sessions.sessionTenant(claims.sid) !== claims.uid || !this.#sessions.machineReports(claims.mid, claims.sid)) return undefined
    const actor: SessionActor = { kind: "session", userID: claims.uid, machineID: claims.mid, sessionID: claims.sid }
    return actor
  }

  toJSON(): { audience: string; lifetimeMs: number } {
    return { audience: this.#aud, lifetimeMs: this.lifetimeMs }
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SessionTokens(${this.#aud})`
  }
}
