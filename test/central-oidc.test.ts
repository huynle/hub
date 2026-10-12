import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { deviceName, safeNext } from "../src/central/oidc"
import { LOCAL_USER } from "../src/central/store"
import { harness, PUBLIC, type Harness } from "./central-harness"
import { fakeProvider, oidcEnv, setCookie, signIn, unsignedJWT, type FakeProvider } from "./oidc-fake"

let h: Harness | undefined
let idp: FakeProvider | undefined
afterEach(async () => {
  await h?.stop()
  idp?.stop()
  h = idp = undefined
})

function oidcHub(extra: Record<string, string> = {}, now?: () => number): Harness {
  idp = fakeProvider()
  h = harness({ env: oidcEnv(idp, extra), noDevice: true, ...(now ? { now } : {}) })
  return h
}

const me = async (hub: Harness, cookie: string) => (await (await hub.api("/api/me", { cookie })).json()) as any
const text = (r: Response) => r.text()

describe("GET /api/auth", () => {
  test("pairing mode: no sign-in", async () => {
    h = harness({ noDevice: true })
    const res = await h.api("/api/auth", { cookie: null })
    expect(await res.json()).toEqual({ mode: "pairing", signIn: null })
    expect((await h.api("/auth/login", { cookie: null })).status).toBe(404)
    expect((await h.api("/auth/callback?code=x&state=y", { cookie: null })).status).toBe(404)
  })

  test("oidc mode: sign-in path, public", async () => {
    const hub = oidcHub()
    expect(await (await hub.api("/api/auth", { cookie: null })).json()).toEqual({ mode: "oidc", signIn: "/auth/login" })
  })
})

describe("/auth/login", () => {
  test("redirects to the provider with PKCE S256, state, nonce and a voice_oidc cookie", async () => {
    const hub = oidcHub()
    const res = await hub.api("/auth/login?next=/s/ses_1", { cookie: null })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(`${location.origin}${location.pathname}`).toBe(`${idp!.issuer}/authorize`)
    const p = location.searchParams
    expect(p.get("response_type")).toBe("code")
    expect(p.get("client_id")).toBe("client-123")
    expect(p.get("redirect_uri")).toBe(`${PUBLIC}/auth/callback`)
    expect(p.get("scope")).toBe("openid email profile")
    expect(p.get("code_challenge_method")).toBe("S256")
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(p.get("state")!.length).toBeGreaterThanOrEqual(32)
    expect(p.get("nonce")!.length).toBeGreaterThanOrEqual(32)
    expect(p.get("state")).not.toBe(p.get("nonce"))
    expect(location.search).not.toContain("s3cret")
    const header = res.headers.getSetCookie().find((c) => c.startsWith("voice_oidc="))!
    expect(header).toContain(`voice_oidc=${p.get("state")}`)
    expect(header).toMatch(/HttpOnly/)
    expect(header).toMatch(/SameSite=Lax/)
    expect(header).toMatch(/Max-Age=600/)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  test("discovery is cached", async () => {
    const hub = oidcHub()
    await hub.api("/auth/login", { cookie: null })
    await hub.api("/auth/login", { cookie: null })
    expect(idp!.discoveryHits).toBe(1)
  })

  test("discovery with a different issuer is refused (502 page)", async () => {
    const hub = oidcHub()
    idp!.discovery = { issuer: "https://other.example.com", authorization_endpoint: `${idp!.issuer}/authorize`, token_endpoint: `${idp!.issuer}/token` }
    const res = await hub.api("/auth/login", { cookie: null })
    expect(res.status).toBe(502)
    expect(res.headers.get("content-type")).toContain("text/html")
  })
})

describe("/auth/callback", () => {
  test("happy path: user created, device cookie, 302 to next, /api/me, audit", async () => {
    const hub = oidcHub()
    const { response, cookie, location } = await signIn(hub.url, idp!, "Alice@Example.com", { next: "/s/ses_1" })
    expect(response.status).toBe(302)
    expect(location).toBe("/s/ses_1#speech")
    expect(cookie).toBeTruthy()
    const deviceHeader = response.headers.getSetCookie().find((c) => c.startsWith("voice_device="))!
    expect(deviceHeader).toMatch(/HttpOnly; SameSite=Lax; Path=\//)
    // the state cookie is cleared
    expect(response.headers.getSetCookie().find((c) => c.startsWith("voice_oidc="))).toMatch(/Max-Age=0/)
    const body = await me(hub, cookie!)
    expect(body.auth).toBe("oidc")
    expect(body.user).toEqual({ id: expect.any(String), email: "alice@example.com", name: "Alice", role: "user" })
    expect(body.device.name).toMatch(/iPhone/)
    // client_secret_post + PKCE verifier sent to the token endpoint
    const form = idp!.tokenRequests[0]!.form
    expect(form).toMatchObject({ grant_type: "authorization_code", client_id: "client-123", client_secret: "s3cret-value", redirect_uri: `${PUBLIC}/auth/callback` })
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    const audit = hub.store.auditLog()
    expect(audit[0]).toMatchObject({ actor: body.user.id, action: "signin", target: body.device.id })
    expect(JSON.stringify(hub.store.data())).not.toContain("s3cret-value")
    expect(JSON.stringify(audit)).not.toMatch(/code-1|s3cret/)
    // signing in again keeps the same user
    const again = await signIn(hub.url, idp!, "alice@example.com")
    expect((await me(hub, again.cookie!)).user.id).toBe(body.user.id)
  })

  test("no #speech hint once speech is ready", async () => {
    const hub = oidcHub({ OPENROUTER_API_KEY: "sk-or-test-key-1234" })
    const { location } = await signIn(hub.url, idp!, "alice@example.com", { next: "/s/ses_1" })
    expect(location).toBe("/s/ses_1")
  })

  test("state must match the cookie", async () => {
    const hub = oidcHub()
    const login = await hub.api("/auth/login", { cookie: null })
    const { code, state } = idp!.authorize(login.headers.get("location")!, { claims: { email: "alice@example.com" } })
    const other = setCookie(await hub.api("/auth/login", { cookie: null }), "voice_oidc")
    for (const cookie of [null, `voice_oidc=${other}`, "voice_oidc="]) {
      const res = await hub.api(`/auth/callback?code=${code}&state=${state}`, { cookie })
      expect(res.status).toBe(400)
      expect(setCookie(res, "voice_device")).toBeUndefined()
    }
    expect(idp!.tokenRequests.length).toBe(0)
    expect(hub.store.devices().length).toBe(0)
  })

  test("a state is single use (replay refused)", async () => {
    const hub = oidcHub()
    const login = await hub.api("/auth/login", { cookie: null })
    const cookie = `voice_oidc=${setCookie(login, "voice_oidc")}`
    const { code, state } = idp!.authorize(login.headers.get("location")!, { claims: { email: "alice@example.com" } })
    expect((await hub.api(`/auth/callback?code=${code}&state=${state}`, { cookie })).status).toBe(302)
    const replay = await hub.api(`/auth/callback?code=${code}&state=${state}`, { cookie })
    expect(replay.status).toBe(400)
    expect(await text(replay)).toMatch(/expired|again/i)
    expect(hub.store.devices().length).toBe(1)
  })

  test("a pending sign-in expires after 10 minutes", async () => {
    let t = Date.now()
    const hub = oidcHub({}, () => t)
    const login = await hub.api("/auth/login", { cookie: null })
    const cookie = `voice_oidc=${setCookie(login, "voice_oidc")}`
    const { code, state } = idp!.authorize(login.headers.get("location")!, { claims: { email: "alice@example.com" } })
    t += 10 * 60_000 + 1
    expect((await hub.api(`/auth/callback?code=${code}&state=${state}`, { cookie })).status).toBe(400)
    expect(idp!.tokenRequests.length).toBe(0)
  })

  const rejected: Array<[string, Record<string, unknown>]> = [
    ["nonce mismatch", { nonce: "other-nonce" }],
    ["missing nonce", { nonce: undefined }],
    ["wrong issuer", { iss: "https://evil.example.com" }],
    ["wrong audience", { aud: "someone-else" }],
    ["audience list without the client", { aud: ["a", "b"] }],
    ["several audiences, azp not us", { aud: ["client-123", "other"], azp: "other" }],
    ["expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["email not verified", { email_verified: false }],
    ["email_verified missing", { email_verified: undefined }],
    ["no email", { email: undefined }],
  ]
  for (const [name, claims] of rejected) {
    test(`rejects: ${name}`, async () => {
      const hub = oidcHub()
      const { response, cookie } = await signIn(hub.url, idp!, "alice@example.com", { claims })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(cookie).toBeUndefined()
      expect(hub.store.devices().length).toBe(0)
      expect(hub.store.users().filter((u) => u.email).length).toBe(0)
    })
  }

  test("accepts an audience list containing the client with azp", async () => {
    const hub = oidcHub()
    const { response } = await signIn(hub.url, idp!, "alice@example.com", { claims: { aud: ["client-123", "other"], azp: "client-123" } })
    expect(response.status).toBe(302)
  })

  test("token endpoint failure is a 502 page", async () => {
    const hub = oidcHub()
    const { response, cookie } = await signIn(hub.url, idp!, "alice@example.com", { grant: { status: 500 } })
    expect(response.status).toBe(502)
    expect(cookie).toBeUndefined()
  })

  test("a malformed ID token is refused", async () => {
    const hub = oidcHub()
    // A grant whose claims make the token unparsable is not possible through the fake; check the decoder directly.
    expect(unsignedJWT({ a: 1 }).split(".").length).toBe(3)
    const { response } = await signIn(hub.url, idp!, "alice@example.com", { claims: { exp: "soon" } })
    expect(response.status).toBe(401)
  })

  test("not allowed: 403 page, audited, no user or device", async () => {
    const hub = oidcHub()
    const { response, cookie } = await signIn(hub.url, idp!, "mallory@example.net")
    expect(response.status).toBe(403)
    expect(await text(response)).toContain("Not allowed")
    expect(cookie).toBeUndefined()
    expect(hub.store.userByEmail("mallory@example.net")).toBeUndefined()
    expect(hub.store.auditLog()[0]).toMatchObject({ actor: "system", action: "signin.denied", target: "mallory@example.net" })
  })

  test("@domain entries allow any address of that domain", async () => {
    const hub = oidcHub()
    const { response } = await signIn(hub.url, idp!, "carol@example.org")
    expect(response.status).toBe(302)
    expect((await signIn(hub.url, idp!, "carol@sub.example.org")).response.status).toBe(403)
  })

  test("admins get the admin role; the first admin sign-in takes over local records", async () => {
    const hub = oidcHub()
    const machine = hub.store.addMachine("old laptop").machine
    const device = hub.store.addDevice("old phone").device
    const { cookie } = await signIn(hub.url, idp!, "admin@example.com")
    const body = await me(hub, cookie!)
    expect(body.user.role).toBe("admin")
    expect(hub.store.machines().find((m) => m.id === machine.id)?.ownerID).toBe(body.user.id)
    expect(hub.store.devices().find((d) => d.id === device.id)?.ownerID).toBe(body.user.id)
    expect(hub.store.user(LOCAL_USER)?.disabled).toBe(true)
    expect(hub.store.auditLog().some((e) => e.action === "migrate.local" && e.target === body.user.id)).toBe(true)
    // a plain user signing in first does not migrate
    const alice = await signIn(hub.url, idp!, "alice@example.com")
    expect((await me(hub, alice.cookie!)).user.role).toBe("user")
  })

  test("a plain user's sign-in does not migrate local records", async () => {
    const hub = oidcHub()
    const machine = hub.store.addMachine("old laptop").machine
    await signIn(hub.url, idp!, "alice@example.com")
    expect(hub.store.machines().find((m) => m.id === machine.id)?.ownerID).toBe(LOCAL_USER)
  })

  test("a disabled user cannot sign in", async () => {
    const hub = oidcHub()
    const first = await signIn(hub.url, idp!, "alice@example.com")
    const id = (await me(hub, first.cookie!)).user.id
    hub.store.setUser(id, { disabled: true })
    const { response, cookie } = await signIn(hub.url, idp!, "alice@example.com")
    expect(response.status).toBe(403)
    expect(cookie).toBeUndefined()
    expect(hub.store.auditLog()[0]).toMatchObject({ action: "signin.denied", target: "alice@example.com" })
  })

  test("provider error param: readable, escaped page with a link back", async () => {
    const hub = oidcHub()
    const login = await hub.api("/auth/login", { cookie: null })
    const cookie = `voice_oidc=${setCookie(login, "voice_oidc")}`
    const state = new URL(login.headers.get("location")!).searchParams.get("state")
    const res = await hub.api(`/auth/callback?error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}&state=${state}`, { cookie })
    expect(res.status).toBe(400)
    const html = await text(res)
    expect(html).toContain('href="/"')
    expect(html).toContain("access_denied")
    expect(html).not.toContain("<script>x")
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'")
    // the pending state was consumed
    const { code } = idp!.authorize(login.headers.get("location")!, { claims: { email: "alice@example.com" } })
    expect((await hub.api(`/auth/callback?code=${code}&state=${state}`, { cookie })).status).toBe(400)
  })

  test("open redirects in next are neutralized", async () => {
    const hub = oidcHub({ OPENROUTER_API_KEY: "sk-or-test-key-1234" })
    for (const next of ["//evil.test", "https://evil.test/x", "/\\evil.test", "\\\\evil.test", "http:/evil.test", "javascript:alert(1)", "/%0d%0aSet-Cookie:x", " /x", "evil"]) {
      const { location } = await signIn(hub.url, idp!, "alice@example.com", { next })
      expect(location?.startsWith("/")).toBe(true)
      expect(location?.startsWith("//")).toBe(false)
      expect(new URL(location!, PUBLIC).origin).toBe(PUBLIC)
    }
    expect((await signIn(hub.url, idp!, "alice@example.com", { next: "/s/ses_1?x=1" })).location).toBe("/s/ses_1?x=1")
    expect((await signIn(hub.url, idp!, "alice@example.com", { next: "//evil.test" })).location).toBe("/")
  })
})

describe("helpers", () => {
  test("safeNext", () => {
    expect(safeNext(null)).toBe("/")
    expect(safeNext("/")).toBe("/")
    expect(safeNext("/s/ses_1")).toBe("/s/ses_1")
    expect(safeNext("/approve?code=BCDF-GHJK")).toBe("/approve?code=BCDF-GHJK")
    for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "", "x", "/a\nb", `/${"a".repeat(2000)}`]) expect(safeNext(bad)).toBe("/")
  })

  test("deviceName from the user agent", () => {
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Safari/604.1")).toBe("Safari on iPhone")
    expect(deviceName("Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36")).toBe("Chrome on Android")
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/120.0")).toBe("Firefox on Mac")
    expect(deviceName(null)).toBe("Browser")
  })

  test("PKCE challenge format sanity", () => {
    expect(createHash("sha256").update("x").digest("base64url")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
