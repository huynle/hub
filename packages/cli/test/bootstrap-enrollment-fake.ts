// A local fake hub for the machine enrollment tests: the device-code endpoints (POST /spoke/enroll and
// /spoke/enroll/poll) and the credential check (GET /spoke/ws without an upgrade: 426 when the machine token is
// accepted, 401 when it is not), on 127.0.0.1 only. Tokens are built at run time; none is committed.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export const testToken = (tag: string) => ["mt", "test", tag, "only"].join("_")
export const DEVICE_CODE = ["dc", "test", "only"].join("_")

export interface FakeHubOptions {
  /** The poll replies in order; the last one repeats. Default: approved with `token`. */
  polls?: unknown[]
  /** The token GET /spoke/ws accepts (default: the approved one). Undefined after revoke(). */
  accepted?: string
  start?: Record<string, unknown>
  /** Replaces the default handler for a path. */
  routes?: Record<string, (req: Request) => Response | Promise<Response>>
  pollDelayMs?: number
}

export interface FakeHub {
  readonly url: string
  readonly token: string
  readonly requests: Array<{ method: string; path: string; authorized: boolean }>
  polls: number
  revoke(): void
  stop(): void
}

export function fakeHub(options: FakeHubOptions = {}): FakeHub {
  const token = testToken("approved")
  let accepted: string | undefined = options.accepted ?? token
  const polls = [...(options.polls ?? [{ status: "approved", machineID: "mach_01", machineToken: token }])]
  const state = { polls: 0 }
  const requests: FakeHub["requests"] = []
  let port = 0
  const server: { port?: number; stop(force?: boolean): unknown } = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const auth = req.headers.get("authorization") ?? ""
      requests.push({ method: req.method, path: url.pathname, authorized: auth.length > 0 })
      const custom = options.routes?.[url.pathname]
      if (custom) return custom(req)
      if (req.method === "POST" && url.pathname === "/spoke/enroll") {
        const body = (await req.json().catch(() => ({}))) as { machineName?: string }
        if (typeof body.machineName !== "string") return new Response("bad", { status: 400 })
        return Response.json({
          userCode: "ABCD-EFGH",
          deviceCode: DEVICE_CODE,
          approveURL: `http://127.0.0.1:${port}/approve?code=ABCD-EFGH`,
          intervalMs: 1,
          expiresAt: Date.now() + 60_000,
          ...options.start,
        })
      }
      if (req.method === "POST" && url.pathname === "/spoke/enroll/poll") {
        state.polls++
        if (options.pollDelayMs) await Bun.sleep(options.pollDelayMs)
        const reply = polls.length > 1 ? polls.shift() : polls[0]
        return Response.json(reply)
      }
      if (req.method === "GET" && url.pathname === "/spoke/ws") {
        if (accepted && auth === `Bearer ${accepted}`) return Response.json({ error: "Expected a WebSocket upgrade" }, { status: 426 })
        return Response.json({ error: "Invalid or revoked machine token" }, { status: 401 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  port = server.port ?? 0
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    get polls() {
      return state.polls
    },
    set polls(n: number) {
      state.polls = n
    },
    revoke() {
      accepted = undefined
    },
    stop() {
      server.stop(true)
    },
  }
}

export const tempConfig = () => path.join(mkdtempSync(path.join(tmpdir(), "hbs04-")), "hub", "config.json")
