// Phase 3 (agent actions and grants) end to end: one in-process hub (hub.json agents.never set), a real OpenCode
// spoke announcing deliver, actTokens, hubPrompt and permissionMessage, a raw spoke without any of them, the
// `hub` CLI (as a session's shell token, as app tokens with scope sessions:act, as the user's device token) and
// the OpenCode `hub` tool's code path (runHubTool, with the session's act token the hub pushed).
//
// - Spoke 1: the real Spoke class (fake host: replyPermission, interrupt and synthetic are recorded) on
//   "laptop-a" with three sessions in /work/hub: LEAD ("Lead agent", @lead-agent, claims @@orchestrator),
//   WORKER ("Worker bee") and PEER ("Peer review").
// - Spoke 2: a raw protocol client on "laptop-b" (a hooks harness serving only the core op permission) with GAMMA in /work/hub.
// - The user grants @@orchestrator approve/deny/answer/prompt/stop in /work/hub, shell `bun test*` allowed and
//   `rm -rf*` never; the hub never lets an agent approve `git push*`. An app token holds a grant of its own.
// - Permission requests are permission.asked events from the fake host; like OpenCode it answers each once and
//   announces the reply (permission.replied), which is how the hub learns a request is no longer pending.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../packages/cli/src/cli"
import { centralConfig } from "../src/central/config"
import { defaults, writeConfig } from "../src/config"
import { runHubTool } from "../src/spoke/hub-tool"
import { Spoke, type SpokeHost } from "../src/spoke/spoke"
import { harness, PUBLIC, session, spoke as rawSpoke, waitFor, type FakeSpoke, type Harness } from "./central-harness"
import { EventQueue } from "./spoke-fake"

const USER = "local"
const LEAD = "ses_lead03"
const WORKER = "ses_worker03"
const PEER = "ses_peer03"
const GAMMA = "ses_gamma03"
const PROJECT = "/work/hub"
const TITLES: Record<string, string> = { [LEAD]: "Lead agent", [WORKER]: "Worker bee", [PEER]: "Peer review" }

type Ev = { type: string; data: Record<string, unknown> }
interface Reply {
  sessionID: string
  requestID: string
  decision: string
  message?: string
}
interface Admitted {
  sessionID: string
  id: string
  text: string
  metadata: Record<string, unknown>
}
interface Result {
  code: number
  stdout: string
  stderr: string
}

let h: Harness
let tmp: string
let spokeA: Spoke
let events: EventQueue<Ev>
let rawB: FakeSpoke & { token: string }
/** Requests the hub sent the raw spoke. */
const rawRequests: any[] = []
const replies: Reply[] = []
/** Permission requests pending in the fake OpenCode. */
const pending = new Set<string>()
const interrupts: string[] = []
const admitted: Admitted[] = []
const shell: Record<string, { token: string; url: string }> = {}
let leadGrant = ""
/** The CLI as the user (device token), and as the app token with scope sessions:act. */
let user: { env: Record<string, string>; home: string }
let app: { env: Record<string, string>; home: string; tokenID: string; grant: string }

function host(queue: EventQueue<Ev>): SpokeHost {
  return {
    directory: PROJECT,
    opencodeVersion: "2.1.4",
    events: (signal) => queue.iterate(signal),
    prompt: async () => ({ id: "msg_1" }),
    synthetic: async (input) => {
      admitted.push({ sessionID: input.sessionID, id: input.id, text: input.text, metadata: input.metadata })
      return { id: input.id }
    },
    context: async () => [],
    getSession: async (id) => ({ id, title: TITLES[id] ?? id, location: { directory: PROJECT }, time: { updated: 1 } }),
    // As OpenCode: a request answers once (then "gone"), and its reply is announced as permission.replied.
    replyPermission: async (input) => {
      if (!pending.delete(input.requestID)) return "gone"
      queue.push({ type: "permission.replied", data: { sessionID: input.sessionID, requestID: input.requestID } })
      replies.push({ sessionID: input.sessionID, requestID: input.requestID, decision: input.decision, ...(input.message !== undefined ? { message: input.message } : {}) })
      return "replied"
    },
    interrupt: async (sessionID) => void interrupts.push(sessionID),
    switchAgent: async () => undefined,
    switchModel: async () => undefined,
    hasAgent: async () => true,
    defaultAgent: async () => "build",
  }
}

async function cli(argv: string[], who: { env: Record<string, string>; home: string }): Promise<Result> {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, { env: who.env, home: who.home, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}
const json = (r: Result) => JSON.parse(r.stdout)
const body = async (r: Response) => (await r.json()) as any
const dir = (name: string) => mkdtempSync(path.join(tmp, `${name}-`))
/** The CLI as a session: its shells' HUB_URL + HUB_SESSION_TOKEN (the shell token, which never acts). */
const asSession = (sessionID: string) => ({ env: { HUB_URL: shell[sessionID]!.url, HUB_SESSION_TOKEN: shell[sessionID]!.token }, home: dir(`home-${sessionID}`) })
/** The OpenCode `hub` tool as a session (its act verbs send the session's act token). */
const tool = (sessionID: string, input: Record<string, unknown>) => runHubTool(() => spokeA, input, { sessionID })

let seq = 0
/** A permission request OpenCode asks in a session of the real spoke; waits until the hub has it. */
async function ask(sessionID: string, resource: string, action = "shell"): Promise<string> {
  const id = `per_e2e${++seq}`
  pending.add(id)
  events.push({ type: "permission.asked", data: { sessionID, id, action, resources: [resource] } })
  await waitFor(() => h.registry.permissionTargets(sessionID, id).length === 1, 5000)
  return id
}
const repliesTo = (requestID: string) => replies.filter((r) => r.requestID === requestID)

async function login(token: string, name: string) {
  const home = dir(name)
  const who = { env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, home }
  expect((await cli(["login", "--url", h.url, "--token", token], who)).code).toBe(0)
  return who
}

async function appToken(label: string) {
  const created = await h.api("/api/agent/app-tokens", { method: "POST", json: { label, scopes: ["sessions:act"] } })
  expect(created.status).toBe(201)
  const { id, token } = await body(created)
  return { id: id as string, ...(await login(token, label.replaceAll(" ", "-"))) }
}

const audit = async () => (await body(await h.api("/api/agent/audit?limit=500"))).entries as any[]

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "hub-e2e-p3-"))
  const config = {
    ...centralConfig({ HUB_PORT: "0", HUB_PUBLIC_URL: PUBLIC, HUB_STATE_DIR: mkdtempSync(path.join(tmpdir(), "voice-state-")) }),
    agentsNever: ["shell:git push*"],
  }
  h = await harness({ config })
  const a = await h.store.addMachine("laptop-a")
  const b = await h.store.addMachine("laptop-b")

  const configFile = path.join(tmp, "spoke-a.json")
  writeConfig(configFile, { ...defaults("laptop-a"), server: h.url, mode: "always", token: a.token, autoStartLocalHub: false, herdr: false })
  events = new EventQueue<Ev>()
  spokeA = new Spoke(host(events), {
    configFile,
    machineName: "laptop-a",
    kind: "standalone",
    processID: "proc_a3",
    pid: 4201,
    pluginVersion: "9.9.9",
    snapshotDebounceMs: 10,
    snapshotIntervalMs: 60_000,
    seedDebounceMs: 10,
    pollMs: 20,
    backoff: { minMs: 10, maxMs: 50 },
  })
  spokeA.start()
  await waitFor(() => spokeA.status().connection === "connected", 5000)
  for (const id of [LEAD, WORKER, PEER]) events.push({ type: "session.created", data: { sessionID: id, title: TITLES[id]!, location: { directory: PROJECT }, slug: id } })

  rawB = await rawSpoke(h, { machine: b, processID: "proc_b3", hello: { harness: "fake", harnessVersion: "0.1.0", evidence: "hooks", features: ["permission"], directory: PROJECT } })
  rawB.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    rawRequests.push(frame.req)
    rawB.send({ t: "res", id: frame.id, ok: true, result: {} })
  })
  rawB.send({ t: "sessions", sessions: [session(GAMMA, { title: "Gamma hooks", directory: PROJECT })] })
  await waitFor(() => [LEAD, WORKER, PEER, GAMMA].every((id) => h.registry.hasSession(id)), 5000)
  await waitFor(() => [LEAD, WORKER, PEER].every((id) => spokeA.shellIdentity(id) !== undefined && spokeA.actIdentity(id) !== undefined), 5000)
  for (const id of [LEAD, WORKER, PEER]) {
    const identity = spokeA.shellIdentity(id)!
    shell[id] = { token: identity.token, url: identity.url! }
  }
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) >= 3, 5000)

  // The user's device token for the CLI (a device link, redeemed).
  const { code } = await body(await h.api("/api/devices/link", { method: "POST", json: {} }))
  const { token } = await body(await h.api("/api/devices/redeem", { method: "POST", json: { code }, cookie: null, origin: null }))
  user = await login(token, "user-home")

  // A reserved role: a session cannot claim it; the user assigns it to LEAD. The user's grant follows the role.
  expect((await cli(["role", "claim", "orchestrator"], asSession(LEAD))).code).toBe(5)
  expect((await cli(["role", "claim", "orchestrator", "--session", LEAD], user)).code).toBe(0)
  const created = await cli(
    ["grant", "create", "--holder", "@@orchestrator", "--project", PROJECT, "--allow", "approve,deny,answer,prompt,stop", "--permit", "shell:bun test*", "--never", "shell:rm -rf*", "--json"],
    user,
  )
  expect(created.code).toBe(0)
  leadGrant = json(created).grant.id

  // An app token with scope sessions:act and a grant of its own (shell `bun test*`, approve and deny).
  const token2 = await appToken("e2e actor")
  const appGrant = await cli(["grant", "create", "--holder", `app:${token2.id}`, "--project", PROJECT, "--allow", "approve,deny", "--permit", "shell:bun test*", "--json"], user)
  expect(appGrant.code).toBe(0)
  app = { env: token2.env, home: token2.home, tokenID: token2.id, grant: json(appGrant).grant.id }
})

afterAll(async () => {
  spokeA?.stop()
  rawB?.close()
  await h?.stop()
  rmSync(tmp, { recursive: true, force: true })
})

describe("setup", () => {
  test("the real spoke announces deliver, actTokens, hubPrompt and permissionMessage; the raw spoke none", () => {
    const supports = (sessionID: string, feature: string) => h.registry.sessionTargets(sessionID).some((c) => h.registry.supports(c, feature as any))
    for (const feature of ["deliver", "actTokens", "hubPrompt", "permissionMessage"]) {
      expect({ feature, real: supports(WORKER, feature), raw: supports(GAMMA, feature) }).toEqual({ feature, real: true, raw: false })
    }
  })

  test("the grant lists for the user with its holder, patterns and state", async () => {
    const shown = json(await cli(["grant", "show", leadGrant, "--json"], user)).grant
    expect(shown).toMatchObject({ holder: "@@orchestrator", state: "active", allow: ["approve", "deny", "answer", "prompt", "stop"], permissions: { allow: ["shell:bun test*"], never: ["shell:rm -rf*"] } })
    expect(shown.owner).toBeUndefined()
  })

  test("only the user manages grants: the session's credential and the app token are refused (exit 5)", async () => {
    for (const who of [asSession(LEAD), app]) {
      const r = await cli(["grant", "create", "--holder", "@@orchestrator", "--project", PROJECT, "--allow", "stop", "--json"], who)
      expect(r.code).toBe(5)
    }
  })
})

describe("acting inside the grant", () => {
  test("the holder session approves through the hub tool (act token): the spoke gets the permission once", async () => {
    const id = await ask(WORKER, "bun test")
    const result = await tool(LEAD, { verb: "approve", session: WORKER, id, why: "only the test suite" })
    expect(result.content).toBe(`Approved ${id} in ${WORKER} (once) under grant ${leadGrant}.`)
    expect(result.metadata).toMatchObject({ verb: "approve", requestID: id, grant: leadGrant })
    await waitFor(() => repliesTo(id).length === 1, 5000)
    expect(repliesTo(id)).toEqual([{ sessionID: WORKER, requestID: id, decision: "once" }])
    // Approving again: the request is no longer pending (not_found); still one reply.
    const again = await tool(LEAD, { verb: "approve", session: WORKER, id })
    expect(again.metadata).toMatchObject({ error: "not_found" })
    await Bun.sleep(50)
    expect(repliesTo(id)).toHaveLength(1)
    // The tool output never carries a token.
    expect(JSON.stringify([result, again])).not.toContain(spokeA.actIdentity(LEAD)!.token)
  })

  test("the app token (scope sessions:act) approves through the CLI under its own grant", async () => {
    const id = await ask(WORKER, "bun test --coverage")
    const r = await cli(["approve", WORKER, id, "--json"], app)
    expect(r.code).toBe(0)
    expect(json(r)).toEqual({ sessionID: WORKER, requestID: id, decision: "once", grant: app.grant })
    await waitFor(() => repliesTo(id).length === 1, 5000)
  })

  test("a session's shell token never acts: 403 forbidden (exit 5), nothing reaches the spoke", async () => {
    const id = await ask(WORKER, "bun test")
    const r = await cli(["approve", WORKER, id, "--json"], asSession(LEAD))
    expect(r.code).toBe(5)
    expect(json(r).error.code).toBe("forbidden")
    const raw = await fetch(`${h.url}/api/agent/sessions/${WORKER}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${shell[LEAD]!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestID: id }),
    })
    expect(raw.status).toBe(403)
    expect((await raw.json()) as any).toMatchObject({ error: { code: "forbidden" } })
    await Bun.sleep(50)
    expect(repliesTo(id)).toEqual([])
    // Settle it for later tests.
    expect((await tool(LEAD, { verb: "approve", session: WORKER, id })).metadata).toMatchObject({ verb: "approve" })
  })

  test("a deny with a reason reaches the harness, prefixed with who denied it under which grant", async () => {
    const id = await ask(WORKER, "bun x something-odd")
    const denied = await tool(LEAD, { verb: "deny", session: WORKER, id, why: "only tests may run here" })
    expect(denied.content).toContain(`Denied ${id} in ${WORKER}`)
    await waitFor(() => repliesTo(id).length === 1, 5000)
    expect(repliesTo(id)[0]).toEqual({ sessionID: WORKER, requestID: id, decision: "reject", message: `Denied by @lead-agent (grant ${leadGrant}): only tests may run here` })
  })

  test("on the raw spoke (no permissionMessage) the deny goes through without the reason, and says so", async () => {
    rawB.send({ t: "event", event: { type: "permission.asked", data: { sessionID: GAMMA, id: "per_gamma1", action: "shell", resources: ["make"] } } })
    await waitFor(() => h.registry.permissionTargets(GAMMA, "per_gamma1").length === 1, 5000)
    const r = await cli(["deny", GAMMA, "per_gamma1", "--why", "not now", "--json"], app)
    expect(r.code).toBe(0)
    expect(json(r)).toMatchObject({ sessionID: GAMMA, requestID: "per_gamma1", reasonSent: false })
    expect(rawRequests.filter((q) => q.op === "permission")).toEqual([{ op: "permission", sessionID: GAMMA, requestID: "per_gamma1", decision: "reject" }])
  })
})

describe("refused before the spoke", () => {
  test("a grant's never pattern: forbidden, even though the action is in the grant", async () => {
    const id = await ask(WORKER, "rm -rf dist")
    const result = await tool(LEAD, { verb: "approve", session: WORKER, id })
    expect(result.metadata).toMatchObject({ error: "forbidden" })
    expect(result.content).toContain("rm -rf*")
    await Bun.sleep(50)
    expect(repliesTo(id)).toEqual([])
  })

  test("hub.json agents.never: forbidden for every grant (also behind a wrapper like sudo)", async () => {
    for (const resource of ["git push origin main", "sudo git push --force"]) {
      const id = await ask(WORKER, resource)
      const r = await cli(["approve", WORKER, id, "--json"], app)
      expect({ resource, code: r.code }).toEqual({ resource, code: 5 })
      expect(json(r).error).toMatchObject({ code: "forbidden" })
      expect(json(r).error.message).toContain("hub's rule shell:git push*")
      expect(repliesTo(id)).toEqual([])
    }
  })

  test("a session never answers requests in its own session tree (forbidden)", async () => {
    const id = await ask(LEAD, "bun test")
    const result = await tool(LEAD, { verb: "approve", session: LEAD, id })
    expect(result.metadata).toMatchObject({ error: "forbidden" })
    expect(result.content).toContain("own session tree")
    await Bun.sleep(50)
    expect(repliesTo(id)).toEqual([])
  })
})

describe("outside the grant: the user decides", () => {
  test("needs_user opens a tap Decision; the console's answer (cookie) approves it through the spoke as the user", async () => {
    const id = await ask(WORKER, "curl https://example.com")
    const result = await tool(LEAD, { verb: "approve", session: WORKER, id, why: "fetches the fixture" })
    expect(result.content).toContain("outside your grant, so the user decides")
    expect(result.metadata).toMatchObject({ error: "needs_user", evaluation: { verdict: "outside", tier: "tap" } })
    const decisionID = (result.metadata as any).decisionID as string
    expect(decisionID).toMatch(/^dec_/)
    const { decision } = await body(await h.api(`/api/decisions/${decisionID}`))
    expect(decision).toMatchObject({ state: "open", tier: "tap", from: { kind: "session", sessionID: LEAD }, recommendation: { option: "approve", why: "fetches the fixture" } })
    expect(decision.question).toContain("curl https://example.com")
    expect(repliesTo(id)).toEqual([])
    const answered = await h.api(`/api/decisions/${decisionID}/answer`, { method: "POST", json: { option: "approve" } })
    expect(answered.status).toBe(200)
    await waitFor(() => repliesTo(id).length === 1, 5000)
    expect(repliesTo(id)).toEqual([{ sessionID: WORKER, requestID: id, decision: "once" }])
    const entry = (await audit()).find((e) => e.target.requestID === id && e.actor.kind === "user")
    expect(entry).toMatchObject({ verb: "approve", decision: "allow", outcome: "ok", reason: `Decision ${decisionID}` })
  })

  test("the user answering the request first: the Decision closes and the agent then gets not_found", async () => {
    const id = await ask(WORKER, "make deploy")
    const r = await cli(["approve", WORKER, id, "--json"], app)
    expect(r.code).toBe(4)
    const decisionID = json(r).error.decisionID as string
    expect(decisionID).toMatch(/^dec_/)
    // The user approves on the session page (not through the Decision).
    expect((await h.api(`/api/sessions/${WORKER}/permission`, { method: "POST", json: { requestID: id, decision: "once" } })).status).toBeLessThan(300)
    await waitFor(() => repliesTo(id).length === 1, 5000)
    let state = "open"
    for (let i = 0; i < 200 && state !== "closed"; i++) {
      await Bun.sleep(10)
      state = (await body(await h.api(`/api/decisions/${decisionID}`))).decision.state
    }
    expect(state).toBe("closed")
    const late = await cli(["approve", WORKER, id, "--json"], app)
    expect(late.code).toBe(3)
    expect(json(late).error.code).toBe("not_found")
    expect((await h.api(`/api/decisions/${decisionID}/answer`, { method: "POST", json: { option: "approve" } })).status).toBe(409)
    expect(repliesTo(id)).toHaveLength(1)
  })
})

describe("prompts", () => {
  test("an agent's prompt arrives in the provenance envelope (never as the user's) and keeps the hop chain", async () => {
    const depth = () => h.delivery.hops.depth(USER, { kind: "session", sessionID: WORKER })
    // PEER messages WORKER first: WORKER's chain is one hop deep.
    expect((await cli(["msg", WORKER, "ping from peer", "--no-wake"], asSession(PEER))).code).toBe(0)
    expect(await depth()).toBe(1)
    const seen = admitted.filter((a) => a.sessionID === WORKER).length
    const result = await tool(LEAD, { verb: "prompt", session: WORKER, text: "please run the tests", delivery: "queue" })
    expect(result.content).toMatch(new RegExp(`^Prompted ${WORKER}: msg_\\w+ \\(\\w+\\)`))
    const messageID = (result.metadata as any).id as string
    await waitFor(() => admitted.filter((a) => a.sessionID === WORKER).length > seen, 5000)
    const got = admitted.filter((a) => a.sessionID === WORKER)[seen]!
    expect(got.id).toBe(messageID)
    expect(got.text).toBe(`[hub] prompt from @lead-agent · grant ${leadGrant} · ${messageID}\n----- ${messageID} -----\nplease run the tests\n----- ${messageID} -----`)
    expect(got.metadata).toMatchObject({ source: "hub", kind: "prompt" })
    // Not a human turn: the chain is not reset.
    expect(await depth()).toBe(1)
  })

  test("a prompt to the raw spoke (no hubPrompt) is unsupported (exit 7)", async () => {
    const token = await appToken("prompter")
    expect((await cli(["grant", "create", "--holder", `app:${token.id}`, "--project", PROJECT, "--allow", "prompt"], user)).code).toBe(0)
    const r = await cli(["prompt", GAMMA, "hello", "--json"], token)
    expect(r.code).toBe(7)
    expect(json(r).error).toMatchObject({ code: "unsupported", feature: "deliver" })
    expect(rawRequests.filter((q) => q.op === "deliver")).toEqual([])
  })
})

describe("kill switches and the hourly cap", () => {
  test("the user's switch, then the admin's: acting is paused (423, exit 5) while reading and messaging work", async () => {
    for (const [route, label] of [
      ["/api/agent/acting", "user"],
      ["/api/admin/agents/acting", "admin"],
    ] as const) {
      expect((await h.api(route, { method: "PUT", json: { enabled: false } })).status).toBe(200)
      const id = await ask(WORKER, "bun test")
      const stopped = await tool(LEAD, { verb: "stop", session: WORKER })
      expect({ label, error: (stopped.metadata as any).error }).toEqual({ label, error: "paused" })
      const r = await cli(["approve", WORKER, id, "--json"], app)
      expect({ label, code: r.code, error: json(r).error.code }).toEqual({ label, code: 5, error: "paused" })
      const raw = await fetch(`${h.url}/api/agent/sessions/${WORKER}/stop`, { method: "POST", headers: { authorization: `Bearer ${spokeA.actIdentity(LEAD)!.token}` } })
      expect(raw.status).toBe(423)
      // Reading and messaging keep working.
      const lead = asSession(LEAD)
      expect((await cli(["show", WORKER], lead)).code).toBe(0)
      expect((await cli(["inbox"], lead)).code).toBe(0)
      expect((await cli(["msg", WORKER, `still here (${label} paused)`, "--no-wake"], lead)).code).toBe(0)
      expect(repliesTo(id)).toEqual([])
      expect(interrupts).toEqual([])
      expect((await h.api(route, { method: "PUT", json: { enabled: true } })).status).toBe(200)
      // Resumed: the same request goes through.
      expect((await cli(["approve", WORKER, id], app)).code).toBe(0)
    }
  })

  test("the grant's maxActionsPerHour: past it, rate_limited (exit 6)", async () => {
    const token = await appToken("capped")
    const grant = await cli(["grant", "create", "--holder", `app:${token.id}`, "--project", PROJECT, "--allow", "stop", "--max-per-hour", "1", "--json"], user)
    expect(grant.code).toBe(0)
    const first = await cli(["stop", WORKER, "--why", "runaway loop"], token)
    expect(first.code).toBe(0)
    await waitFor(() => interrupts.includes(WORKER), 5000)
    const second = await cli(["stop", WORKER, "--json"], token)
    expect(second.code).toBe(6)
    expect(json(second).error.code).toBe("rate_limited")
    expect(interrupts.filter((s) => s === WORKER)).toHaveLength(1)
  })
})

describe("grant requests", () => {
  test("a session requests a grant; the user's approval in the console creates it, and the session is told", async () => {
    const r = await cli(["grant", "request", "--project", PROJECT, "--allow", "stop", "--why", "I keep needing to stop runaway workers", "--json"], asSession(WORKER))
    expect(r.code).toBe(0)
    const decisionID = json(r).decision.id as string
    const { decision } = await body(await h.api(`/api/decisions/${decisionID}`))
    expect(decision).toMatchObject({ state: "open", tier: "tap", from: { kind: "session", sessionID: WORKER } })
    expect(decision.question).toContain("I keep needing to stop runaway workers")
    const seen = admitted.filter((a) => a.sessionID === WORKER).length
    expect((await h.api(`/api/decisions/${decisionID}/answer`, { method: "POST", json: { option: "approve" } })).status).toBe(200)
    const grants = json(await cli(["grant", "list", "--json"], user)).grants as any[]
    const created = grants.find((g) => g.holder === WORKER)
    expect(created).toMatchObject({ state: "active", allow: ["stop"], scope: { projects: [PROJECT] } })
    await waitFor(() => admitted.filter((a) => a.sessionID === WORKER).length > seen, 5000)
    expect(admitted.filter((a) => a.sessionID === WORKER).slice(seen).some((a) => a.text.includes(created.id))).toBe(true)
  })
})

describe("audit", () => {
  test("the user's agent audit lists every decision and outcome, newest first", async () => {
    const entries = await audit()
    for (let i = 1; i < entries.length; i++) expect(entries[i - 1].seq).toBeGreaterThan(entries[i].seq)
    const decisions = new Set(entries.map((e) => e.decision))
    for (const d of ["allow", "needs_user", "forbidden", "paused", "rate_limited"]) expect(decisions).toContain(d)
    const outcomes = new Set(entries.map((e) => e.outcome))
    for (const o of ["ok", "escalated", "refused"]) expect(outcomes).toContain(o)
    expect(entries.map((e) => e.verb)).toEqual(expect.arrayContaining(["approve", "deny", "prompt", "stop", "acting.pause", "acting.resume", "grant.request"]))
    expect(entries.find((e) => e.verb === "approve" && e.grant === leadGrant && e.outcome === "ok")).toMatchObject({ actor: { kind: "session", sessionID: LEAD }, target: { sessionID: WORKER } })
  })

  test("admins see only summaries: who, agent.<verb>, the actor kind; never targets, reasons or grants", async () => {
    const admin = (await body(await h.api("/api/admin/audit"))) as any[]
    const agent = admin.filter((e) => String(e.action).startsWith("agent."))
    expect(agent.length).toBeGreaterThan(5)
    for (const e of agent) {
      expect(Object.keys(e).sort()).toEqual(["action", "actor", "at", "detail"])
      expect(["session", "app", "user"]).toContain(e.detail)
    }
    const text = JSON.stringify(agent)
    for (const secret of [WORKER, LEAD, "bun test", "only tests may run here", "fetches the fixture", leadGrant]) expect(text).not.toContain(secret)
  })
})
