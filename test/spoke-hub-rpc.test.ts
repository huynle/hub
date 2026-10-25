// The TUI's /who and /msg on the server side (src/spoke/hub-rpc.ts): the hub's agent API as the TUI's current
// session, through the SDK with that session's token, against a fake hub.
import { afterEach, describe, expect, test } from "bun:test"
import { HubRpcError, hubMsg, hubWho } from "../src/spoke/hub-rpc"
import type { HubToolSpoke } from "../src/spoke/hub-tool"
import { stopServer } from "./spoke-fake"

const TOKEN = "hst.secret-token-value"

interface Seen {
  method: string
  path: string
  query: string
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
      const entry: Seen = { method: req.method, path: url.pathname, query: url.search, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined }
      seen.push(entry)
      const route = routes[`${req.method} ${url.pathname}`]
      if (!route) return Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 })
      return route(entry)
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

/** The rejection's HubRpcError (fails the test when the call resolves or throws something else). */
async function rejected(promise: Promise<unknown>): Promise<HubRpcError> {
  try {
    await promise
  } catch (cause) {
    expect(cause).toBeInstanceOf(HubRpcError)
    return cause as HubRpcError
  }
  throw new Error("expected a rejection")
}

describe("hubMsg", () => {
  test("sends the text word for word as the given session, with that session's token", async () => {
    const hub = fakeHub({ "POST /api/agent/msg": () => Response.json({ message: message({ delivery: "queued" }), delivery: "queued" }, { status: 201 }) })
    const text = '  hello   "there"\nsecond line '
    const sent = await hubMsg(spokeFor(hub.url), { sessionID: "ses_me", to: "@bob", text })
    expect(sent).toEqual({ id: "m_1", to: "@bob", delivery: "queued" })
    expect(hub.seen).toHaveLength(1)
    expect(hub.seen[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(hub.seen[0]!.body).toMatchObject({ to: "@bob", text })
    expect(hub.seen[0]!.body.all).toBeUndefined()
  })

  test("names the user and stored-only messages", async () => {
    const hub = fakeHub({ "POST /api/agent/msg": () => Response.json({ message: message({ to: "@me", recipient: { kind: "user" } }) }, { status: 201 }) })
    expect(await hubMsg(spokeFor(hub.url), { sessionID: "ses_me", to: "@me", text: "done" })).toEqual({ id: "m_1", to: "the user" })
  })

  test("without a session, address or text it is invalid and nothing is sent", async () => {
    const hub = fakeHub({})
    const spoke = spokeFor(hub.url)
    expect((await rejected(hubMsg(spoke, { to: "@bob", text: "hi" }))).code).toBe("invalid")
    expect((await rejected(hubMsg(spoke, { to: "@bob", text: "hi" }))).message).toMatch(/session/i)
    expect((await rejected(hubMsg(spoke, { sessionID: "ses_me", to: " ", text: "hi" }))).code).toBe("invalid")
    expect((await rejected(hubMsg(spoke, { sessionID: "ses_me", to: "@bob", text: "  " }))).code).toBe("invalid")
    expect((await rejected(hubMsg(spoke, { sessionID: "ses_me", to: "@bob", text: 3 }))).code).toBe("invalid")
    expect(hub.seen).toHaveLength(0)
  })

  test("a session without a token, or a hub without messaging, is a clear error", async () => {
    const hub = fakeHub({})
    const noToken = await rejected(hubMsg(spokeFor(hub.url, { token: undefined }), { sessionID: "ses_me", to: "@bob", text: "hi" }))
    expect(noToken.code).toBe("not_connected")
    expect(noToken.message).toMatch(/no hub token/i)
    expect((await rejected(hubMsg(spokeFor(undefined), { sessionID: "ses_me", to: "@bob", text: "hi" }))).code).toBe("not_connected")
    const old = await rejected(hubMsg(spokeFor(hub.url, { messaging: false }), { sessionID: "ses_me", to: "@bob", text: "hi" }))
    expect(old.code).toBe("unsupported")
    expect(old.message).toMatch(/does not support messaging/i)
    expect(hub.seen).toHaveLength(0)
  })

  test("the hub's refusal carries its message, code and hint; the token never appears", async () => {
    const hub = fakeHub({
      "POST /api/agent/msg": (seen) => Response.json({ error: { code: "not_found", message: `no session @nobody (auth ${seen.auth})`, hint: "see /who" } }, { status: 404 }),
    })
    const error = await rejected(hubMsg(spokeFor(hub.url), { sessionID: "ses_me", to: "@nobody", text: "hi" }))
    expect(error.code).toBe("server_error")
    expect(error.message).toContain("no session @nobody")
    expect(error.message).toContain("not_found")
    expect(error.message).toContain("see /who")
    expect(error.message).not.toContain(TOKEN)
  })

  test("an unreachable hub is unreachable", async () => {
    const error = await rejected(hubMsg(spokeFor("http://127.0.0.1:1"), { sessionID: "ses_me", to: "@bob", text: "hi" }))
    expect(error.code).toBe("unreachable")
  })
})

describe("hubWho", () => {
  test("lists sessions with sanitised labels and bare role names, as the given session", async () => {
    const hub = fakeHub({
      "GET /api/agent/who": () =>
        Response.json({
          sessions: [
            { sessionID: "ses_bob", name: "bob\u202e", project: "hub", state: "idle", online: true, roles: [{ role: "reviewer", project: "hub" }] },
            { sessionID: "ses_x", online: false, roles: [] },
          ],
        }),
    })
    const { sessions } = await hubWho(spokeFor(hub.url), { sessionID: "ses_me", role: "reviewer" })
    expect(sessions).toEqual([
      { sessionID: "ses_bob", name: "bob", project: "hub", state: "idle", online: true, roles: ["reviewer"] },
      { sessionID: "ses_x", online: false, roles: [] },
    ])
    expect(hub.seen[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(hub.seen[0]!.query).toContain("role=reviewer")
  })

  test("works with a hub without messaging, but needs a session with a token", async () => {
    const hub = fakeHub({ "GET /api/agent/who": () => Response.json({ sessions: [] }) })
    expect(await hubWho(spokeFor(hub.url, { messaging: false }), { sessionID: "ses_me", project: "hub" })).toEqual({ sessions: [] })
    expect(hub.seen[0]!.query).toContain("project=hub")
    expect((await rejected(hubWho(spokeFor(hub.url), {}))).code).toBe("invalid")
    expect((await rejected(hubWho(spokeFor(hub.url, { token: undefined }), { sessionID: "ses_me" }))).code).toBe("not_connected")
  })
})
