// /api/agent directory routes over HTTP (design §2.2): GET who, POST name, POST roles/claim and roles/release.
// Session tokens come from a fake verifier (the real one is P1-T5); sessions are reported by real spokes.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

/** Session token of ses_1 (a root session of the local user). */
const SES_1 = "hst_fake_ses_1"
const APP = "hat_fake_app"

const verifiers: BearerVerifier[] = [
  { kind: "session", verify: (token) => (token === SES_1 ? { kind: "session", userID: "local", machineID: "mch_x", sessionID: "ses_1" } : undefined) },
  { kind: "app", verify: (token) => (token === APP ? { kind: "app", userID: "local", tokenID: "tok_1", scopes: ["sessions:read"] } : undefined) },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const bearer = (pathname: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token}` } })
const post = (pathname: string, body: unknown, token?: string) => (token ? bearer(pathname, token, { method: "POST", json: body }) : h.api(pathname, { method: "POST", json: body }))

/** A hub with ses_1 "API refactor", ses_2 "Web work" (roots, project hub) and ses_3 (a subagent of ses_1). */
async function start() {
  h = await harness({ agent: { verifiers } } as any)
  const sessions = [
    session("ses_1", { title: "API refactor", projectName: "hub" }),
    session("ses_2", { title: "Web work", projectName: "hub" }),
    session("ses_3", { title: "explore", parentID: "ses_1", projectName: "hub" }),
  ]
  await spoke(h, { sessions })
  await waitFor(() => (h.store.agentData("local").names?.length ?? 0) === 2)
}

describe("GET /api/agent/who", () => {
  test("lists the user's sessions in tree order with derived names (roots only), for cookies and session tokens", async () => {
    await start()
    const res = await h.api("/api/agent/who")
    expect(res.status).toBe(200)
    const { sessions } = await json(res)
    expect(sessions.map((s: any) => [s.sessionID, s.name, s.online, s.project])).toEqual([
      ["ses_1", "api-refactor", true, "hub"],
      ["ses_3", undefined, true, "hub"],
      ["ses_2", "web-work", true, "hub"],
    ])
    expect(sessions[1].parentID).toBe("ses_1")
    const viaSession = await json(await bearer("/api/agent/who", SES_1))
    expect(viaSession.sessions.length).toBe(3)
  })

  test("filters by role and project", async () => {
    await start()
    await post("/api/agent/roles/claim", { role: "reviewer" }, SES_1)
    expect((await json(await h.api("/api/agent/who?role=reviewer"))).sessions.map((s: any) => s.sessionID)).toEqual(["ses_1"])
    expect((await json(await h.api("/api/agent/who?project=elsewhere"))).sessions).toEqual([])
  })

  test("app tokens with sessions:read may read who, but never name or claim", async () => {
    await start()
    const res = await bearer("/api/agent/who", APP)
    expect(res.status).toBe(200)
    expect((await json(res)).sessions.map((s: any) => s.sessionID)).toContain("ses_1")
    const write = await post("/api/agent/name", { name: "@x", session: "ses_1" }, APP)
    expect(write.status).toBe(403)
    expect((await json(write)).error.code).toBe("forbidden")
  })
})

describe("POST /api/agent/name", () => {
  test("a session names itself; its old name stays an alias", async () => {
    await start()
    const res = await post("/api/agent/name", { name: "@lead" }, SES_1)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ sessionID: "ses_1", name: "lead", alias: "api-refactor" })
    // Addressing itself by name is its own session too.
    expect((await post("/api/agent/name", { name: "lead", session: "@api-refactor" }, SES_1)).status).toBe(200)
  })

  test("a session cannot name another session (forbidden)", async () => {
    await start()
    const res = await post("/api/agent/name", { name: "x-y", session: "ses_2" }, SES_1)
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe("forbidden")
  })

  test("the user names any of their sessions by address; the session is required", async () => {
    await start()
    expect(await json(await post("/api/agent/name", { name: "frontend", session: "@web-work" }))).toEqual({ sessionID: "ses_2", name: "frontend", alias: "web-work" })
    const missing = await post("/api/agent/name", { name: "frontend" })
    expect(missing.status).toBe(400)
    expect((await json(missing)).error.code).toBe("invalid")
  })

  test("a taken name answers 409 name_taken; a bad one 400 invalid", async () => {
    await start()
    const taken = await post("/api/agent/name", { name: "web-work" }, SES_1)
    expect(taken.status).toBe(409)
    expect((await json(taken)).error.code).toBe("name_taken")
    expect((await post("/api/agent/name", { name: "Nope!" }, SES_1)).status).toBe(400)
    expect((await post("/api/agent/name", { name: 5 }, SES_1)).status).toBe(400)
  })

  test("tenancy: another user's sessions and names are not_found", async () => {
    await start()
    const bob = await h.store.upsertUser({ email: "bob@example.test", role: "user" })
    const machine = await h.store.addMachine("bob box", bob.id)
    await spoke(h, { machine, processID: "p2", sessions: [session("ses_bob", { title: "Bob secret", projectName: "hub" })] })
    await waitFor(() => (h.store.agentData(bob.id).names?.length ?? 0) === 1)
    for (const target of ["ses_bob", "@bob-secret"]) {
      const res = await post("/api/agent/name", { name: "mine", session: target })
      expect(res.status).toBe(404)
      expect((await json(res)).error.code).toBe("not_found")
    }
    expect((await json(await h.api("/api/agent/who"))).sessions.map((s: any) => s.sessionID)).not.toContain("ses_bob")
  })
})

describe("POST /api/agent/roles/claim and /release", () => {
  test("a session claims and releases a role for itself; generations grow", async () => {
    await start()
    const claim = await post("/api/agent/roles/claim", { role: "reviewer.hub", exclusive: true }, SES_1)
    expect(claim.status).toBe(200)
    expect(await json(claim)).toEqual({ sessionID: "ses_1", role: "reviewer", project: "hub", generation: 1, exclusive: true })
    const other = await post("/api/agent/roles/claim", { role: "reviewer.hub", session: "ses_2" })
    expect(other.status).toBe(409)
    expect((await json(other)).error.code).toBe("name_taken")
    expect(await json(await post("/api/agent/roles/release", { role: "reviewer.hub" }, SES_1))).toEqual({ sessionID: "ses_1", role: "reviewer", project: "hub", released: true })
    expect((await post("/api/agent/roles/release", { role: "reviewer.hub" }, SES_1)).status).toBe(404)
    expect((await json(await post("/api/agent/roles/claim", { role: "reviewer.hub", session: "ses_2" }))).generation).toBe(2)
  })

  test("a session cannot claim for another session; reserved roles need the user", async () => {
    await start()
    expect((await post("/api/agent/roles/claim", { role: "reviewer", session: "ses_2" }, SES_1)).status).toBe(403)
    const reserved = await post("/api/agent/roles/claim", { role: "orchestrator" }, SES_1)
    expect(reserved.status).toBe(403)
    expect((await json(reserved)).error.code).toBe("forbidden")
    expect((await json(await post("/api/agent/roles/claim", { role: "orchestrator", session: "ses_1" }))).generation).toBe(1)
  })

  test("bad bodies are 400 invalid", async () => {
    await start()
    expect((await post("/api/agent/roles/claim", { role: "reviewer", exclusive: "yes" }, SES_1)).status).toBe(400)
    expect((await post("/api/agent/roles/claim", {}, SES_1)).status).toBe(400)
    expect((await post("/api/agent/roles/release", { role: 1 }, SES_1)).status).toBe(400)
  })
})
