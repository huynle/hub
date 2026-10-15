import { stopServer } from "./spoke-fake"
// A fake OpenID Connect provider for tests: discovery, an "authorize" step simulated by the test (it
// reads the hub's redirect and decides which claims the code yields), and a token endpoint that checks
// client_secret_post + PKCE and returns an unsigned ID token.
import { createHash } from "node:crypto"

export interface FakeGrant {
  /** ID token claims; iss/aud/exp/nonce default to valid values. */
  claims?: Record<string, unknown>
  /** Token endpoint answers with this status (and no id_token). */
  status?: number
}

export interface TokenRequest {
  readonly form: Record<string, string>
}

export interface FakeProvider {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  readonly tokenRequests: TokenRequest[]
  discoveryHits: number
  /** Override what the discovery document says (e.g. a different issuer). */
  discovery: Record<string, unknown> | undefined
  /** Simulates the user signing in at the provider: returns a code bound to the authorize request. */
  authorize(authorizeURL: string, grant?: FakeGrant): { code: string; state: string; nonce: string; redirectURI: string }
  stop(): void
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url")

export function unsignedJWT(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "RS256", kid: "fake" }))}.${b64url(JSON.stringify(claims))}.${b64url("not-a-real-signature")}`
}

export function fakeProvider(options: { clientId?: string; clientSecret?: string } = {}): FakeProvider {
  const clientId = options.clientId ?? "client-123"
  const clientSecret = options.clientSecret ?? "s3cret-value"
  const codes = new Map<string, { challenge: string; redirectURI: string; nonce: string; grant: FakeGrant }>()
  const tokenRequests: TokenRequest[] = []
  let seq = 0
  let issuer = ""
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === "/.well-known/openid-configuration") {
        provider.discoveryHits++
        return Response.json(
          provider.discovery ?? {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          },
        )
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(await request.text()))
        tokenRequests.push({ form })
        const entry = codes.get(form.code ?? "")
        codes.delete(form.code ?? "")
        if (!entry) return Response.json({ error: "invalid_grant" }, { status: 400 })
        if (form.client_id !== clientId || form.client_secret !== clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 })
        if (form.grant_type !== "authorization_code" || form.redirect_uri !== entry.redirectURI) return Response.json({ error: "invalid_request" }, { status: 400 })
        const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url")
        if (challenge !== entry.challenge) return Response.json({ error: "invalid_grant", error_description: "PKCE" }, { status: 400 })
        if (entry.grant.status) return Response.json({ error: "server_error" }, { status: entry.grant.status })
        const claims = {
          iss: issuer,
          aud: clientId,
          sub: `sub-${seq}`,
          exp: Math.floor(Date.now() / 1000) + 600,
          iat: Math.floor(Date.now() / 1000),
          nonce: entry.nonce,
          email_verified: true,
          ...entry.grant.claims,
        }
        return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: unsignedJWT(claims) })
      }
      return new Response("not found", { status: 404 })
    },
  })
  issuer = `http://127.0.0.1:${server.port}`
  const provider: FakeProvider = {
    issuer,
    clientId,
    clientSecret,
    tokenRequests,
    discoveryHits: 0,
    discovery: undefined,
    authorize(authorizeURL, grant = {}) {
      const url = new URL(authorizeURL)
      const p = url.searchParams
      if (`${url.origin}${url.pathname}` !== `${issuer}/authorize`) throw new Error(`unexpected authorize URL ${authorizeURL}`)
      if (p.get("client_id") !== clientId || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") {
        throw new Error(`bad authorize request ${authorizeURL}`)
      }
      const code = `code-${++seq}`
      const nonce = p.get("nonce")!
      codes.set(code, { challenge: p.get("code_challenge")!, redirectURI: p.get("redirect_uri")!, nonce, grant })
      return { code, state: p.get("state")!, nonce, redirectURI: p.get("redirect_uri")! }
    },
    stop: () => void stopServer(server),
  }
  return provider
}

/** Hub env for oidc mode against the fake provider. */
export function oidcEnv(provider: FakeProvider, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HUB_AUTH: "oidc",
    HUB_OIDC_ISSUER: provider.issuer,
    HUB_OIDC_INSECURE_ISSUER: "1",
    HUB_OIDC_CLIENT_ID: provider.clientId,
    HUB_OIDC_CLIENT_SECRET: provider.clientSecret,
    HUB_OIDC_ALLOWED: "alice@example.com,bob@example.com,@example.org",
    HUB_ADMIN_EMAILS: "admin@example.com",
    ...extra,
  }
}

/** Reads one cookie value from Set-Cookie headers. */
export function setCookie(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";")
    const [key, ...rest] = pair!.split("=")
    if (key!.trim() === name) return rest.join("=")
  }
  return undefined
}

/**
 * Full browser-free sign-in against a hub: /auth/login → fake authorize → /auth/callback. Returns the
 * callback response and the device cookie (when one was set).
 */
export async function signIn(
  hubURL: string,
  provider: FakeProvider,
  email: string,
  options: { next?: string; claims?: Record<string, unknown>; grant?: FakeGrant; headers?: Record<string, string> } = {},
): Promise<{ response: Response; cookie?: string; location: string | null }> {
  const login = await fetch(`${hubURL}/auth/login${options.next !== undefined ? `?next=${encodeURIComponent(options.next)}` : ""}`, {
    redirect: "manual",
    headers: options.headers,
  })
  if (login.status !== 302) throw new Error(`login answered ${login.status}`)
  const oidcCookie = setCookie(login, "voice_oidc")
  const grant = options.grant ?? { claims: { email, name: email.split("@")[0], ...options.claims } }
  const { code, state } = provider.authorize(login.headers.get("location")!, grant)
  const response = await fetch(`${hubURL}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: { cookie: `voice_oidc=${oidcCookie}`, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", ...options.headers },
  })
  const device = setCookie(response, "voice_device")
  return { response, location: response.headers.get("location"), ...(device ? { cookie: `voice_device=${device}` } : {}) }
}
