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

const ask = (fields: Record<string, unknown> = {}) => message({ kind: "ask", text: "ready?", state: "open", expiresAt: Date.UTC(2026, 9, 25, 8, 15), ...fields })
const reply = (fields: Record<string, unknown> = {}) => message({ id: "msg_r", kind: "reply", from: WEB, to: "ses_api", recipient: API, replyTo: "msg_1", text: "yes, go", ...fields })

describe("hub ask", () => {
  test("POST /api/agent/ask {to, text}; text says it is open and until when", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask(), delivery: "steer" }, { status: 201 })
    const r = await cli(["ask", "@web-work", "ready?"])
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([{ method: "POST", path: "/api/agent/ask", body: { to: "@web-work", text: "ready?" } }])
    expect(r.stdout).toContain("ask msg_1 to @web-work")
    expect(r.stdout).toContain("open until 2026-10-25T08:15")
    expect(r.stdout).toContain("hub inbox")
  })

  test("--expires takes seconds or a duration (30s, 5m, 2h, 1d); anything else is a usage error", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask() }, { status: 201 })
    for (const [value, seconds] of [["90", 90], ["30s", 30], ["5m", 300], ["2h", 7200], ["1d", 86400], ["1.5h", 5400]] as const) {
      hub.seen.length = 0
      expect((await cli(["ask", "@web-work", "ready?", "--expires", value])).code).toBe(0)
      expect(hub.seen[0]!.body.expiresIn).toBe(seconds)
    }
    hub.seen.length = 0
    for (const bad of ["soon", "-5", "2w", ""]) expect((await cli(["ask", "@web-work", "ready?", `--expires=${bad}`])).code).toBe(2)
    expect(hub.seen).toEqual([])
  })

  test("--wait N sends the wait; an answer prints its text and exits 0", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask({ state: "answered", answer: { id: "msg_r", at: 2 } }), delivery: "turn", answer: reply() }, { status: 201 })
    const r = await cli(["ask", "@web-work", "ready?", "--wait", "30"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.body).toEqual({ to: "@web-work", text: "ready?", wait: 30 })
    expect(r.stdout).toContain("@web-work")
    expect(r.stdout).toContain("yes, go")
  })

  test("a bare --wait waits until the ask expires (looping GET messages/:id?wait= past 60 s)", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask(), delivery: "turn" }, { status: 201 })
    hub.routes["GET /api/agent/messages/msg_1"] = () => Response.json({ message: ask({ state: "answered" }), answer: reply() })
    const r = await cli(["ask", "@web-work", "--wait", "ready?", "--expires", "2m"])
    expect(r.code).toBe(0)
    expect(hub.seen.map((s) => [s.method, s.path, s.body?.wait, s.body?.text])).toEqual([
      ["POST", "/api/agent/ask", 60, "ready?"],
      ["GET", "/api/agent/messages/msg_1?wait=60", undefined, undefined],
    ])
    expect(r.stdout).toContain("yes, go")
  })

  test("--wait takes a duration too; a bad one is a usage error", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask({ state: "answered" }), answer: reply() }, { status: 201 })
    expect((await cli(["ask", "@web-work", "ready?", "--wait", "45s"])).code).toBe(0)
    expect(hub.seen[0]!.body.wait).toBe(45)
    expect((await cli(["ask", "@web-work", "ready?", "--wait=later"])).code).toBe(2)
  })

  test("declined exits 1 with the reason; expired exits 8; still open after the wait exits 1", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask({ state: "declined" }), answer: reply({ kind: "decline", text: "busy with the release" }) }, { status: 201 })
    const declined = await cli(["ask", "@web-work", "ready?", "--wait", "5"])
    expect(declined.code).toBe(1)
    expect(declined.stdout + declined.stderr).toContain("declined")
    expect(declined.stdout + declined.stderr).toContain("busy with the release")
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask({ state: "expired" }) }, { status: 201 })
    const expired = await cli(["ask", "@web-work", "ready?", "--wait", "5"])
    expect(expired.code).toBe(8)
    expect(expired.stdout + expired.stderr).toContain("expired")
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask() }, { status: 201 })
    const open = await cli(["ask", "@web-work", "ready?", "--wait", "5"])
    expect(open.code).toBe(1)
    expect(open.stderr).toContain("no answer within 5 s")
    expect(open.stderr).toContain("msg_1")
  })

  test("--json prints the hub's answer and keeps the exit code", async () => {
    const answer = { message: ask({ state: "declined" }), answer: reply({ kind: "decline", text: "no" }) }
    hub.routes["POST /api/agent/ask"] = () => Response.json(answer, { status: 201 })
    const r = await cli(["ask", "@web-work", "ready?", "--wait", "5", "--json"])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toEqual(answer)
  })

  test("--all asks every holder; it cannot be combined with --wait", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ sent: [{ message: ask(), delivery: "turn" }, { message: ask({ id: "msg_2", recipient: API }) }] }, { status: 201 })
    const r = await cli(["ask", "@@reviewer", "ready?", "--all", "--no-wake", "--urgent"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.body).toEqual({ to: "@@reviewer", text: "ready?", all: true, wake: false, urgent: true })
    expect(r.stdout.trim().split("\n").filter((l) => l.includes("msg_"))).toHaveLength(2)
    hub.seen.length = 0
    expect((await cli(["ask", "@@reviewer", "ready?", "--all", "--wait", "5"])).code).toBe(2)
    expect(hub.seen).toEqual([])
  })

  test('"-" reads the question from stdin', async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: ask() }, { status: 201 })
    expect((await cli(["ask", "@web-work", "-"], { stdin: "a long\nquestion\n" })).code).toBe(0)
    expect(hub.seen[0]!.body.text).toBe("a long\nquestion")
  })
})

describe("hub reply and hub decline", () => {
  test("reply: POST /api/agent/reply {replyTo, text}; text names the real sender it went to", async () => {
    hub.routes["POST /api/agent/reply"] = () => Response.json({ message: reply(), delivery: "turn", original: ask({ state: "answered" }) }, { status: 201 })
    const r = await cli(["reply", "msg_1", "yes, go"])
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([{ method: "POST", path: "/api/agent/reply", body: { replyTo: "msg_1", text: "yes, go" } }])
    expect(r.stdout).toContain("reply msg_r")
    expect(r.stdout).toContain("@api-refactor")
    expect(r.stdout).toContain("msg_1")
  })

  test("reply --no-wake and stdin text", async () => {
    hub.routes["POST /api/agent/reply"] = () => Response.json({ message: reply(), original: ask() }, { status: 201 })
    expect((await cli(["reply", "msg_1", "-", "--no-wake"], { stdin: "done\n" })).code).toBe(0)
    expect(hub.seen[0]!.body).toEqual({ replyTo: "msg_1", text: "done", wake: false })
  })

  test("decline: POST /api/agent/decline {replyTo, why}; --why is required (stdin with -)", async () => {
    hub.routes["POST /api/agent/decline"] = () => Response.json({ message: reply({ kind: "decline", text: "busy" }), delivery: "queued", original: ask({ state: "declined" }) }, { status: 201 })
    const r = await cli(["decline", "msg_1", "--why", "busy"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]).toEqual({ method: "POST", path: "/api/agent/decline", body: { replyTo: "msg_1", why: "busy" } })
    expect(r.stdout).toContain("declined msg_1")
    expect((await cli(["decline", "msg_1", "--why", "-"], { stdin: "on leave\n" })).code).toBe(0)
    expect(hub.seen[1]!.body.why).toBe("on leave")
    hub.seen.length = 0
    expect((await cli(["decline", "msg_1"])).code).toBe(2)
    expect((await cli(["decline", "msg_1", "--why", " "])).code).toBe(2)
    expect(hub.seen).toEqual([])
  })

  test("an answered or expired ask is gone (exit 8); a foreign id not_found (exit 3)", async () => {
    hub.routes["POST /api/agent/reply"] = fail(410, "gone", "That ask was already answered")
    expect((await cli(["reply", "msg_1", "late"])).code).toBe(8)
    hub.routes["POST /api/agent/decline"] = fail(404, "not_found", "No such message")
    expect((await cli(["decline", "msg_x", "--why", "no"])).code).toBe(3)
  })
})

describe("hub inbox", () => {
  const INBOX = {
    asks: [message({ id: "msg_a", kind: "ask", from: WEB, recipient: API, to: "@api-refactor", text: "can you\nreview?", state: "open", expiresAt: Date.UTC(2026, 9, 25) })],
    waiting: [ask({ id: "msg_w" })],
    messages: [message({ id: "msg_m", from: { kind: "user" }, recipient: API, to: "ses_api", text: "lunch at 12" })],
    muted: ["ses_noisy"],
  }

  test("GET /api/agent/inbox; text lists asks to answer (with how), own open asks, messages and mutes", async () => {
    hub.routes["GET /api/agent/inbox"] = () => Response.json(INBOX)
    const r = await cli(["inbox"])
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([{ method: "GET", path: "/api/agent/inbox" }])
    const out = r.stdout
    expect(out).toContain("msg_a")
    expect(out).toContain("@web-work")
    expect(out).toContain("can you review?")
    expect(out).toContain('hub reply msg_a "…"')
    expect(out).toContain("msg_w")
    expect(out).toContain("msg_m")
    expect(out).toContain("@me")
    expect(out).toContain("lunch at 12")
    expect(out).toContain("ses_noisy")
    expect(out.indexOf("msg_a")).toBeLessThan(out.indexOf("msg_w"))
    expect(out.indexOf("msg_w")).toBeLessThan(out.indexOf("msg_m"))
  })

  test("an empty inbox says so; --json prints the hub's answer", async () => {
    hub.routes["GET /api/agent/inbox"] = () => Response.json({ asks: [], waiting: [], messages: [], muted: [] })
    expect((await cli(["inbox"])).stdout.trim()).toBe("inbox empty")
    hub.routes["GET /api/agent/inbox"] = () => Response.json(INBOX)
    expect(JSON.parse((await cli(["inbox", "--json"])).stdout)).toEqual(INBOX)
  })
})

describe("hub mute and hub unmute", () => {
  test("POST /api/agent/mute|unmute {session}; text lists who is muted", async () => {
    hub.routes["POST /api/agent/mute"] = () => Response.json({ muted: ["ses_noisy", "ses_web"] })
    hub.routes["POST /api/agent/unmute"] = () => Response.json({ muted: [] })
    const muted = await cli(["mute", "@web-work"])
    expect(muted.code).toBe(0)
    expect(hub.seen[0]).toEqual({ method: "POST", path: "/api/agent/mute", body: { session: "@web-work" } })
    expect(muted.stdout).toContain("ses_noisy")
    expect(muted.stdout).toContain("ses_web")
    const unmuted = await cli(["unmute", "@web-work"])
    expect(hub.seen[1]).toEqual({ method: "POST", path: "/api/agent/unmute", body: { session: "@web-work" } })
    expect(unmuted.stdout).toContain("nobody")
    expect(JSON.parse((await cli(["unmute", "@web-work", "--json"])).stdout)).toEqual({ muted: [] })
    expect((await cli(["mute"])).code).toBe(2)
  })
})

describe("help", () => {
  test("usage lists the messaging verbs", async () => {
    const r = await cli(["help"])
    for (const verb of ["hub msg", "hub ask", "hub reply", "hub decline", "hub inbox", "hub mute", "hub unmute", "--wait", "--expires", "--no-wake", "--urgent", "--all", "--why"]) expect(r.stdout).toContain(verb)
  })
})
