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

describe("GET /api/agent/sessions", () => {
  const ids = async (query: string) => (await json(await h.api(`/api/agent/sessions${query}`))).sessions.map((s: any) => s.id)

  test("lists the user's sessions flat, with machine and project", async () => {
    const { machine } = await start()
    const { sessions } = await json(await h.api("/api/agent/sessions"))
    expect(sessions.map((s: any) => [s.id, s.machineID, s.project])).toEqual([
      ["ses_1", machine.id, "hub"],
      ["ses_3", machine.id, "hub"],
      ["ses_2", machine.id, "web"],
    ])
    expect(sessions[0]).toMatchObject({ name: "@api-refactor", state: "blocked", harness: "opencode", labels: {} })
  })

  test("filters by project, state, machine and label", async () => {
    const { machine } = await start()
    expect(await ids("?project=web")).toEqual(["ses_2"])
    expect(await ids("?project=/u/hub")).toEqual(["ses_1", "ses_3"])
    expect(await ids("?state=blocked")).toEqual(["ses_1"])
    expect(await ids("?state=working,blocked")).toEqual(["ses_1", "ses_2"])
    expect(await ids(`?machine=${machine.id}`)).toEqual(["ses_1", "ses_3", "ses_2"])
    expect(await ids("?machine=laptop")).toEqual(["ses_1", "ses_3", "ses_2"])
    expect(await ids("?machine=elsewhere")).toEqual([])
    expect(await ids("?label=team=api")).toEqual([])
    const bad = await h.api("/api/agent/sessions?label=nope")
    expect(bad.status).toBe(400)
    expect((await json(bad)).error.code).toBe("invalid")
    expect((await h.api("/api/agent/sessions?state=sleeping")).status).toBe(400)
  })
})

describe("GET /api/agent/sessions/:addr (show)", () => {
  test("answers state, full blockers, now, name and roles, and the spoke's summary", async () => {
    const { client } = await start()
    const seen = answer(client, (req) => (req.op === "summary" ? { context: { used: 10 }, branch: "main" } : undefined))
    client.send(event("form.created", { form: { id: "frm_1", sessionID: "ses_1", title: "Pick one", fields: [{ key: "choice", type: "string", title: "Choice" }] } }))
    await waitFor(() => (h.registry.session("ses_1")?.blockers.length ?? 0) === 2)
    const res = await h.api("/api/agent/sessions/@api-refactor")
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toMatchObject({ id: "ses_1", name: "@api-refactor", roles: [], title: "API refactor", state: "blocked", harness: "opencode", online: true, project: "hub" })
    expect(body.blockers[0]).toEqual({ kind: "permission", id: "per_1", summary: "bash: git push origin main", sessionID: "ses_1" })
    expect(body.blockers[1]).toMatchObject({ kind: "form", id: "frm_1", fields: [{ key: "choice", type: "string" }] })
    expect(body.summary).toEqual({ context: { used: 10 }, branch: "main" })
    expect(body.unsupported).toBeUndefined()
    expect(seen).toEqual([{ op: "summary", sessionID: "ses_1" }])
  })

  test("a spoke without the summary feature: no summary, an unsupported note, no request", async () => {
    const { client } = await start({ hello: { harness: "claude-code", harnessVersion: "1.0", features: [] } })
    const seen = answer(client)
    const body = await json(await h.api("/api/agent/sessions/ses_2"))
    expect(body).toMatchObject({ id: "ses_2", harness: "claude-code", state: "working" })
    expect(body.summary).toBeUndefined()
    expect(body.unsupported).toEqual([{ feature: "summary", harness: "claude-code" }])
    expect(seen).toEqual([])
  })

  test("unknown and ambiguous addresses use the agent envelope", async () => {
    await start()
    const missing = await h.api("/api/agent/sessions/@nobody")
    expect(missing.status).toBe(404)
    expect((await json(missing)).error.code).toBe("not_found")
    for (const session of ["ses_1", "ses_2"]) await h.api("/api/agent/roles/claim", { method: "POST", json: { role: "worker", session } })
    const ambiguous = await h.api("/api/agent/sessions/@@worker")
    expect(ambiguous.status).toBe(409)
    expect((await json(ambiguous)).error.candidates.map((c: any) => c.sessionID).sort()).toEqual(["ses_1", "ses_2"])
    expect((await h.api("/api/agent/sessions/bad addr")).status).toBe(400)
  })
})

describe("GET /api/agent/sessions/:addr/log", () => {
  test("asks the spoke for the newest timeline rows (n, default 20, at most 200)", async () => {
    const { client } = await start()
    const seen = answer(client, (req) => (req.op === "timeline" ? { items: [{ id: "r2" }, { id: "r1" }], older: "c1" } : undefined))
    const res = await bearer("/api/agent/sessions/@web-work/log?n=2", SES_1)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ sessionID: "ses_2", rows: [{ id: "r2" }, { id: "r1" }], older: "c1" })
    expect((await h.api("/api/agent/sessions/ses_2/log")).status).toBe(200)
    expect(seen).toEqual([
      { op: "timeline", sessionID: "ses_2", limit: 2, order: "desc" },
      { op: "timeline", sessionID: "ses_2", limit: 20, order: "desc" },
    ])
    for (const n of ["0", "201", "x"]) expect((await h.api(`/api/agent/sessions/ses_2/log?n=${n}`)).status).toBe(400)
  })

  test("unsupported {feature: timeline, harness} when the spoke lacks it", async () => {
    const { client } = await start({ hello: { harness: "claude-code", features: [] } })
    const seen = answer(client)
    const res = await h.api("/api/agent/sessions/ses_2/log")
    expect(res.status).toBe(422)
    expect((await json(res)).error).toMatchObject({ code: "unsupported", feature: "timeline", harness: "claude-code" })
    expect(seen).toEqual([])
  })
})
