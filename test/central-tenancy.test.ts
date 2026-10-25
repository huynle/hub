// Tenant isolation on a multi-user hub: alice and bob each have a machine (fake spoke) and a device.
// Bob must not see or act on anything of alice's, through any endpoint; admins manage users, machines and
// devices but do not see sessions. The session/machine endpoint lists come from the hub's own route
// table, so a new route cannot silently skip the ownership check.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Push, type PushSendOptions } from "../src/central/push"
import { Store, type PushTarget } from "../src/central/store"
import { harness, session, spoke, sse, waitFor, type Harness } from "./central-harness"
import { fakeProvider, oidcEnv, signIn, type FakeProvider } from "./oidc-fake"
import { run as cli } from "../packages/cli/src/cli"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

type Client = Awaited<ReturnType<typeof spoke>>
interface Person {
  id: string
  cookie: string
  machineID: string
  spoke: Client
  /** Requests the hub sent to this person's spoke. */
  requests: any[]
}

let h: Harness
let idp: FakeProvider
let alice: Person
let bob: Person
let admin: { id: string; cookie: string }
const notified: Array<{ kind: string; sessionID: string; owner?: string }> = []
/** Endpoints the hub sent a Web Push to. */
const pushed: string[] = []

const event = (type: string, data: Record<string, unknown>) => ({ t: "event" as const, event: { type, data } })

/** Answers every server request so positive controls work; records what the spoke was asked. */
function answer(client: Client, requests: any[]) {
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    requests.push(frame.req)
    const op = frame.req.op
    const result =
      op === "turn" ? { text: "ok" } : op === "steer" ? { inboxID: "inb_1" } : op === "conversation" ? { agent: "voice" } : op === "context" ? { messages: [] } : op === "expose" ? { exposed: true } : op === "create" ? { sessionID: "ses_new" } : {}
    client.send({ t: "res", id: frame.id, ok: true, result })
  })
}

async function person(email: string, sessionID: string, processID: string): Promise<Person> {
  const { cookie } = await signIn(h.url, idp, email)
  const id = ((await (await h.api("/api/me", { cookie })).json()) as any).user.id
  const machine = h.store.addMachine(`${email} laptop`, id)
  const client = await spoke(h, {
    machine,
    processID,
    hello: { kind: "service", directory: "/home/user/work" },
    sessions: [session(sessionID, { owned: true, directory: "/home/user/work", title: `${email} session` })],
  })
  const requests: any[] = []
  answer(client, requests)
  return { id, cookie: cookie!, machineID: machine.machine.id, spoke: client, requests }
}

beforeEach(async () => {
  notified.length = 0
  pushed.length = 0
  idp = fakeProvider()
  h = harness({
    env: oidcEnv(idp),
    noDevice: true,
    pushSender: async (target) => void pushed.push(target.endpoint),
    notifier: {
      notify: async (kind, sessionID, _title, _body, owner) => {
        notified.push({ kind, sessionID, ...(owner ? { owner } : {}) })
        return 1
      },
    },
  })
  const signed = await signIn(h.url, idp, "admin@example.com")
  admin = { id: ((await (await h.api("/api/me", { cookie: signed.cookie! })).json()) as any).user.id, cookie: signed.cookie! }
  alice = await person("alice@example.com", "ses_alice", "p_alice")
  bob = await person("bob@example.com", "ses_bob", "p_bob")
})

afterEach(async () => {
  alice?.spoke.close()
  bob?.spoke.close()
  await h?.stop()
  idp?.stop()
})

const as = (who: { cookie: string }, pathname: string, init: RequestInit & { json?: unknown } = {}) => h.api(pathname, { ...init, cookie: who.cookie })
const json = async (r: Response) => (await r.json()) as any

/** A concrete request for a route of the table, aimed at the given session/machine/other IDs. */
function requestFor(route: { method: string; path: string }, ids: { session?: string; machine?: string; id?: string }) {
  const pathname = route.path
    .replace(":session", encodeURIComponent(ids.session ?? "ses_x"))
    .replace(":machine", encodeURIComponent(ids.machine ?? "mch_x"))
    .replace(/:[a-z]+/g, encodeURIComponent(ids.id ?? "x"))
  const body =
    route.method === "GET" || route.method === "DELETE"
      ? {}
      : { json: { text: "hello", on: true, visible: true, decision: "once", requestID: "per_1", directory: "/home/user/work", role: "user", disabled: true } }
  return { pathname, init: { method: route.method, ...body } }
}

describe("route table", () => {
  test("every route declares its access; session and machine routes are classified as such", () => {
    expect(h.routes.length).toBeGreaterThan(20)
    for (const route of h.routes) {
      expect(["public", "user", "admin", "session", "machine", "agent"]).toContain(route.access)
      // /api/agent addresses sessions with :addr (resolved per caller), never :session.
      if (route.path.startsWith("/api/agent/")) expect({ path: route.path, access: route.access }).toEqual({ path: route.path, access: "agent" })
      if (route.access === "agent") expect(route.path.startsWith("/api/agent/") && !route.path.includes(":session")).toBe(true)
      if (route.path.includes(":session")) expect(route.access).toBe("session")
      if (route.path.startsWith("/api/admin/")) expect(route.access).toBe("admin")
      if (route.path.includes(":machine")) expect(route.access).toBe("machine")
    }
    const keys = h.routes.map((r) => `${r.method} ${r.path}`)
    for (const required of [
      "GET /api/sessions/:session",
      "POST /api/sessions/:session/turn",
      "POST /api/sessions/:session/utterance",
      "POST /api/sessions/:session/interrupt",
      "POST /api/sessions/:session/conversation",
      "POST /api/sessions/:session/permission",
      "POST /api/sessions/:session/form",
      "GET /api/sessions/:session/model-prefs",
      "PUT /api/sessions/:session/model-prefs",
      "GET /api/sessions/:session/context",
      "GET /api/sessions/:session/timeline/messages/:message/files/:index",
      "POST /api/sessions/:session/stop",
      "POST /api/sessions/:session/rename",
      "GET /api/sessions/:session/summary",
      "GET /api/sessions/:session/diff",
      "POST /api/sessions/:session/read",
      "POST /api/sessions/:session/expose",
      "POST /api/sessions/:session/presence",
      "POST /api/machines/:machine/sessions",
      "DELETE /api/machines/:machine",
      "GET /api/admin/users",
      "PUT /api/admin/users/:id",
      "GET /api/admin/machines",
      "DELETE /api/admin/machines/:id",
      "DELETE /api/admin/devices/:id",
      "GET /api/admin/audit",
      "GET /api/enrollments",
      "GET /api/settings/speech/default",
      "PUT /api/settings/speech/default",
      "POST /api/push/subscribe",
      "POST /api/push/unsubscribe",
      "GET /api/push/prefs",
      "PUT /api/push/prefs",
      "PUT /api/push/mute",
      "POST /api/push/test",
      "GET /api/agent/whoami",
      "GET /api/sessions/:session/messages",
      "POST /api/agent/msg",
      "POST /api/agent/ask",
      "POST /api/agent/reply",
      "POST /api/agent/decline",
      "GET /api/agent/inbox",
      "GET /api/agent/messages/:id",
      "POST /api/agent/mute",
      "POST /api/agent/unmute",
      "GET /api/agent/messaging",
      "PUT /api/agent/messaging",
      "GET /api/agent/acting",
      "PUT /api/agent/acting",
      "GET /api/admin/agents/acting",
      "PUT /api/admin/agents/acting",
      "GET /api/agent/decisions",
      "GET /api/agent/decisions/:id",
      "GET /api/decisions",
      "GET /api/decisions/:id",
      "POST /api/decisions/:id/answer",
      "POST /api/agent/launches",
      "GET /api/agent/launches",
      "GET /api/agent/launches/:id",
      "DELETE /api/agent/launches/:id",
      "POST /api/agent/webhooks",
      "GET /api/agent/webhooks",
      "GET /api/agent/webhooks/:id",
      "DELETE /api/agent/webhooks/:id",
    ]) {
      expect(keys).toContain(required)
    }
  })
})

describe("bob cannot reach alice's sessions", () => {
  test("every session-scoped route answers 404 Not found, exactly like an unknown session, and nothing reaches alice's spoke", async () => {
    const sessionRoutes = h.routes.filter((r) => r.access === "session")
    expect(sessionRoutes.length).toBeGreaterThanOrEqual(9)
    for (const route of sessionRoutes) {
      for (const target of ["ses_alice", "ses_unknown"]) {
        const { pathname, init } = requestFor(route, { session: target })
        const res = await as(bob, pathname, init)
        expect({ route: `${route.method} ${route.path}`, target, status: res.status }).toEqual({ route: `${route.method} ${route.path}`, target, status: 404 })
        expect(await json(res)).toEqual({ error: "Not found" })
      }
    }
    expect(alice.requests).toEqual([])
    expect(h.registry.watched("ses_alice")).toBe(false)
    expect(h.registry.conversation("ses_alice")).toBe(false)
  })

  test("admins don't see other users' sessions either", async () => {
    for (const route of h.routes.filter((r) => r.access === "session")) {
      const { pathname, init } = requestFor(route, { session: "ses_alice" })
      expect((await as(admin, pathname, init)).status).toBe(404)
    }
    expect(alice.requests).toEqual([])
  })

  test("alice can use her own session (positive control)", async () => {
    expect((await as(alice, "/api/sessions/ses_alice")).status).toBe(200)
    expect((await as(alice, "/api/sessions/ses_alice/turn", { method: "POST", json: { text: "hi" } })).status).toBe(200)
    expect((await as(alice, "/api/sessions/ses_alice/presence", { method: "POST", json: { visible: true } })).status).toBe(204)
    expect(alice.requests.map((r) => r.op)).toEqual(["turn"])
    expect(bob.requests).toEqual([])
  })

  test("every machine-scoped route answers 404 for alice's machine and touches nothing", async () => {
    const machineRoutes = h.routes.filter((r) => r.access === "machine")
    expect(machineRoutes.length).toBeGreaterThanOrEqual(2)
    for (const route of machineRoutes) {
      const { pathname, init } = requestFor(route, { machine: alice.machineID })
      const res = await as(bob, pathname, init)
      expect({ route: route.path, status: res.status }).toEqual({ route: route.path, status: 404 })
    }
    expect(h.store.machines().find((m) => m.id === alice.machineID)?.revoked).toBeUndefined()
    expect(alice.requests).toEqual([])
    // alice can create a session on her own machine
    expect((await as(alice, `/api/machines/${alice.machineID}/sessions`, { method: "POST", json: { directory: "/home/user/work" } })).status).toBe(201)
  })

  test("every admin route answers 403 to bob", async () => {
    for (const route of h.routes.filter((r) => r.access === "admin")) {
      const { pathname, init } = requestFor(route, { id: alice.id })
      const res = await as(bob, pathname, init)
      expect({ route: route.path, status: res.status }).toEqual({ route: route.path, status: 403 })
    }
    expect(h.store.user(alice.id)?.disabled).toBeUndefined()
  })
})

describe("bob cannot reach alice's agent messages", () => {
  /** A message to alice's session, stored for alice. */
  const aliceAsk = () =>
    h.delivery.messages.send(alice.id, { from: { kind: "user" }, to: "ses_alice", recipient: { kind: "session", sessionID: "ses_alice" }, kind: "ask", text: "alice secret" })

  test("every message route answers not_found for alice's sessions and message ids, like unknown ones", async () => {
    const ask = await aliceAsk()
    const cases: Array<[string, string, unknown?]> = [
      ["POST", "/api/agent/msg", { to: "ses_alice", text: "hi" }],
      ["POST", "/api/agent/msg", { to: "ses_unknown", text: "hi" }],
      ["POST", "/api/agent/ask", { to: "ses_alice", text: "hi" }],
      ["POST", "/api/agent/msg", { to: "ses_alice", text: "hi", all: true }],
      ["POST", "/api/agent/reply", { replyTo: ask.id, text: "spoof" }],
      ["POST", "/api/agent/reply", { replyTo: "msg_unknown", text: "spoof" }],
      ["POST", "/api/agent/decline", { replyTo: ask.id, why: "spoof" }],
      ["GET", `/api/agent/messages/${ask.id}`],
      ["GET", "/api/agent/messages/msg_unknown"],
      ["POST", "/api/agent/mute", { session: "ses_alice" }],
      ["POST", "/api/agent/unmute", { session: "ses_alice" }],
    ]
    for (const [method, pathname, body] of cases) {
      const res = await as(bob, pathname, body === undefined ? { method } : { method, json: body })
      expect({ method, pathname, status: res.status }).toEqual({ method, pathname, status: 404 })
      expect((await json(res)).error.code).toBe("not_found")
    }
    expect(JSON.stringify(await json(await as(bob, "/api/agent/inbox")))).not.toContain("alice secret")
    expect((await h.delivery.messages.get(alice.id, ask.id))?.state).toBe("open")
    expect(await h.delivery.messages.muted(alice.id, { kind: "session", sessionID: "ses_alice" })).toEqual([])
    expect(alice.requests).toEqual([])
    // admins get no extra agent powers
    expect((await as(admin, `/api/agent/messages/${ask.id}`)).status).toBe(404)
  })

  test("alice's Decisions: bob gets not_found on the console and agent routes, like unknown ids, and cannot answer", async () => {
    const actor = { kind: "app" as const, userID: alice.id, tokenID: "tok_alice", scopes: ["messages:send"] }
    const { decision } = await h.decisions.ask(alice.id, actor, { question: "alice secret?", options: [{ id: "go", label: "Go" }] })
    for (const id of [decision.id, "dec_unknown"]) {
      expect((await as(bob, `/api/decisions/${id}`)).status).toBe(404)
      expect((await as(bob, `/api/decisions/${id}/answer`, { method: "POST", json: { option: "go" } })).status).toBe(404)
      const agent = await as(bob, `/api/agent/decisions/${id}`)
      expect(agent.status).toBe(404)
      expect((await json(agent)).error.code).toBe("not_found")
    }
    expect(JSON.stringify(await json(await as(bob, "/api/decisions")))).not.toContain("alice secret")
    expect(JSON.stringify(await json(await as(bob, "/api/agent/decisions")))).not.toContain("alice secret")
    expect((await as(admin, `/api/decisions/${decision.id}`)).status).toBe(404)
    expect((await h.decisions.get(alice.id, decision.id))?.state).toBe("open")
    // positive control
    expect((await as(alice, `/api/decisions/${decision.id}/answer`, { method: "POST", json: { option: "go" } })).status).toBe(200)
  })

  test("bob's messaging switch is his own", async () => {
    expect((await as(bob, "/api/agent/messaging", { method: "PUT", json: { enabled: false } })).status).toBe(200)
    expect(await json(await as(alice, "/api/agent/messaging"))).toEqual({ enabled: true })
  })

  test("bob's acting switch is his own; only the admin's hub-wide switch reaches alice", async () => {
    expect((await as(bob, "/api/agent/acting", { method: "PUT", json: { enabled: false } })).status).toBe(200)
    expect(await json(await as(alice, "/api/agent/acting"))).toEqual({ enabled: true, hubEnabled: true })
    expect(h.acting.isActingPaused(alice.id)).toBe(false)
    expect((await as(bob, "/api/admin/agents/acting", { method: "PUT", json: { enabled: false } })).status).toBe(403)
    expect((await as(admin, "/api/admin/agents/acting", { method: "PUT", json: { enabled: false } })).status).toBe(200)
    expect(await json(await as(alice, "/api/agent/acting"))).toEqual({ enabled: true, hubEnabled: false })
    expect(h.acting.isActingPaused(alice.id)).toBe(true)
  })

  test("alice reads her session's messages on the console route (positive control)", async () => {
    const ask = await aliceAsk()
    const res = await as(alice, "/api/sessions/ses_alice/messages")
    expect(res.status).toBe(200)
    expect((await json(res)).messages.map((m: any) => m.id)).toEqual([ask.id])
  })
})

describe("bob cannot act on alice's sessions (approve, deny, answer, prompt, stop)", () => {
  const ACT_OPS = ["permission", "form", "deliver", "steer", "turn", "stop"]

  async function pending() {
    alice.spoke.send(event("permission.asked", { sessionID: "ses_alice", id: "per_alice", action: "shell", resources: ["bun test"] }))
    await waitFor(() => h.registry.permissionTargets("ses_alice", "per_alice").length === 1)
  }

  const verbs = (addr: string): Array<[string, unknown]> => [
    [`/api/agent/sessions/${addr}/approve`, { requestID: "per_alice" }],
    [`/api/agent/sessions/${addr}/deny`, { requestID: "per_alice", why: "spoof" }],
    [`/api/agent/sessions/${addr}/answer`, { formID: "form_alice", cancel: true }],
    [`/api/agent/sessions/${addr}/prompt`, { text: "spoof" }],
    [`/api/agent/sessions/${addr}/stop`, {}],
  ]

  test("as a user, on alice's session or with her request id from his own session: not_found, like unknown ones; nothing reaches alice's spoke", async () => {
    await pending()
    for (const addr of ["ses_alice", "ses_unknown"]) {
      for (const [pathname, body] of verbs(addr)) {
        const res = await as(bob, pathname, { method: "POST", json: body })
        expect({ pathname, status: res.status }).toEqual({ pathname, status: 404 })
        expect((await json(res)).error.code).toBe("not_found")
      }
    }
    for (const verb of ["approve", "deny"]) {
      expect((await as(bob, `/api/agent/sessions/ses_bob/${verb}`, { method: "POST", json: { requestID: "per_alice" } })).status).toBe(404)
    }
    // admins get no extra agent powers
    expect((await as(admin, "/api/agent/sessions/ses_alice/approve", { method: "POST", json: { requestID: "per_alice" } })).status).toBe(404)
    expect(alice.requests.filter((r) => ACT_OPS.includes(r.op))).toEqual([])
    expect(h.registry.permissionTargets("ses_alice", "per_alice")).toHaveLength(1)
  })

  test("bob's act app token under his own grant: alice's sessions stay not_found; a grant naming her session is refused", async () => {
    await pending()
    const token = await json(await as(bob, "/api/agent/app-tokens", { method: "POST", json: { scopes: ["sessions:act"] } }))
    const created = await as(bob, "/api/agent/grants", {
      method: "POST",
      json: { holder: `app:${token.id}`, scope: { projects: ["/home/user/work"] }, allow: ["approve", "deny", "answer", "prompt", "stop"], permissions: { allow: ["shell"] } },
    })
    expect(created.status).toBe(201)
    expect((await as(bob, "/api/agent/grants", { method: "POST", json: { holder: "ses_alice", scope: { projects: ["/home/user/work"] }, allow: ["stop"] } })).status).toBe(404)
    for (const [pathname, body] of verbs("ses_alice")) {
      const res = await h.api(pathname, { method: "POST", cookie: null, origin: null, headers: { authorization: `Bearer ${token.token}` }, json: body })
      expect({ pathname, status: res.status }).toEqual({ pathname, status: 404 })
    }
    expect(alice.requests.filter((r) => ACT_OPS.includes(r.op))).toEqual([])
    // alice's audit has nothing of bob's
    expect((await json(await as(alice, "/api/agent/audit"))).entries).toEqual([])
  })

  test("alice approves her own request (positive control)", async () => {
    await pending()
    expect((await as(alice, "/api/agent/sessions/ses_alice/approve", { method: "POST", json: { requestID: "per_alice" } })).status).toBe(200)
    expect(alice.requests.filter((r) => r.op === "permission")).toEqual([{ op: "permission", sessionID: "ses_alice", requestID: "per_alice", decision: "once" }])
  })
})

describe("bob cannot reach alice's grants, escalations, grant requests or agent audit (HTTP and CLI)", () => {
  /** Alice's phase-3 world: a grant, an app token acting under it, an escalation Decision and a grant-request Decision. */
  interface AliceWorld {
    grantID: string
    appTokenID: string
    escalationID: string
    requestDecisionID: string
  }
  /** Bob's credentials: a device token (CLI login), and a session of his own with its shell and act tokens. */
  interface BobCreds {
    env: Record<string, string>
    home: string
    session: { shell: string; act: string }
    spoke: Client
  }

  const bearer = (token: string, pathname: string, init: RequestInit & { json?: unknown } = {}) =>
    h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token}` } })

  async function aliceWorld(): Promise<AliceWorld> {
    alice.spoke.send(event("permission.asked", { sessionID: "ses_alice", id: "per_alice", action: "shell", resources: ["rm -rf dist"] }))
    await waitFor(() => h.registry.permissionTargets("ses_alice", "per_alice").length === 1)
    const app = await json(await as(alice, "/api/agent/app-tokens", { method: "POST", json: { label: "alice bot", scopes: ["sessions:act", "messages:send"] } }))
    const grant = await as(alice, "/api/agent/grants", {
      method: "POST",
      json: { holder: `app:${app.id}`, scope: { projects: ["/home/user/work"] }, allow: ["approve", "deny"], permissions: { allow: ["shell:bun test*"] } },
    })
    expect(grant.status).toBe(201)
    const grantID = (await json(grant)).grant.id as string
    // Outside the grant: needs_user, with a Decision for alice.
    const escalated = await bearer(app.token, "/api/agent/sessions/ses_alice/approve", { method: "POST", json: { requestID: "per_alice", why: "alice secret why" } })
    expect(escalated.status).toBe(403)
    const escalationID = (await json(escalated)).error.decisionID as string
    expect(escalationID).toMatch(/^dec_/)
    const requested = await bearer(app.token, "/api/agent/grants/requests", {
      method: "POST",
      json: { grant: { scope: { projects: ["/home/user/work"] }, allow: ["stop"] }, why: "alice secret request" },
    })
    expect(requested.status).toBe(201)
    const requestDecisionID = (await json(requested)).decision.id as string
    return { grantID, appTokenID: app.id, escalationID, requestDecisionID }
  }

  async function bobCreds(): Promise<BobCreds> {
    const { code } = await json(await as(bob, "/api/devices/link", { method: "POST", json: {} }))
    const { token } = await json(await h.api("/api/devices/redeem", { method: "POST", json: { code }, cookie: null, origin: null }))
    const home = mkdtempSync(path.join(tmpdir(), "voice-tenancy-cli-"))
    const env = { XDG_CONFIG_HOME: path.join(home, "xdg") }
    expect(await cli(["login", "--url", h.url, "--token", token], { env, home, stdout: () => {}, stderr: () => {} })).toBe(0)
    // A second spoke of bob's announcing session and act tokens, so his session has both.
    const machine = h.store.addMachine("bob desktop", bob.id)
    const tokens: { shell?: string; act?: string } = {}
    const client = await spoke(h, {
      machine,
      processID: "p_bob_tokens",
      hello: { kind: "service", directory: "/home/user/work", harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["sessionTokens", "actTokens", "deliver"] } as any,
    })
    client.ws.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data))
      if (frame.t !== "req") return
      const op = frame.req.op
      if (op === "sessionTokens" || op === "actTokens") {
        const mine = frame.req.tokens.find((t: any) => t.sessionID === "ses_bobtok")
        if (mine) tokens[op === "sessionTokens" ? "shell" : "act"] = mine.token
        client.send({ t: "res", id: frame.id, ok: true, result: { applied: frame.req.tokens.map((t: any) => t.sessionID), skipped: [] } })
      } else client.send({ t: "res", id: frame.id, ok: true, result: op === "deliver" ? { delivered: "queued" } : {} })
    })
    client.send({ t: "sessions", sessions: [session("ses_bobtok", { owned: true, directory: "/home/user/work", title: "bob tokens" })] })
    await waitFor(() => tokens.shell !== undefined && tokens.act !== undefined, 5000)
    return { env, home, session: { shell: tokens.shell!, act: tokens.act! }, spoke: client }
  }

  async function bobCli(creds: { env: Record<string, string>; home: string }, argv: string[]) {
    let stdout = ""
    const code = await cli([...argv, "--json"], { env: creds.env, home: creds.home, stdout: (s) => (stdout += s), stderr: (s) => (stdout ||= s) })
    let body: any
    try {
      body = JSON.parse(stdout)
    } catch {
      body = { raw: stdout }
    }
    return { code, body }
  }

  const ACT_OPS = ["permission", "form", "deliver", "steer", "turn", "stop"]

  test("grants: bob's list is empty; alice's grant is not_found on every grant route, like an unknown id; admins neither", async () => {
    const world = await aliceWorld()
    const before = await json(await as(alice, `/api/agent/grants/${world.grantID}`))
    expect((await json(await as(bob, "/api/agent/grants"))).grants).toEqual([])
    const spec = { holder: `app:${world.appTokenID}`, scope: { projects: ["/home/user/work"] }, allow: ["approve", "deny", "stop"] }
    for (const id of [world.grantID, "g_0000000000000000"]) {
      for (const [method, body] of [["GET"], ["PUT", spec], ["DELETE"]] as Array<[string, unknown?]>) {
        for (const who of [bob, admin]) {
          const res = await as(who, `/api/agent/grants/${id}`, body === undefined ? { method } : { method, json: body })
          expect({ id, method, status: res.status }).toEqual({ id, method, status: 404 })
          expect((await json(res)).error.code).toBe("not_found")
        }
      }
    }
    // A grant naming alice's app token or session as its holder is refused as not found.
    for (const holder of [`app:${world.appTokenID}`, "ses_alice"]) {
      const res = await as(bob, "/api/agent/grants", { method: "POST", json: { ...spec, holder } })
      expect({ holder, status: res.status }).toEqual({ holder, status: 404 })
    }
    expect((await json(await as(bob, "/api/agent/grants"))).grants).toEqual([])
    expect((await json(await as(admin, "/api/agent/grants"))).grants).toEqual([])
    expect(await json(await as(alice, `/api/agent/grants/${world.grantID}`))).toEqual(before)
  })

  test("escalation and grant-request Decisions: not_found on the console and agent routes, never listed, still open", async () => {
    const world = await aliceWorld()
    for (const id of [world.escalationID, world.requestDecisionID]) {
      for (const who of [bob, admin]) {
        expect((await as(who, `/api/decisions/${id}`)).status).toBe(404)
        expect((await as(who, `/api/decisions/${id}/answer`, { method: "POST", json: { option: "approve" } })).status).toBe(404)
        expect((await as(who, `/api/agent/decisions/${id}`)).status).toBe(404)
      }
    }
    for (const pathname of ["/api/decisions", "/api/decisions?state=open", "/api/agent/decisions", "/api/agent/inbox"]) {
      const text = JSON.stringify(await json(await as(bob, pathname)))
      expect(text).not.toContain("alice secret")
      expect(text).not.toContain(world.escalationID)
      expect(text).not.toContain(world.requestDecisionID)
    }
    expect((await h.decisions.get(alice.id, world.escalationID))?.state).toBe("open")
    expect((await h.decisions.get(alice.id, world.requestDecisionID))?.state).toBe("open")
    // The escalated request was not answered, and no grant was created for alice.
    expect(alice.requests.filter((r) => r.op === "permission")).toEqual([])
    expect((await json(await as(alice, "/api/agent/grants"))).grants).toHaveLength(1)
  })

  test("agent audit: bob's log (and his SSE) never carries alice's entries", async () => {
    const bobEvents = sse(await as(bob, "/api/events"))
    await bobEvents.next((m) => m.type === "catalog")
    const world = await aliceWorld()
    const aliceAudit = (await json(await as(alice, "/api/agent/audit"))).entries
    expect(aliceAudit.map((e: any) => e.verb)).toEqual(expect.arrayContaining(["approve", "grant.request"]))
    expect((await json(await as(bob, "/api/agent/audit"))).entries).toEqual([])
    expect((await json(await as(admin, "/api/agent/audit"))).entries).toEqual([])
    // Bob's own action is the marker: his stream gets his agent entry, never alice's.
    expect((await as(bob, "/api/agent/acting", { method: "PUT", json: { enabled: true } })).status).toBe(200)
    const seen: any[] = []
    await bobEvents.next((m) => {
      seen.push(m)
      return m.type === "agent"
    })
    expect(seen.filter((m) => m.type === "agent").map((m) => m.entry.verb)).toEqual(["acting.resume"])
    expect(JSON.stringify(seen)).not.toContain("ses_alice")
    expect(JSON.stringify(seen)).not.toContain(world.grantID)
    await bobEvents.cancel()
  })

  test("the CLI as bob's device: grant show/revoke/create, act verbs on alice's are not found (exit 3); lists are empty", async () => {
    const world = await aliceWorld()
    const creds = await bobCreds()
    const list = await bobCli(creds, ["grant", "list"])
    expect(list.code).toBe(0)
    expect(list.body.grants).toEqual([])
    const cases: string[][] = [
      ["grant", "show", world.grantID],
      ["grant", "revoke", world.grantID],
      ["grant", "create", "--holder", `app:${world.appTokenID}`, "--project", "/home/user/work", "--allow", "stop"],
      ["grant", "create", "--holder", "ses_alice", "--project", "/home/user/work", "--allow", "stop"],
      ["approve", "ses_alice", "per_alice"],
      ["deny", "ses_alice", "per_alice", "--why", "spoof"],
      ["answer", "ses_alice", "form_alice", "--cancel"],
      ["prompt", "ses_alice", "spoof"],
      ["stop", "ses_alice"],
      ["approve", "ses_bob", "per_alice"],
    ]
    for (const argv of cases) {
      const r = await bobCli(creds, argv)
      expect({ argv, code: r.code }).toEqual({ argv, code: 3 })
      expect(r.body.error.code).toBe("not_found")
    }
    const decisions = await bobCli(creds, ["decisions", "list"])
    expect(decisions.code).toBe(0)
    expect(JSON.stringify(decisions.body)).not.toContain("alice secret")
    expect(alice.requests.filter((r) => ACT_OPS.includes(r.op))).toEqual([])
    expect((await json(await as(alice, `/api/agent/grants/${world.grantID}`))).grant.state).toBe("active")
    creds.spoke.close()
  })

  test("bob's session: its act token gets not_found on alice's sessions; a grant request naming her session is not found", async () => {
    const world = await aliceWorld()
    const creds = await bobCreds()
    // Even under a grant of bob's own covering the same project path.
    const own = await as(bob, "/api/agent/grants", {
      method: "POST",
      json: { holder: "ses_bobtok", scope: { projects: ["/home/user/work"] }, allow: ["approve", "deny", "answer", "prompt", "stop"], permissions: { allow: ["shell"] } },
    })
    expect(own.status).toBe(201)
    for (const [verb, body] of [
      ["approve", { requestID: "per_alice" }],
      ["deny", { requestID: "per_alice", why: "spoof" }],
      ["answer", { formID: "form_alice", cancel: true }],
      ["prompt", { text: "spoof" }],
      ["stop", {}],
    ] as Array<[string, unknown]>) {
      const res = await bearer(creds.session.act, `/api/agent/sessions/ses_alice/${verb}`, { method: "POST", json: body })
      expect({ verb, status: res.status }).toEqual({ verb, status: 404 })
      expect((await json(res)).error.code).toBe("not_found")
    }
    // The CLI as the session (its shell token): a grant request held by alice's session is not found.
    const asSession = { env: { HUB_URL: h.url, HUB_SESSION_TOKEN: creds.session.shell }, home: creds.home }
    const requested = await bobCli(asSession, ["grant", "request", "--holder", "ses_alice", "--project", "/home/user/work", "--allow", "stop", "--why", "spoof"])
    expect(requested.code).toBe(3)
    expect(requested.body.error.code).toBe("not_found")
    const open = (await json(await as(alice, "/api/decisions?state=open"))).decisions.map((d: any) => d.id).sort()
    expect(open).toEqual([world.escalationID, world.requestDecisionID].sort())
    expect(alice.requests.filter((r) => ACT_OPS.includes(r.op))).toEqual([])
    creds.spoke.close()
  })
})

describe("bob cannot reach alice's launches", () => {
  const launch = (key: string) => ({ key, workspace: { repo: "/home/user/work", branch: "feat/x" }, prompt: "secret plan", labels: { app: "brain" } })

  async function aliceLaunch(): Promise<string> {
    const created = await as(alice, "/api/agent/launches", { method: "POST", json: launch("k1") })
    expect(created.status).toBe(201)
    return (await json(created)).launch.id
  }

  test("GET and DELETE of alice's launch are not_found for bob and the admin, like an unknown id; lists are empty; it keeps running", async () => {
    const id = await aliceLaunch()
    for (const who of [bob, admin]) {
      for (const target of [id, "lch_unknown"]) {
        for (const method of ["GET", "DELETE"]) {
          const res = await as(who, `/api/agent/launches/${target}`, { method })
          expect({ method, target, status: res.status }).toEqual({ method, target, status: 404 })
          expect((await json(res)).error.code).toBe("not_found")
        }
      }
      expect((await json(await as(who, "/api/agent/launches"))).launches).toEqual([])
      expect((await json(await as(who, "/api/agent/launches?label=app=brain"))).launches).toEqual([])
    }
    expect((await json(await as(alice, `/api/agent/launches/${id}`))).launch.state).not.toBe("ended")
  })

  test("bob reusing alice's idempotency key gets his own launch, never hers", async () => {
    const id = await aliceLaunch()
    const res = await as(bob, "/api/agent/launches", { method: "POST", json: launch("k1") })
    expect(res.status).toBe(201)
    expect((await json(res)).launch.id).not.toBe(id)
    expect((await json(await as(alice, "/api/agent/launches"))).launches.map((l: any) => l.id)).toEqual([id])
  })

  test("bob's launch app token under his own grant cannot see or stop alice's launch", async () => {
    const id = await aliceLaunch()
    const token = await json(await as(bob, "/api/agent/app-tokens", { method: "POST", json: { scopes: ["sessions:launch", "sessions:read"] } }))
    const granted = await as(bob, "/api/agent/grants", { method: "POST", json: { holder: `app:${token.id}`, scope: { projects: ["/home/user/work"] }, allow: ["launch"] } })
    expect(granted.status).toBe(201)
    const asApp = (pathname: string, init: RequestInit = {}) => h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token.token}` } })
    expect((await asApp(`/api/agent/launches/${id}`)).status).toBe(404)
    expect((await asApp(`/api/agent/launches/${id}`, { method: "DELETE" })).status).toBe(404)
    expect((await json(await asApp("/api/agent/launches"))).launches).toEqual([])
    expect((await json(await as(alice, "/api/agent/audit"))).entries.map((e: any) => e.verb)).toEqual(["launch"])
  })

  test("SSE and watch: alice's launch events never reach bob or the admin", async () => {
    const bobEvents = sse(await as(bob, "/api/events"))
    const adminEvents = sse(await as(admin, "/api/events"))
    const aliceEvents = sse(await as(alice, "/api/events"))
    const bobWatch = sse(await as(bob, "/api/agent/watch"))
    for (const stream of [bobEvents, adminEvents, aliceEvents]) await stream.next((m) => m.type === "catalog")
    await bobWatch.next((m) => m.type === "ready")
    const id = await aliceLaunch()
    expect(await aliceEvents.next((m) => m.type === "launch")).toMatchObject({ launch: { id, state: "queued" } })
    // bob's own launch is the marker: his streams get it, never alice's
    const mine = (await json(await as(bob, "/api/agent/launches", { method: "POST", json: { ...launch("b1"), prompt: "bob plan" } }))).launch.id
    for (const stream of [bobEvents, bobWatch]) {
      const seen: any[] = []
      await stream.next((m) => {
        seen.push(m)
        return m.type === "launch"
      })
      expect(seen.filter((m) => m.type === "launch").map((m) => m.id ?? m.launch.id)).toEqual([mine])
      expect(JSON.stringify(seen)).not.toContain(id)
      expect(JSON.stringify(seen)).not.toContain("secret plan")
    }
    await expect(adminEvents.next((m) => m.type === "launch", 150)).rejects.toThrow(/timed out/)
    for (const stream of [bobEvents, adminEvents, aliceEvents, bobWatch]) await stream.cancel()
  })
})

describe("bob cannot reach alice's push settings", () => {
  test("user-scoped push routes only read and change the caller's own device and user", async () => {
    const endpoint = "https://push.example.com/alice"
    const subscription = { endpoint, keys: { p256dh: "p256-alice", auth: "auth-alice" } }
    expect((await as(alice, "/api/push/subscribe", { method: "POST", json: { subscription, prefs: { finished: true } } })).status).toBe(200)
    expect((await as(alice, "/api/push/mute", { method: "PUT", json: { sessionID: "ses_alice", muted: true } })).status).toBe(200)
    const before = await json(await as(alice, `/api/push/prefs?endpoint=${encodeURIComponent(endpoint)}`))
    expect(before).toMatchObject({ subscribed: true, subscriptions: 1, muted: ["ses_alice"] })

    // Bob does not see alice's subscription, cannot remove it, and his changes stay his own.
    expect(await json(await as(bob, `/api/push/prefs?endpoint=${encodeURIComponent(endpoint)}`))).toMatchObject({ subscribed: false, subscriptions: 0, muted: [] })
    expect((await as(bob, "/api/push/unsubscribe", { method: "POST", json: { endpoint } })).status).toBe(404)
    expect((await as(bob, "/api/push/prefs", { method: "PUT", json: { finished: false, handoff: false } })).status).toBe(200)
    expect((await as(bob, "/api/push/mute", { method: "PUT", json: { sessionID: "ses_alice", muted: false } })).status).toBe(200)
    expect(await json(await as(bob, "/api/push/test", { method: "POST" }))).toMatchObject({ sent: 0, subscriptions: 0 })
    // Re-subscribing alice's endpoint from bob's device with oldEndpoint does not drop alice's.
    expect((await as(bob, "/api/push/subscribe", { method: "POST", json: { subscription: { ...subscription, endpoint: "https://push.example.com/bob" }, oldEndpoint: endpoint } })).status).toBe(200)
    expect(pushed).toEqual([])

    expect(await json(await as(alice, `/api/push/prefs?endpoint=${encodeURIComponent(endpoint)}`))).toEqual(before)
    expect(h.store.pushSubscriptions().filter((s) => s.endpoint === endpoint)).toHaveLength(1)
    expect((await as(alice, "/api/push/test", { method: "POST" })).status).toBe(200)
    expect(pushed).toEqual([endpoint])
  })
})

describe("catalog, SSE and push", () => {
  test("terminals, Herdr directories and view prefs stay with their owner", async () => {
    alice.spoke.send({ t: "terminals", herdr: { workspaces: [{ id: "w5", label: "alice-space", directories: ["/home/user/alice"] }] } })
    await waitFor(() => h.registry.terminals(alice.machineID) !== undefined)
    expect(JSON.stringify(await json(await as(bob, "/api/machines")))).not.toContain("alice-space")
    expect((await json(await as(alice, "/api/machines"))).machines[0].terminals.herdr.workspaces[0].label).toBe("alice-space")
    // Alice's Herdr folder is not a workspace on bob's machine.
    const create = await as(bob, `/api/machines/${bob.machineID}/sessions`, { method: "POST", json: { directory: "/home/user/alice", herdrWorkspace: "w5" } })
    expect(create.status).toBe(400)
    expect((await as(alice, "/api/prefs/view", { method: "PUT", json: { pinnedSessions: ["ses_alice"] } })).status).toBe(200)
    expect((await json(await as(bob, "/api/prefs/view"))).prefs.pinnedSessions).toEqual([])
  })

  test("GET /api/machines lists only your own machines", async () => {
    const machines = (await json(await as(bob, "/api/machines"))).machines
    expect(machines.map((m: any) => m.id)).toEqual([bob.machineID])
    expect(JSON.stringify(machines)).not.toContain("ses_alice")
    expect((await json(await as(admin, "/api/machines"))).machines).toEqual([])
  })

  test("SSE: catalog, status and stream events only reach the session's owner; enrollments only admins", async () => {
    const bobEvents = sse(await as(bob, "/api/events"))
    const aliceEvents = sse(await as(alice, "/api/events"))
    const adminEvents = sse(await as(admin, "/api/events"))
    const first = await bobEvents.next((m) => m.type === "catalog")
    expect(first.machines.map((m: any) => m.id)).toEqual([bob.machineID])
    await aliceEvents.next((m) => m.type === "catalog")
    await adminEvents.next((m) => m.type === "catalog")

    alice.spoke.send(event("session.execution.started", { sessionID: "ses_alice" }))
    alice.spoke.send(event("session.text.delta", { sessionID: "ses_alice", assistantMessageID: "msg_a", delta: "secret plan" }))
    alice.spoke.send(event("permission.asked", { sessionID: "ses_alice", id: "per_a", action: "bash" }))
    expect((await aliceEvents.next((m) => m.type === "delta")).text).toBe("secret plan")
    await h.api("/spoke/enroll", { method: "POST", json: { machineName: "new box" }, cookie: null, origin: null })
    expect((await adminEvents.next((m) => m.type === "enrollment")).type).toBe("enrollment")

    bob.spoke.send(event("session.text.delta", { sessionID: "ses_bob", assistantMessageID: "msg_b", delta: "bob text" }))
    const seen: any[] = []
    const marker = await bobEvents.next((m) => {
      seen.push(m)
      return m.type === "delta"
    })
    expect(marker.sessionID).toBe("ses_bob")
    expect(JSON.stringify(seen)).not.toContain("ses_alice")
    expect(JSON.stringify(seen)).not.toContain("secret plan")
    expect(seen.some((m) => m.type === "enrollment")).toBe(false)
    // catalog pushes after alice's changes never carry alice's machine to bob
    for (const m of seen.filter((m) => m.type === "catalog")) expect(m.machines.map((x: any) => x.id)).toEqual([bob.machineID])
    // the push for alice's permission goes to alice only
    await waitFor(() => notified.some((n) => n.sessionID === "ses_alice"))
    expect(notified.filter((n) => n.sessionID === "ses_alice").every((n) => n.owner === alice.id)).toBe(true)
    await bobEvents.cancel()
    await aliceEvents.cancel()
    await adminEvents.cancel()
  })

  test("Push delivers only to the owner's devices", async () => {
    const store = Store.open(mkdtempSync(path.join(tmpdir(), "voice-tenancy-push-")))
    const a = store.addDevice("a", "u_a").device
    const b = store.addDevice("b", "u_b").device
    store.addPushSubscription(a.id, { endpoint: "https://push.example.com/a", keys: { p256dh: "x", auth: "y" } })
    store.addPushSubscription(b.id, { endpoint: "https://push.example.com/b", keys: { p256dh: "x", auth: "y" } })
    const sent: string[] = []
    const push = new Push({ store, subject: "mailto:admin@example.com", sender: async (target: PushTarget, _p: string, _o: PushSendOptions) => void sent.push(target.endpoint) })
    expect(await push.notify("handoff", "ses_1", "t", undefined, "u_a")).toBe(1)
    expect(sent).toEqual(["https://push.example.com/a"])
  })

  test("a spoke reporting someone else's session ID gets nothing: no listing, no routing, no injected events", async () => {
    const aliceEvents = sse(await as(alice, "/api/events"))
    await aliceEvents.next((m) => m.type === "catalog")
    bob.spoke.send({ t: "sessions", sessions: [session("ses_bob", { owned: true }), session("ses_alice", { owned: true, title: "forged" })] })
    await Bun.sleep(50)
    // bob's catalog does not list it and bob still gets 404
    const bobMachines = (await json(await as(bob, "/api/machines"))).machines
    expect(JSON.stringify(bobMachines)).not.toContain("ses_alice")
    expect((await as(bob, "/api/sessions/ses_alice")).status).toBe(404)
    // alice's view is not the forged one, and her turn goes to her own spoke
    expect((await json(await as(alice, "/api/sessions/ses_alice"))).title).toBe("alice@example.com session")
    expect((await as(alice, "/api/sessions/ses_alice/turn", { method: "POST", json: { text: "hi" } })).status).toBe(200)
    expect(bob.requests).toEqual([])
    // events bob forwards about alice's session never reach alice
    bob.spoke.send(event("session.text.delta", { sessionID: "ses_alice", assistantMessageID: "m_forged", delta: "injected" }))
    bob.spoke.send(event("session.created", { sessionID: "ses_child", parentID: "ses_alice", title: "forged child" }))
    alice.spoke.send(event("session.text.delta", { sessionID: "ses_alice", assistantMessageID: "m_real", delta: "real" }))
    const delta = await aliceEvents.next((m) => m.type === "delta")
    expect(delta.text).toBe("real")
    expect(JSON.stringify(h.registry.status("ses_alice"))).not.toContain("forged child")
    await aliceEvents.cancel()
  })
})

describe("subagent (child) sessions", () => {
  test("a child known only from its owner's events opens for its owner, steers through the owner's spoke, and stays 404 for bob", async () => {
    alice.spoke.send(event("session.created", { sessionID: "ses_alice_kid", parentID: "ses_alice", title: "Integrate P6.5 sessions" }))
    await waitFor(() => h.registry.status("ses_alice")?.some((s) => s.id === "ses_alice_kid") === true)
    const view = await as(alice, "/api/sessions/ses_alice_kid")
    expect(view.status).toBe(200)
    expect(await json(view)).toMatchObject({ id: "ses_alice_kid", parentID: "ses_alice", title: "Integrate P6.5 sessions", directory: "/home/user/work" })
    expect((await as(alice, "/api/sessions/ses_alice_kid/timeline")).status).toBe(200)
    expect((await as(alice, "/api/sessions/ses_alice_kid/turn", { method: "POST", json: { text: "focus on tests" } })).status).toBe(200)
    expect(alice.requests.map((r) => [r.op, r.sessionID])).toEqual([
      ["timeline", "ses_alice_kid"],
      ["turn", "ses_alice_kid"],
    ])
    for (const pathname of ["/api/sessions/ses_alice_kid", "/api/sessions/ses_alice_kid/timeline"]) expect((await as(bob, pathname)).status).toBe(404)
    expect((await as(bob, "/api/sessions/ses_alice_kid/turn", { method: "POST", json: { text: "x" } })).status).toBe(404)
    // bob reporting a session of his own as a child of alice's root does not nest it in alice's tree
    bob.spoke.send({ t: "sessions", sessions: [session("ses_bob", { owned: true }), session("ses_bob_kid", { parentID: "ses_alice", title: "sneaky" })] })
    await Bun.sleep(50)
    expect(JSON.stringify(h.registry.status("ses_alice"))).not.toContain("ses_bob_kid")
    expect((await as(alice, "/api/sessions/ses_bob_kid")).status).toBe(404)
    expect(bob.requests).toEqual([])
  })
})

describe("devices and machines", () => {
  test("own devices only; foreign device and machine revocation is 404", async () => {
    const devices = (await json(await as(bob, "/api/devices"))).devices
    expect(devices.length).toBe(1)
    expect(devices[0].current).toBe(true)
    const aliceDevice = h.store.devices().find((d) => d.ownerID === alice.id)!
    expect((await as(bob, `/api/devices/${aliceDevice.id}`, { method: "DELETE" })).status).toBe(404)
    expect((await as(bob, `/api/machines/${alice.machineID}`, { method: "DELETE" })).status).toBe(404)
    expect((await as(alice, "/api/me")).status).toBe(200)
    // bob can revoke his own machine (audited)
    expect((await as(bob, `/api/machines/${bob.machineID}`, { method: "DELETE" })).status).toBe(204)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: bob.id, action: "machine.revoke", target: bob.machineID })
    const bobDevice = h.store.devices().find((d) => d.ownerID === bob.id)!
    expect((await as(bob, `/api/devices/${bobDevice.id}`, { method: "DELETE" })).status).toBe(204)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: bob.id, action: "device.revoke", target: bobDevice.id })
  })

  test("GET /api/enrollments is admin only", async () => {
    expect((await as(bob, "/api/enrollments")).status).toBe(403)
    expect((await as(admin, "/api/enrollments")).status).toBe(200)
  })
})

describe("admin API", () => {
  test("GET /api/admin/users lists users with counts; no secrets", async () => {
    const users = await json(await as(admin, "/api/admin/users"))
    expect(Array.isArray(users)).toBe(true)
    const row = users.find((u: any) => u.email === "alice@example.com")
    expect(row).toEqual({ id: alice.id, email: "alice@example.com", name: "alice", role: "user", disabled: false, created: expect.any(Number), lastSeen: expect.any(Number), machines: 1, devices: 1 })
    expect(JSON.stringify(users)).not.toMatch(/tokenHash|speech/)
  })

  test("PUT /api/admin/users/:id changes role and disables; last admin protected", async () => {
    const res = await as(admin, `/api/admin/users/${bob.id}`, { method: "PUT", json: { role: "admin" } })
    expect(res.status).toBe(200)
    expect((await json(res)).role).toBe("admin")
    expect(h.store.auditLog()[0]).toMatchObject({ actor: admin.id, action: "user.role", target: bob.id, detail: "admin" })
    await as(admin, `/api/admin/users/${bob.id}`, { method: "PUT", json: { role: "user" } })
    // the only active admin cannot demote or disable themselves
    expect((await as(admin, `/api/admin/users/${admin.id}`, { method: "PUT", json: { role: "user" } })).status).toBe(409)
    expect((await as(admin, `/api/admin/users/${admin.id}`, { method: "PUT", json: { disabled: true } })).status).toBe(409)
    expect((await as(admin, `/api/admin/users/nobody`, { method: "PUT", json: { role: "user" } })).status).toBe(404)
    expect((await as(admin, `/api/admin/users/${bob.id}`, { method: "PUT", json: { role: "root" } })).status).toBe(400)
    expect((await as(admin, `/api/admin/users/${bob.id}`, { method: "PUT", json: { disabled: "yes" } })).status).toBe(400)
  })

  test("disabling a user locks out their devices, closes their spokes (bye revoked) and their SSE", async () => {
    const aliceEvents = sse(await as(alice, "/api/events"))
    await aliceEvents.next((m) => m.type === "catalog")
    const res = await as(admin, `/api/admin/users/${alice.id}`, { method: "PUT", json: { disabled: true } })
    expect(res.status).toBe(200)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: admin.id, action: "user.disable", target: alice.id })
    expect((await as(alice, "/api/me")).status).toBe(401)
    const bye = await alice.spoke.next((f) => f.t === "bye")
    expect(bye.reason).toBe("revoked")
    await expect(aliceEvents.next(() => false, 1000)).rejects.toThrow(/ended|timed out/)
    // enabling again lets the devices back in
    await as(admin, `/api/admin/users/${alice.id}`, { method: "PUT", json: { disabled: false } })
    expect((await as(alice, "/api/me")).status).toBe(200)
    expect(h.store.auditLog()[0]).toMatchObject({ action: "user.enable", target: alice.id })
  })

  test("admin machines and devices: list with owner email, revoke anyone's", async () => {
    const machines = await json(await as(admin, "/api/admin/machines"))
    expect(Array.isArray(machines)).toBe(true)
    const row = machines.find((m: any) => m.id === alice.machineID)
    expect(row).toMatchObject({ id: alice.machineID, ownerID: alice.id, ownerEmail: "alice@example.com", online: true })
    expect(JSON.stringify(machines)).not.toContain("tokenHash")
    expect(JSON.stringify(machines)).not.toContain("ses_alice")
    expect((await as(admin, `/api/admin/machines/${alice.machineID}`, { method: "DELETE" })).status).toBe(204)
    expect((await alice.spoke.next((f) => f.t === "bye")).reason).toBe("revoked")
    expect(h.store.auditLog()[0]).toMatchObject({ actor: admin.id, action: "machine.revoke", target: alice.machineID })
    expect((await as(admin, `/api/admin/machines/${alice.machineID}`, { method: "DELETE" })).status).toBe(404)
    const aliceDevice = h.store.devices().find((d) => d.ownerID === alice.id)!
    expect((await as(admin, `/api/admin/devices/${aliceDevice.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await as(alice, "/api/me")).status).toBe(401)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: admin.id, action: "device.revoke", target: aliceDevice.id })
  })

  test("GET /api/admin/audit is newest first", async () => {
    const audit = await json(await as(admin, "/api/admin/audit"))
    expect(Array.isArray(audit)).toBe(true)
    expect(audit.length).toBeGreaterThan(2)
    for (let i = 1; i < audit.length; i++) expect(audit[i - 1].at).toBeGreaterThanOrEqual(audit[i].at)
    expect(audit.map((e: any) => e.action)).toContain("signin")
  })

  test("/api/me has the contract shape", async () => {
    const me = await json(await as(bob, "/api/me"))
    expect(me).toMatchObject({ device: { id: expect.any(String), name: expect.any(String) }, user: { id: bob.id, email: "bob@example.com", role: "user" }, auth: "oidc" })
  })
})

describe("bob cannot reach alice's webhooks", () => {
  test("GET and DELETE of alice's webhook are not_found for bob and the admin, like an unknown id; their lists are empty", async () => {
    const created = await as(alice, "/api/agent/webhooks", { method: "POST", json: { url: "https://hooks.example.com/alice" } })
    expect(created.status).toBe(201)
    const id = (await json(created)).webhook.id
    for (const who of [bob, admin]) {
      for (const target of [id, "wh_0000000000000000"]) {
        for (const method of ["GET", "DELETE"]) {
          const res = await as(who, `/api/agent/webhooks/${target}`, { method })
          expect({ method, target, status: res.status }).toEqual({ method, target, status: 404 })
          expect((await json(res)).error.code).toBe("not_found")
        }
      }
      expect((await json(await as(who, "/api/agent/webhooks"))).webhooks).toEqual([])
    }
    expect((await json(await as(alice, "/api/agent/webhooks"))).webhooks.map((w: any) => w.id)).toEqual([id])
  })
})
