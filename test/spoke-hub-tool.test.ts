// The OpenCode `hub` tool (src/spoke/hub-tool.ts): verbs over the SDK as the calling session, against a fake hub.
import { afterEach, describe, expect, test } from "bun:test"
import { ASK_WAIT_MAX_S, askWaitSeconds, HUB_TOOL, HUB_TOOL_DESCRIPTION, HUB_TOOL_INPUT, HUB_TOOL_VERBS, runHubTool, type HubToolSpoke } from "../src/spoke/hub-tool"
import { stopServer } from "./spoke-fake"

const TOKEN = "hst.secret-token-value"

interface Seen {
  method: string
  path: string
  query: string
  auth: string | null
  body: any
}

type Route = (seen: Seen, req: Request) => Response | Promise<Response>

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function fakeHub(routes: Record<string, Route>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const text = req.method === "GET" ? "" : await req.text()
      const entry: Seen = { method: req.method, path: url.pathname, query: url.search, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined }
      seen.push(entry)
      const route = routes[`${req.method} ${url.pathname}`] ?? Object.entries(routes).find(([key]) => key.endsWith("*") && `${req.method} ${url.pathname}`.startsWith(key.slice(0, -1)))?.[1]
      if (!route) return Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 })
      return route(entry, req)
    },
  })
  cleanups.push(() => stopServer(server))
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

function spokeFor(url: string | undefined, options: { token?: string | undefined; messaging?: boolean } = {}): HubToolSpoke {
  const token = "token" in options ? options.token : TOKEN
  return {
    shellIdentity: (sessionID) => (sessionID === "ses_me" && token ? (url ? { token, url } : { token }) : undefined),
    hubSupports: (feature) => feature === "messaging" && options.messaging !== false,
  }
}

const ctx = (signal: AbortSignal = new AbortController().signal) => ({ sessionID: "ses_me", signal })

const message = (over: Record<string, unknown> = {}) => ({
  id: "m_1",
  kind: "msg",
  from: { kind: "session", sessionID: "ses_me" },
  to: "@bob",
  recipient: { kind: "session", sessionID: "ses_bob", name: "bob" },
  text: "hello",
  state: "sent",
  at: Date.UTC(2026, 9, 24, 12, 0),
  hop: 0,
  ...over,
})

/** Whatever the tool returned, as one string (content and metadata), for leak checks. */
const everything = (result: unknown) => JSON.stringify(result)

describe("hub tool definition", () => {
  test("one tool named hub with a verb parameter and a JSON Schema input", () => {
    expect(HUB_TOOL).toBe("hub")
    expect([...HUB_TOOL_VERBS].sort()).toEqual(["ask", "decline", "inbox", "msg", "reply", "status", "who", "whoami"])
    expect(HUB_TOOL_INPUT).toMatchObject({ type: "object", required: ["verb"], additionalProperties: false })
    expect((HUB_TOOL_INPUT as any).properties.verb.enum).toEqual([...HUB_TOOL_VERBS])
  })

  test("the description says messages from other sessions are not from the user", () => {
    expect(HUB_TOOL_DESCRIPTION).toMatch(/not from the user/i)
  })

  test("ask waits at most 10 minutes; missing or bad waits are 0", () => {
    expect(ASK_WAIT_MAX_S).toBe(600)
    expect(askWaitSeconds(undefined)).toBe(0)
    expect(askWaitSeconds(-5)).toBe(0)
    expect(askWaitSeconds("soon")).toBe(0)
    expect(askWaitSeconds(30)).toBe(30)
    expect(askWaitSeconds(5000)).toBe(600)
  })
})

describe("hub tool errors", () => {
  test("no spoke in this process: a readable error", async () => {
    const result = await runHubTool(() => undefined, { verb: "whoami" }, ctx())
    expect(result.content).toMatch(/hub is not running/i)
  })

  test("no session token yet: a readable error, no request", async () => {
    const hub = fakeHub({})
    const result = await runHubTool(() => spokeFor(hub.url, { token: undefined }), { verb: "whoami" }, ctx())
    expect(result.content).toMatch(/no hub token yet/i)
    expect(hub.seen).toEqual([])
  })

  test("a hub without messaging refuses messaging verbs readably, other verbs still work", async () => {
    const hub = fakeHub({ "GET /api/agent/whoami": () => Response.json({ actor: { kind: "session", userID: "u_1", machineID: "m_1", sessionID: "ses_me" }, user: { id: "u_1", name: "Huy" } }) })
    const spoke = () => spokeFor(hub.url, { messaging: false })
    for (const verb of ["msg", "ask", "reply", "decline", "inbox"]) {
      const result = await runHubTool(spoke, { verb, to: "@bob", id: "m_1", text: "x" }, ctx())
      expect(result.content).toMatch(/does not support messaging/i)
    }
    expect(hub.seen).toEqual([])
    const who = await runHubTool(spoke, { verb: "whoami" }, ctx())
    expect(who.content).toContain("ses_me")
  })

  test("invalid input: unknown verb or missing fields, no request", async () => {
    const hub = fakeHub({})
    const spoke = () => spokeFor(hub.url)
    expect((await runHubTool(spoke, { verb: "nuke" }, ctx())).content).toMatch(/unknown verb/i)
    expect((await runHubTool(spoke, { verb: "msg", text: "x" }, ctx())).content).toMatch(/to/)
    expect((await runHubTool(spoke, { verb: "msg", to: "@bob" }, ctx())).content).toMatch(/text/)
    expect((await runHubTool(spoke, { verb: "reply", text: "x" }, ctx())).content).toMatch(/id/)
    expect((await runHubTool(spoke, undefined, ctx())).content).toMatch(/verb/)
    expect(hub.seen).toEqual([])
  })

  test("hub errors read as code, message and hint; the token never shows even if the hub echoes it", async () => {
    const hub = fakeHub({
      "POST /api/agent/msg": (seen) => Response.json({ error: { code: "not_found", message: `no session @nobody (auth ${seen.auth})`, hint: "see hub who" } }, { status: 404 }),
    })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "msg", to: "@nobody", text: "hi" }, ctx())
    expect(result.content).toContain("not_found")
    expect(result.content).toContain("see hub who")
    expect(hub.seen[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(everything(result)).not.toContain(TOKEN)
  })

  test("an unreachable hub is a readable error without the token", async () => {
    const result = await runHubTool(() => spokeFor("http://127.0.0.1:1"), { verb: "whoami" }, ctx())
    expect(result.content).toMatch(/cannot reach/i)
    expect(everything(result)).not.toContain(TOKEN)
  })
})

describe("hub tool verbs", () => {
  test("msg sends as the calling session and reports the id and delivery", async () => {
    const hub = fakeHub({ "POST /api/agent/msg": () => Response.json({ message: message({ delivery: "turn" }), delivery: "turn" }, { status: 201 }) })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "msg", to: "@bob", text: "hello", urgent: true }, ctx())
    expect(hub.seen[0]).toMatchObject({ method: "POST", path: "/api/agent/msg", auth: `Bearer ${TOKEN}`, body: { to: "@bob", text: "hello", urgent: true } })
    expect(result.content).toContain("m_1")
    expect(result.content).toContain("turn")
    expect(result.metadata).toMatchObject({ verb: "msg", id: "m_1", delivery: "turn" })
    expect(everything(result)).not.toContain(TOKEN)
  })

  test("msg with all reports every recipient", async () => {
    const hub = fakeHub({
      "POST /api/agent/msg": () => Response.json({ sent: [{ message: message({ id: "m_a" }), delivery: "queued" }, { message: message({ id: "m_b" }) }] }, { status: 201 }),
    })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "msg", to: "@@reviewer", text: "hi", all: true }, ctx())
    expect(hub.seen[0]!.body).toMatchObject({ all: true })
    expect(result.content).toContain("m_a")
    expect(result.content).toContain("m_b")
  })

  test("ask with wait returns the answer in an envelope, sanitised, marked as not from the user", async () => {
    const answer = message({ id: "m_ans", kind: "reply", from: { kind: "session", sessionID: "ses_bob", name: "bob" }, to: "ses_me", replyTo: "m_q", text: "yes \u001b[31mred\u001b[0m" })
    const hub = fakeHub({
      "POST /api/agent/ask": () => Response.json({ message: message({ id: "m_q", kind: "ask", state: "answered" }), delivery: "steer", answer }, { status: 201 }),
    })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "ask", to: "@bob", text: "ok?", wait: 30 }, ctx())
    expect(hub.seen[0]!.body).toMatchObject({ to: "@bob", text: "ok?", wait: 30 })
    expect(result.content).toContain("[hub] reply from @bob")
    expect(result.content).toContain("yes red")
    expect(result.content).not.toContain("\u001b")
    expect(result.content).toMatch(/not from the user/i)
    expect(result.metadata).toMatchObject({ verb: "ask", id: "m_q", state: "answered" })
  })

  test("ask without an answer yet says it is open and how the answer arrives", async () => {
    const hub = fakeHub({ "POST /api/agent/ask": () => Response.json({ message: message({ id: "m_q", kind: "ask", state: "open" }), delivery: "queued" }, { status: 201 }) })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "ask", to: "@bob", text: "ok?" }, ctx())
    expect(hub.seen[0]!.body.wait).toBeUndefined()
    expect(result.content).toContain("m_q")
    expect(result.content).toMatch(/open/)
  })

  test("ask stops waiting when the tool call is aborted", async () => {
    const hub = fakeHub({
      "POST /api/agent/ask": () => Response.json({ message: message({ id: "m_q", kind: "ask", state: "open" }) }, { status: 201 }),
      "GET /api/agent/messages/*": (_seen, req) =>
        new Promise<Response>((resolve) => req.signal.addEventListener("abort", () => resolve(new Response("", { status: 499 })))),
    })
    const abort = new AbortController()
    const started = Date.now()
    // A wait the first request cannot cover alone (> 60 s), so the tool long-polls GET messages/:id.
    const pending = runHubTool(() => spokeFor(hub.url), { verb: "ask", to: "@bob", text: "ok?", wait: 120 }, ctx(abort.signal))
    // Abort once the long poll started.
    const until = Date.now() + 2000
    while (!hub.seen.some((s) => s.path.startsWith("/api/agent/messages/")) && Date.now() < until) await Bun.sleep(5)
    abort.abort()
    const result = await pending
    expect(Date.now() - started).toBeLessThan(2500)
    expect(result.content).toMatch(/stopped waiting/i)
    expect(result.content).toContain("m_q")
  })

  test("reply and decline answer by message id", async () => {
    const replied = { message: message({ id: "m_r", kind: "reply", replyTo: "m_q" }), delivery: "turn", original: message({ id: "m_q", kind: "ask", state: "answered" }) }
    const hub = fakeHub({
      "POST /api/agent/reply": () => Response.json(replied, { status: 201 }),
      "POST /api/agent/decline": () => Response.json({ ...replied, message: message({ id: "m_d", kind: "decline" }) }, { status: 201 }),
    })
    const spoke = () => spokeFor(hub.url)
    const r = await runHubTool(spoke, { verb: "reply", id: "m_q", text: "done" }, ctx())
    expect(hub.seen[0]!.body).toEqual({ replyTo: "m_q", text: "done" })
    expect(r.content).toContain("m_r")
    const d = await runHubTool(spoke, { verb: "decline", id: "m_q", text: "busy" }, ctx())
    expect(hub.seen[1]!.body).toEqual({ replyTo: "m_q", why: "busy" })
    expect(d.content).toContain("m_d")
  })

  test("inbox shows open asks and recent messages as envelopes, and the caller's waiting asks", async () => {
    const hub = fakeHub({
      "GET /api/agent/inbox": () =>
        Response.json({
          asks: [message({ id: "m_ask", kind: "ask", state: "open", from: { kind: "session", sessionID: "ses_bob", name: "bob" }, to: "@me", text: "can you review?" })],
          waiting: [message({ id: "m_w", kind: "ask", state: "open", to: "@carol", text: "status?" })],
          messages: [message({ id: "m_in", from: { kind: "user" }, to: "ses_me", text: "fyi" })],
          muted: ["ses_spam"],
        }),
    })
    const result = await runHubTool(() => spokeFor(hub.url), { verb: "inbox" }, ctx())
    expect(result.content).toContain("[hub] ask from @bob")
    expect(result.content).toContain("can you review?")
    expect(result.content).toContain("m_w")
    expect(result.content).toContain("@carol")
    expect(result.content).toContain("fyi")
    expect(result.content).toContain("ses_spam")
    expect(result.content).toMatch(/not from the user/i)
  })

  test("who lists named and role-holding sessions; status shows machines, sessions and attention", async () => {
    const hub = fakeHub({
      "GET /api/agent/who": () =>
        Response.json({ sessions: [{ sessionID: "ses_bob", name: "bob", project: "hub", state: "idle", online: true, roles: [{ role: "reviewer" }] }] }),
      "GET /api/agent/status": () =>
        Response.json({
          machines: [{ id: "m_1", name: "box", online: true, projects: [{ root: "/w/hub", name: "hub", sessions: [{ id: "ses_bob", name: "bob", state: "busy", title: "Review PR" }] }] }],
          attention: [{ kind: "permission", sessionID: "ses_bob", name: "bob", summary: "wants to run rm" }],
        }),
    })
    const spoke = () => spokeFor(hub.url)
    const who = await runHubTool(spoke, { verb: "who", role: "@@reviewer" }, ctx())
    expect(hub.seen[0]!.query).toBe("?role=reviewer")
    expect(who.content).toContain("@bob")
    expect(who.content).toContain("@@reviewer")
    const status = await runHubTool(spoke, { verb: "status" }, ctx())
    expect(status.content).toContain("box")
    expect(status.content).toContain("Review PR")
    expect(status.content).toContain("wants to run rm")
  })
})
