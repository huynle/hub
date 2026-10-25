// The SDK's typed phase-1 verbs: each sends the request the hub's /api/agent routes expect and answers the hub's
// body unchanged.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HubClient, isHubError } from "../src/index.ts"
import { fakeHub } from "./fake-hub.ts"

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const client = () => new HubClient({ url: hub.url, token: "tok" })
/** Answers `body` on `route` and returns what the hub saw. */
function answer(route: string, body: unknown = { ok: true }, status = 200) {
  hub.routes[route] = () => (status === 204 ? new Response(null, { status }) : Response.json(body, { status }))
  return hub.seen
}
const seen = () => hub.seen.map(({ method, path, body }) => ({ method, path, ...(body !== undefined ? { body } : {}) }))

describe("reading", () => {
  test("whoami", async () => {
    const body = { actor: { kind: "session" as const, userID: "u1", machineID: "m1", sessionID: "ses_1" }, user: { id: "u1" } }
    answer("GET /api/agent/whoami", body)
    const me = await client().whoami()
    expect(me).toEqual(body)
    expect(me.actor.kind).toBe("session")
    expect(seen()).toEqual([{ method: "GET", path: "/api/agent/whoami" }])
  })

  test("status", async () => {
    const body = { machines: [], attention: [] }
    answer("GET /api/agent/status", body)
    expect(await client().status()).toEqual(body)
    expect(seen()).toEqual([{ method: "GET", path: "/api/agent/status" }])
  })

  test("sessions, with and without filters (states joined by commas, labels repeated)", async () => {
    const body = { sessions: [{ id: "ses_1", state: "idle" }] }
    answer("GET /api/agent/sessions", body)
    expect(await client().sessions()).toEqual(body)
    await client().sessions({ project: "hub", state: ["idle", "working"], machine: "mbp", label: ["team=a", "x=y"] })
    await client().sessions({ state: "blocked" })
    expect(seen().map((s) => s.path)).toEqual([
      "/api/agent/sessions",
      "/api/agent/sessions?project=hub&state=idle%2Cworking&machine=mbp&label=team%3Da&label=x%3Dy",
      "/api/agent/sessions?state=blocked",
    ])
  })

  test("show: the address is one path segment, @ kept readable", async () => {
    answer("GET /api/agent/sessions/@api.hub", { id: "ses_1", state: "idle" })
    expect(await client().show("@api.hub")).toEqual({ id: "ses_1", state: "idle" })
    await client().show("a/b c").catch(() => {})
    expect(seen().map((s) => s.path)).toEqual(["/api/agent/sessions/@api.hub", "/api/agent/sessions/a%2Fb%20c"])
  })

  test("log, with an optional row count", async () => {
    answer("GET /api/agent/sessions/ses_1/log", { rows: [] })
    expect(await client().log("ses_1")).toEqual({ rows: [] })
    await client().log("ses_1", { n: 5 })
    await client().log("ses_1", { n: "7" })
    expect(seen().map((s) => s.path)).toEqual(["/api/agent/sessions/ses_1/log", "/api/agent/sessions/ses_1/log?n=5", "/api/agent/sessions/ses_1/log?n=7"])
  })

  test("who, by project and role (a leading @@ is dropped)", async () => {
    answer("GET /api/agent/who", { sessions: [] })
    expect(await client().who()).toEqual({ sessions: [] })
    await client().who({ project: "hub", role: "@@reviewer" })
    expect(seen().map((s) => s.path)).toEqual(["/api/agent/who", "/api/agent/who?project=hub&role=reviewer"])
  })
})

describe("naming", () => {
  test("name, for this session or another", async () => {
    answer("POST /api/agent/name", { sessionID: "ses_1", name: "api" })
    expect(await client().name("@api")).toEqual({ sessionID: "ses_1", name: "api" })
    await client().name("@api", { session: "ses_2" })
    expect(seen()).toEqual([
      { method: "POST", path: "/api/agent/name", body: { name: "@api" } },
      { method: "POST", path: "/api/agent/name", body: { name: "@api", session: "ses_2" } },
    ])
  })

  test("claimRole: @@ dropped, exclusive only when set, session and project when given", async () => {
    answer("POST /api/agent/roles/claim", { sessionID: "ses_1", role: "reviewer" })
    expect(await client().claimRole("@@reviewer")).toEqual({ sessionID: "ses_1", role: "reviewer" })
    await client().claimRole("reviewer.hub", { exclusive: true, session: "ses_2" })
    await client().claimRole("reviewer", { exclusive: false, project: "hub" })
    expect(seen().map((s) => s.body)).toEqual([{ role: "reviewer" }, { role: "reviewer.hub", exclusive: true, session: "ses_2" }, { role: "reviewer", project: "hub" }])
  })

  test("releaseRole", async () => {
    answer("POST /api/agent/roles/release", { sessionID: "ses_1", role: "reviewer", released: true })
    expect(await client().releaseRole("@@reviewer", { session: "ses_1" })).toEqual({ sessionID: "ses_1", role: "reviewer", released: true })
    expect(seen()).toEqual([{ method: "POST", path: "/api/agent/roles/release", body: { role: "reviewer", session: "ses_1" } }])
  })
})

describe("app tokens (user credentials)", () => {
  test("create, list and revoke", async () => {
    answer("POST /api/agent/app-tokens", { id: "t1", label: "ci", scopes: [], token: "hat_t1_x" }, 201)
    answer("GET /api/agent/app-tokens", { tokens: [{ id: "t1", label: "ci", scopes: [] }] })
    answer("DELETE /api/agent/app-tokens/t1", undefined, 204)
    expect((await client().createAppToken({ label: "ci", scopes: ["sessions:read"] })).token).toBe("hat_t1_x")
    expect((await client().appTokens()).tokens[0]!.id).toBe("t1")
    expect(await client().revokeAppToken("t1")).toBeUndefined()
    expect(seen()).toEqual([
      { method: "POST", path: "/api/agent/app-tokens", body: { label: "ci", scopes: ["sessions:read"] } },
      { method: "GET", path: "/api/agent/app-tokens" },
      { method: "DELETE", path: "/api/agent/app-tokens/t1" },
    ])
  })
})

test("verbs reject with the hub's envelope", async () => {
  hub.routes["GET /api/agent/sessions/@nope"] = () => Response.json({ error: { code: "not_found", message: "No session @nope" } }, { status: 404 })
  const error = await client().show("@nope").catch((e: unknown) => e)
  expect(isHubError(error, "not_found")).toBe(true)
})
