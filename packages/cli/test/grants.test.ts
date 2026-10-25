// `hub grant list | show | create | revoke` (design §5): the user's grants through /api/agent/grants. Only the user
// creates or revokes a grant: a session's own credential exits 5 (forbidden) without asking the hub; any other
// credential the hub refuses exits 5 too. Against an in-process fake hub.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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

/** A home logged in with a device token (the user). */
function userHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "hub-cli-grant-"))
  mkdirSync(path.join(home, ".config", "hub"), { recursive: true })
  writeFileSync(path.join(home, ".config", "hub", "cli.json"), JSON.stringify({ url: hub.url, token: "hdt_device" }), { mode: 0o600 })
  return home
}

async function cli(argv: string[], options: { session?: boolean; stdin?: string } = {}) {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    env: options.session ? { HUB_URL: hub.url, HUB_SESSION_TOKEN: "hst1.session" } : {},
    home: userHome(),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin! } : {}),
  }
  const code = await run(argv, io)
  return { code, stdout, stderr }
}

const ok = (body: unknown, status = 200) => () => Response.json(body, { status })
const EXPIRES = Date.UTC(2026, 9, 25, 8, 0, 0)
const grant = (extra: Record<string, unknown> = {}) => ({
  id: "g_1",
  holder: "@@orchestrator",
  scope: { projects: ["/Users/huy/projects/hub"] },
  allow: ["approve", "deny"],
  permissions: { allow: ["read", "shell:bun test*"], never: ["shell:git push*"] },
  allowAlways: false,
  maxActionsPerHour: 120,
  created: EXPIRES - 8 * 3_600_000,
  expiresAt: EXPIRES,
  state: "active",
  ...extra,
})

describe("hub grant list / show", () => {
  test("list: one line per grant", async () => {
    hub.routes["GET /api/agent/grants"] = ok({ grants: [grant(), grant({ id: "g_2", holder: "ses_abc", state: "revoked", allow: ["stop"] })] })
    const r = await cli(["grant", "list"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      "g_1  active  @@orchestrator  approve,deny  /Users/huy/projects/hub  until 2026-10-25T08:00:00Z\n" +
        "g_2  revoked  ses_abc  stop  /Users/huy/projects/hub  until 2026-10-25T08:00:00Z\n",
    )
  })

  test("list: none", async () => {
    hub.routes["GET /api/agent/grants"] = ok({ grants: [] })
    expect((await cli(["grant", "list"])).stdout).toBe("no grants\n")
  })

  test("show: the whole grant", async () => {
    hub.routes["GET /api/agent/grants/g_1"] = ok({ grant: grant({ holderSessionID: "ses_orc" }) })
    const r = await cli(["grant", "show", "g_1"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        "g_1  active",
        "holder: @@orchestrator (ses_orc)",
        "projects: /Users/huy/projects/hub",
        "verbs: approve, deny",
        "permissions allow: read, shell:bun test*",
        "permissions never: shell:git push*",
        "always: no",
        "max actions per hour: 120",
        "expires: 2026-10-25T08:00:00Z",
        "",
      ].join("\n"),
    )
  })

  test("--json prints the raw answer", async () => {
    hub.routes["GET /api/agent/grants"] = ok({ grants: [grant()] })
    expect(JSON.parse((await cli(["grant", "list", "--json"])).stdout)).toEqual({ grants: [grant()] })
  })

  test("a credential the hub refuses exits 5 with a hint", async () => {
    hub.routes["GET /api/agent/grants"] = () => Response.json({ error: { code: "forbidden", message: "This credential cannot use this route" } }, { status: 403 })
    const r = await cli(["grant", "list"])
    expect(r.code).toBe(EXIT.forbidden)
    expect(r.stderr).toContain("only the user")
  })
})

describe("hub grant create", () => {
  test("flags become the grant spec", async () => {
    hub.routes["POST /api/agent/grants"] = ok({ grant: grant() }, 201)
    const r = await cli([
      "grant", "create",
      "--holder", "@@orchestrator",
      "--project", "/Users/huy/projects/hub",
      "--allow", "approve,deny",
      "--allow", "stop",
      "--permit", "read",
      "--permit", "shell:bun test*",
      "--never", "shell:git push*",
      "--expires", "8h",
      "--max-per-hour", "120",
      "--allow-always",
    ])
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([
      {
        method: "POST",
        path: "/api/agent/grants",
        body: {
          holder: "@@orchestrator",
          scope: { projects: ["/Users/huy/projects/hub"] },
          allow: ["approve", "deny", "stop"],
          permissions: { allow: ["read", "shell:bun test*"], never: ["shell:git push*"] },
          expires: "8h",
          maxActionsPerHour: 120,
          allowAlways: true,
        },
      },
    ])
    expect(r.stdout.split("\n")[0]).toBe("created g_1  active")
  })

  test("only what is given is sent", async () => {
    hub.routes["POST /api/agent/grants"] = ok({ grant: grant() }, 201)
    await cli(["grant", "create", "--holder", "@api", "--project", "/p", "--allow", "stop"])
    expect(hub.seen[0]!.body).toEqual({ holder: "@api", scope: { projects: ["/p"] }, allow: ["stop"] })
  })

  test("--json '{…}' (or --json -) is the spec as JSON", async () => {
    hub.routes["POST /api/agent/grants"] = ok({ grant: grant() }, 201)
    const spec = { holder: "@api", scope: { projects: ["/p"] }, allow: ["approve"], expires: "2h" }
    expect((await cli(["grant", "create", "--json", JSON.stringify(spec)])).code).toBe(0)
    expect((await cli(["grant", "create", "--json", "-"], { stdin: JSON.stringify(spec) })).code).toBe(0)
    expect(hub.seen.map((s) => s.body)).toEqual([spec, spec])
  })

  test.each([
    [["grant", "create", "--project", "/p", "--allow", "stop"], "--holder"],
    [["grant", "create", "--holder", "@a", "--allow", "stop"], "--project"],
    [["grant", "create", "--holder", "@a", "--project", "/p"], "--allow"],
    [["grant", "create", "--holder", "@a", "--project", "/p", "--allow", "stop", "--max-per-hour", "lots"], "--max-per-hour"],
    [["grant", "create", "--json", '{"holder":"@a"}', "--holder", "@a"], "either"],
    [["grant", "create", "--json", "[1]"], "JSON object"],
  ])("usage error: %p", async (argv, message) => {
    const r = await cli(argv as string[])
    expect(r.code).toBe(EXIT.usage)
    expect(r.stderr).toContain(message)
    expect(hub.seen).toEqual([])
  })

  test("a session's own credential exits 5 without asking the hub", async () => {
    const r = await cli(["grant", "create", "--holder", "@a", "--project", "/p", "--allow", "stop"], { session: true })
    expect(r.code).toBe(EXIT.forbidden)
    expect(r.stderr).toContain("only the user")
    expect(hub.seen).toEqual([])
  })

  test("the hub's invalid is a usage exit with its message", async () => {
    hub.routes["POST /api/agent/grants"] = () => Response.json({ error: { code: "invalid", message: "expires is 1 minute to 30 days" } }, { status: 400 })
    const r = await cli(["grant", "create", "--holder", "@a", "--project", "/p", "--allow", "stop", "--expires", "90d"])
    expect(r.code).toBe(EXIT.usage)
    expect(r.stderr).toContain("expires is 1 minute to 30 days")
  })
})

describe("hub grant revoke", () => {
  test("DELETEs the grant", async () => {
    hub.routes["DELETE /api/agent/grants/g_1"] = ok({ grant: grant({ state: "revoked", revokedAt: EXPIRES }) })
    const r = await cli(["grant", "revoke", "g_1"])
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([{ method: "DELETE", path: "/api/agent/grants/g_1" }])
    expect(r.stdout).toBe("revoked g_1 (@@orchestrator)\n")
  })

  test("an ended grant is gone (8)", async () => {
    hub.routes["DELETE /api/agent/grants/g_1"] = () => Response.json({ error: { code: "gone", message: "The grant already ended" } }, { status: 410 })
    expect((await cli(["grant", "revoke", "g_1"])).code).toBe(EXIT.gone)
  })

  test("a session's own credential exits 5 without asking the hub", async () => {
    const r = await cli(["grant", "revoke", "g_1"], { session: true })
    expect(r.code).toBe(EXIT.forbidden)
    expect(hub.seen).toEqual([])
  })

  test("grant needs a subcommand", async () => {
    const r = await cli(["grant"])
    expect(r.code).toBe(EXIT.usage)
    expect(r.stderr).toContain("list or show or create or revoke or request")
  })
})

describe("hub grant request (agents ask the user)", () => {
  const decision = { id: "dec_1", messageID: "msg_1", state: "open", tier: "tap", urgency: "high", question: "…", options: [], from: { kind: "session", sessionID: "ses_o" }, about: [], at: 0, expiresAt: 1 }
  const requested = () => Response.json({ message: { id: "msg_1" }, decision }, { status: 201 })

  test("flags become {grant, why} (holder defaults to the requester); prints the Decision it waits on", async () => {
    hub.routes["POST /api/agent/grants/requests"] = requested
    const r = await cli(
      ["grant", "request", "--project", "/Users/huy/projects/hub", "--allow", "approve,deny", "--permission-allow", "read", "--never", "shell:git push*", "--expires", "8h", "--why", "the workers keep asking to read"],
      { session: true },
    )
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([
      {
        method: "POST",
        path: "/api/agent/grants/requests",
        body: {
          grant: { scope: { projects: ["/Users/huy/projects/hub"] }, allow: ["approve", "deny"], permissions: { allow: ["read"], never: ["shell:git push*"] }, expires: "8h" },
          why: "the workers keep asking to read",
        },
      },
    ])
    expect(r.stdout).toBe("requested; waiting for the user (Decision dec_1)\n")
  })

  test("--holder, --max-per-hour, --allow-always and --permit pass through; --json prints the raw answer", async () => {
    hub.routes["POST /api/agent/grants/requests"] = requested
    const r = await cli(["grant", "request", "--holder", "@@orchestrator", "--project", "/p", "--allow", "stop", "--permit", "edit", "--max-per-hour", "10", "--allow-always", "--why", "x", "--json"], { session: true })
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.body).toEqual({ grant: { holder: "@@orchestrator", scope: { projects: ["/p"] }, allow: ["stop"], permissions: { allow: ["edit"] }, maxActionsPerHour: 10, allowAlways: true }, why: "x" })
    expect(JSON.parse(r.stdout).decision.id).toBe("dec_1")
  })

  test("--why is required; --project and --allow too (usage, without asking the hub)", async () => {
    for (const argv of [
      ["grant", "request", "--project", "/p", "--allow", "stop"],
      ["grant", "request", "--allow", "stop", "--why", "x"],
      ["grant", "request", "--project", "/p", "--why", "x"],
    ]) {
      const r = await cli(argv, { session: true })
      expect(r.code).toBe(EXIT.usage)
    }
    expect(hub.seen).toEqual([])
  })

  test("an open request already waiting is rate limited (6), with the hub's message", async () => {
    hub.routes["POST /api/agent/grants/requests"] = () => Response.json({ error: { code: "rate_limited", message: "Your grant request dec_1 still waits for the user", decisionID: "dec_1", retryAfter: 60 } }, { status: 429 })
    const r = await cli(["grant", "request", "--project", "/p", "--allow", "stop", "--why", "x"], { session: true })
    expect(r.code).toBe(EXIT.rateLimited)
    expect(r.stderr).toContain("dec_1 still waits")
  })
})
