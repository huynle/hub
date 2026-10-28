// /api/agent directory routes over HTTP (design §2.2): GET who, POST name, POST roles/claim and roles/release.
// Session tokens come from a fake verifier (the real one is P1-T5); sessions are reported by real spokes.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

/** Session token of ses_1 (a root session of the local user). */
const SES_1 = "hst_fake_ses_1"
const APP = "hat_fake_app"
const MANAGE = "hat_fake_manage"

const verifiers: BearerVerifier[] = [
  { kind: "session", verify: (token) => (token === SES_1 ? { kind: "session", userID: "local", machineID: "mch_x", sessionID: "ses_1" } : undefined) },
  { kind: "app", verify: (token) => (token === APP ? { kind: "app", userID: "local", tokenID: "tok_1", scopes: ["sessions:read"] } : token === MANAGE ? { kind: "app", userID: "local", tokenID: "tok_manage", scopes: ["sessions:manage"] } : undefined) },
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

describe("PUT /api/agent/sessions/:addr/archive", () => {
  const mine = (path: string, body: unknown, token?: string) => token ? bearer(path, token, { method: "PUT", json: body }) : h.api(path, { method: "PUT", json: body })

  test("a managed app archives and unarchives idempotently, preserving unrelated preferences", async () => {
    await start()
    await h.store.setViewPrefs("local", { pinnedSessions: ["ses_2"], hiddenWorkspaces: ["/private"] })
    for (let i = 0; i < 2; i++) {
      const res = await mine("/api/agent/sessions/ses_1/archive", { archived: true }, MANAGE)
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ sessionID: "ses_1", archived: true, changed: i === 0 })
    }
    expect(h.store.viewPrefs("local").hiddenSessions).toEqual(["ses_1"])
    expect(h.store.viewPrefs("local").pinnedSessions).toEqual(["ses_2"])
    expect(h.store.viewPrefs("local").hiddenWorkspaces).toEqual(["/private"])
    expect(h.store.agentData("local").sessions?.find((s) => s.sessionID === "ses_1")?.archivedAt).toEqual(expect.any(Number))
    expect(h.store.auditLog().filter((e) => e.action === "session.archive")).toHaveLength(1)
    const remove = await mine("/api/agent/sessions/@api-refactor/archive", { archived: false }, MANAGE)
    expect(await json(remove)).toEqual({ sessionID: "ses_1", archived: false, changed: true })
    expect(await json(await mine("/api/agent/sessions/ses_1/archive", { archived: false }, MANAGE))).toMatchObject({ changed: false })
    expect(h.store.agentData("local").sessions?.find((s) => s.sessionID === "ses_1")?.archivedAt).toBeUndefined()
    expect(h.store.auditLog().filter((e) => e.action === "session.unarchive")).toHaveLength(1)
  })

  test("a read-scoped app cannot archive; users can", async () => {
    await start()
    expect((await mine("/api/agent/sessions/ses_1/archive", { archived: true }, APP)).status).toBe(403)
    expect((await mine("/api/agent/sessions/ses_1/archive", { archived: true })).status).toBe(200)
  })

  test("archive writes stay bounded and session tokens cannot manage organization", async () => {
    await start()
    expect((await mine("/api/agent/sessions/ses_1/archive", { archived: true }, SES_1)).status).toBe(403)
    const archived = Array.from({ length: 5000 }, (_, i) => `ses_old_${i}`)
    await h.store.setViewPrefs("local", { hiddenSessions: archived })
    const res = await mine("/api/agent/sessions/ses_1/archive", { archived: true }, MANAGE)
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe("invalid")
    expect(h.store.viewPrefs("local").hiddenSessions).toEqual(archived)
  })

  test("foreign and unknown sessions are both not_found; invalid input is 400", async () => {
    await start()
    const bob = await h.store.upsertUser({ email: "bob@example.test", role: "user" })
    const machine = await h.store.addMachine("bob box", bob.id)
    await spoke(h, { machine, processID: "p2", sessions: [session("ses_bob")] })
    for (const target of ["ses_bob", "ses_unknown"]) {
      const res = await mine(`/api/agent/sessions/${target}/archive`, { archived: true }, MANAGE)
      expect(res.status).toBe(404)
      expect((await json(res)).error.code).toBe("not_found")
    }
    expect((await mine("/api/agent/sessions/ses_1/archive", { archived: "yes" }, MANAGE)).status).toBe(400)
  })
})

describe("PUT /api/agent/sessions/:addr/pin", () => {
  const mine = (path: string, body: unknown, token?: string) => token ? bearer(path, token, { method: "PUT", json: body }) : h.api(path, { method: "PUT", json: body })

  test("a managed app pins and unpins idempotently while preserving unrelated preferences", async () => {
    await start()
    await h.store.setViewPrefs("local", { hiddenSessions: ["ses_2"], hiddenWorkspaces: ["/private"] })
    expect(await json(await mine("/api/agent/sessions/ses_1/pin", { pinned: true }, MANAGE))).toEqual({ sessionID: "ses_1", pinned: true, changed: true })
    expect(await json(await mine("/api/agent/sessions/@api-refactor/pin", { pinned: true }, MANAGE))).toEqual({ sessionID: "ses_1", pinned: true, changed: false })
    expect(h.store.viewPrefs("local")).toMatchObject({ pinnedSessions: ["ses_1"], hiddenSessions: ["ses_2"], hiddenWorkspaces: ["/private"] })
    expect(await json(await mine("/api/agent/sessions/ses_1/pin", { pinned: false }, MANAGE))).toEqual({ sessionID: "ses_1", pinned: false, changed: true })
    expect(h.store.auditLog().filter((e) => e.action.startsWith("session.") && e.action.includes("pin"))).toHaveLength(2)
  })

  test("pin needs sessions:manage and foreign IDs look unknown", async () => {
    await start()
    expect((await mine("/api/agent/sessions/ses_1/pin", { pinned: true }, APP)).status).toBe(403)
    expect((await mine("/api/agent/sessions/ses_1/pin", { pinned: "yes" }, MANAGE)).status).toBe(400)
    for (const id of ["ses_unknown", "ses_bob"]) expect((await mine(`/api/agent/sessions/${id}/pin`, { pinned: true }, MANAGE)).status).toBe(404)
  })
})

describe("POST /api/agent/sessions/archive-inactive", () => {
  const call = (body: unknown, token = MANAGE) => bearer("/api/agent/sessions/archive-inactive", token, { method: "POST", json: body })

  test("preview writes nothing; confirm archives only the exact revalidated candidates", async () => {
    await start()
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000
    await h.store.updateAgentData("local", (data) => {
      ;(data.sessions ??= []).push({ sessionID: "ses_old", title: "Old offline", firstSeen: old, lastSeen: old })
    })
    await h.store.setViewPrefs("local", { pinnedSessions: ["ses_2"], hiddenWorkspaces: ["/keep"] })
    const preview = await json(await call({ preview: true, inactiveFor: "7d", limit: 10 }))
    expect(preview.candidates).toEqual(["ses_old"])
    expect(preview.previewToken).toMatch(/^hai1_/)
    expect(h.store.viewPrefs("local").hiddenSessions).toEqual([])
    await h.store.setViewPrefs("local", { pinnedSessions: ["ses_old"] })
    const applied = await json(await call({ previewToken: preview.previewToken, confirm: true }))
    expect(applied).toEqual({ changed: [], skipped: [{ sessionID: "ses_old", reason: "pinned" }] })
    expect(h.store.viewPrefs("local")).toMatchObject({ hiddenSessions: [], hiddenWorkspaces: ["/keep"], pinnedSessions: ["ses_old"] })
  })

  test("bounds, scope and malformed or cross-user preview tokens are rejected", async () => {
    await start()
    expect((await call({ preview: true, inactiveFor: "7d", limit: 10 }, APP)).status).toBe(403)
    for (const body of [{ preview: true, inactiveFor: "nope", limit: 10 }, { preview: true, inactiveFor: "7d", limit: 0 }, { previewToken: "hai1_bad", confirm: true }]) {
      expect((await call(body)).status).toBe(400)
    }
  })
})

describe("managed apps: names and roles (sessions:manage; role writes also need a roles grant)", () => {
  /** The journal's organization (manage) events for the local user after `position`, as [type, sessionID, data]. */
  const journal = async (position: string) => {
    const result = await h.agentEvents.since("local", position)
    if ("reset" in result && result.reset) throw new Error("journal reset")
    return (result as any).records
      .filter((r: any) => r.family === "manage")
      .map((r: any) => [r.event.type, r.event.subject.sessionID, r.event.data])
  }
  /** A real app token with these scopes, and a fetch as it. */
  const appToken = async (scopes: string[]) => {
    const token = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes } }))
    return { id: token.id as string, post: (pathname: string, body: unknown) => bearer(pathname, token.token, { method: "POST", json: body }) }
  }
  const grant = (id: string, projects: string[], allow: string[] = ["roles"]) => h.api("/api/agent/grants", { method: "POST", json: { holder: `app:${id}`, scope: { projects }, allow } })

  test("a managed app names any session by address; audited and one session.named event per change", async () => {
    await start()
    const position = await h.agentEvents.latest("local")
    const res = await post("/api/agent/name", { name: "@lead", session: "@web-work" }, MANAGE)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ sessionID: "ses_2", name: "lead", alias: "web-work" })
    expect((await post("/api/agent/name", { name: "lead", session: "ses_2" }, MANAGE)).status).toBe(200)
    const missing = await post("/api/agent/name", { name: "other" }, MANAGE)
    expect(missing.status).toBe(400)
    expect((await json(missing)).error.code).toBe("invalid")
    expect(await journal(position)).toEqual([["session.named", "ses_2", { name: "lead" }]])
    expect(h.store.auditLog().filter((e) => e.action === "session.name").map((e) => [e.target, e.detail])).toEqual([["ses_2", "app"]])
  })

  test("names stay tenant-bound: foreign and unknown sessions are both not_found", async () => {
    await start()
    const bob = await h.store.upsertUser({ email: "bob@example.test", role: "user" })
    const machine = await h.store.addMachine("bob box", bob.id)
    await spoke(h, { machine, processID: "p2", sessions: [session("ses_bob")] })
    for (const target of ["ses_bob", "ses_unknown"]) {
      const res = await post("/api/agent/name", { name: "mine", session: target }, MANAGE)
      expect(res.status).toBe(404)
      expect((await json(res)).error.code).toBe("not_found")
    }
  })

  test("an app's role claim and release need sessions:manage and a roles grant covering the session's project", async () => {
    await start()
    const reader = await appToken(["sessions:read"])
    expect((await reader.post("/api/agent/roles/claim", { role: "reviewer", session: "ses_2" })).status).toBe(403)
    const app = await appToken(["sessions:manage"])
    const ungranted = await app.post("/api/agent/roles/claim", { role: "reviewer", session: "ses_2" })
    expect(ungranted.status).toBe(403)
    expect((await json(ungranted)).error.code).toBe("forbidden")
    expect((await grant(app.id, ["/elsewhere"])).status).toBe(201)
    expect((await grant(app.id, ["/work"], ["prompt"])).status).toBe(201)
    expect((await app.post("/api/agent/roles/claim", { role: "reviewer", session: "ses_2" })).status).toBe(403)
    expect((await grant(app.id, ["/work"])).status).toBe(201)
    const position = await h.agentEvents.latest("local")
    const claimed = await app.post("/api/agent/roles/claim", { role: "reviewer", session: "@web-work", exclusive: true })
    expect(claimed.status).toBe(200)
    expect(await json(claimed)).toEqual({ sessionID: "ses_2", role: "reviewer", generation: 1, exclusive: true })
    expect(await json(await app.post("/api/agent/roles/claim", { role: "reviewer", session: "ses_2" }))).toMatchObject({ generation: 1 })
    const released = await app.post("/api/agent/roles/release", { role: "reviewer", session: "ses_2" })
    expect(await json(released)).toEqual({ sessionID: "ses_2", role: "reviewer", released: true })
    expect(await journal(position)).toEqual([
      ["role.claimed", "ses_2", { role: "reviewer", generation: 1, exclusive: true }],
      ["role.released", "ses_2", { role: "reviewer" }],
    ])
    const audit = (await json(await h.api("/api/agent/audit"))).entries.map((e: any) => [e.verb, e.target.sessionID, e.decision, e.outcome, e.actor.kind])
    expect(audit.slice(0, 3)).toEqual([
      ["roles.release", "ses_2", "allow", "ok", "app"],
      ["roles", "ses_2", "allow", "ok", "app"],
      ["roles", "ses_2", "allow", "ok", "app"],
    ])
    expect(h.store.auditLog().filter((e) => e.action === "role.claim" || e.action === "role.release").map((e) => e.action)).toEqual(["role.release", "role.claim"])
  })

  test("an app never claims a reserved role, even under a roles grant; the kill switch pauses role writes", async () => {
    await start()
    const app = await appToken(["sessions:manage"])
    await grant(app.id, ["/work"])
    const reserved = await app.post("/api/agent/roles/claim", { role: "orchestrator", session: "ses_2" })
    expect(reserved.status).toBe(403)
    expect((await json(reserved)).error.code).toBe("forbidden")
    await h.api("/api/agent/acting", { method: "PUT", json: { enabled: false } })
    expect((await app.post("/api/agent/roles/claim", { role: "reviewer", session: "ses_2" })).status).toBe(423)
  })

  test("an app's role write on a foreign or unknown session is not_found, before any grant check", async () => {
    await start()
    const bob = await h.store.upsertUser({ email: "bob@example.test", role: "user" })
    const machine = await h.store.addMachine("bob box", bob.id)
    await spoke(h, { machine, processID: "p2", sessions: [session("ses_bob")] })
    const app = await appToken(["sessions:manage"])
    for (const target of ["ses_bob", "ses_unknown"]) {
      const res = await app.post("/api/agent/roles/claim", { role: "reviewer", session: target })
      expect(res.status).toBe(404)
      expect((await json(res)).error.code).toBe("not_found")
    }
  })

  test("users and sessions keep their rules, now also with role events", async () => {
    await start()
    const position = await h.agentEvents.latest("local")
    expect((await post("/api/agent/roles/claim", { role: "builder.hub" }, SES_1)).status).toBe(200)
    expect((await post("/api/agent/roles/claim", { role: "orchestrator", session: "ses_2" })).status).toBe(200)
    expect(await journal(position)).toEqual([
      ["role.claimed", "ses_1", { role: "builder", project: "hub", generation: 1 }],
      ["role.claimed", "ses_2", { role: "orchestrator", generation: 1 }],
    ])
  })
})
