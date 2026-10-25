// The act verbs over HTTP (design §5, §8; decision wvqeuis0): POST /api/agent/sessions/:addr/{approve,deny,answer,
// prompt,stop}. Users always; sessions only through their act token (never a shell token); app tokens with scope
// sessions:act. Agents act under a grant; needs_user is 403 with the evaluation; every outcome is audited.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { APP_SCOPES } from "../src/central/agent/app-tokens"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

const USER = "local"
const ACT = "hst_fake_act_orch"
const SHELL = "hst_fake_shell_orch"
const verifiers: BearerVerifier[] = [
  {
    kind: "session",
    verify: (token) =>
      token === ACT || token === SHELL
        ? { kind: "session", userID: USER, machineID: "mch_x", sessionID: "ses_orch", via: token === ACT ? "act" : "shell" }
        : undefined,
  },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const bearer = (token: string, pathname: string, body?: unknown) =>
  h.api(pathname, { method: "POST", cookie: null, origin: null, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { json: body }) })
const asUser = (pathname: string, body?: unknown) => h.api(pathname, { method: "POST", ...(body === undefined ? {} : { json: body }) })
const event = (type: string, data: Record<string, unknown>) => ({ t: "event" as const, event: { type, data } })

/** A machine with ses_1 (the worker, /work/hub) and ses_orch (the orchestrator, its own tree), one pending permission. */
async function start(options: { features?: string[]; gone?: boolean } = {}) {
  h = harness({ agent: { verifiers } } as any)
  const requests: any[] = []
  const client = await spoke(h, {
    hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: options.features ?? ["deliver", "hubPrompt", "permissionMessage"] } as any,
    sessions: [session("ses_1", { title: "Worker", owned: true, directory: "/work/hub" }), session("ses_orch", { title: "Orchestrator", owned: true, directory: "/work/hub" })],
  })
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    requests.push(frame.req)
    const op = frame.req.op
    const result =
      op === "deliver" ? { delivered: "turn", inboxID: "inb_1" } : op === "stop" ? { stopped: [frame.req.sessionID] } : op === "permission" && options.gone ? { gone: true } : op === "steer" ? { inboxID: "inb_2" } : {}
    client.send({ t: "res", id: frame.id, ok: true, result })
  })
  client.send(event("permission.asked", { sessionID: "ses_1", id: "per_1", action: "shell", resources: ["bun test"], save: ["bun test *"] }))
  client.send(event("permission.asked", { sessionID: "ses_1", id: "per_2", action: "shell", resources: ["rm -rf dist"] }))
  await waitFor(() => h.registry.permissionTargets("ses_1", "per_2").length === 1)
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === 2)
  return { client, requests }
}

async function grantFor(holder: string, extra: Record<string, unknown> = {}) {
  const res = await h.api("/api/agent/grants", {
    method: "POST",
    json: { holder, scope: { projects: ["/work/hub"] }, allow: ["approve", "deny", "answer", "prompt", "stop"], permissions: { allow: ["shell:bun test*"] }, ...extra },
  })
  expect(res.status).toBe(201)
  return (await json(res)).grant.id as string
}

const VERBS = ["approve", "deny", "answer", "prompt", "stop"] as const

describe("who may call the act verbs", () => {
  test("a shell session token never acts; an app token needs sessions:act (now a known scope)", async () => {
    const { requests } = await start()
    for (const verb of VERBS) {
      const res = await bearer(SHELL, `/api/agent/sessions/ses_1/${verb}`, { requestID: "per_1" })
      expect([verb, res.status, (await json(res)).error.code]).toEqual([verb, 403, "forbidden"])
    }
    expect(APP_SCOPES).toContain("sessions:act")
    const reader = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["sessions:read"] } }))
    expect((await bearer(reader.token, "/api/agent/sessions/ses_1/stop", {})).status).toBe(403)
    expect(requests.filter((r) => r.op === "permission" || r.op === "stop")).toEqual([])
  })
})

describe("approve", () => {
  test("an act token inside its grant approves; audited with the grant", async () => {
    const { requests } = await start()
    const grant = await grantFor("ses_orch")
    const res = await bearer(ACT, "/api/agent/sessions/ses_1/approve", { requestID: "per_1", why: "only tests" })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ sessionID: "ses_1", requestID: "per_1", decision: "once", grant })
    expect(requests.filter((r) => r.op === "permission")).toEqual([{ op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "once" }])
    const audit = await json(await h.api("/api/agent/audit"))
    expect(audit.entries[0]).toMatchObject({ verb: "approve", actor: { kind: "session", sessionID: "ses_orch" }, grant, decision: "allow", outcome: "ok", reason: "only tests" })
  })

  test("outside the grant: 403 needs_user with the evaluation; nothing reaches the spoke", async () => {
    const { requests } = await start()
    await grantFor("ses_orch")
    const res = await bearer(ACT, "/api/agent/sessions/ses_1/approve", { requestID: "per_2" })
    expect(res.status).toBe(403)
    const body = await json(res)
    expect(body.error).toMatchObject({ code: "needs_user", evaluation: { verdict: "outside", tier: "tap" } })
    expect(requests.filter((r) => r.op === "permission")).toEqual([])
  })

  test("no grant: forbidden; kill switch: paused (423)", async () => {
    await start()
    expect((await json(await bearer(ACT, "/api/agent/sessions/ses_1/approve", { requestID: "per_1" }))).error.code).toBe("forbidden")
    await grantFor("ses_orch")
    expect((await h.api("/api/agent/acting", { method: "PUT", json: { enabled: false } })).status).toBe(200)
    expect((await bearer(ACT, "/api/agent/sessions/ses_1/approve", { requestID: "per_1" })).status).toBe(423)
  })

  test("the user approves with the cookie, always included, without a grant", async () => {
    const { requests } = await start()
    const res = await asUser("/api/agent/sessions/ses_1/approve", { requestID: "per_2", always: true })
    expect(res.status).toBe(200)
    expect(requests.filter((r) => r.op === "permission")).toEqual([{ op: "permission", sessionID: "ses_1", requestID: "per_2", decision: "always" }])
  })

  test("an app token with sessions:act acts under its own grant", async () => {
    const { requests } = await start()
    const token = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["sessions:act"] } }))
    await grantFor(`app:${token.id}`)
    expect((await bearer(token.token, "/api/agent/sessions/ses_1/approve", { requestID: "per_1" })).status).toBe(200)
    expect(requests.filter((r) => r.op === "permission")).toHaveLength(1)
  })

  test("a race (the spoke no longer holds it) is 410 gone; an unknown request is 404", async () => {
    await start({ gone: true })
    await grantFor("ses_orch")
    expect((await json(await bearer(ACT, "/api/agent/sessions/ses_1/approve", { requestID: "per_1" }))).error.code).toBe("gone")
    expect((await bearer(ACT, "/api/agent/sessions/ses_1/approve", { requestID: "per_9" })).status).toBe(404)
  })

  test("malformed bodies are 400 invalid", async () => {
    await start()
    for (const body of [{}, { requestID: 5 }, { requestID: "per_1", always: "yes" }, { requestID: "per_1", why: 3 }, { requestID: "x".repeat(301) }]) {
      expect((await asUser("/api/agent/sessions/ses_1/approve", body)).status).toBe(400)
    }
  })
})

describe("deny, answer, prompt, stop", () => {
  test("deny passes the reason with provenance", async () => {
    const { requests } = await start()
    const grant = await grantFor("ses_orch")
    const res = await bearer(ACT, "/api/agent/sessions/ses_1/deny", { requestID: "per_2", why: "destructive" })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ reasonSent: true })
    expect(requests.find((r) => r.op === "permission")).toEqual({
      op: "permission",
      sessionID: "ses_1",
      requestID: "per_2",
      decision: "reject",
      message: `Denied by @orchestrator (grant ${grant}): destructive`,
    })
  })

  test("answer: a form not pending is 404; bodies are checked", async () => {
    await start()
    await grantFor("ses_orch")
    expect((await bearer(ACT, "/api/agent/sessions/ses_1/answer", { formID: "form_1", cancel: true })).status).toBe(404)
    expect((await asUser("/api/agent/sessions/ses_1/answer", { formID: "form_1" })).status).toBe(400)
    expect((await asUser("/api/agent/sessions/ses_1/answer", { formID: "form_1", cancel: true, answer: {} })).status).toBe(400)
  })

  test("an agent's prompt is a hub prompt (deliver kind prompt) naming the grant", async () => {
    const { requests } = await start()
    const grant = await grantFor("ses_orch")
    const res = await bearer(ACT, "/api/agent/sessions/ses_1/prompt", { text: "run the tests" })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ sessionID: "ses_1", delivered: "turn", grant })
    expect(requests.find((r) => r.op === "deliver" && r.meta.kind === "prompt")).toMatchObject({ sessionID: "ses_1", text: "run the tests", wake: true, meta: { kind: "prompt", from: "@orchestrator", to: "ses_1", grant } })
    expect((await bearer(ACT, "/api/agent/sessions/ses_1/prompt", { text: "x", wake: false })).status).toBe(400)
    expect((await bearer(ACT, "/api/agent/sessions/ses_1/prompt", { text: "x", delivery: "later" })).status).toBe(400)
  })

  test("a spoke without hubPrompt: 422 unsupported", async () => {
    await start({ features: ["deliver"] })
    await grantFor("ses_orch")
    const res = await bearer(ACT, "/api/agent/sessions/ses_1/prompt", { text: "x" })
    expect(res.status).toBe(422)
    expect((await json(res)).error).toMatchObject({ code: "unsupported", feature: "hubPrompt" })
  })

  test("stop stops the session's tree", async () => {
    const { requests } = await start()
    await grantFor("ses_orch")
    const res = await bearer(ACT, "/api/agent/sessions/ses_1/stop", {})
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ sessionID: "ses_1", result: { stopped: ["ses_1"] } })
    expect(requests.filter((r) => r.op === "stop")).toEqual([{ op: "stop", sessionID: "ses_1" }])
  })

  test("the user prompts like the console (a steer while it runs, else a turn)", async () => {
    const { requests } = await start()
    // ses_1 waits on permissions (its tree runs): steered. ses_orch is idle: a new turn.
    const steered = await asUser("/api/agent/sessions/ses_1/prompt", { text: "hello" })
    expect(steered.status).toBe(200)
    expect(await json(steered)).toEqual({ sessionID: "ses_1", mode: "steer", inboxID: "inb_2" })
    const turn = await asUser("/api/agent/sessions/ses_orch/prompt", { text: "hello" })
    expect(await json(turn)).toEqual({ sessionID: "ses_orch", mode: "turn" })
    await waitFor(() => requests.some((r) => r.op === "turn" && r.sessionID === "ses_orch"))
  })
})
