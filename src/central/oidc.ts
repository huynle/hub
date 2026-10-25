// OpenID Connect sign-in (authorization code flow with PKCE S256, state and nonce) for multi-user hubs.
// The ID token comes straight from the token endpoint over TLS (confidential client, client_secret_post),
// so its signature is not checked (OIDC Core 3.1.3.7, item 6); its claims are. Pending sign-ins live in the Kv
// backend (process memory by default, so a restart invalidates them; Valkey in a cluster, so the callback may land
// on any pod) and are single use (GETDEL).
import { createHash, randomBytes } from "node:crypto"
import { MemoryCounters } from "./backend/memory-counters"
import { MemoryKv } from "./backend/memory-kv"
import type { Counters, Kv } from "./backend/types"
import type { OidcConfig } from "./config"

export const OIDC_COOKIE = "voice_oidc"
export const OIDC_PENDING_TTL_MS = 10 * 60_000
/** Discovery documents are re-fetched after this long. */
export const DISCOVERY_CACHE_MS = 60 * 60_000
/** Clock skew tolerated on `exp`. */
const SKEW_SECONDS = 60
/** Most sign-ins started per pending lifetime (every pod together); /auth/login is public. */
const MAX_PENDING = 10_000
const PENDING_KEY = (state: string) => `oidc:pending:${state}`
const STARTED_KEY = "oidc:started"
const FETCH_TIMEOUT_MS = 10_000
const MAX_NEXT_CHARS = 1024

/** A failed sign-in step; `message` is safe to show, `reason` goes to the audit log. */
export class OidcError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: string,
    /** The state was valid: the attempt is worth an audit entry. */
    readonly audited = false,
  ) {
    super(message)
    this.name = "OidcError"
  }
}

export interface OidcIdentity {
  readonly sub: string
  /** Lowercased, verified. */
  readonly email: string
  readonly name?: string
}

interface Discovery {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
}

interface Pending {
  readonly nonce: string
  readonly verifier: string
  readonly next: string
  readonly expiresAt: number
}

export interface OidcClientOptions {
  readonly config: OidcConfig
  /** Hub origin: the redirect URI is <publicURL>/auth/callback. */
  readonly publicURL: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  /** Pending sign-ins (default: in this process, on `now`). */
  readonly kv?: Kv
  /** The cap on sign-ins started (default: in this process, on `now`). */
  readonly counters?: Counters
}

const random = () => randomBytes(32).toString("base64url")

/** A same-origin path (with query and fragment) to land on after sign-in; anything else becomes "/". */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > MAX_NEXT_CHARS) return "/"
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\x00-\x20\x7f]/.test(raw)) return "/"
  const base = "http://hub.invalid"
  try {
    const url = new URL(raw, base)
    if (url.origin !== base) return "/"
    const path = `${url.pathname}${url.search}${url.hash}`
    return path.startsWith("//") ? "/" : path
  } catch {
    return "/"
  }
}

/** A short device name from a user agent, e.g. "Safari on iPhone". */
export function deviceName(userAgent: string | null | undefined): string {
  const ua = userAgent ?? ""
  if (!ua) return "Browser"
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux|X11/.test(ua)
              ? "Linux"
              : undefined
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser"
  return os ? `${browser} on ${os}` : browser
}

/** The value of one cookie in a Cookie header. */
export function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return undefined
}

function decodePayload(idToken: unknown): Record<string, unknown> {
  const parts = typeof idToken === "string" ? idToken.split(".") : []
  if (parts.length !== 3 || !parts[1]) throw new OidcError(401, "The sign-in provider sent an invalid ID token.", "id_token malformed", true)
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("not an object")
    return payload as Record<string, unknown>
  } catch {
    throw new OidcError(401, "The sign-in provider sent an invalid ID token.", "id_token malformed", true)
  }
}

export class OidcClient {
  private readonly config: OidcConfig
  private readonly fetch: typeof globalThis.fetch
  private readonly now: () => number
  private readonly kv: Kv
  private readonly counters: Counters
  private discovery?: { at: number; doc: Discovery }
  readonly redirectURI: string

  constructor(options: OidcClientOptions) {
    this.config = options.config
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.kv = options.kv ?? new MemoryKv({ now: this.now })
    this.counters = options.counters ?? new MemoryCounters({ now: this.now })
    this.redirectURI = `${options.publicURL}/auth/callback`
  }

  /** Starts a sign-in: the provider URL to redirect to and the state for the voice_oidc cookie. */
  async login(next: string | null): Promise<{ location: string; state: string }> {
    const doc = await this.discover()
    if ((await this.counters.incr(STARTED_KEY, OIDC_PENDING_TTL_MS)) > MAX_PENDING) {
      throw new OidcError(429, "Too many sign-ins are in progress. Please try again in a few minutes.", "too many pending sign-ins")
    }
    const state = random()
    const nonce = random()
    const verifier = random()
    const pending: Pending = { nonce, verifier, next: safeNext(next), expiresAt: this.now() + OIDC_PENDING_TTL_MS }
    await this.kv.set(PENDING_KEY(state), JSON.stringify(pending), { px: OIDC_PENDING_TTL_MS })
    const url = new URL(doc.authorization_endpoint)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", this.config.clientId)
    url.searchParams.set("redirect_uri", this.redirectURI)
    url.searchParams.set("scope", "openid email profile")
    url.searchParams.set("state", state)
    url.searchParams.set("nonce", nonce)
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"))
    url.searchParams.set("code_challenge_method", "S256")
    return { location: url.toString(), state }
  }

  /**
   * Finishes a sign-in from the callback's query and the voice_oidc cookie. Throws OidcError. The
   * pending entry is consumed whatever the outcome once the state matches the cookie.
   */
  async callback(params: URLSearchParams, cookieState: string | undefined): Promise<{ identity: OidcIdentity; next: string }> {
    const state = params.get("state") ?? ""
    const pending = state && cookieState === state ? await this.consume(state) : undefined
    if (!pending) {
      throw new OidcError(400, "This sign-in has expired or was already used. Please sign in again.", "state invalid")
    }
    const providerError = params.get("error")
    if (providerError) {
      const description = params.get("error_description")
      throw new OidcError(400, `The sign-in provider reported: ${providerError}${description ? ` (${description})` : ""}`, `provider error ${providerError.slice(0, 64)}`, true)
    }
    const code = params.get("code")
    if (!code) throw new OidcError(400, "The sign-in provider sent no authorization code.", "no code", true)

    const doc = await this.discover()
    let tokens: Record<string, unknown>
    try {
      const response = await this.fetch(doc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.redirectURI,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`token endpoint answered ${response.status}`)
      tokens = (await response.json()) as Record<string, unknown>
    } catch (cause) {
      throw new OidcError(502, "Could not complete sign-in with the provider. Please try again.", `token exchange failed: ${cause instanceof Error ? cause.message : cause}`, true)
    }
    const identity = this.validate(decodePayload(tokens?.id_token), doc, pending.nonce)
    return { identity, next: pending.next }
  }

  private validate(claims: Record<string, unknown>, doc: Discovery, nonce: string): OidcIdentity {
    const reject = (reason: string, status = 401, message = "The sign-in could not be verified. Please sign in again."): never => {
      throw new OidcError(status, message, reason, true)
    }
    const issuers = new Set([doc.issuer])
    // Google documents both forms for `iss`.
    if (doc.issuer === "https://accounts.google.com") issuers.add("accounts.google.com")
    if (typeof claims.iss !== "string" || !issuers.has(claims.iss)) reject("iss mismatch")
    const aud = claims.aud
    const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : []
    if (!audiences.includes(this.config.clientId)) reject("aud mismatch")
    if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== this.config.clientId) reject("azp mismatch")
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + SKEW_SECONDS <= this.now() / 1000) reject("token expired")
    if (typeof claims.nonce !== "string" || claims.nonce !== nonce) reject("nonce mismatch")
    if (typeof claims.sub !== "string" || !claims.sub) reject("no sub")
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : ""
    if (!email) reject("no email", 403, "Your account did not share an email address.")
    if (claims.email_verified !== true && claims.email_verified !== "true") reject("email not verified", 403, "Your email address is not verified with the sign-in provider.")
    const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 100) : undefined
    return { sub: claims.sub as string, email, ...(name ? { name } : {}) }
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.at < DISCOVERY_CACHE_MS) return this.discovery.doc
    const issuer = this.config.issuer
    let raw: Record<string, unknown>
    try {
      const response = await this.fetch(`${issuer}/.well-known/openid-configuration`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`answered ${response.status}`)
      raw = (await response.json()) as Record<string, unknown>
    } catch (cause) {
      throw new OidcError(502, "The sign-in provider is not reachable right now. Please try again later.", `discovery failed: ${cause instanceof Error ? cause.message : cause}`)
    }
    const fail = (what: string): never => {
      throw new OidcError(502, "The sign-in provider is misconfigured.", `discovery: ${what}`)
    }
    if (typeof raw.issuer !== "string" || raw.issuer.replace(/\/+$/, "") !== issuer) fail("issuer mismatch")
    for (const key of ["authorization_endpoint", "token_endpoint"] as const) {
      if (!this.endpointOK(raw[key])) fail(`${key} invalid`)
    }
    const doc: Discovery = {
      issuer: raw.issuer as string,
      authorization_endpoint: raw.authorization_endpoint as string,
      token_endpoint: raw.token_endpoint as string,
    }
    this.discovery = { at: this.now(), doc }
    return doc
  }

  /** https, or http on the (dev-only) insecure loopback issuer's host. */
  private endpointOK(value: unknown): boolean {
    if (typeof value !== "string") return false
    try {
      const url = new URL(value)
      if (url.protocol === "https:") return true
      return url.protocol === "http:" && this.config.insecureIssuer === true && url.origin === new URL(this.config.issuer).origin
    } catch {
      return false
    }
  }

  /** Takes a pending sign-in out of the Kv (GETDEL: one callback wins, on any pod); undefined when unknown or expired. */
  private async consume(state: string): Promise<Pending | undefined> {
    const raw = await this.kv.getdel(PENDING_KEY(state))
    if (raw === undefined) return undefined
    try {
      const pending = JSON.parse(raw) as Pending
      return pending.expiresAt > this.now() ? pending : undefined
    } catch {
      return undefined
    }
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const escapeHTML = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

/** A small standalone HTML page for sign-in results (no scripts, nothing external). */
export function authPage(status: number, title: string, message: string, headers: HeadersInit = {}): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)} · Hub</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}a{color:#0a58ca}</style>
</head><body><h1>${escapeHTML(title)}</h1><p>${escapeHTML(message)}</p><p><a href="/">Back to Hub</a></p></body></html>
`
  const h = new Headers(headers)
  h.set("content-type", "text/html; charset=utf-8")
  h.set("cache-control", "no-store")
  h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
  return new Response(html, { status, headers: h })
}
