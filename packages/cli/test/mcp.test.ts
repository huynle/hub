// `hub mcp`'s MCP server (JSON-RPC 2.0) in process: the protocol (initialize, ping, notifications, errors), and the
// tools (the CLI's verbs) against a fake hub (Bun.serve).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { CliError, EXIT } from "../src/http"
import { createMcpServer, MCP_PROTOCOL_VERSIONS } from "../src/mcp"

interface Seen {
  method: string
  path: string
  auth: string | null
  body?: any
}

type Handler = (request: Request, url: URL, body: any) => Response | Promise<Response>

/** A fake hub: `routes["GET /api/agent/whoami"] = () => Response.json(...)`; every request is recorded. */
function fakeHub() {
  const routes: Record<string, Handler> = {}
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" ? "" : await request.text()
      const body = text ? JSON.parse(text) : undefined
      seen.push({ method: request.method, path: url.pathname + url.search, auth: request.headers.get("authorization"), ...(text ? { body } : {}) })
      const handler = routes[`${request.method} ${url.pathname}`]
      if (!handler) return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })
      return handler(request, url, body)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, routes, seen, stop: () => server.stop(true) }
}

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const TOKEN = "hat_secret_token"
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => () => Response.json({ error: { code, message, ...extra } }, { status })

/** tools/call against the fake hub; resolves the whole response. */
async function call(name: string, args?: unknown, options: { credentials?: () => any } = {}) {
  const s = createMcpServer({ credentials: options.credentials ?? (() => ({ url: hub.url, token: TOKEN, source: "login" as const })), version: "0" })
  return (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, ...(args !== undefined ? { arguments: args } : {}) } })) as any
}
const textOf = (r: any): string => r.result.content.map((c: any) => c.text).join("\n")

const server = (credentials = () => ({ url: "http://127.0.0.1:9", token: "tok", source: "env" as const })) => createMcpServer({ credentials, version: "9.9.9" })

describe("JSON-RPC core", () => {
  test("initialize echoes a supported protocolVersion, names the server and announces tools", async () => {
    const r = await server().handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
    expect(r).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "hub", version: "9.9.9" }, capabilities: { tools: {} } } })
  })

  test("initialize with an unknown protocolVersion answers the newest the server supports", async () => {
    const r = (await server().handle({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any
    expect(r.id).toBe("a")
    expect(r.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0])
    expect(MCP_PROTOCOL_VERSIONS).toContain("2024-11-05")
  })

  test("ping answers an empty result", async () => {
    expect(await server().handle({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 7, result: {} })
  })

  test("notifications (no id) get no answer, known or not", async () => {
    const s = server()
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined()
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/whatever", params: {} })).toBeUndefined()
  })

  test("unknown methods are -32601", async () => {
    const r = (await server().handle({ jsonrpc: "2.0", id: 3, method: "resources/list" })) as any
    expect(r).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32601 } })
    expect(r.error.message).toContain("resources/list")
  })

  test("invalid requests are -32600 (with the id when it has one); responses from the client are ignored", async () => {
    const s = server()
    expect(await s.handle({ jsonrpc: "1.0", id: 4, method: "ping" })).toMatchObject({ id: 4, error: { code: -32600 } })
    expect(await s.handle({ jsonrpc: "2.0", id: 5, method: 42 })).toMatchObject({ id: 5, error: { code: -32600 } })
    expect(await s.handle("nope")).toMatchObject({ id: null, error: { code: -32600 } })
    expect(await s.handle([{ jsonrpc: "2.0", id: 6, method: "ping" }])).toMatchObject({ id: null, error: { code: -32600 } })
    expect(await s.handle({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" })).toMatchObject({ id: null, error: { code: -32600 } })
    expect(await s.handle({ jsonrpc: "2.0", id: 8, result: {} })).toBeUndefined()
  })
})

const VERBS = ["whoami", "status", "sessions", "show", "log", "who"]

describe("tools/list", () => {
  test("lists one tool per CLI verb, each with a description and an object input schema", async () => {
    const r = (await server().handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as any
    const tools = r.result.tools as any[]
    expect(tools.map((t) => t.name)).toEqual(VERBS)
    for (const t of tools) {
      expect(typeof t.description).toBe("string")
      expect(t.inputSchema.type).toBe("object")
    }
    expect(tools.find((t) => t.name === "show").inputSchema.required).toEqual(["addr"])
  })
})

describe("read tools", () => {
  test("whoami: GET /api/agent/whoami with the credential's bearer token; the CLI's text", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json({ actor: { kind: "app", tokenID: "tok_1", label: "mcp" }, user: { id: "u1", name: "Huy" } })
    const r = await call("whoami")
    expect(hub.seen).toEqual([{ method: "GET", path: "/api/agent/whoami", auth: `Bearer ${TOKEN}` }])
    expect(r.result.isError).toBe(false)
    expect(r.result.content[0].type).toBe("text")
    expect(textOf(r)).toContain("app token tok_1 (mcp)")
  })

  test("status, sessions (filters), show, log (n), who (role)", async () => {
    hub.routes["GET /api/agent/status"] = () => Response.json({ machines: [{ id: "m1", name: "mac", online: true, projects: [{ root: "/p", name: "hub", sessions: [{ id: "ses_1", name: "api", state: "idle" }] }] }], attention: [] })
    hub.routes["GET /api/agent/sessions"] = () => Response.json({ sessions: [{ id: "ses_1", name: "api", state: "busy" }] })
    hub.routes["GET /api/agent/sessions/@api"] = () => Response.json({ id: "ses_1", name: "api", state: "idle", title: "Refactor" })
    hub.routes["GET /api/agent/sessions/@api/log"] = () => Response.json({ rows: [{ kind: "user", text: "hi", at: 0 }] })
    hub.routes["GET /api/agent/who"] = () => Response.json({ sessions: [{ sessionID: "ses_1", name: "api", online: true, state: "idle", roles: [{ role: "reviewer" }] }] })
    expect(textOf(await call("status"))).toContain("@api ses_1  idle")
    expect(textOf(await call("sessions", { project: "hub", state: "busy", label: ["a=b"] }))).toContain("@api ses_1  busy")
    expect(textOf(await call("show", { addr: "@api" }))).toContain("title: Refactor")
    expect(textOf(await call("log", { addr: "@api", n: 5 }))).toContain("user  hi")
    expect(textOf(await call("who", { role: "@@reviewer" }))).toContain("@@reviewer")
    expect(hub.seen.map((s) => s.path)).toEqual([
      "/api/agent/status",
      "/api/agent/sessions?project=hub&state=busy&label=a%3Db",
      "/api/agent/sessions/@api",
      "/api/agent/sessions/@api/log?n=5",
      "/api/agent/who?role=reviewer",
    ])
  })

  test("output is stripped of control and invisible characters, and never carries the token", async () => {
    hub.routes["GET /api/agent/sessions/@api"] = () => Response.json({ id: "ses_1", state: "idle", title: `evil\u001b[31m\u202e ${TOKEN}` })
    const text = textOf(await call("show", { addr: "@api" }))
    expect(text).toContain("title: evil [redacted]")
    expect(text).not.toContain(TOKEN)
    expect(text).not.toMatch(/[\u001b\u202e]/)
  })
})

describe("tool errors", () => {
  test("hub errors are tool results with isError, the code, message, candidates and hint (not protocol errors)", async () => {
    hub.routes["GET /api/agent/sessions/@a"] = fail(409, "ambiguous", "@a matches 2 sessions", { hint: "use a session ID", candidates: [{ sessionID: "ses_1", name: "a1" }, { sessionID: "ses_2" }] })
    const r = await call("show", { addr: "@a" })
    expect(r.error).toBeUndefined()
    expect(r.result.isError).toBe(true)
    const text = textOf(r)
    expect(text).toContain("ambiguous: @a matches 2 sessions")
    expect(text).toContain("ses_1  @a1")
    expect(text).toContain("ses_2")
    expect(text).toContain("hint: use a session ID")
  })

  test("missing or wrongly typed arguments are isError results naming the argument", async () => {
    const missing = await call("show", {})
    expect(missing.result.isError).toBe(true)
    expect(textOf(missing)).toContain('"addr"')
    const typed = await call("log", { addr: "@x", n: "five" })
    expect(typed.result.isError).toBe(true)
    expect(textOf(typed)).toContain('"n"')
    expect(hub.seen).toEqual([])
  })

  test("no credential: an isError result saying how to log in", async () => {
    const r = await call("whoami", undefined, {
      credentials: () => {
        throw new CliError(EXIT.unauthorized, "not logged in to a hub", "Run `hub login`")
      },
    })
    expect(r.result.isError).toBe(true)
    expect(textOf(r)).toContain("not logged in to a hub")
    expect(textOf(r)).toContain("hub login")
  })

  test("an unreachable hub is an isError result", async () => {
    const r = await call("whoami", undefined, { credentials: () => ({ url: "http://127.0.0.1:1", token: TOKEN, source: "login" }) })
    expect(r.result.isError).toBe(true)
    expect(textOf(r)).toContain("cannot reach")
  })

  test("an unknown tool or missing name is -32602; non-object arguments are -32602", async () => {
    expect(await call("nope")).toMatchObject({ error: { code: -32602 } })
    expect(await call("whoami", "x")).toMatchObject({ error: { code: -32602 } })
    expect(await server().handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).toMatchObject({ error: { code: -32602 } })
  })
})
