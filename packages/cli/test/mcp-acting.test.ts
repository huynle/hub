// `hub mcp`'s act tools (design §5): approve, deny, answer, prompt and stop, with this server's credential (an app
// token with scope sessions:act, or the user's), against a fake hub (Bun.serve); needs_user shows the evaluation.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createMcpServer } from "../src/mcp"

type Handler = (request: Request, url: URL, body: any) => Response | Promise<Response>

function fakeHub() {
  const routes: Record<string, Handler> = {}
  const seen: Array<{ method: string; path: string; auth: string | null; body?: any }> = []
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

const TOKEN = "hat_act_token"
const server = () => createMcpServer({ credentials: () => ({ url: hub.url, token: TOKEN, source: "login" as const }), version: "0" })
async function call(name: string, args: unknown) {
  return (await server().handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any
}
const textOf = (r: any): string => r.result.content.map((c: any) => c.text).join("\n")
const ok = (body: unknown) => () => Response.json(body)
const bodies = () => hub.seen.map((s) => s.body)

describe("act tools", () => {
  test("listed, not read-only, with their required arguments", async () => {
    const r = (await server().handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as any
    const tools = Object.fromEntries((r.result.tools as any[]).map((t) => [t.name, t]))
    expect(tools.approve.inputSchema.required).toEqual(["addr", "requestID"])
    expect(tools.deny.inputSchema.required).toEqual(["addr", "requestID"])
    expect(tools.answer.inputSchema.required).toEqual(["addr", "formID"])
    expect(tools.prompt.inputSchema.required).toEqual(["addr", "text"])
    expect(tools.stop.inputSchema.required).toEqual(["addr"])
    for (const name of ["approve", "deny", "answer", "prompt", "stop"]) expect(tools[name].annotations.readOnlyHint).toBe(false)
  })

  test("approve: {requestID, always?, why?} with the bearer; the CLI's text", async () => {
    hub.routes["POST /api/agent/sessions/@api/approve"] = ok({ sessionID: "ses_api", requestID: "per_1", decision: "once", grant: "g_1" })
    const r = await call("approve", { addr: "@api", requestID: "per_1", why: "tests only" })
    expect(r.result.isError).toBe(false)
    expect(textOf(r)).toBe("approved per_1 in ses_api (once, grant g_1)")
    expect(hub.seen).toEqual([{ method: "POST", path: "/api/agent/sessions/@api/approve", auth: `Bearer ${TOKEN}`, body: { requestID: "per_1", why: "tests only" } }])
    await call("approve", { addr: "@api", requestID: "per_1", always: true })
    expect(bodies()[1]).toEqual({ requestID: "per_1", always: true })
  })

  test("deny, prompt, stop", async () => {
    hub.routes["POST /api/agent/sessions/@api/deny"] = ok({ sessionID: "ses_api", requestID: "per_1", reasonSent: true })
    hub.routes["POST /api/agent/sessions/@api/prompt"] = ok({ sessionID: "ses_api", messageID: "msg_1", delivered: "queued", grant: "g_1" })
    hub.routes["POST /api/agent/sessions/@api/stop"] = ok({ sessionID: "ses_api", result: {} })
    expect(textOf(await call("deny", { addr: "@api", requestID: "per_1", why: "no" }))).toContain("denied per_1 in ses_api")
    expect(textOf(await call("prompt", { addr: "@api", text: "run tests", delivery: "queue" }))).toBe("prompted ses_api: msg_1 delivered (queued), grant g_1")
    expect(textOf(await call("stop", { addr: "@api" }))).toBe("stopped ses_api")
    expect(bodies()).toEqual([{ requestID: "per_1", why: "no" }, { text: "run tests", delivery: "queue" }, {}])
  })

  test("answer: an answer object, or cancel", async () => {
    hub.routes["POST /api/agent/sessions/@api/answer"] = ok({ sessionID: "ses_api", formID: "que_1" })
    expect(textOf(await call("answer", { addr: "@api", formID: "que_1", answer: { choice: "yes" } }))).toBe("answered que_1 in ses_api")
    expect(textOf(await call("answer", { addr: "@api", formID: "que_1", cancel: true }))).toBe("cancelled que_1 in ses_api")
    expect(bodies()).toEqual([{ formID: "que_1", answer: { choice: "yes" } }, { formID: "que_1", cancel: true }])
  })

  test.each([
    ["approve", { addr: "@api" }, "requestID"],
    ["approve", { addr: "@api", requestID: "per_1", always: "yes" }, "always"],
    ["answer", { addr: "@api", formID: "que_1" }, "answer"],
    ["answer", { addr: "@api", formID: "que_1", answer: { a: "b" }, cancel: true }, "either"],
    ["answer", { addr: "@api", formID: "que_1", answer: ["x"] }, "answer"],
    ["prompt", { addr: "@api", text: "x", delivery: "now" }, "delivery"],
  ])("%s with bad arguments is an invalid tool result: %p", async (name, args, word) => {
    const r = await call(name, args)
    expect(r.result.isError).toBe(true)
    expect(textOf(r)).toContain("invalid:")
    expect(textOf(r)).toContain(word)
    expect(hub.seen).toEqual([])
  })

  test("needs_user: an error result with the evaluation and the Decision", async () => {
    const evaluation = { verdict: "outside", reason: "edit outside the worktree", tier: "confirm", grants: ["g_1"] }
    hub.routes["POST /api/agent/sessions/@api/approve"] = () => Response.json({ error: { code: "needs_user", message: "Needs the user: edit outside the worktree", evaluation, decisionID: "dec_2" } }, { status: 403 })
    const r = await call("approve", { addr: "@api", requestID: "per_1" })
    expect(r.result.isError).toBe(true)
    const text = textOf(r)
    expect(text).toContain("needs_user: Needs the user: edit outside the worktree")
    expect(text).toContain("evaluation: outside (confirm) — edit outside the worktree")
    expect(text).toContain("grants checked: g_1")
    expect(text).toContain("decision dec_2 is open for the user")
  })
})
