// /api/agent/grants through the hub (P3-T2, design §5, §7): users create, list, read, edit and revoke their
// grants (device cookie, same origin, or device token); session and app tokens never touch grants.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, type Harness } from "./central-harness"

const SESSION_TOKEN = "hst_fake_session"
const APP_TOKEN = "hat_fake_app"
const verifiers: BearerVerifier[] = [
  { kind: "session", verify: (token) => (token === SESSION_TOKEN ? { kind: "session", userID: "local", machineID: "mch_x", sessionID: "ses_1" } : undefined) },
  { kind: "app", verify: (token) => (token === APP_TOKEN ? { kind: "app", userID: "local", tokenID: "tok_1", scopes: ["sessions:read", "messages:send", "messages:read"] } : undefined) },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const bearer = (pathname: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token}` } })
const GRANT = { holder: "@@orchestrator", scope: { projects: ["/Users/huy/projects/hub"] }, allow: ["approve", "deny"], permissions: { allow: ["bash:bun test*"], never: ["bash:git push*"] }, expires: "2h" }
const PREFIX = "/api/agent/grants"

describe("/api/agent/grants", () => {
  test("its routes are agent routes", () => {
    h = harness({ agent: { verifiers } } as any)
    for (const [method, path] of [
      ["POST", PREFIX],
      ["GET", PREFIX],
      ["GET", `${PREFIX}/:id`],
      ["PUT", `${PREFIX}/:id`],
      ["DELETE", `${PREFIX}/:id`],
    ] as const) {
      expect(h.routes).toContainEqual({ method, path, access: "agent" })
    }
  })

  test("the user creates, lists, reads, edits and revokes a grant", async () => {
    h = harness({ agent: { verifiers } } as any)
    const created = await h.api(PREFIX, { method: "POST", json: GRANT })
    expect(created.status).toBe(201)
    expect(created.headers.get("cache-control")).toBe("no-store")
    const grant = (await json(created)).grant
    expect(grant).toMatchObject({ holder: "@@orchestrator", allow: ["approve", "deny"], permissions: { allow: ["shell:bun test*"], never: ["shell:git push*"] }, state: "active" })
    expect(grant.expiresAt - grant.created).toBe(2 * 3_600_000)
    expect("owner" in grant).toBe(false)

    expect((await json(await h.api(PREFIX))).grants.map((g: any) => g.id)).toEqual([grant.id])
    expect((await json(await h.api(`${PREFIX}/${grant.id}`))).grant.id).toBe(grant.id)

    const edited = await h.api(`${PREFIX}/${grant.id}`, { method: "PUT", json: { ...GRANT, allow: ["answer"] } })
    expect(edited.status).toBe(200)
    expect((await json(edited)).grant).toMatchObject({ id: grant.id, allow: ["answer"], state: "active" })

    const revoked = await h.api(`${PREFIX}/${grant.id}`, { method: "DELETE" })
    expect(revoked.status).toBe(200)
    expect((await json(revoked)).grant).toMatchObject({ id: grant.id, state: "revoked" })
    const again = await h.api(`${PREFIX}/${grant.id}`, { method: "DELETE" })
    expect(again.status).toBe(410)
    expect((await json(again)).error.code).toBe("gone")
  })

  test("a device token (bearer) may manage grants too", async () => {
    h = harness({ agent: { verifiers } } as any)
    const deviceToken = h.cookie.slice("voice_device=".length)
    const res = await bearer(PREFIX, deviceToken, { method: "POST", json: GRANT })
    expect(res.status).toBe(201)
  })

  test("invalid grants and unknown ids answer the agent envelope", async () => {
    h = harness({ agent: { verifiers } } as any)
    const bad = await h.api(PREFIX, { method: "POST", json: { ...GRANT, allow: ["delete"] } })
    expect(bad.status).toBe(400)
    expect((await json(bad)).error.code).toBe("invalid")
    const missing = await h.api(`${PREFIX}/g_0123456789abcdef`)
    expect(missing.status).toBe(404)
    expect((await json(missing)).error.code).toBe("not_found")
    const notJSON = await h.api(PREFIX, { method: "POST", body: "{", headers: { "content-type": "application/json" } })
    expect(notJSON.status).toBe(400)
  })

  test("a cross-origin cookie write is refused", async () => {
    h = harness({ agent: { verifiers } } as any)
    const res = await h.api(PREFIX, { method: "POST", json: GRANT, origin: "http://evil.test" })
    expect(res.status).toBe(403)
    expect((await json(await h.api(PREFIX))).grants).toEqual([])
  })

  test("session and app tokens can neither create nor read grants (403 forbidden)", async () => {
    h = harness({ agent: { verifiers } } as any)
    const id = (await json(await h.api(PREFIX, { method: "POST", json: GRANT }))).grant.id
    for (const token of [SESSION_TOKEN, APP_TOKEN]) {
      for (const [method, path, body] of [
        ["POST", PREFIX, GRANT],
        ["GET", PREFIX],
        ["GET", `${PREFIX}/${id}`],
        ["PUT", `${PREFIX}/${id}`, GRANT],
        ["DELETE", `${PREFIX}/${id}`],
      ] as const) {
        const res = await bearer(path, token, { method, ...(body ? { json: body } : {}) })
        expect(res.status).toBe(403)
        expect((await json(res)).error.code).toBe("forbidden")
      }
    }
    expect((await json(await h.api(`${PREFIX}/${id}`))).grant.state).toBe("active")
  })
})
