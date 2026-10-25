// Grant requests through the hub (P3-T9): POST /api/agent/grants/requests {grant, why} from a session (any token)
// or an app token with messages:send opens a tap-tier Decision to @me; the user gets 400 (they create grants
// directly). The user's approval in the console creates the grant owned by the user, holder pinned to the
// requester; deny creates nothing. One open request per requester; tenancy answers not_found.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

const USER = "local"
const SHELL = "hst_fake_shell_orch"
const ACT = "hst_fake_act_orch"
const APP = "hat_fake_app_send"
const APP_READ = "hat_fake_app_read"
const TOKEN = "0123456789abcdef"
const verifiers: BearerVerifier[] = [
  {
    kind: "session",
    verify: (token) =>
      token === SHELL
        ? { kind: "session", userID: USER, machineID: "mch_x", sessionID: "ses_orch", via: "shell" }
        : token === ACT
          ? { kind: "session", userID: USER, machineID: "mch_x", sessionID: "ses_orch", via: "act" }
          : undefined,
  },
  {
    kind: "app",
    verify: (token) =>
      token === APP
        ? { kind: "app", userID: USER, tokenID: TOKEN, scopes: ["messages:send"] }
        : token === APP_READ
          ? { kind: "app", userID: USER, tokenID: "fedcba9876543210", scopes: ["sessions:read", "messages:read"] }
          : undefined,
  },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const PATH = "/api/agent/grants/requests"
const GRANT = { scope: { projects: ["/work/hub"] }, allow: ["approve", "deny"], permissions: { allow: ["read"], never: ["bash:git push*"] }, expires: "8h" }
const BODY = { grant: GRANT, why: "the workers keep asking to read files" }
const json = async (r: Response) => (await r.json()) as any
const bearer = (token: string, body: unknown = BODY) => h.api(PATH, { method: "POST", cookie: null, origin: null, headers: { authorization: `Bearer ${token}` }, json: body })

async function start() {
  h = await harness({ agent: { verifiers } } as any)
  const client = await spoke(h, {
    hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver", "hubPrompt"] } as any,
    sessions: [session("ses_orch", { title: "Orchestrator", owned: true, directory: "/work/hub" }), session("ses_w", { title: "Worker", owned: true, directory: "/work/hub" })],
  })
  // The spoke delivers the user's replies (to the requesting session) at once.
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t === "req") client.send({ t: "res", id: frame.id, ok: true, result: frame.req.op === "deliver" ? { delivered: "queued" } : {} })
  })
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === 2)
}

describe("POST /api/agent/grants/requests", () => {
  test("is an agent route", async () => {
    h = await harness({ agent: { verifiers } } as any)
    expect(h.routes).toContainEqual({ method: "POST", path: PATH, access: "agent" })
  })

  test("a session (shell or act token) opens a tap-tier, high-urgency Decision for the user", async () => {
    await start()
    const res = await bearer(SHELL)
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.decision).toMatchObject({ state: "open", tier: "tap", urgency: "high", from: { kind: "session", sessionID: "ses_orch" } })
    expect(body.decision.options.map((o: any) => o.id)).toEqual(["approve", "deny"])
    expect(body.message.id).toBe(body.decision.messageID)
    const listed = await json(await h.api(`/api/decisions/${body.decision.id}`))
    expect(listed.decision.question).toContain("holder ses_orch")
    await waitFor(() => h.notified.some((n) => n.kind === "decision"))
    const audit = await json(await h.api("/api/agent/audit"))
    expect(audit.entries[0]).toMatchObject({ verb: "grant.request", decision: "needs_user", outcome: "escalated" })
  })

  test("the act token may request too", async () => {
    await start()
    expect((await bearer(ACT)).status).toBe(201)
  })

  test("an app token needs messages:send", async () => {
    await start()
    const ok = await bearer(APP)
    expect(ok.status).toBe(201)
    expect((await json(ok)).decision.question).toContain(`holder app:${TOKEN}`)
    const refused = await bearer(APP_READ)
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.code).toBe("forbidden")
  })

  test("the user gets 400: they create grants directly", async () => {
    await start()
    const res = await h.api(PATH, { method: "POST", json: BODY })
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe("invalid")
  })

  test("invalid grants, another holder (forbidden), another user's session (not_found)", async () => {
    await start()
    const bad = await bearer(SHELL, { grant: { ...GRANT, allow: ["delete"] }, why: "x" })
    expect(bad.status).toBe(400)
    expect((await bearer(SHELL, { grant: GRANT })).status).toBe(400)
    const other = await bearer(SHELL, { grant: { ...GRANT, holder: "ses_w" }, why: "x" })
    expect(other.status).toBe(403)
    expect((await json(other)).error.code).toBe("forbidden")
    const foreign = await bearer(SHELL, { grant: { ...GRANT, holder: "ses_nothers" }, why: "x" })
    expect(foreign.status).toBe(404)
    expect((await json(foreign)).error.code).toBe("not_found")
  })

  test("one open request per requester (429 with the open Decision)", async () => {
    await start()
    const first = await json(await bearer(SHELL))
    const again = await bearer(ACT)
    expect(again.status).toBe(429)
    expect((await json(again)).error).toMatchObject({ code: "rate_limited", decisionID: first.decision.id })
  })
})

describe("the user's answer", () => {
  test("approve (console tap) creates the grant owned by the user, held by the requesting session", async () => {
    await start()
    const { decision } = await json(await bearer(SHELL))
    const deviceToken = h.cookie.slice("voice_device=".length)
    const tapless = await h.api(`/api/decisions/${decision.id}/answer`, { method: "POST", cookie: null, origin: null, headers: { authorization: `Bearer ${deviceToken}` }, json: { option: "approve" } })
    expect(tapless.status).toBe(403)
    const res = await h.api(`/api/decisions/${decision.id}/answer`, { method: "POST", json: { option: "approve" } })
    expect(res.status).toBe(200)
    const answered = await json(res)
    const { grants } = await json(await h.api("/api/agent/grants"))
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ holder: "ses_orch", holderSessionID: "ses_orch", allow: ["approve", "deny"], state: "active" })
    expect(answered.reply.text).toContain(`Grant ${grants[0].id} created`)
    const audit = await json(await h.api("/api/agent/audit"))
    expect(audit.entries[0]).toMatchObject({ verb: "grant.approve", actor: { kind: "user" }, grant: grants[0].id, outcome: "ok" })
  })

  test("deny creates nothing; the requester hears it", async () => {
    await start()
    const { decision } = await json(await bearer(SHELL))
    const answered = await json(await h.api(`/api/decisions/${decision.id}/answer`, { method: "POST", json: { option: "deny" } }))
    expect(answered.reply.text).toBe(`Decision ${decision.id}: Deny [deny]`)
    expect((await json(await h.api("/api/agent/grants"))).grants).toEqual([])
  })
})
