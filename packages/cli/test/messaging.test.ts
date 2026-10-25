// The messaging verbs of the hub CLI (msg, ask, reply, decline, inbox, mute, unmute) against an in-process fake hub:
// request bodies, text and --json output, stdin text ("-"), exit codes.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run, type Io } from "../src/cli"

interface Seen {
  method: string
  path: string
  body?: any
}

type Handler = (request: Request, url: URL, body: any) => Response | Promise<Response>

function fakeHub() {
  const routes: Record<string, Handler> = {}
  const seen: Seen[] = []
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

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => () => Response.json({ error: { code, message, ...extra } }, { status })

async function cli(argv: string[], options: { stdin?: string } = {}) {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    env: { HUB_URL: hub.url, HUB_SESSION_TOKEN: "hst1.session" },
    home: mkdtempSync(path.join(tmpdir(), "hub-cli-msg-")),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin! } : {}),
  }
  const code = await run(argv, io)
  return { code, stdout, stderr }
}

const API = { kind: "session", sessionID: "ses_api", name: "api-refactor" }
const WEB = { kind: "session", sessionID: "ses_web", name: "web-work" }

const message = (fields: Record<string, unknown> = {}) => ({
  id: "msg_1",
  kind: "msg",
  from: API,
  to: "@web-work",
  recipient: WEB,
  text: "hello",
  state: "sent",
  at: Date.UTC(2026, 9, 24, 8, 15),
  hop: 0,
  ...fields,
})

describe("hub msg", () => {
  test("POST /api/agent/msg {to, text}; text names the recipient, the id and the delivery", async () => {
    hub.routes["POST /api/agent/msg"] = () => Response.json({ message: message(), delivery: "turn" }, { status: 201 })
    const r = await cli(["msg", "@web-work", "hello"])
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([{ method: "POST", path: "/api/agent/msg", body: { to: "@web-work", text: "hello" } }])
    expect(r.stdout).toContain("msg_1")
    expect(r.stdout).toContain("@web-work")
    expect(r.stdout).toContain("turn")
    expect(r.stderr).toBe("")
  })

  test("--no-wake, --urgent and --all are sent; --all prints one line per recipient", async () => {
    hub.routes["POST /api/agent/msg"] = () =>
      Response.json({ sent: [{ message: message(), delivery: "queued" }, { message: message({ id: "msg_2", recipient: API }), delivery: "steer" }] }, { status: 201 })
    const r = await cli(["msg", "@@reviewer", "look", "--no-wake", "--urgent", "--all"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.body).toEqual({ to: "@@reviewer", text: "look", wake: false, urgent: true, all: true })
    const lines = r.stdout.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("msg_1")
    expect(lines[0]).toContain("queued")
    expect(lines[1]).toContain("msg_2")
    expect(lines[1]).toContain("@api-refactor")
  })

  test('"-" reads the text from stdin (trailing newline dropped)', async () => {
    hub.routes["POST /api/agent/msg"] = () => Response.json({ message: message() }, { status: 201 })
    const r = await cli(["msg", "@web-work", "-"], { stdin: "line one\nline two\n" })
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.body.text).toBe("line one\nline two")
  })

  test("empty text is a usage error; nothing is sent", async () => {
    for (const [argv, stdin] of [[["msg", "@web-work", "  "]], [["msg", "@web-work", "-"], "\n"]] as [string[], string?][]) {
      const r = await cli(argv, stdin === undefined ? {} : { stdin })
      expect(r.code).toBe(2)
    }
    expect((await cli(["msg", "@web-work"])).code).toBe(2)
    expect(hub.seen).toEqual([])
  })

  test("a message without a delivery (stored only) says so", async () => {
    hub.routes["POST /api/agent/msg"] = () => Response.json({ message: message({ to: "@me", recipient: { kind: "user" } }) }, { status: 201 })
    const r = await cli(["msg", "@me", "hi"])
    expect(r.stdout).toContain("@me")
    expect(r.stdout).toContain("stored")
  })

  test("--json prints the hub's answer", async () => {
    const answer = { message: message(), delivery: "turn" }
    hub.routes["POST /api/agent/msg"] = () => Response.json(answer, { status: 201 })
    const r = await cli(["msg", "@web-work", "hello", "--json"])
    expect(JSON.parse(r.stdout)).toEqual(answer)
  })

  test("exit codes: unsupported deliver 7, paused 5, rate_limited 6, muted (forbidden) 5", async () => {
    const cases: [number, string, Record<string, unknown>, number][] = [
      [422, "unsupported", { feature: "deliver" }, 7],
      [423, "paused", {}, 5],
      [429, "rate_limited", { retryAfter: 30 }, 6],
      [403, "forbidden", {}, 5],
    ]
    for (const [status, code, extra, exit] of cases) {
      hub.routes["POST /api/agent/msg"] = fail(status, code, `the ${code} message`, extra)
      const r = await cli(["msg", "@web-work", "hello"])
      expect({ code, exit: r.code }).toEqual({ code, exit })
      expect(r.stderr).toContain(`the ${code} message`)
    }
  })

  test("unsupported names the missing feature", async () => {
    hub.routes["POST /api/agent/msg"] = fail(422, "unsupported", "The recipient's spoke cannot receive messages", { feature: "deliver" })
    const r = await cli(["msg", "@web-work", "hello"])
    expect(r.stderr).toContain("deliver")
  })
})
