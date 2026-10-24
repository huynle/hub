// The credential × route-class matrix over HTTP (design §14.2), the /api/agent framework, GET /.well-known/hub
// and GET /api/agent/whoami. Session and app tokens come from fake verifiers here (the real ones are P1-T5 and
// P1-T7): they must reach /api/agent only, never a console route.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, PUBLIC, session, spoke, type Harness } from "./central-harness"
import { fakeProvider, oidcEnv, type FakeProvider } from "./oidc-fake"

const SESSION_TOKEN = "hst_fake_session"
const APP_TOKEN = "hat_fake_app"
const EXPIRED_TOKEN = "hst_fake_expired"

const verifiers: BearerVerifier[] = [
  {
    kind: "session",
    verify: (token) =>
      token === SESSION_TOKEN ? { kind: "session", userID: "local", machineID: "mch_x", sessionID: "ses_1" } : token === EXPIRED_TOKEN ? "expired" : undefined,
  },
  { kind: "app", verify: (token) => (token === APP_TOKEN ? { kind: "app", userID: "local", tokenID: "tok_1", scopes: ["sessions:read"] } : undefined) },
]

let h: Harness
let idp: FakeProvider | undefined
afterEach(async () => {
  await h?.stop()
  idp?.stop()
  idp = undefined
})

const start = (extra: Parameters<typeof harness>[0] = {}) => (h = harness({ agent: { verifiers }, ...extra } as any))
/** The device token: the same secret as the device cookie. */
const deviceToken = () => h.cookie.slice("voice_device=".length)
/** A bearer request: no cookie and no Origin (a native app or CLI). */
const bearer = (pathname: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } })
const json = async (r: Response) => (await r.json()) as any

describe("GET /.well-known/hub", () => {
  test("public discovery document, no credential needed, cached briefly", async () => {
    start()
    const res = await h.api("/.well-known/hub", { cookie: null, origin: null })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, max-age=60")
    expect(await res.json()).toEqual({
      publicURL: PUBLIC,
      version: "9.9.9",
      minClientVersion: "0.0.0",
      auth: { modes: ["pairing"] },
      features: [],
    })
  })

  test("an OIDC hub names its issuer; pairing codes still work there", async () => {
    idp = fakeProvider()
    start({ env: oidcEnv(idp), noDevice: true })
    const body = await json(await h.api("/.well-known/hub", { cookie: null, origin: null }))
    expect(body.auth).toEqual({ modes: ["oidc", "pairing"], oidc: { issuer: idp.issuer } })
  })
})

describe("GET /api/agent/whoami", () => {
  test("cookie: the user actor via cookie", async () => {
    start()
    const me = await json(await h.api("/api/me"))
    const res = await h.api("/api/agent/whoami")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      actor: { kind: "user", userID: "local", deviceID: me.device.id, via: "cookie" },
      user: { id: "local", role: "admin" },
    })
  })

  test("device token: the same device via device-token", async () => {
    start()
    const me = await json(await h.api("/api/me"))
    const res = await bearer("/api/agent/whoami", deviceToken())
    expect(res.status).toBe(200)
    expect((await res.json()).actor).toEqual({ kind: "user", userID: "local", deviceID: me.device.id, via: "device-token" })
  })

  test("session and app tokens see their own actor", async () => {
    start()
    expect((await json(await bearer("/api/agent/whoami", SESSION_TOKEN))).actor).toEqual({ kind: "session", userID: "local", machineID: "mch_x", sessionID: "ses_1" })
    expect((await json(await bearer("/api/agent/whoami", APP_TOKEN))).actor).toEqual({ kind: "app", userID: "local", tokenID: "tok_1", scopes: ["sessions:read"] })
  })
})

describe("device token on console routes (native apps)", () => {
  test("reads and writes like the cookie, without Origin", async () => {
    start()
    const viaCookie = await json(await h.api("/api/me"))
    const res = await bearer("/api/me", deviceToken())
    expect(res.status).toBe(200)
    expect((await res.json()).device.id).toBe(viaCookie.device.id)
    const put = await bearer("/api/prefs/view", deviceToken(), { method: "PUT", json: { pinnedSessions: ["ses_1"] } })
    expect(put.status).toBe(200)
    expect((await json(await h.api("/api/prefs/view"))).prefs.pinnedSessions).toEqual(["ses_1"])
  })

  test("session ownership and admin checks apply as for the cookie", async () => {
    start()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    try {
      expect((await bearer("/api/sessions/ses_1", deviceToken())).status).toBe(200)
      expect((await bearer("/api/sessions/ses_other", deviceToken())).status).toBe(404)
      expect((await bearer("/api/admin/users", deviceToken())).status).toBe(200)
    } finally {
      client.close()
    }
  })

  test("the cookie still needs the same origin for writes", async () => {
    start()
    const res = await h.api("/api/prefs/view", { method: "PUT", origin: null, json: { pinnedSessions: [] } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Cross-origin request refused" })
  })
})

describe("session and app tokens never reach console routes", () => {
  test("every non-public console route refuses them with 403 forbidden (old envelope) and nothing runs", async () => {
    start()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    try {
      const consoleRoutes = h.routes.filter((r) => r.access !== "public" && r.access !== "agent")
      expect(consoleRoutes.length).toBeGreaterThan(40)
      for (const token of [SESSION_TOKEN, APP_TOKEN]) {
        for (const route of consoleRoutes) {
          const pathname = route.path.replace(":session", "ses_1").replace(/:[a-z]+/g, "x")
          const init = route.method === "GET" || route.method === "DELETE" ? { method: route.method } : { method: route.method, json: { text: "hi" } }
          const res = await bearer(pathname, token, init)
          const label = `${token} ${route.method} ${route.path}`
          expect({ label, status: res.status }).toEqual({ label, status: 403 })
          expect(await res.json()).toEqual({ error: "This token cannot be used here", code: "forbidden" })
        }
      }
      expect(client.frames.filter((f) => f.t === "req")).toEqual([])
    } finally {
      client.close()
    }
  })
})

describe("credential errors", () => {
  test("cookie and bearer together: 400 invalid, in each route class's envelope", async () => {
    start()
    const mixed = { headers: { authorization: `Bearer ${deviceToken()}` } }
    const consoleRes = await h.api("/api/me", mixed)
    expect(consoleRes.status).toBe(400)
    expect(await consoleRes.json()).toEqual({ error: "Send the device cookie or a bearer token, not both", code: "invalid" })
    const agentRes = await h.api("/api/agent/whoami", mixed)
    expect(agentRes.status).toBe(400)
    expect((await agentRes.json()).error).toEqual({ code: "invalid", message: "Send the device cookie or a bearer token, not both" })
  })

  test("unknown bearer: 401 with the agent envelope on /api/agent, the old envelope elsewhere", async () => {
    start()
    const agentRes = await bearer("/api/agent/whoami", "nope")
    expect(agentRes.status).toBe(401)
    expect((await agentRes.json()).error).toMatchObject({ code: "unauthorized" })
    const consoleRes = await bearer("/api/me", "nope")
    expect(consoleRes.status).toBe(401)
    expect(await consoleRes.json()).toEqual({ error: "Invalid or revoked token", code: "unauthorized" })
    // A POST with an unknown bearer is refused as unauthorized, not as cross-origin.
    expect((await bearer("/api/prefs/view", "nope", { method: "PUT", json: {} })).status).toBe(401)
  })

  test("expired token: 401 token_expired", async () => {
    start()
    const agentRes = await bearer("/api/agent/whoami", EXPIRED_TOKEN)
    expect(agentRes.status).toBe(401)
    expect((await agentRes.json()).error.code).toBe("token_expired")
    expect(await json(await bearer("/api/me", EXPIRED_TOKEN))).toEqual({ error: "Token expired", code: "token_expired" })
  })

  test("no credential on /api/agent: 401 unauthorized envelope; console keeps its message", async () => {
    start()
    const res = await h.api("/api/agent/whoami", { cookie: null })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("unauthorized")
    expect(await json(await h.api("/api/me", { cookie: null }))).toEqual({ error: "This device is not paired" })
  })

  test("unknown agent route: 404 not_found once signed in", async () => {
    start()
    const res = await h.api("/api/agent/nope")
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe("not_found")
  })
})

describe("/api/agent route classes and same-origin", () => {
  const routes = [
    { method: "POST", path: "/api/agent/test/echo/:addr", allow: { session: true }, handle: ({ actor, params }: any) => Response.json({ kind: actor.kind, addr: params.addr }) },
    { method: "POST", path: "/api/agent/test/manage", allow: {}, handle: () => Response.json({ ok: true }) },
    { method: "POST", path: "/api/agent/test/read", allow: { scope: "sessions:read" }, handle: () => Response.json({ ok: true }) },
    { method: "POST", path: "/api/agent/test/launch", allow: { scope: "sessions:launch" }, handle: () => Response.json({ ok: true }) },
    { method: "POST", path: "/api/agent/test/boom", allow: {}, handle: () => { throw new Error("internal detail") } },
  ]
  const startWithRoutes = () => start({ agent: { verifiers, routes } } as any)

  test("bearer POST without Origin is accepted (device, session token); cookie POST needs the same origin", async () => {
    startWithRoutes()
    expect(await json(await bearer("/api/agent/test/echo/%40api", deviceToken(), { method: "POST", json: {} }))).toEqual({ kind: "user", addr: "@api" })
    expect(await json(await bearer("/api/agent/test/echo/x", SESSION_TOKEN, { method: "POST", json: {} }))).toEqual({ kind: "session", addr: "x" })
    expect(await json(await h.api("/api/agent/test/echo/x", { method: "POST", json: {} }))).toEqual({ kind: "user", addr: "x" })
    const crossOrigin = await h.api("/api/agent/test/echo/x", { method: "POST", origin: null, json: {} })
    expect(crossOrigin.status).toBe(403)
    expect((await crossOrigin.json()).error).toEqual({ code: "forbidden", message: "Cross-origin request refused" })
    const evil = await h.api("/api/agent/test/echo/x", { method: "POST", origin: "https://evil.example", json: {} })
    expect(evil.status).toBe(403)
  })

  test("user-only routes (token management) refuse session and app tokens", async () => {
    startWithRoutes()
    expect((await bearer("/api/agent/test/manage", deviceToken(), { method: "POST" })).status).toBe(200)
    for (const token of [SESSION_TOKEN, APP_TOKEN]) {
      const res = await bearer("/api/agent/test/manage", token, { method: "POST" })
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe("forbidden")
    }
  })

  test("app tokens by scope only", async () => {
    startWithRoutes()
    expect((await bearer("/api/agent/test/read", APP_TOKEN, { method: "POST" })).status).toBe(200)
    expect((await bearer("/api/agent/test/launch", APP_TOKEN, { method: "POST" })).status).toBe(403)
    expect((await bearer("/api/agent/test/echo/x", APP_TOKEN, { method: "POST" })).status).toBe(403)
    expect((await bearer("/api/agent/test/read", SESSION_TOKEN, { method: "POST" })).status).toBe(403)
  })

  test("handler failures answer the agent envelope without internals", async () => {
    startWithRoutes()
    const original = console.error
    console.error = () => {}
    try {
      const res = await h.api("/api/agent/test/boom", { method: "POST" })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: { code: "internal", message: "Internal error" } })
    } finally {
      console.error = original
    }
  })

  test("agent routes are in the route table as access agent", () => {
    startWithRoutes()
    expect(h.routes).toContainEqual({ method: "GET", path: "/api/agent/whoami", access: "agent" })
    expect(h.routes).toContainEqual({ method: "POST", path: "/api/agent/test/echo/:addr", access: "agent" })
  })
})
