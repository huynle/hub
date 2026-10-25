// `hub mcp`'s launch tools (design §6.1): launch, launches, launch_show and launch_stop, with this server's
// credential (an app token with scope sessions:launch and a launch grant, or the user's), against a fake hub.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createMcpServer } from "../src/mcp"

type Handler = (request: Request, url: URL, body: any) => Response | Promise<Response>

function fakeHub() {
  const routes: Record<string, Handler> = {}
  const seen: Array<{ method: string; path: string; body?: any }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text()
      const body = text ? JSON.parse(text) : undefined
      seen.push({ method: request.method, path: url.pathname + url.search, ...(text ? { body } : {}) })
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

const server = () => createMcpServer({ credentials: () => ({ url: hub.url, token: "hat_launch", source: "login" as const }), version: "0" })
async function call(name: string, args: unknown) {
  return (await server().handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any
}
const textOf = (r: any): string => r.result.content.map((c: any) => c.text).join("\n")

const launch = (extra: Record<string, unknown> = {}) => ({
  id: "lch_1",
  state: "queued",
  reason: "waiting for a node",
  spec: { workspace: { repo: "/p/hub", mode: "worktree", branch: "feat/x" }, labels: { app: "brain" } },
  created: 1,
  updated: 1,
  history: [],
  ...extra,
})

describe("launch tools", () => {
  test("listed: launch (repo required, not read-only), launches and launch_show read-only, launch_stop", async () => {
    const r = (await server().handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as any
    const tools = Object.fromEntries((r.result.tools as any[]).map((t) => [t.name, t]))
    expect(tools.launch.inputSchema.required).toEqual(["repo"])
    expect(tools.launch.annotations.readOnlyHint).toBe(false)
    expect(tools.launches.annotations.readOnlyHint).toBe(true)
    expect(tools.launch_show.inputSchema.required).toEqual(["id"])
    expect(tools.launch_show.annotations.readOnlyHint).toBe(true)
    expect(tools.launch_stop.inputSchema.required).toEqual(["id"])
    expect(tools.launch_stop.annotations.readOnlyHint).toBe(false)
  })

  test("launch: the arguments as the spec; the CLI's text", async () => {
    hub.routes["POST /api/agent/launches"] = () => Response.json({ launch: launch() }, { status: 201 })
    const r = await call("launch", {
      repo: "/p/hub",
      branch: "feat/x",
      mode: "worktree",
      base: "main",
      key: "k1",
      name: "@api",
      roles: ["@@reviewer"],
      agent: "build",
      model: "anthropic/x",
      runtime: "host",
      machine: "mbp",
      prefer: true,
      nodeLabels: { os: "darwin" },
      labels: { app: "brain" },
      prompt: "do it",
      end: "idle",
      timeout: "2h",
      cleanup: "keep",
    })
    expect(r.result.isError).toBe(false)
    expect(textOf(r)).toBe("launched lch_1: queued (waiting for a node)")
    expect(hub.seen[0]!.body).toEqual({
      key: "k1",
      name: "api",
      roles: ["reviewer"],
      agent: "build",
      model: "anthropic/x",
      workspace: { repo: "/p/hub", mode: "worktree", branch: "feat/x", base: "main" },
      runtime: { kind: "host" },
      placement: { labels: { os: "darwin" }, machine: "mbp", mode: "prefer" },
      prompt: "do it",
      labels: { app: "brain" },
      end: { when: "idle", timeout: "2h", cleanup: "keep" },
    })
  })

  test("launch: bad arguments are tool errors, never sent", async () => {
    for (const args of [{}, { repo: "relative/path" }, { repo: "/p", mode: "fork" }, { repo: "/p", labels: { a: 1 } }, { repo: "/p", roles: "x" }, { repo: "/p", profile: "p" }]) {
      const r = await call("launch", args)
      expect({ args, isError: r.result.isError }).toEqual({ args, isError: true })
    }
    expect(hub.seen).toEqual([])
  })

  test("launches, launch_show, launch_stop; gone is a tool error with its code", async () => {
    hub.routes["GET /api/agent/launches"] = () => Response.json({ launches: [launch()] })
    hub.routes["GET /api/agent/launches/lch_1"] = () => Response.json({ launch: launch() })
    hub.routes["DELETE /api/agent/launches/lch_1"] = () => Response.json({ launch: launch({ state: "ended", outcome: "stopped", reason: "stopped by app" }) })
    hub.routes["DELETE /api/agent/launches/lch_2"] = () => Response.json({ error: { code: "gone", message: "Launch lch_2 already ended" } }, { status: 410 })
    expect(textOf(await call("launches", { state: "queued,running", label: ["app=brain"] }))).toBe("lch_1  queued  /p/hub (feat/x)  app=brain")
    expect(hub.seen[0]!.path).toBe("/api/agent/launches?state=queued%2Crunning&label=app%3Dbrain")
    expect(textOf(await call("launch_show", { id: "lch_1" }))).toContain("lch_1  queued (waiting for a node)")
    expect(textOf(await call("launch_stop", { id: "lch_1" }))).toBe("stopped lch_1: ended stopped (stopped by app)")
    const gone = await call("launch_stop", { id: "lch_2" })
    expect(gone.result.isError).toBe(true)
    expect(textOf(gone)).toContain("gone: Launch lch_2 already ended")
  })
})
