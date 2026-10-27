// App/agent tokens (P1-T7, design §1.3, §7): users create, list and revoke them on /api/agent/app-tokens; the
// hub stores sha256 hashes only and shows a token once; the app verifier resolves them to app actors, which
// reach /api/agent routes by scope (or app: true) and never a console route or token management.
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { BearerVerifier } from "../src/central/agent/actor"
import type { AgentRoute } from "../src/central/agent/routes"
import { hashToken } from "../src/central/store"
import { harness, type Harness } from "./central-harness"

const SESSION_TOKEN = "hst_fake_session"
const sessionVerifier: BearerVerifier = {
  kind: "session",
  verify: (token) => (token === SESSION_TOKEN ? { kind: "session", userID: "local", machineID: "mch_x", sessionID: "ses_1" } : undefined),
}
const ok = () => Response.json({ ok: true })
const testRoutes: AgentRoute[] = [
  { method: "GET", path: "/api/agent/test/read", allow: { scope: "sessions:read" }, handle: ok },
  { method: "GET", path: "/api/agent/test/x", allow: { scope: "x" }, handle: ok },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const start = async () => (h = await harness({ agent: { verifiers: [sessionVerifier], routes: testRoutes } }))
const bearer = (pathname: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } })
const json = async (r: Response) => (await r.json()) as any
const create = async (body: unknown = {}) => {
  const res = await h.api("/api/agent/app-tokens", { method: "POST", json: body })
  return { res, body: await json(res) }
}
const state = () => readFileSync(path.join(h.stateDir, "state.json"), "utf8")

describe("POST /api/agent/app-tokens", () => {
  test("creates a token, shown once: hat_<id>_<secret>, default scope sessions:read", async () => {
    await start()
    const { res, body } = await create({ label: "brain" })
    expect(res.status).toBe(201)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(body).toEqual({ id: expect.any(String), token: expect.any(String), label: "brain", scopes: ["sessions:read"], created: expect.any(Number) })
    const match = /^hat_([^_]+)_([A-Za-z0-9_-]+)$/.exec(body.token)
    expect(match).not.toBeNull()
    expect(match![1]).toBe(body.id)
    expect(Buffer.from(match![2]!, "base64url").length).toBeGreaterThanOrEqual(32)
  })

  test("no label: none stored; explicit scopes kept, duplicates dropped", async () => {
    await start()
    const { res, body } = await create({ scopes: ["sessions:read", "sessions:read"] })
    expect(res.status).toBe(201)
    expect(body.label).toBeUndefined()
    expect(body.scopes).toEqual(["sessions:read"])
  })

  test("messaging scopes: messages:send and messages:read", async () => {
    await start()
    const { res, body } = await create({ scopes: ["messages:send", "messages:read"] })
    expect(res.status).toBe(201)
    expect(body.scopes).toEqual(["messages:send", "messages:read"])
  })

  test("launch scope: sessions:launch (phase 4)", async () => {
    await start()
    const { res, body } = await create({ scopes: ["sessions:launch", "sessions:read"] })
    expect(res.status).toBe(201)
    expect(body.scopes).toEqual(["sessions:launch", "sessions:read"])
  })

  test("organizational scope: sessions:manage", async () => {
    await start()
    const { res, body } = await create({ scopes: ["sessions:manage", "sessions:read"] })
    expect(res.status).toBe(201)
    expect(body.scopes).toEqual(["sessions:manage", "sessions:read"])
  })

  test("only the sha256 hash reaches state.json", async () => {
    await start()
    const { body } = await create({ label: "brain" })
    const saved = state()
    expect(saved).not.toContain(body.token)
    expect(saved).not.toContain(body.token.split("_").slice(2).join("_"))
    expect(saved).toContain(hashToken(body.token))
  })

  test("rejects bad input with 400 invalid", async () => {
    await start()
    for (const bad of [[], "x", { label: 5 }, { label: "x".repeat(101) }, { scopes: "sessions:read" }, { scopes: ["sessions:write"] }, { scopes: [1] }]) {
      const { res, body } = await create(bad)
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 })
      expect(body.error.code).toBe("invalid")
    }
    expect((await create({ label: "x".repeat(100) })).res.status).toBe(201)
  })

  test("at most 50 tokens per user", async () => {
    await start()
    for (let i = 0; i < 50; i++) expect((await create()).res.status).toBe(201)
    const { res, body } = await create()
    expect(res.status).toBe(429)
    expect(body.error.code).toBe("rate_limited")
  })

  test("audits creation without the token", async () => {
    await start()
    const { body } = await create({ label: "brain" })
    const entry = h.store.auditLog().find((e) => e.action === "app-token.create")
    expect(entry).toMatchObject({ actor: "local", target: body.id })
    expect(JSON.stringify(h.store.auditLog())).not.toContain(body.token)
  })
})

describe("GET /api/agent/app-tokens", () => {
  test("lists the user's tokens without secrets or hashes", async () => {
    await start()
    const a = (await create({ label: "a" })).body
    const b = (await create()).body
    const res = await h.api("/api/agent/app-tokens")
    expect(res.status).toBe(200)
    const list = await json(res)
    expect(list).toEqual({
      tokens: [
        { id: a.id, label: "a", scopes: ["sessions:read"], created: a.created },
        { id: b.id, scopes: ["sessions:read"], created: b.created },
      ],
    })
    expect(JSON.stringify(list)).not.toContain("tokenHash")
  })
})

describe("DELETE /api/agent/app-tokens/:id", () => {
  test("revokes: 204, gone from the list, the token answers 401, audited", async () => {
    await start()
    const { body } = await create()
    expect((await bearer("/api/agent/whoami", body.token)).status).toBe(200)
    const res = await h.api(`/api/agent/app-tokens/${body.id}`, { method: "DELETE" })
    expect(res.status).toBe(204)
    expect((await json(await h.api("/api/agent/app-tokens"))).tokens).toEqual([])
    const after = await bearer("/api/agent/whoami", body.token)
    expect(after.status).toBe(401)
    expect((await json(after)).error.code).toBe("unauthorized")
    expect(h.store.auditLog().find((e) => e.action === "app-token.revoke")).toMatchObject({ actor: "local", target: body.id })
  })

  test("unknown id: 404 not_found", async () => {
    await start()
    const res = await h.api("/api/agent/app-tokens/nope", { method: "DELETE" })
    expect(res.status).toBe(404)
    expect((await json(res)).error.code).toBe("not_found")
  })

  test("another user's token: 404, still works", async () => {
    await start()
    const { body } = await create()
    // A second user, with their own device, tries to revoke it.
    const second = await addUser(h)
    const res = await h.api(`/api/agent/app-tokens/${body.id}`, { method: "DELETE", cookie: second })
    expect(res.status).toBe(404)
    expect((await bearer("/api/agent/whoami", body.token)).status).toBe(200)
  })
})

/** A second user with a device; returns its cookie. */
async function addUser(central: Harness): Promise<string> {
  const user = await central.store.upsertUser({ email: "other@example.com", role: "user" })
  return `voice_device=${(await central.store.addDevice("other phone", user.id)).token}`
}

describe("the app verifier", () => {
  test("an app token is an app actor on whoami", async () => {
    await start()
    const { body } = await create({ label: "brain" })
    const res = await bearer("/api/agent/whoami", body.token)
    expect(res.status).toBe(200)
    expect((await json(res)).actor).toEqual({ kind: "app", userID: "local", tokenID: body.id, scopes: ["sessions:read"], label: "brain" })
  })

  test("scopes decide which routes it reaches", async () => {
    await start()
    const { body } = await create()
    expect((await bearer("/api/agent/test/read", body.token)).status).toBe(200)
    const res = await bearer("/api/agent/test/x", body.token)
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe("forbidden")
  })

  test("refused on console routes with 403", async () => {
    await start()
    const { body } = await create()
    for (const pathname of ["/api/me", "/api/sessions", "/api/admin/users"]) {
      const res = await bearer(pathname, body.token)
      expect({ pathname, status: res.status }).toEqual({ pathname, status: 403 })
    }
  })

  test("session and app tokens cannot create, list or revoke app tokens", async () => {
    await start()
    const { body } = await create()
    for (const token of [SESSION_TOKEN, body.token]) {
      for (const [method, pathname] of [
        ["POST", "/api/agent/app-tokens"],
        ["GET", "/api/agent/app-tokens"],
        ["DELETE", `/api/agent/app-tokens/${body.id}`],
      ] as const) {
        const res = await bearer(pathname, token, method === "POST" ? { method, json: {} } : { method })
        expect({ method, status: res.status }).toEqual({ method, status: 403 })
        expect((await json(res)).error.code).toBe("forbidden")
      }
    }
    expect((await json(await h.api("/api/agent/app-tokens"))).tokens).toHaveLength(1)
  })

  test("the device token (bearer) may manage app tokens", async () => {
    await start()
    const res = await bearer("/api/agent/app-tokens", h.cookie.slice("voice_device=".length), { method: "POST", json: {} })
    expect(res.status).toBe(201)
  })

  test("disabled user: 401", async () => {
    await start()
    const { body } = await create()
    await h.store.setUser("local", { disabled: true })
    const res = await bearer("/api/agent/whoami", body.token)
    expect(res.status).toBe(401)
  })

  test("wrong secret, unknown id or garbage: 401", async () => {
    await start()
    const { body } = await create()
    const secret = body.token.slice(`hat_${body.id}_`.length)
    const flipped = secret[0] === "A" ? `B${secret.slice(1)}` : `A${secret.slice(1)}`
    for (const token of [`hat_${body.id}_${flipped}`, `hat_zzzz_${secret}`, `hat_${body.id}`, "hat_", "hat__x", body.token.slice(4)]) {
      const res = await bearer("/api/agent/whoami", token)
      expect({ token, status: res.status }).toEqual({ token, status: 401 })
    }
  })
})
