// The act verbs in the hub CLI (design §5, §8): hub approve / deny / answer / prompt / stop against an in-process
// fake hub: request bodies, text and --json output, needs_user (exit 4, the evaluation printed) and the other exit
// codes, usage errors.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EXIT, run, type Io } from "../src/cli"

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

async function cli(argv: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    env: options.env ?? { HUB_URL: hub.url, HUB_SESSION_TOKEN: "hst1.session" },
    home: mkdtempSync(path.join(tmpdir(), "hub-cli-act-")),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin! } : {}),
  }
  const code = await run(argv, io)
  return { code, stdout, stderr }
}

const ok = (body: unknown) => () => Response.json(body)
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => () => Response.json({ error: { code, message, ...extra } }, { status })
const bodies = () => hub.seen.map((s) => s.body)

describe("hub approve", () => {
  test("POSTs {requestID}; prints what was approved and under which grant", async () => {
    hub.routes["POST /api/agent/sessions/@api/approve"] = ok({ sessionID: "ses_api", requestID: "per_1", decision: "once", grant: "g_1" })
    const r = await cli(["approve", "@api", "per_1"])
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([{ method: "POST", path: "/api/agent/sessions/@api/approve", body: { requestID: "per_1" } }])
    expect(r.stdout).toBe("approved per_1 in ses_api (once, grant g_1)\n")
  })

  test("--always and --why are sent", async () => {
    hub.routes["POST /api/agent/sessions/@api/approve"] = ok({ sessionID: "ses_api", requestID: "per_1", decision: "always" })
    const r = await cli(["approve", "@api", "per_1", "--always", "--why", "only runs bun test"])
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([{ requestID: "per_1", always: true, why: "only runs bun test" }])
    expect(r.stdout).toBe("approved per_1 in ses_api (always)\n")
  })

  test("needs_user exits 4 and prints the evaluation and the Decision opened", async () => {
    const evaluation = { verdict: "outside", reason: "shell git push origin is outside every grant", tier: "tap", grants: ["g_1", "g_2"] }
    hub.routes["POST /api/agent/sessions/@api/approve"] = fail(403, "needs_user", "Needs the user: shell git push origin is outside every grant", { evaluation, decisionID: "dec_9" })
    const r = await cli(["approve", "@api", "per_1", "--why", "it is the release"])
    expect(r.code).toBe(EXIT.needsUser)
    expect(r.code).toBe(4)
    expect(r.stderr).toContain("hub: Needs the user: shell git push origin is outside every grant")
    expect(r.stderr).toContain("evaluation: outside (tap) — shell git push origin is outside every grant")
    expect(r.stderr).toContain("grants checked: g_1, g_2")
    expect(r.stderr).toContain("decision dec_9 is open for the user")
  })

  test("needs_user with --json prints the envelope (with the evaluation) on stdout", async () => {
    const evaluation = { verdict: "outside", reason: "r", tier: "confirm", grants: [] }
    hub.routes["POST /api/agent/sessions/@api/approve"] = fail(403, "needs_user", "Needs the user: r", { evaluation })
    const r = await cli(["approve", "@api", "per_1", "--json"])
    expect(r.code).toBe(4)
    expect(JSON.parse(r.stdout)).toEqual({ error: { code: "needs_user", message: "Needs the user: r", evaluation } })
    expect(r.stderr).toContain("grants checked: none")
  })

  test.each([
    ["not_found", 404, 3],
    ["forbidden", 403, 5],
    ["paused", 423, 5],
    ["rate_limited", 429, 6],
    ["unsupported", 422, 7],
    ["offline", 503, 7],
    ["gone", 410, 8],
  ] as const)("%s (HTTP %d) exits %d", async (code, status, exit) => {
    hub.routes["POST /api/agent/sessions/@api/approve"] = fail(status, code, `${code} happened`)
    expect((await cli(["approve", "@api", "per_1"])).code).toBe(exit)
  })

  test("needs the address and the request ID", async () => {
    expect((await cli(["approve", "@api"])).code).toBe(EXIT.usage)
    expect(hub.seen).toEqual([])
  })
})

describe("hub deny", () => {
  test("POSTs {requestID, why}; says whether the reason reached the harness", async () => {
    hub.routes["POST /api/agent/sessions/@api/deny"] = ok({ sessionID: "ses_api", requestID: "per_1", grant: "g_1", reasonSent: true })
    const r = await cli(["deny", "@api", "per_1", "--why", "pushes to main"])
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([{ requestID: "per_1", why: "pushes to main" }])
    expect(r.stdout).toBe("denied per_1 in ses_api (grant g_1); the reason reached the harness\n")
  })

  test("without --why only the request ID; an older spoke drops the reason", async () => {
    hub.routes["POST /api/agent/sessions/@api/deny"] = ok({ sessionID: "ses_api", requestID: "per_1", reasonSent: false })
    const r = await cli(["deny", "@api", "per_1"])
    expect(bodies()).toEqual([{ requestID: "per_1" }])
    expect(r.stdout).toBe("denied per_1 in ses_api; the harness did not get the reason (older spoke)\n")
  })
})

describe("hub answer", () => {
  const answered = ok({ sessionID: "ses_api", formID: "que_1" })

  test("key=value pairs become the answer; a repeated key is a list", async () => {
    hub.routes["POST /api/agent/sessions/@api/answer"] = answered
    const r = await cli(["answer", "@api", "que_1", "choice=yes", "tags=a", "tags=b=c", "--why", "the user said so"])
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([{ formID: "que_1", answer: { choice: "yes", tags: ["a", "b=c"] }, why: "the user said so" }])
    expect(r.stdout).toBe("answered que_1 in ses_api\n")
  })

  test("--json '{…}' is the answer as JSON (typed values)", async () => {
    hub.routes["POST /api/agent/sessions/@api/answer"] = answered
    const r = await cli(["answer", "@api", "que_1", "--json", '{"ok":true,"n":2}'])
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([{ formID: "que_1", answer: { ok: true, n: 2 } }])
    expect(r.stdout).toBe("answered que_1 in ses_api\n")
  })

  test("--json - reads the JSON answer from stdin", async () => {
    hub.routes["POST /api/agent/sessions/@api/answer"] = answered
    const r = await cli(["answer", "@api", "que_1", "--json", "-"], { stdin: '{"a":"b"}\n' })
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([{ formID: "que_1", answer: { a: "b" } }])
  })

  test("--json alone (no answer JSON) prints the raw response", async () => {
    hub.routes["POST /api/agent/sessions/@api/answer"] = answered
    const r = await cli(["answer", "@api", "que_1", "a=b", "--json"])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ sessionID: "ses_api", formID: "que_1" })
  })

  test("--cancel dismisses the form", async () => {
    hub.routes["POST /api/agent/sessions/@api/answer"] = answered
    const r = await cli(["answer", "@api", "que_1", "--cancel"])
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([{ formID: "que_1", cancel: true }])
    expect(r.stdout).toBe("cancelled que_1 in ses_api\n")
  })

  test.each([
    [["answer", "@api", "que_1"], "needs key=value"],
    [["answer", "@api", "que_1", "novalue"], "key=value"],
    [["answer", "@api", "que_1", "=x"], "key=value"],
    [["answer", "@api", "que_1", "--json", "[1]"], "JSON object"],
    [["answer", "@api", "que_1", "--json", "{nope"], "JSON object"],
    [["answer", "@api", "que_1", "a=b", "--json", '{"a":"b"}'], "either"],
    [["answer", "@api", "que_1", "a=b", "--cancel"], "either"],
  ])("usage error: %p", async (argv, message) => {
    const r = await cli(argv as string[])
    expect(r.code).toBe(EXIT.usage)
    expect(r.stderr).toContain(message)
    expect(hub.seen).toEqual([])
  })
})

describe("hub prompt", () => {
  test("POSTs {text}; an agent's prompt names its message and grant", async () => {
    hub.routes["POST /api/agent/sessions/@api/prompt"] = ok({ sessionID: "ses_api", messageID: "msg_1", delivered: "turn", grant: "g_1" })
    const r = await cli(["prompt", "@api", "run the tests"])
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([{ text: "run the tests" }])
    expect(r.stdout).toBe("prompted ses_api: msg_1 delivered (turn), grant g_1\n")
  })

  test("--delivery, --why and text from stdin", async () => {
    hub.routes["POST /api/agent/sessions/@api/prompt"] = ok({ sessionID: "ses_api", mode: "steer", inboxID: "in_1" })
    const r = await cli(["prompt", "@api", "-", "--delivery", "steer", "--why", "faster"], { stdin: "hello there\n" })
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([{ text: "hello there", delivery: "steer", why: "faster" }])
    expect(r.stdout).toBe("prompted ses_api: steered into the running turn\n")
  })

  test("the user's prompt that starts a turn", async () => {
    hub.routes["POST /api/agent/sessions/@api/prompt"] = ok({ sessionID: "ses_api", mode: "turn" })
    expect((await cli(["prompt", "@api", "go"])).stdout).toBe("prompted ses_api: started a turn\n")
  })

  test("a bad --delivery or an empty text is a usage error", async () => {
    expect((await cli(["prompt", "@api", "x", "--delivery", "now"])).code).toBe(EXIT.usage)
    expect((await cli(["prompt", "@api", "  "])).code).toBe(EXIT.usage)
    expect(hub.seen).toEqual([])
  })
})

describe("hub stop", () => {
  test("POSTs {} (or {why}) and prints what stopped", async () => {
    hub.routes["POST /api/agent/sessions/@api/stop"] = ok({ sessionID: "ses_api", grant: "g_1", result: { ok: true } })
    const r = await cli(["stop", "@api"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("stopped ses_api (grant g_1)\n")
    await cli(["stop", "@api", "--why", "looping"])
    expect(bodies()).toEqual([{}, { why: "looping" }])
  })

  test("--json prints the raw answer", async () => {
    hub.routes["POST /api/agent/sessions/@api/stop"] = ok({ sessionID: "ses_api", result: { ok: true } })
    expect(JSON.parse((await cli(["stop", "@api", "--json"])).stdout)).toEqual({ sessionID: "ses_api", result: { ok: true } })
  })
})
