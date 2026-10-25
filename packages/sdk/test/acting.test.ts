// The SDK's act verbs (design §5, §8; decision wvqeuis0) and the user's grants: each sends the request the hub's
// /api/agent routes expect (acting-routes.ts, grant-routes.ts) and answers the hub's body unchanged; needs_user
// keeps its evaluation.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HubClient, HubError, needsUserOf, type Approved, type Evaluation, type Grant } from "../src/index.ts"
import { fakeHub } from "./fake-hub.ts"

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const client = () => new HubClient({ url: hub.url, token: "tok" })
function answer(route: string, body: unknown = { ok: true }, status = 200) {
  hub.routes[route] = () => Response.json(body, { status })
}
const seen = () => hub.seen.map(({ method, path, body }) => ({ method, path, ...(body !== undefined ? { body } : {}) }))

describe("act verbs", () => {
  test("approve: {requestID}; always and why only when given", async () => {
    const body: Approved = { sessionID: "ses_1", requestID: "per_1", decision: "once", grant: "g_1" }
    answer("POST /api/agent/sessions/@api/approve", body)
    expect(await client().approve("@api", "per_1")).toEqual(body)
    await client().approve("@api", "per_1", { always: true, why: "only runs tests" })
    expect(seen()).toEqual([
      { method: "POST", path: "/api/agent/sessions/@api/approve", body: { requestID: "per_1" } },
      { method: "POST", path: "/api/agent/sessions/@api/approve", body: { requestID: "per_1", always: true, why: "only runs tests" } },
    ])
  })

  test("deny: {requestID, why?}", async () => {
    answer("POST /api/agent/sessions/ses_1/deny", { sessionID: "ses_1", requestID: "per_1", reasonSent: true })
    expect(await client().deny("ses_1", "per_1", { why: "pushes to main" })).toEqual({ sessionID: "ses_1", requestID: "per_1", reasonSent: true })
    await client().deny("ses_1", "per_2")
    expect(seen().map((s) => s.body)).toEqual([{ requestID: "per_1", why: "pushes to main" }, { requestID: "per_2" }])
  })

  test("answer: {formID, answer, why?}; cancelForm: {formID, cancel: true}", async () => {
    answer("POST /api/agent/sessions/@api/answer", { sessionID: "ses_1", formID: "que_1" })
    expect(await client().answer("@api", "que_1", { choice: "yes", tags: ["a", "b"] }, { why: "asked for" })).toEqual({ sessionID: "ses_1", formID: "que_1" })
    await client().cancelForm("@api", "que_1")
    expect(seen().map((s) => s.body)).toEqual([
      { formID: "que_1", answer: { choice: "yes", tags: ["a", "b"] }, why: "asked for" },
      { formID: "que_1", cancel: true },
    ])
  })

  test("prompt: {text, delivery?, wake?, why?}", async () => {
    answer("POST /api/agent/sessions/@api/prompt", { sessionID: "ses_1", messageID: "msg_1", delivered: "turn", grant: "g_1" })
    expect(await client().prompt("@api", "run the tests")).toMatchObject({ messageID: "msg_1" })
    await client().prompt("@api", "steer", { delivery: "steer", why: "faster" })
    expect(seen().map((s) => s.body)).toEqual([{ text: "run the tests" }, { text: "steer", delivery: "steer", why: "faster" }])
  })

  test("stop: {why?}", async () => {
    answer("POST /api/agent/sessions/@api/stop", { sessionID: "ses_1", result: { stopped: true } })
    expect(await client().stop("@api")).toEqual({ sessionID: "ses_1", result: { stopped: true } })
    await client().stop("@api", { why: "looping" })
    expect(seen().map((s) => s.body)).toEqual([{}, { why: "looping" }])
  })

  test("needs_user: a HubError whose evaluation (and decision) needsUserOf reads", async () => {
    const evaluation: Evaluation = { verdict: "outside", reason: "shell git push is outside g_1", tier: "tap", grants: ["g_1"] }
    answer("POST /api/agent/sessions/@api/approve", { error: { code: "needs_user", message: "Needs the user", evaluation, decisionID: "dec_1" } }, 403)
    const error = await client().approve("@api", "per_1").catch((e) => e)
    expect(error).toBeInstanceOf(HubError)
    expect(error.code).toBe("needs_user")
    expect(needsUserOf(error)).toEqual({ evaluation, decisionID: "dec_1" })
    expect(needsUserOf(new Error("x"))).toBeUndefined()
  })
})

describe("grants (user credentials only)", () => {
  const grant: Grant = { id: "g_1", holder: "@@orchestrator", scope: { projects: ["/p"] }, allow: ["approve"], permissions: { allow: ["read"], never: [] }, allowAlways: false, maxActionsPerHour: 60, created: 1, expiresAt: 2, state: "active" }

  test("list, show, create, update, revoke", async () => {
    answer("GET /api/agent/grants", { grants: [grant] })
    answer("GET /api/agent/grants/g_1", { grant })
    answer("POST /api/agent/grants", { grant }, 201)
    answer("PUT /api/agent/grants/g_1", { grant })
    answer("DELETE /api/agent/grants/g_1", { grant: { ...grant, state: "revoked" } })
    expect(await client().grants()).toEqual({ grants: [grant] })
    expect(await client().grant("g_1")).toEqual({ grant })
    const spec = { holder: "@@orchestrator", scope: { projects: ["/p"] }, allow: ["approve" as const], expires: "8h" }
    expect(await client().createGrant(spec)).toEqual({ grant })
    await client().updateGrant("g_1", spec)
    expect((await client().revokeGrant("g_1")).grant.state).toBe("revoked")
    expect(seen()).toEqual([
      { method: "GET", path: "/api/agent/grants" },
      { method: "GET", path: "/api/agent/grants/g_1" },
      { method: "POST", path: "/api/agent/grants", body: spec },
      { method: "PUT", path: "/api/agent/grants/g_1", body: spec },
      { method: "DELETE", path: "/api/agent/grants/g_1" },
    ])
  })
})
