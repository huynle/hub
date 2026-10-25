// Decisions in the hub CLI (design §12.1): `hub ask @me` with --option id=label[:safe] (repeatable), --recommend
// id --why, --urgency, --deadline, --on-timeout, --tier, --about; `hub decisions list [--state S]`. Against an
// in-process fake hub: request bodies, text and --json output, usage errors.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run, type Io } from "../src/cli"

type Handler = (request: Request, url: URL, body: any) => Response | Promise<Response>

function fakeHub() {
  const routes: Record<string, Handler> = {}
  const seen: Array<{ method: string; path: string; body?: any }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" ? "" : await request.text()
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

async function cli(argv: string[]) {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    env: { HUB_URL: hub.url, HUB_SESSION_TOKEN: "hst1.session" },
    home: mkdtempSync(path.join(tmpdir(), "hub-cli-dec-")),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  }
  const code = await run(argv, io)
  return { code, stdout, stderr }
}

const API = { kind: "session", sessionID: "ses_api", name: "api-refactor" }
const message = (extra: Record<string, unknown> = {}) => ({ id: "msg_1", kind: "ask", from: API, to: "@me", recipient: { kind: "user" }, text: "Proceed?", state: "open", at: 0, hop: 0, expiresAt: 86_400_000, ...extra })
const decision = (extra: Record<string, unknown> = {}) => ({
  id: "dec_1",
  messageID: "msg_1",
  from: API,
  about: ["ses_api"],
  sessionID: "ses_api",
  question: "Proceed?",
  options: [{ id: "go", label: "Proceed" }, { id: "hold", label: "Hold", safe: true }],
  recommendation: { option: "hold", why: "readers left" },
  urgency: "high",
  tier: "confirm",
  state: "open",
  at: 0,
  expiresAt: 86_400_000,
  ...extra,
})

describe("hub ask @me", () => {
  test("sends the Decision options as the hub expects", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: message(), decision: decision() }, { status: 201 })
    const r = await cli([
      "ask", "@me", "Proceed?",
      "--option", "go=Proceed", "--option", "hold=Hold: for now:safe",
      "--recommend", "hold", "--why", "readers left",
      "--urgency", "high", "--deadline", "2h", "--on-timeout", "hold", "--tier", "tap", "--about", "@web-work", "--about", "ses_x",
    ])
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.body).toEqual({
      to: "@me",
      text: "Proceed?",
      options: [{ id: "go", label: "Proceed" }, { id: "hold", label: "Hold: for now", safe: true }],
      recommendation: { option: "hold", why: "readers left" },
      urgency: "high",
      tier: "tap",
      deadline: 7200,
      onTimeout: "hold",
      about: ["@web-work", "ses_x"],
    })
    expect(r.stdout).toContain("ask msg_1 to @me")
    expect(r.stdout).toContain("decision dec_1 (high): Proceed?")
    expect(r.stdout).toContain("go Proceed · hold Hold (safe)")
    expect(r.stdout).toContain("recommended: hold (readers left)")
  })

  test("--wait prints the user's answer (exit 0)", async () => {
    hub.routes["POST /api/agent/ask"] = () =>
      Response.json({ message: message({ state: "answered" }), decision: decision(), answer: message({ id: "msg_2", kind: "reply", from: { kind: "user" }, text: "Decision dec_1: Hold [hold]", state: "sent" }) }, { status: 201 })
    const r = await cli(["ask", "@me", "Proceed?", "--option", "hold=Hold:safe", "--wait", "30"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("Decision dec_1: Hold [hold]")
  })

  const usage: Array<[string, string[]]> = [
    ["--option without =", ["--option", "go"]],
    ["--option with an empty label", ["--option", "go="]],
    ["--why without --recommend", ["--why", "because"]],
    ["a bad --deadline", ["--deadline", "soon"]],
  ]
  for (const [what, flags] of usage) {
    test(`usage error: ${what}`, async () => {
      const r = await cli(["ask", "@me", "Proceed?", ...flags])
      expect(r.code).toBe(2)
      expect(hub.seen).toEqual([])
    })
  }

  test("Decision options on an ask to a session are a usage error", async () => {
    const r = await cli(["ask", "@web-work", "Proceed?", "--option", "go=Go"])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("@me")
    expect(hub.seen).toEqual([])
  })
})

describe("hub decisions list", () => {
  test("lists the caller's Decisions as text, with the state filter", async () => {
    hub.routes["GET /api/agent/decisions"] = () =>
      Response.json({
        decisions: [
          decision(),
          decision({ id: "dec_0", question: "Old?", state: "answered", urgency: "normal", answer: { option: "hold", answeredBy: "timeout", at: 5 } }),
        ],
      })
    const r = await cli(["decisions", "list", "--state", "open"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.path).toBe("/api/agent/decisions?state=open")
    const lines = r.stdout.trim().split("\n")
    expect(lines[0]).toBe("dec_1  open  high  from @api-refactor  Proceed?")
    expect(lines[1]).toBe("  go Proceed · hold Hold (safe) — recommended: hold (readers left)")
    expect(r.stdout).toContain("dec_0  answered hold (timeout)  normal  from @api-refactor  Old?")
  })

  test("--json prints the hub's answer; none is 'no decisions'; a bad --state is a usage error", async () => {
    hub.routes["GET /api/agent/decisions"] = () => Response.json({ decisions: [] })
    expect((await cli(["decisions", "list"])).stdout.trim()).toBe("no decisions")
    expect(JSON.parse((await cli(["decisions", "list", "--json"])).stdout)).toEqual({ decisions: [] })
    expect((await cli(["decisions", "list", "--state", "bogus"])).code).toBe(2)
    expect((await cli(["decisions"])).code).toBe(2)
  })
})
