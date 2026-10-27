// POST /mcp: the hub's MCP tools over Streamable HTTP (stateless JSON responses, no SSE, no MCP sessions), for MCP
// clients and gateways. Bearer auth with any agent API credential; the tools call /api/agent in process as the caller,
// so scopes, grants and tenancy are the HTTP API's. Against a real in-process hub (central-harness).
import { afterEach, describe, expect, test } from "bun:test"
import { harness, PUBLIC, session, spoke, type Harness } from "./central-harness"
import { fakeProvider, oidcEnv, signIn, type FakeProvider } from "./oidc-fake"

let h: Harness | undefined
let idp: FakeProvider | undefined
afterEach(async () => {
  await h?.stop()
  idp?.stop()
  h = undefined
  idp = undefined
})

const json = async (r: Response) => (await r.json()) as any

/** A JSON-RPC POST to /mcp (no cookie; Origin only when given). */
function post(token: string | undefined, message: unknown, init: { headers?: Record<string, string>; body?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...init.headers }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return fetch(`${h!.url}/mcp`, { method: "POST", headers, body: init.body ?? JSON.stringify(message) })
}
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })
const call = (token: string, name: string, args: Record<string, unknown> = {}) => post(token, rpc(9, "tools/call", { name, arguments: args }))
const textOf = (body: any): string => body.result.content.map((c: any) => c.text).join("\n")

async function appToken(scopes: string[], cookie?: string): Promise<{ id: string; token: string }> {
  const r = await h!.api("/api/agent/app-tokens", { method: "POST", json: { label: "gateway", scopes }, ...(cookie ? { cookie } : {}) })
  expect(r.status).toBe(201)
  return json(r)
}
const deviceToken = () => h!.cookie.split("=")[1]!

describe("auth", () => {
  test("no token: 401 with WWW-Authenticate Bearer (no OAuth discovery) and a JSON error", async () => {
    h = await harness()
    const r = await post(undefined, rpc(1, "initialize", { protocolVersion: "2025-06-18" }))
    expect(r.status).toBe(401)
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="hub"')
    expect(r.headers.get("www-authenticate")).not.toContain("resource_metadata")
    expect(r.headers.get("content-type")).toContain("application/json")
    expect((await json(r)).error.code).toBe("unauthorized")
  })

  test("a bad token: 401, the token never echoed", async () => {
    h = await harness()
    const bad = "hat_nope_SECRETSECRETSECRET"
    const r = await post(bad, rpc(1, "tools/list"))
    expect(r.status).toBe(401)
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="hub"')
    const text = await r.text()
    expect(text).not.toContain("SECRETSECRETSECRET")
    expect(JSON.parse(text).error.code).toBe("unauthorized")
  })

  test("a device cookie alone is not enough (bearer required)", async () => {
    h = await harness()
    const r = await post(undefined, rpc(1, "tools/list"), { headers: { cookie: h.cookie, origin: PUBLIC } })
    expect(r.status).toBe(401)
  })
})

describe("transport", () => {
  test("GET and DELETE are 405 with Allow: POST", async () => {
    h = await harness()
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(`${h.url}/mcp`, { method, headers: { authorization: `Bearer ${deviceToken()}` } })
      expect(r.status).toBe(405)
      expect(r.headers.get("allow")).toBe("POST")
    }
  })

  test("a notification is 202 with no body", async () => {
    h = await harness()
    const r = await post(deviceToken(), { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(r.status).toBe(202)
    expect(await r.text()).toBe("")
  })

  test("a JSON-RPC response from the client is 202", async () => {
    h = await harness()
    const r = await post(deviceToken(), { jsonrpc: "2.0", id: 4, result: {} })
    expect(r.status).toBe(202)
  })

  test("a foreign Origin is 403; the hub's own origin is fine", async () => {
    h = await harness()
    expect((await post(deviceToken(), rpc(1, "ping"), { headers: { origin: "https://evil.example" } })).status).toBe(403)
    const own = await post(deviceToken(), rpc(1, "ping"), { headers: { origin: PUBLIC } })
    expect(own.status).toBe(200)
    expect(await json(own)).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  })

  test("a body over 1 MiB is 413", async () => {
    h = await harness()
    const big = JSON.stringify(rpc(1, "tools/call", { name: "msg", arguments: { to: "@x", text: "x".repeat(1100 * 1024) } }))
    const r = await post(deviceToken(), undefined, { body: big })
    expect(r.status).toBe(413)
  })

  test("Content-Type other than application/json is 415", async () => {
    h = await harness()
    const r = await post(deviceToken(), rpc(1, "ping"), { headers: { "content-type": "text/plain" } })
    expect(r.status).toBe(415)
  })

  test("an Accept without application/json or */* is 406; */* or none is fine", async () => {
    h = await harness()
    expect((await post(deviceToken(), rpc(1, "ping"), { headers: { accept: "text/event-stream" } })).status).toBe(406)
    expect((await post(deviceToken(), rpc(1, "ping"), { headers: { accept: "*/*" } })).status).toBe(200)
  })

  test("an unsupported MCP-Protocol-Version is 400; a supported one is fine", async () => {
    h = await harness()
    expect((await post(deviceToken(), rpc(1, "ping"), { headers: { "mcp-protocol-version": "1999-01-01" } })).status).toBe(400)
    expect((await post(deviceToken(), rpc(1, "ping"), { headers: { "mcp-protocol-version": "2025-06-18" } })).status).toBe(200)
  })

  test("not JSON is 400 with a -32700 parse error; a batch is 400 with -32600", async () => {
    h = await harness()
    const parse = await post(deviceToken(), undefined, { body: "{nope" })
    expect(parse.status).toBe(400)
    expect((await json(parse)).error.code).toBe(-32700)
    const batch = await post(deviceToken(), [rpc(1, "ping"), rpc(2, "ping")])
    expect(batch.status).toBe(400)
    expect((await json(batch)).error.code).toBe(-32600)
  })

  test("an unknown method is -32601 (HTTP 200, a JSON-RPC error)", async () => {
    h = await harness()
    const r = await post(deviceToken(), rpc(5, "resources/list"))
    expect(r.status).toBe(200)
    expect(await json(r)).toMatchObject({ jsonrpc: "2.0", id: 5, error: { code: -32601 } })
  })

  test("no Mcp-Session-Id is issued; replies are application/json", async () => {
    h = await harness()
    const r = await post(deviceToken(), rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("application/json")
    expect(r.headers.get("mcp-session-id")).toBeNull()
  })
})

describe("MCP over HTTP", () => {
  test("initialize: serverInfo hub + version, tools capability, instructions", async () => {
    h = await harness()
    const { token } = await appToken(["sessions:read"])
    const body = await json(await post(token, rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })))
    expect(body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "hub", version: "9.9.9" }, capabilities: { tools: {} } })
    expect(body.result.instructions).toContain("not from the user")
  })

  test("tools/list: the CLI's tool table", async () => {
    h = await harness()
    const { token } = await appToken(["sessions:read"])
    const body = await json(await post(token, rpc(2, "tools/list")))
    const names = body.result.tools.map((t: any) => t.name)
    for (const name of ["whoami", "status", "sessions", "msg", "ask", "inbox", "approve", "launch"]) expect(names).toContain(name)
  })

  test("archive and unarchive act only with sessions:manage, through real /mcp", async () => {
    h = await harness()
    await spoke(h, { sessions: [session("ses_archive", { title: "Archive me" })] })
    const { token } = await appToken(["sessions:read", "sessions:manage"])
    const denied = await json(await call(await appToken(["sessions:read"]).then((x) => x.token), "archive", { addr: "ses_archive" }))
    expect(denied.result.isError).toBe(true)
    const archived = await call(token, "archive", { addr: "ses_archive" })
    const raw = await archived.text()
    expect(textOf(JSON.parse(raw))).toContain("Archived ses_archive")
    expect(h.store.viewPrefs("local").hiddenSessions).toEqual(["ses_archive"])
    expect(textOf(await json(await call(token, "unarchive", { addr: "ses_archive" })))).toContain("Unarchived ses_archive")
    expect(h.store.viewPrefs("local").hiddenSessions).toEqual([])
    expect(raw.includes(token)).toBe(false)
  })

  test("events: a resumable cursor over the journal, needing events:subscribe, through real /mcp", async () => {
    h = await harness()
    await spoke(h, { sessions: [session("ses_ev", { title: "SECRET title" })] })
    const denied = await json(await call((await appToken(["sessions:read"])).token, "events"))
    expect(denied.result.isError).toBe(true)
    const { token } = await appToken(["events:subscribe", "sessions:read", "sessions:manage"])
    const first = JSON.parse(textOf(await json(await call(token, "events"))))
    expect(first).toMatchObject({ events: [], more: false, reset: false })
    expect(first.cursor).toMatch(/^hev1_/)
    expect((await call(token, "archive", { addr: "ses_ev" })).status).toBe(200)
    const raw = textOf(await json(await call(token, "events", { cursor: first.cursor, wait: 5, limit: 10, types: ["session.archived"], sessions: ["ses_ev"] })))
    expect(raw).not.toContain("SECRET")
    const page = JSON.parse(raw)
    expect(page.events).toEqual([{ id: expect.stringMatching(/^evt_/), at: expect.any(Number), type: "session.archived", subject: { sessionID: "ses_ev" }, data: { archived: true } }])
    const bad = await json(await call(token, "events", { cursor: "hev1_forged.x" }))
    expect(bad.result.isError).toBe(true)
    expect(textOf(bad)).toContain("invalid_cursor")
  })

  test("tools/call whoami answers the caller (app token), never its token", async () => {
    h = await harness()
    const { id, token } = await appToken(["sessions:read"])
    const r = await call(token, "whoami")
    expect(r.status).toBe(200)
    const raw = await r.text()
    expect(raw).not.toContain(token)
    const body = JSON.parse(raw)
    expect(body.result.isError).toBe(false)
    expect(textOf(body)).toContain(`app token ${id} (gateway)`)
  })

  test("tools/call whoami with a device token answers the user's device", async () => {
    h = await harness()
    const body = await json(await call(deviceToken(), "whoami"))
    expect(body.result.isError).toBe(false)
    expect(textOf(body)).toMatch(/^user \(device /)
  })

  test("scopes apply: a token without messages:send gets an isError result for msg", async () => {
    h = await harness()
    const { token } = await appToken(["sessions:read"])
    const r = await call(token, "msg", { to: "@me", text: "hi" })
    expect(r.status).toBe(200)
    const raw = await r.text()
    expect(raw).not.toContain(token)
    const body = JSON.parse(raw)
    expect(body.result.isError).toBe(true)
    expect(textOf(body)).toContain("forbidden")
  })

  test("a bad tool argument is an isError result, not a protocol error", async () => {
    h = await harness()
    const body = await json(await call(deviceToken(), "show", {}))
    expect(body.result.isError).toBe(true)
    expect(textOf(body)).toContain('"addr" is required')
  })

  test("a spec-following client over real HTTP: initialize, initialized, tools/list, tools/call", async () => {
    h = await harness()
    const { token } = await appToken(["sessions:read"])
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }
    const send = (message: unknown, version?: string) =>
      fetch(`${h!.url}/mcp`, { method: "POST", headers: { ...headers, ...(version ? { "mcp-protocol-version": version } : {}) }, body: JSON.stringify(message) })
    const init = await send(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spec-client", version: "1" } }))
    expect(init.status).toBe(200)
    const version = (await json(init)).result.protocolVersion as string
    expect(version).toBe("2025-06-18")
    const sessionID = init.headers.get("mcp-session-id")
    expect(sessionID).toBeNull()
    expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" }, version)).status).toBe(202)
    const list = await json(await send(rpc(2, "tools/list"), version))
    expect(list.result.tools.length).toBeGreaterThan(5)
    const status = await json(await send(rpc(3, "tools/call", { name: "status", arguments: {} }), version))
    expect(status.id).toBe(3)
    expect(status.result.isError).toBe(false)
  })
})

describe("tenancy", () => {
  test("bob's token cannot see alice's sessions through /mcp", async () => {
    idp = fakeProvider()
    h = await harness({ env: oidcEnv(idp), noDevice: true })
    const signedIn = async (email: string) => {
      const { cookie } = await signIn(h!.url, idp!, email)
      const id = ((await (await h!.api("/api/me", { cookie })).json()) as any).user.id as string
      return { id, cookie: cookie! }
    }
    await signedIn("admin@example.com")
    const alice = await signedIn("alice@example.com")
    const bob = await signedIn("bob@example.com")
    const machine = await h.store.addMachine("alice laptop", alice.id)
    const client = await spoke(h, {
      machine,
      processID: "p_alice",
      hello: { kind: "service", directory: "/home/user/work" },
      sessions: [session("ses_alicemcp", { owned: true, directory: "/home/user/work", title: "alice secret session" })],
    })
    try {
      const aliceToken = (await appToken(["sessions:read"], alice.cookie)).token
      const bobToken = (await appToken(["sessions:read"], bob.cookie)).token
      // Positive control: alice sees her session.
      expect(textOf(await json(await call(aliceToken, "sessions")))).toContain("ses_alicemcp")
      const listed = await json(await call(bobToken, "sessions"))
      expect(listed.result.isError).toBe(false)
      expect(JSON.stringify(listed)).not.toContain("ses_alicemcp")
      expect(JSON.stringify(listed)).not.toContain("alice secret session")
      const shown = await json(await call(bobToken, "show", { addr: "ses_alicemcp" }))
      expect(shown.result.isError).toBe(true)
      expect(JSON.stringify(shown)).not.toContain("alice secret session")
    } finally {
      client.close()
    }
  })
})
