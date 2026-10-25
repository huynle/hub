// `hub launch` and `hub launches list | show | stop` (design §6.1, §8; decision znbg8xa5): flags become the launch
// spec POSTed to /api/agent/launches (unset fields left to the hub's defaults), and the launch routes' answers
// become short text (or the raw answer with --json). Against an in-process fake hub.
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

const CWD = "/Users/huy/projects/hub"

async function cli(argv: string[], options: { stdin?: string } = {}) {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    env: { HUB_URL: hub.url, HUB_SESSION_TOKEN: "hst1.session" },
    home: mkdtempSync(path.join(tmpdir(), "hub-cli-launch-")),
    cwd: CWD,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin! } : {}),
  }
  const code = await run(argv, io)
  return { code, stdout, stderr }
}

const launch = (extra: Record<string, unknown> = {}) => ({
  id: "lch_1",
  state: "queued",
  reason: "waiting for a node",
  spec: { workspace: { repo: CWD, mode: "worktree", branch: "feat/x" }, labels: { app: "brain" } },
  created: 1,
  updated: 1,
  by: "user",
  history: [{ state: "queued", reason: "waiting for a node", at: 1 }],
  ...extra,
})

describe("hub launch", () => {
  test("every flag of the spec, as the hub's body", async () => {
    hub.routes["POST /api/agent/launches"] = () => Response.json({ launch: launch() }, { status: 201 })
    const r = await cli([
      "launch",
      "--key", "brain-abc",
      "--name", "@api-refactor",
      "--role", "reviewer.hub",
      "--role", "@@tester",
      "--harness", "opencode",
      "--agent", "build",
      "--model", "anthropic/claude-x",
      "--repo", "../other",
      "--mode", "worktree",
      "--branch", "feat/x",
      "--base", "main",
      "--remote", "git@github.com:huynle/hub.git",
      "--runtime", "openshell",
      "--profile", "untrusted-code",
      "--machine", "mbp",
      "--prefer",
      "--node-label", "os=darwin",
      "--label", "app=brain",
      "--label", "brain.task=abc",
      "--prompt", "refactor the API",
      "--end", "asked",
      "--timeout", "4h",
      "--cleanup", "remove",
    ])
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    expect(hub.seen).toEqual([
      {
        method: "POST",
        path: "/api/agent/launches",
        body: {
          key: "brain-abc",
          name: "api-refactor",
          roles: ["reviewer.hub", "tester"],
          harness: "opencode",
          agent: "build",
          model: "anthropic/claude-x",
          workspace: { repo: "/Users/huy/projects/other", mode: "worktree", branch: "feat/x", base: "main", remote: "git@github.com:huynle/hub.git" },
          runtime: { kind: "openshell", profile: "untrusted-code" },
          placement: { labels: { os: "darwin" }, machine: "mbp", mode: "prefer" },
          prompt: "refactor the API",
          labels: { app: "brain", "brain.task": "abc" },
          end: { when: "asked", timeout: "4h", cleanup: "remove" },
        },
      },
    ])
    expect(r.stdout).toBe("launched lch_1: queued (waiting for a node)\n")
  })

  test("only what is given: the repo defaults to the working directory; the prompt from stdin with -", async () => {
    hub.routes["POST /api/agent/launches"] = () => Response.json({ launch: launch() }, { status: 201 })
    const r = await cli(["launch", "--branch", "feat/x", "--prompt", "-"], { stdin: "a long\nprompt\n" })
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.body).toEqual({ workspace: { repo: CWD, branch: "feat/x" }, prompt: "a long\nprompt\n" })
  })

  test("the same key again: the existing launch (200), said so", async () => {
    hub.routes["POST /api/agent/launches"] = () => Response.json({ launch: launch({ state: "running", reason: "session started", sessionID: "ses_1", name: "api" }) })
    const r = await cli(["launch", "--key", "k1", "--branch", "feat/x"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("lch_1 was already launched with key k1: running (session started), @api ses_1\n")
  })

  test("--json prints the hub's answer", async () => {
    hub.routes["POST /api/agent/launches"] = () => Response.json({ launch: launch() }, { status: 201 })
    const r = await cli(["launch", "--branch", "feat/x", "--json"])
    expect(JSON.parse(r.stdout)).toEqual({ launch: launch() })
  })

  test("usage errors before asking the hub (exit 2)", async () => {
    for (const [argv, message] of [
      [["launch", "--mode", "fork"], "--mode is worktree, checkout or clone"],
      [["launch", "--runtime", "vm"], "--runtime is host or openshell"],
      [["launch", "--end", "done"], "--end is idle, asked or never"],
      [["launch", "--cleanup", "all"], "--cleanup is keep or remove"],
      [["launch", "--label", "novalue"], "--label takes key=value"],
      [["launch", "--node-label", "=x"], "--node-label takes key=value"],
      [["launch", "--profile", "p"], "--profile needs --runtime"],
      [["launch", "--prefer"], "--prefer needs --machine or --node-label"],
      [["launch", "--prompt", ""], "--prompt is empty"],
    ] as const) {
      const r = await cli([...argv])
      expect({ argv, code: r.code }).toEqual({ argv, code: EXIT.usage })
      expect(r.stderr).toContain(message)
    }
    expect(hub.seen).toEqual([])
  })

  test("the hub's errors keep their exit codes: forbidden 5, rate_limited 6, invalid 2", async () => {
    let answer: { status: number; body: unknown } = { status: 403, body: { error: { code: "forbidden", message: "No grant lets this session launch in /x" } } }
    hub.routes["POST /api/agent/launches"] = () => Response.json(answer.body, { status: answer.status })
    expect((await cli(["launch", "--branch", "b"])).code).toBe(EXIT.forbidden)
    answer = { status: 429, body: { error: { code: "rate_limited", message: "Too many launches", retryAfter: 30 } } }
    const limited = await cli(["launch", "--branch", "b"])
    expect(limited.code).toBe(EXIT.rateLimited)
    expect(limited.stderr).toContain("retry after 30 s")
    answer = { status: 400, body: { error: { code: "invalid", message: "A worktree workspace needs workspace.branch" } } }
    expect((await cli(["launch"])).code).toBe(EXIT.usage)
  })
})

describe("hub launches list | show | stop", () => {
  test("list: one line per launch, filters as query", async () => {
    hub.routes["GET /api/agent/launches"] = () =>
      Response.json({
        launches: [
          launch(),
          launch({ id: "lch_2", state: "ended", reason: "idle", outcome: "idle", sessionID: "ses_2", name: "api", machineID: "m1", directory: `${CWD}/.worktrees/feat/y` }),
        ],
      })
    const r = await cli(["launches", "list", "--state", "queued,ended", "--label", "app=brain"])
    expect(r.code).toBe(0)
    expect(hub.seen[0]!.path).toBe("/api/agent/launches?state=queued%2Cended&label=app%3Dbrain")
    expect(r.stdout).toBe(
      [
        `lch_1  queued  ${CWD} (feat/x)  app=brain`,
        `lch_2  ended idle  @api ses_2  ${CWD}/.worktrees/feat/y  app=brain`,
        "",
      ].join("\n"),
    )
    hub.routes["GET /api/agent/launches"] = () => Response.json({ launches: [] })
    expect((await cli(["launches", "list"])).stdout).toBe("no launches\n")
  })

  test("show: the launch, its steps and artifacts", async () => {
    hub.routes["GET /api/agent/launches/lch_2"] = () =>
      Response.json({
        launch: launch({
          id: "lch_2",
          state: "ended",
          reason: "idle for 30 s",
          outcome: "idle",
          sessionID: "ses_2",
          name: "api",
          machineID: "m1",
          directory: "/w",
          artifacts: { branch: "feat/x", base: "main", head: "abc1234", commits: 2, dirty: false },
          history: [
            { state: "queued", reason: "accepted", at: Date.UTC(2026, 9, 25, 8, 0, 0) },
            { state: "ended", reason: "idle for 30 s", at: Date.UTC(2026, 9, 25, 8, 5, 0), outcome: "idle" },
          ],
        }),
      })
    const r = await cli(["launches", "show", "lch_2"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("lch_2  ended idle (idle for 30 s)")
    expect(r.stdout).toContain("session: @api ses_2 on m1")
    expect(r.stdout).toContain("workspace: /Users/huy/projects/hub worktree feat/x → /w")
    expect(r.stdout).toContain("by: user")
    expect(r.stdout).toContain("labels: app=brain")
    expect(r.stdout).toContain("artifacts: branch feat/x from main, head abc1234, 2 commits, clean")
    expect(r.stdout).toContain("2026-10-25T08:05:00.000Z  ended idle: idle for 30 s")
  })

  test("stop: DELETE; one already ended is gone (exit 8); unknown is not found (exit 3)", async () => {
    hub.routes["DELETE /api/agent/launches/lch_1"] = () => Response.json({ launch: launch({ state: "ended", reason: "stopped by user", outcome: "stopped" }) })
    hub.routes["DELETE /api/agent/launches/lch_2"] = () => Response.json({ error: { code: "gone", message: "Launch lch_2 already ended" } }, { status: 410 })
    const r = await cli(["launches", "stop", "lch_1"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("stopped lch_1: ended stopped (stopped by user)\n")
    expect((await cli(["launches", "stop", "lch_2"])).code).toBe(EXIT.gone)
    expect((await cli(["launches", "show", "lch_9"])).code).toBe(EXIT.notFound)
    expect((await cli(["launches", "stop"])).code).toBe(EXIT.usage)
  })

  test("the usage lists the launch commands", async () => {
    const r = await cli(["help"])
    expect(r.stdout).toContain("hub launch ")
    expect(r.stdout).toContain("hub launches list")
  })
})
