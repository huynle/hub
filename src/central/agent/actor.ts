// The credential resolver: every /api request resolves to at most one AgentActor, from exactly one credential.
//
// Credentials (design §1.3, §14.2):
// - device cookie (`voice_device`, browsers): a DeviceRecord token; same-origin writes only (checked by callers)
// - device token (`Authorization: Bearer <device token>`, native apps): the same secret as the cookie,
//   resolved through the same device lookup, with the same powers; bearer requests skip the same-origin check
// - session token (P1-T5) and app token (P1-T7): bearer tokens resolved by a BearerVerifier
//
// A request with both a device cookie and a bearer token is refused ("mixed"): credentials never mix.
// Tokens are never logged; the device lookup is constant-time (Store.findDevice).
import type { DeviceRecord, UserRecord } from "../store"

/** The user, signed in as one of their devices (cookie in a browser, device token in an app). */
export interface UserActor {
  readonly kind: "user"
  readonly userID: string
  readonly deviceID: string
  readonly via: "cookie" | "device-token"
}

/** A session, through the session token the hub minted for it (P1-T5). */
export interface SessionActor {
  readonly kind: "session"
  readonly userID: string
  readonly machineID: string
  readonly sessionID: string
}

/** A user-created app/agent token (P1-T7). */
export interface AppActor {
  readonly kind: "app"
  readonly userID: string
  readonly tokenID: string
  readonly scopes: readonly string[]
  readonly label?: string
}

export type AgentActor = UserActor | SessionActor | AppActor

export type Credential = "cookie" | "device-token" | "session-token" | "app-token"

/**
 * Resolves one kind of bearer token (session tokens: P1-T5, app tokens: P1-T7). `verify` answers the actor for
 * a token it recognises and accepts, "expired" for one of its tokens that expired, and undefined otherwise
 * (not its token, bad signature, revoked). It must compare secrets in constant time and never log them. The
 * resolver still refuses actors of unknown or disabled users, and actors of another kind than `kind`.
 */
export interface BearerVerifier {
  readonly kind: "session" | "app"
  verify(token: string): VerifyResult | Promise<VerifyResult>
}

export type VerifyResult = SessionActor | AppActor | "expired" | undefined

export type Resolution =
  | { readonly ok: true; readonly credential: Credential; readonly actor: AgentActor; readonly user: UserRecord; readonly device?: DeviceRecord }
  | {
      readonly ok: false
      /** none: no credential; invalid: unknown, revoked or disabled; expired: a verifier's token expired; mixed: cookie + bearer. */
      readonly reason: "none" | "invalid" | "expired" | "mixed"
      /** The request carried a bearer token (callers answer with token wording). */
      readonly bearer: boolean
    }

export interface ResolverDeps {
  readonly cookieName: string
  /** Device of a token (cookie value or device token); constant-time. */
  findDevice(token: string): DeviceRecord | undefined
  user(id: string): UserRecord | undefined
  /** Session and app token verifiers, tried in order after the device lookup. */
  readonly verifiers?: readonly BearerVerifier[]
}

export type Resolver = (request: Request) => Promise<Resolution>

/** `Bearer <token>`; a Bearer header whose value is not one token still counts as a (invalid, empty) bearer. */
const BEARER = /^\s*Bearer(?:\s+(.*))?$/i

/** The device cookie and the bearer token of a request (an Authorization header with another scheme is neither). */
export function readCredentials(request: Request, cookieName: string): { cookie?: string; bearer?: string } {
  const out: { cookie?: string; bearer?: string } = {}
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === cookieName) {
      out.cookie = rest.join("=")
      break
    }
  }
  const match = BEARER.exec(request.headers.get("authorization") ?? "")
  if (match) {
    const token = (match[1] ?? "").trim()
    out.bearer = /\s/.test(token) ? "" : token
  }
  return out
}

const CREDENTIAL: Record<"session" | "app", Credential> = { session: "session-token", app: "app-token" }

export function createResolver(deps: ResolverDeps): Resolver {
  const verifiers = deps.verifiers ?? []
  const activeUser = (id: string) => {
    const user = deps.user(id)
    return user && !user.disabled ? user : undefined
  }
  const byDevice = (token: string, via: UserActor["via"]): Resolution | undefined => {
    const device = token ? deps.findDevice(token) : undefined
    const user = device && activeUser(device.ownerID)
    if (!device || !user) return undefined
    return { ok: true, credential: via, actor: { kind: "user", userID: user.id, deviceID: device.id, via }, user, device }
  }

  return async (request) => {
    const { cookie, bearer } = readCredentials(request, deps.cookieName)
    if (bearer === undefined) {
      if (cookie === undefined) return { ok: false, reason: "none", bearer: false }
      return byDevice(cookie, "cookie") ?? { ok: false, reason: "invalid", bearer: false }
    }
    if (cookie !== undefined) return { ok: false, reason: "mixed", bearer: true }
    if (!bearer) return { ok: false, reason: "invalid", bearer: true }
    const device = byDevice(bearer, "device-token")
    if (device) return device
    for (const verifier of verifiers) {
      const result = await verifier.verify(bearer)
      if (result === undefined) continue
      if (result === "expired") return { ok: false, reason: "expired", bearer: true }
      if (result.kind !== verifier.kind) continue
      const user = activeUser(result.userID)
      if (!user) return { ok: false, reason: "invalid", bearer: true }
      return { ok: true, credential: CREDENTIAL[verifier.kind], actor: result, user }
    }
    return { ok: false, reason: "invalid", bearer: true }
  }
}

/** Which actors an /api/agent route admits besides user actors (cookie and device token reach every route). */
export interface AgentAllow {
  /** Session tokens may call it (phase-limited verbs). */
  readonly session?: boolean
  /** App tokens holding this scope may call it. */
  readonly scope?: string
  /** Any app token may call it (introspection such as whoami). */
  readonly app?: boolean
}

/** Route classes on /api/agent: users everywhere (incl. token management), sessions where allowed, apps by scope. */
export function agentAllows(allow: AgentAllow, actor: AgentActor): boolean {
  switch (actor.kind) {
    case "user":
      return true
    case "session":
      return allow.session === true
    case "app":
      return allow.app === true || (allow.scope !== undefined && actor.scopes.includes(allow.scope))
  }
}
