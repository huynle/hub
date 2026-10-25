// Escalations through the hub (P3-T8): an act verb outside the grant answers 403 needs_user with the Decision it
// opened; the Decision is listed on /api/decisions (tap tier from the hub), pushed as kind "decision", and its
// recommendation shows on the request's blocker. The user's answer replies to the permission as the user, even
// while agent actions are paused; the request answered elsewhere closes the Decision.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

const USER = "local"
const ACT = "hst_fake_act_orch"
const verifiers: BearerVerifier[] = [
  { kind: "session", verify: (token) => (token === ACT ? { kind: "session", userID: USER, machineID: "mch_x", sessionID: "ses_orch", via: "act" } : undefined) },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const bearer = (pathname: string, body: unknown) =>
  h.api(pathname, { method: "POST", cookie: null, origin: null, headers: { authorization: `Bearer ${ACT}` }, json: body })
const event = (type: string, data: Record<string, unknown>) => ({ t: "event" as const, event: { type, data } })

async function start() {
  h = await harness({ agent: { verifiers } } as any)
  const requests: any[] = []
  const client = await spoke(h, {
    hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver", "hubPrompt", "permissionMessage"] } as any,
    sessions: [session("ses_1", { title: "Worker", owned: true, directory: "/work/hub" }), session("ses_orch", { title: "Orchestrator", owned: true, directory: "/work/hub" })],
  })
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    requests.push(frame.req)
    client.send({ t: "res", id: frame.id, ok: true, result: frame.req.op === "deliver" ? { delivered: "queued" } : {} })
  })
  client.send(event("permission.asked", { sessionID: "ses_1", id: "per_2", action: "shell", resources: ["rm -rf dist"] }))
  await waitFor(() => h.registry.permissionTargets("ses_1", "per_2").length === 1)
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === 2)
  const grant = await h.api("/api/agent/grants", {
    method: "POST",
    json: { holder: "ses_orch", scope: { projects: ["/work/hub"] }, allow: ["approve", "deny"], permissions: { allow: ["shell:bun test*"] } },
  })
  expect(grant.status).toBe(201)
  return { client, requests }
}

async function escalate() {
  const res = await bearer("/api/agent/sessions/ses_1/approve", { requestID: "per_2", why: "cleans the build output only" })
  expect(res.status).toBe(403)
  const body = await json(res)
  expect(body.error).toMatchObject({ code: "needs_user", evaluation: { tier: "tap" } })
  expect(body.error.decisionID).toMatch(/^dec_/)
  return body.error.decisionID as string
}

describe("needs_user opens a Decision", () => {
  test("listed for the user (hub tier tap), pushed as a decision, recommended on the blocker, audited escalated", async () => {
    await start()
    const id = await escalate()
    const { decision } = await json(await h.api(`/api/decisions/${id}`))
    expect(decision).toMatchObject({ state: "open", tier: "tap", from: { kind: "session", sessionID: "ses_orch" }, recommendation: { option: "approve", why: "cleans the build output only" } })
    expect(decision.options.map((o: any) => o.id)).toEqual(["approve", "deny"])
    await waitFor(() => h.notified.some((n) => n.kind === "decision"))
    const view = await json(await h.api("/api/sessions/ses_1"))
    const blocker = view.blockers.find((b: any) => b.id === "per_2")
    expect(blocker.recommendation).toMatchObject({ recommends: "approve", why: "cleans the build output only", decisionID: id })
    expect(blocker.recommendation.by).toContain("orchestrator")
    const audit = await json(await h.api("/api/agent/audit"))
    expect(audit.entries[0]).toMatchObject({ verb: "approve", decision: "needs_user", outcome: "escalated" })
  })

  test("escalating again keeps one Decision", async () => {
    await start()
    const first = await escalate()
    const again = await escalate()
    expect(again).toBe(first)
    expect((await json(await h.api("/api/decisions?state=open"))).decisions).toHaveLength(1)
  })
})

describe("the user's answer", () => {
  test("approve replies to the permission once as the user, even with agent actions paused", async () => {
    const { requests } = await start()
    const id = await escalate()
    expect((await h.api("/api/agent/acting", { method: "PUT", json: { enabled: false } })).status).toBe(200)
    const res = await h.api(`/api/decisions/${id}/answer`, { method: "POST", json: { option: "approve" } })
    expect(res.status).toBe(200)
    expect((await json(res)).decision.state).toBe("answered")
    expect(requests.filter((r) => r.op === "permission")).toEqual([{ op: "permission", sessionID: "ses_1", requestID: "per_2", decision: "once" }])
    const audit = await json(await h.api("/api/agent/audit"))
    expect(audit.entries[0]).toMatchObject({ verb: "approve", actor: { kind: "user" }, decision: "allow", outcome: "ok" })
  })

  test("the request answered elsewhere closes the Decision; answering it then is gone (409)", async () => {
    const { client } = await start()
    const id = await escalate()
    client.send(event("permission.replied", { sessionID: "ses_1", requestID: "per_2" }))
    let state = "open"
    for (let i = 0; i < 100 && state !== "closed"; i++) {
      await Bun.sleep(10)
      state = (await json(await h.api(`/api/decisions/${id}`))).decision.state
    }
    expect(state).toBe("closed")
    expect((await h.api(`/api/decisions/${id}/answer`, { method: "POST", json: { option: "approve" } })).status).toBe(409)
  })
})
