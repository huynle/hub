// The OpenCode `hub` tool's act verbs (approve, deny, answer, prompt, stop; decision wvqeuis0 #1): sent with the
// session's act token only (Spoke.actIdentity), never its shell token; a session without one gets a clear error and
// no request; needs_user reads as "the user decides", with the evaluation. Against a fake hub.
import { afterEach, describe, expect, test } from "bun:test"
import { HUB_TOOL_ACT_VERBS, HUB_TOOL_DESCRIPTION, HUB_TOOL_INPUT, HUB_TOOL_VERBS, runHubTool, verbCredential, type HubToolSpoke } from "../src/spoke/hub-tool"
import { stopServer } from "./spoke-fake"

const SHELL = "hst.shell-secret-value"
const ACT = "hst.act-secret-value"

interface Seen {
  method: string
  path: string
  auth: string | null
  body: any
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function fakeHub(routes: Record<string, (seen: Seen) => Response>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const text = req.method === "GET" ? "" : await req.text()
      const entry: Seen = { method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined }
      seen.push(entry)
      const route = routes[`${req.method} ${url.pathname}`]
      if (!route) return Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 })
      return route(entry)
    },
  })
  cleanups.push(() => stopServer(server))
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

function spokeFor(url: string, options: { act?: boolean } = {}): HubToolSpoke {
  return {
    shellIdentity: (sessionID) => (sessionID === "ses_me" ? { token: SHELL, url } : undefined),
    ...(options.act === false ? {} : { actIdentity: (sessionID: string) => (sessionID === "ses_me" ? { token: ACT, url } : undefined) }),
    hubSupports: () => true,
  }
}

const ctx = { sessionID: "ses_me" }
const ok = (body: unknown) => () => Response.json(body)

describe("act verbs: definition", () => {
  test("approve, deny, answer, prompt and stop are hub tool verbs that use the act token", () => {
    expect([...HUB_TOOL_ACT_VERBS].sort()).toEqual(["answer", "approve", "deny", "prompt", "stop"])
    for (const verb of HUB_TOOL_ACT_VERBS) {
      expect(HUB_TOOL_VERBS as readonly string[]).toContain(verb)
      expect(verbCredential(verb)).toBe("act")
    }
    const properties = (HUB_TOOL_INPUT as any).properties
    for (const key of ["session", "id", "always", "why", "answer", "cancel", "delivery"]) expect(properties[key]).toBeDefined()
    expect(HUB_TOOL_DESCRIPTION).toContain("approve")
    expect(HUB_TOOL_DESCRIPTION).toMatch(/needs_user|the user decides/i)
  })
})

describe("act verbs: requests", () => {
  test("approve: POST …/approve {requestID, always?, why?} with the act token; the output never shows a token", async () => {
    const hub = fakeHub({ "POST /api/agent/sessions/@api/approve": (s) => Response.json({ sessionID: "ses_api", requestID: "per_1", decision: "once", grant: `g_1 ${s.auth}` }) })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "approve", session: "@api", id: "per_1", why: "only tests" }, ctx)
    expect(hub.seen).toEqual([{ method: "POST", path: "/api/agent/sessions/@api/approve", auth: `Bearer ${ACT}`, body: { requestID: "per_1", why: "only tests" } }])
    expect(result.content).toContain("Approved per_1 in ses_api (once)")
    expect(result.metadata).toMatchObject({ verb: "approve", sessionID: "ses_api", requestID: "per_1" })
    expect(JSON.stringify(result)).not.toContain(ACT)
    expect(JSON.stringify(result)).not.toContain(SHELL)
  })

  test("approve always; deny with a why", async () => {
    const hub = fakeHub({
      "POST /api/agent/sessions/@api/approve": ok({ sessionID: "ses_api", requestID: "per_1", decision: "always" }),
      "POST /api/agent/sessions/@api/deny": ok({ sessionID: "ses_api", requestID: "per_2", reasonSent: true }),
    })
    await runHubTool(() => spokeFor(hub.url), { verb: "approve", session: "@api", id: "per_1", always: true }, ctx)
    const denied = await runHubTool(() => spokeFor(hub.url), { verb: "deny", session: "@api", id: "per_2", why: "pushes to main" }, ctx)
    expect(hub.seen.map((s) => s.body)).toEqual([{ requestID: "per_1", always: true }, { requestID: "per_2", why: "pushes to main" }])
    expect(denied.content).toContain("Denied per_2 in ses_api")
  })

  test("answer: an answer object, or cancel", async () => {
    const hub = fakeHub({ "POST /api/agent/sessions/@api/answer": ok({ sessionID: "ses_api", formID: "que_1" }) })
    const answered = await runHubTool(() => spokeFor(hub.url), { verb: "answer", session: "@api", id: "que_1", answer: { choice: "yes" } }, ctx)
    await runHubTool(() => spokeFor(hub.url), { verb: "answer", session: "@api", id: "que_1", cancel: true }, ctx)
    expect(hub.seen.map((s) => s.body)).toEqual([{ formID: "que_1", answer: { choice: "yes" } }, { formID: "que_1", cancel: true }])
    expect(answered.content).toContain("Answered que_1 in ses_api")
  })

  test("prompt and stop", async () => {
    const hub = fakeHub({
      "POST /api/agent/sessions/@api/prompt": ok({ sessionID: "ses_api", messageID: "msg_1", delivered: "turn", grant: "g_1" }),
      "POST /api/agent/sessions/@api/stop": ok({ sessionID: "ses_api", result: {} }),
    })
    const prompted = await runHubTool(() => spokeFor(hub.url), { verb: "prompt", session: "@api", text: "run the tests", delivery: "queue" }, ctx)
    const stopped = await runHubTool(() => spokeFor(hub.url), { verb: "stop", session: "@api", why: "looping" }, ctx)
    expect(hub.seen.map((s) => s.body)).toEqual([{ text: "run the tests", delivery: "queue" }, { why: "looping" }])
    expect(hub.seen.every((s) => s.auth === `Bearer ${ACT}`)).toBe(true)
    expect(prompted.content).toContain("Prompted ses_api")
    expect(stopped.content).toContain("Stopped ses_api")
  })

  test("missing or bad input: a readable error, no request", async () => {
    const hub = fakeHub({})
    const spoke = () => spokeFor(hub.url)
    expect((await runHubTool(spoke, { verb: "approve", id: "per_1" }, ctx)).content).toMatch(/"session" is required/)
    expect((await runHubTool(spoke, { verb: "approve", session: "@api" }, ctx)).content).toMatch(/"id" is required/)
    expect((await runHubTool(spoke, { verb: "answer", session: "@api", id: "que_1" }, ctx)).content).toMatch(/answer/)
    expect((await runHubTool(spoke, { verb: "answer", session: "@api", id: "que_1", answer: { a: "b" }, cancel: true }, ctx)).content).toMatch(/either/)
    expect((await runHubTool(spoke, { verb: "prompt", session: "@api" }, ctx)).content).toMatch(/"text" is required/)
    expect((await runHubTool(spoke, { verb: "prompt", session: "@api", text: "x", delivery: "now" }, ctx)).content).toMatch(/delivery/)
    expect(hub.seen).toEqual([])
  })
})

describe("act verbs: identity and errors", () => {
  test("without an act token: a clear error and no request, never the shell token instead", async () => {
    const hub = fakeHub({})
    for (const verb of HUB_TOOL_ACT_VERBS) {
      const result = await runHubTool(() => spokeFor(hub.url, { act: false }), { verb, session: "@api", id: "x", text: "t", answer: { a: "b" } }, ctx)
      expect(result.content).toMatch(/act token/i)
      expect(result.content).toContain(`hub ${verb}`)
      expect(result.metadata).toMatchObject({ error: "no_act_token" })
    }
    expect(hub.seen).toEqual([])
  })

  test("messaging verbs still use the shell token", async () => {
    const hub = fakeHub({ "GET /api/agent/inbox": ok({ asks: [], waiting: [], messages: [], muted: [] }) })
    await runHubTool(() => spokeFor(hub.url), { verb: "inbox" }, ctx)
    expect(hub.seen.map((s) => s.auth)).toEqual([`Bearer ${SHELL}`])
  })

  test("needs_user: the user decides; the evaluation and the Decision are shown", async () => {
    const evaluation = { verdict: "outside", reason: "shell git push is outside every grant", tier: "tap", grants: ["g_1"] }
    const hub = fakeHub({
      "POST /api/agent/sessions/@api/approve": () => Response.json({ error: { code: "needs_user", message: "Needs the user: shell git push is outside every grant", evaluation, decisionID: "dec_3" } }, { status: 403 }),
    })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "approve", session: "@api", id: "per_1", why: "release" }, ctx)
    expect(result.content).toContain("the user decides")
    expect(result.content).toContain("shell git push is outside every grant")
    expect(result.content).toContain("dec_3")
    expect(result.metadata).toMatchObject({ error: "needs_user", evaluation, decisionID: "dec_3" })
  })

  test("other hub errors read as code and message", async () => {
    const hub = fakeHub({ "POST /api/agent/sessions/@api/stop": () => Response.json({ error: { code: "forbidden", message: "No grant allows stop" } }, { status: 403 }) })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "stop", session: "@api" }, ctx)
    expect(result.content).toContain("No grant allows stop (forbidden)")
    expect(result.metadata).toMatchObject({ error: "forbidden" })
  })
})
