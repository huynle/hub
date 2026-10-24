// /api/agent read routes over HTTP (design §4): status, sessions, show, log and watch.
// Sessions are reported by real spokes; session and app tokens come from fake verifiers.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

const SES_1 = "hst_fake_ses_1"
const APP = "hat_fake_app"
const APP_NONE = "hat_fake_none"

const verifiers: BearerVerifier[] = [
  { kind: "session", verify: (token) => (token === SES_1 ? { kind: "session", userID: "local", machineID: "mch_x", sessionID: "ses_1" } : undefined) },
  {
    kind: "app",
    verify: (token) =>
      token === APP
        ? { kind: "app", userID: "local", tokenID: "tok_1", scopes: ["sessions:read"] }
        : token === APP_NONE
          ? { kind: "app", userID: "local", tokenID: "tok_2", scopes: [] }
          : undefined,
  },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const bearer = (pathname: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token}` } })
const event = (type: string, data: Record<string, unknown>) => ({ t: "event" as const, event: { type, data } })

type Client = Awaited<ReturnType<typeof spoke>>

/** Server requests the spoke received (answered with `reply(req)` when it returns something). */
function answer(client: Client, reply: (req: any) => unknown = () => undefined) {
  const seen: any[] = []
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const result = reply(frame.req)
    if (result instanceof Error) client.send({ t: "res", id: frame.id, ok: false, error: result.message })
    else if (result !== undefined) client.send({ t: "res", id: frame.id, ok: true, result })
  })
  return seen
}

/**
 * A hub with one machine "laptop": ses_1 "API refactor" (project hub, blocked on a permission), its subagent ses_3,
 * and ses_2 "Web work" (project web, working).
 */
async function start(options: { hello?: Record<string, unknown> } = {}) {
  h = harness({ agent: { verifiers }, timing: { heartbeatMs: 40 } } as any)
  const sessions = [
    session("ses_1", { title: "API refactor", directory: "/u/hub", project: "/u/hub", projectName: "hub", updated: 10 }),
    session("ses_3", { title: "explore", parentID: "ses_1", directory: "/u/hub", project: "/u/hub", projectName: "hub", updated: 11 }),
    session("ses_2", { title: "Web work", directory: "/u/web", project: "/u/web", projectName: "web", updated: 12 }),
  ]
  const { machine, token } = h.store.addMachine("laptop")
  const client = await spoke(h, { machine: { token }, sessions, ...(options.hello ? { hello: options.hello as any } : {}) })
  client.send(event("permission.asked", { sessionID: "ses_1", id: "per_1", action: "bash", resources: ["git push origin main"] }))
  client.send(event("session.execution.started", { sessionID: "ses_2" }))
  await waitFor(() => h.registry.session("ses_1")?.state === "blocked" && h.registry.session("ses_2")?.state === "working")
  await waitFor(() => (h.store.agentData("local").names?.length ?? 0) === 2)
  return { client, machine }
}

describe("GET /api/agent/status", () => {
  test("answers the snapshot: machines → projects → sessions, with attention", async () => {
    const { machine } = await start()
    const res = await h.api("/api/agent/status")
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(typeof body.at).toBe("number")
    expect(body.you).toEqual({ kind: "user" })
    expect(body.machines.length).toBe(1)
    const [m] = body.machines
    expect(m).toMatchObject({ id: machine.id, name: "laptop", online: true, harnesses: ["opencode"] })
    expect(m.projects.map((p: any) => [p.root, p.name, p.sessions.map((s: any) => s.id)])).toEqual([
      ["/u/hub", "hub", ["ses_1", "ses_3"]],
      ["/u/web", "web", ["ses_2"]],
    ])
    const [ses1, ses3] = m.projects[0].sessions
    expect(ses1).toEqual({
      id: "ses_1",
      name: "@api-refactor",
      roles: [],
      title: "API refactor",
      state: "blocked",
      harness: "opencode",
      blockers: [{ kind: "permission", id: "per_1", summary: "bash: git push origin main" }],
      children: 1,
      labels: {},
    })
    expect(ses3).toMatchObject({ id: "ses_3", parentID: "ses_1", children: 0 })
    const ses2 = m.projects[1].sessions[0]
    expect(ses2).toMatchObject({ id: "ses_2", name: "@web-work", state: "working", blockers: [] })
    expect(typeof ses2.busySince).toBe("number")
    expect(body.attention).toEqual([{ kind: "permission", sessionID: "ses_1", name: "@api-refactor", id: "per_1", summary: "bash: git push origin main" }])
  })

  test("names the caller: a session token is its session, with its name and roles", async () => {
    await start()
    await bearer("/api/agent/roles/claim", SES_1, { method: "POST", json: { role: "reviewer.hub" } })
    const body = await json(await bearer("/api/agent/status", SES_1))
    expect(body.you).toEqual({ kind: "session", sessionID: "ses_1", name: "@api-refactor" })
    expect(body.machines[0].projects[0].sessions[0].roles).toEqual(["reviewer.hub"])
  })

  test("never sends a spoke request", async () => {
    const { client } = await start()
    const seen = answer(client)
    for (const pathname of ["/api/agent/status", "/api/agent/sessions", "/api/agent/sessions?state=blocked"]) expect((await h.api(pathname)).status).toBe(200)
    await Bun.sleep(30)
    expect(seen).toEqual([])
  })

  test("app tokens need sessions:read", async () => {
    await start()
    expect((await bearer("/api/agent/status", APP)).status).toBe(200)
    const denied = await bearer("/api/agent/status", APP_NONE)
    expect(denied.status).toBe(403)
    expect((await json(denied)).error.code).toBe("forbidden")
  })
})
