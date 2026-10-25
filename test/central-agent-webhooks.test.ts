// Webhooks (P4-T10, design §6.1, §12.2; decision znbg8xa5 #8): registrations per user and per app token (url,
// events, a secret shown once), a durable outbox in the StateStore (deduplicated by event, retried with backoff,
// one sender per delivery under a lease), signed POSTs (Hub-Signature t=…,v1=…, Hub-Event, Hub-Delivery), and URL
// checks (SSRF) at registration and again at every send. Receivers here are local Bun.serve servers, reachable
// only with the admin opt-in allowPrivate.
import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { parseWebhookSignature, webhookSignedPayload, webhookTimestampFresh } from "../packages/protocol/src/webhook"
import type { Launch } from "../src/central/agent/launch-store"
import { launchEvent, WEBHOOK_OUTBOX, Webhooks, type WebhookEvent, type WebhooksDeps } from "../src/central/agent/webhooks"
import { MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import { AgentError } from "../src/central/agent/errors"

const T0 = 1_700_000_000_000
const U = "u1"
const SOURCE = "https://hub.example"

interface Received {
  readonly headers: Headers
  readonly body: string
  readonly path: string
}

let servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  for (const server of servers) server.stop(true)
  servers = []
})

/** A local receiver; `reply` picks each response (default 200). */
function receiver(reply: (n: number, request: Request) => Response | Promise<Response> = () => new Response("ok")) {
  const received: Received[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text()
      received.push({ headers: request.headers, body, path: new URL(request.url).pathname })
      return reply(received.length, request)
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}/hook`, base: `http://127.0.0.1:${server.port}`, received }
}

function setup(extra: Partial<WebhooksDeps> = {}) {
  let t = T0
  const now = () => t
  const state = extra.state ?? new MemoryStateStore({ now })
  const locks = extra.locks ?? new MemoryLocks({ now })
  const webhooks = new Webhooks({
    state,
    locks,
    now,
    source: SOURCE,
    users: () => [U, "u2"],
    resolve: async () => ["93.184.215.14"],
    allowPrivate: true,
    backoffMs: [1000, 5000],
    timeoutMs: 2000,
    ...extra,
  })
  return { webhooks, state, locks, now, advance: (ms: number) => (t += ms) }
}

const event = (id: string, type = "launch.queued", data: unknown = { launch: { id: "l1" } }): WebhookEvent => ({
  id,
  type,
  source: SOURCE,
  subject: "l1",
  time: new Date(T0).toISOString(),
  user: U,
  schemaVersion: 1,
  data,
})

const sign = (secret: string, t: number, body: string) => createHmac("sha256", secret).update(webhookSignedPayload(t, body)).digest("hex")

describe("registrations", () => {
  test("register returns the secret once; list and get never show it", async () => {
    const { webhooks } = setup()
    const { webhook, secret } = await webhooks.register(U, "user", { url: "https://hooks.example.com/x", label: " ci " })
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    expect(webhook).toEqual({ id: expect.stringMatching(/^wh_[0-9a-f]{16}$/), url: "https://hooks.example.com/x", events: ["launch.*"], by: "user", label: "ci", created: T0 })
    expect(await webhooks.list(U)).toEqual([webhook])
    expect(await webhooks.get(U, webhook.id)).toEqual(webhook)
    expect(JSON.stringify(await webhooks.list(U))).not.toContain(secret)
  })

  test("invalid url, events or label are rejected as invalid", async () => {
    const { webhooks } = setup({ allowPrivate: false })
    const bad = async (input: Record<string, unknown>) => {
      const result = await webhooks.register(U, "user", input as never).then(
        () => undefined,
        (cause) => cause,
      )
      expect({ input, code: result instanceof AgentError ? result.code : result }).toEqual({ input, code: "invalid" })
    }
    await bad({ url: "http://hooks.example.com/x" })
    await bad({ url: "https://127.0.0.1/x" })
    await bad({ url: "https://localhost/x" })
    await bad({ url: 3 })
    await bad({ url: `https://hooks.example.com/${"x".repeat(2100)}` })
    await bad({ url: "https://hooks.example.com/x", events: [] })
    await bad({ url: "https://hooks.example.com/x", events: ["decision.opened"] })
    await bad({ url: "https://hooks.example.com/x", events: ["launch.nope"] })
    await bad({ url: "https://hooks.example.com/x", events: "launch.*" })
    await bad({ url: "https://hooks.example.com/x", label: "x".repeat(101) })
    expect(await webhooks.list(U)).toEqual([])
  })

  test("events: exact launch types or launch.*, duplicates dropped", async () => {
    const { webhooks } = setup()
    const { webhook } = await webhooks.register(U, "user", { url: "https://hooks.example.com/x", events: ["launch.ended", "launch.running", "launch.ended"] })
    expect(webhook.events).toEqual(["launch.ended", "launch.running"])
  })

  test("users see all their registrations, an app token only its own; other users' are not found", async () => {
    const { webhooks } = setup()
    const mine = (await webhooks.register(U, "user", { url: "https://hooks.example.com/u" })).webhook
    const app = (await webhooks.register(U, "app:aaaaaaaaaaaaaaaa", { url: "https://hooks.example.com/a" })).webhook
    expect((await webhooks.list(U)).map((w) => w.id)).toEqual([mine.id, app.id].sort())
    expect((await webhooks.list(U, "app:aaaaaaaaaaaaaaaa")).map((w) => w.id)).toEqual([app.id])
    expect(await webhooks.get(U, mine.id, "app:aaaaaaaaaaaaaaaa")).toBeUndefined()
    expect(await webhooks.get("u2", mine.id)).toBeUndefined()
    expect(await webhooks.remove("u2", mine.id)).toBe(false)
    expect(await webhooks.remove(U, mine.id, "app:aaaaaaaaaaaaaaaa")).toBe(false)
    expect(await webhooks.remove(U, app.id, "app:aaaaaaaaaaaaaaaa")).toBe(true)
    expect(await webhooks.remove(U, mine.id)).toBe(true)
    expect(await webhooks.list(U)).toEqual([])
  })

  test("at most maxWebhooks per user", async () => {
    const { webhooks } = setup({ maxWebhooks: 2 })
    await webhooks.register(U, "user", { url: "https://hooks.example.com/1" })
    await webhooks.register(U, "user", { url: "https://hooks.example.com/2" })
    await expect(webhooks.register(U, "user", { url: "https://hooks.example.com/3" })).rejects.toMatchObject({ code: "rate_limited" })
  })
})

describe("delivery", () => {
  test("a published event is POSTed signed, with Hub-Event and Hub-Delivery; the delivery is recorded", async () => {
    const hook = receiver()
    const { webhooks } = setup()
    const { webhook, secret } = await webhooks.register(U, "user", { url: hook.url })
    expect(await webhooks.publish(U, event("evt_1"))).toBe(1)
    await webhooks.drain()
    expect(hook.received).toHaveLength(1)
    const got = hook.received[0]!
    expect(JSON.parse(got.body)).toEqual(event("evt_1"))
    expect(got.headers.get("content-type")).toBe("application/json")
    expect(got.headers.get("hub-event")).toBe("launch.queued")
    const delivery = got.headers.get("hub-delivery")!
    expect(delivery).toMatch(/^whd_[0-9a-f]{24}$/)
    const signature = parseWebhookSignature(got.headers.get("hub-signature"))!
    expect(signature.t).toBe(T0 / 1000)
    expect(webhookTimestampFresh(signature.t, T0)).toBe(true)
    expect(signature.v1).toEqual([sign(secret, signature.t, got.body)])
    expect(await webhooks.deliveries(U, webhook.id)).toEqual([
      { id: delivery, event: "evt_1", type: "launch.queued", state: "delivered", attempts: 1, created: T0, last: { at: T0, status: 200 } },
    ])
  })

  test("the same event published twice is delivered once (dedupe by event id)", async () => {
    const hook = receiver()
    const { webhooks } = setup()
    await webhooks.register(U, "user", { url: hook.url })
    expect(await webhooks.publish(U, event("evt_1"))).toBe(1)
    expect(await webhooks.publish(U, event("evt_1"))).toBe(0)
    await webhooks.drain()
    await webhooks.drain()
    expect(hook.received).toHaveLength(1)
  })

  test("only registrations whose events match get the event; other users' never do", async () => {
    const ended = receiver()
    const all = receiver()
    const other = receiver()
    const { webhooks } = setup()
    await webhooks.register(U, "user", { url: ended.url, events: ["launch.ended"] })
    await webhooks.register(U, "user", { url: all.url })
    await webhooks.register("u2", "user", { url: other.url })
    await webhooks.publish(U, event("evt_1", "launch.queued"))
    await webhooks.publish(U, event("evt_2", "launch.ended"))
    await webhooks.drain()
    expect(ended.received.map((r) => JSON.parse(r.body).id)).toEqual(["evt_2"])
    expect(all.received.map((r) => JSON.parse(r.body).id).sort()).toEqual(["evt_1", "evt_2"])
    expect(other.received).toEqual([])
  })

  test("an app registration gets only the events of what that app started; a revoked app token's registration is dropped", async () => {
    const hook = receiver()
    let alive = true
    const { webhooks } = setup({ appAlive: () => alive })
    await webhooks.register(U, "app:aaaaaaaaaaaaaaaa", { url: hook.url })
    expect(await webhooks.publish(U, event("evt_user"), { by: "user" })).toBe(0)
    expect(await webhooks.publish(U, event("evt_other"), { by: "app:bbbbbbbbbbbbbbbb" })).toBe(0)
    expect(await webhooks.publish(U, event("evt_mine"), { by: "app:aaaaaaaaaaaaaaaa" })).toBe(1)
    alive = false
    await webhooks.drain()
    expect(hook.received).toEqual([])
    expect(await webhooks.list(U)).toEqual([])
  })

  test("failures retry with backoff under the same Hub-Delivery; after the last attempt the delivery fails", async () => {
    const hook = receiver(() => new Response("down", { status: 503 }))
    const { webhooks, advance } = setup({ backoffMs: [1000, 5000] })
    const { webhook } = await webhooks.register(U, "user", { url: hook.url })
    await webhooks.publish(U, event("evt_1"))
    await webhooks.drain()
    expect(hook.received).toHaveLength(1)
    expect((await webhooks.deliveries(U, webhook.id))[0]).toMatchObject({ state: "pending", attempts: 1, nextAt: T0 + 1000, last: { status: 503, at: T0 } })
    advance(999)
    await webhooks.drain()
    expect(hook.received).toHaveLength(1)
    advance(1)
    await webhooks.drain()
    expect(hook.received).toHaveLength(2)
    expect((await webhooks.deliveries(U, webhook.id))[0]).toMatchObject({ state: "pending", attempts: 2, nextAt: T0 + 6000 })
    advance(5000)
    await webhooks.drain()
    expect(hook.received).toHaveLength(3)
    expect((await webhooks.deliveries(U, webhook.id))[0]).toMatchObject({ state: "failed", attempts: 3, last: { status: 503 } })
    advance(60_000)
    await webhooks.drain()
    expect(hook.received).toHaveLength(3)
    const ids = new Set(hook.received.map((r) => r.headers.get("hub-delivery")))
    expect(ids.size).toBe(1)
  })

  test("a retry that succeeds is delivered", async () => {
    const hook = receiver((n) => new Response("", { status: n === 1 ? 500 : 204 }))
    const { webhooks, advance } = setup({ backoffMs: [1000] })
    const { webhook } = await webhooks.register(U, "user", { url: hook.url })
    await webhooks.publish(U, event("evt_1"))
    await webhooks.drain()
    advance(1000)
    await webhooks.drain()
    expect((await webhooks.deliveries(U, webhook.id))[0]).toMatchObject({ state: "delivered", attempts: 2, last: { status: 204 } })
  })

  test("a redirect is not followed and counts as a failure", async () => {
    const hook = receiver((_, request) => (new URL(request.url).pathname === "/hook" ? Response.redirect("/elsewhere", 307) : new Response("ok")))
    const { webhooks } = setup()
    const { webhook } = await webhooks.register(U, "user", { url: hook.url })
    await webhooks.publish(U, event("evt_1"))
    await webhooks.drain()
    expect(hook.received.map((r) => r.path)).toEqual(["/hook"])
    expect((await webhooks.deliveries(U, webhook.id))[0]).toMatchObject({ state: "pending", last: { status: 307 } })
  })

  test("a timeout counts as a failure", async () => {
    const hook = receiver(async () => (await Bun.sleep(500), new Response("late")))
    const { webhooks } = setup({ timeoutMs: 50 })
    const { webhook } = await webhooks.register(U, "user", { url: hook.url })
    await webhooks.publish(U, event("evt_1"))
    await webhooks.drain()
    expect((await webhooks.deliveries(U, webhook.id))[0]).toMatchObject({ state: "pending", attempts: 1, last: { error: expect.stringMatching(/timed out/) } })
  })

  test("the URL is checked again at send time: a host that now resolves privately fails the delivery without a request", async () => {
    const table: Record<string, string[]> = { "hooks.example.com": ["93.184.215.14"] }
    const sent: string[] = []
    const fetch = (async (url: string) => (sent.push(String(url)), new Response("ok"))) as unknown as typeof globalThis.fetch
    const { webhooks } = setup({ allowPrivate: false, resolve: async (host) => table[host] ?? [], fetch })
    const { webhook } = await webhooks.register(U, "user", { url: "https://hooks.example.com/x" })
    table["hooks.example.com"] = ["169.254.169.254"]
    await webhooks.publish(U, event("evt_1"))
    await webhooks.drain()
    expect(sent).toEqual([])
    expect((await webhooks.deliveries(U, webhook.id))[0]).toMatchObject({ state: "failed", attempts: 1, last: { error: expect.stringMatching(/private or local/) } })
  })

  test("removing a registration drops its pending deliveries", async () => {
    const hook = receiver()
    const { webhooks, state } = setup()
    const { webhook } = await webhooks.register(U, "user", { url: hook.url })
    await webhooks.publish(U, event("evt_1"))
    expect(await state.list(U, WEBHOOK_OUTBOX)).toHaveLength(1)
    await webhooks.remove(U, webhook.id)
    expect(await state.list(U, WEBHOOK_OUTBOX)).toEqual([])
    await webhooks.drain()
    expect(hook.received).toEqual([])
  })

  test("finished deliveries are pruned after keepMs", async () => {
    const hook = receiver()
    const { webhooks, state, advance } = setup({ keepMs: 10_000 })
    await webhooks.register(U, "user", { url: hook.url })
    await webhooks.publish(U, event("evt_1"))
    await webhooks.drain()
    expect(await state.list(U, WEBHOOK_OUTBOX)).toHaveLength(1)
    advance(10_001)
    await webhooks.drain()
    expect(await state.list(U, WEBHOOK_OUTBOX)).toEqual([])
  })
})

describe("durability and single sender", () => {
  test("the outbox survives a restart: a new instance on the same state sends what is pending", async () => {
    const hook = receiver()
    const first = setup()
    await first.webhooks.register(U, "user", { url: hook.url })
    await first.webhooks.publish(U, event("evt_1"))
    const second = setup({ state: first.state, locks: first.locks })
    await second.webhooks.drain()
    expect(hook.received).toHaveLength(1)
  })

  test("two senders draining together send each delivery once (lease)", async () => {
    const hook = receiver(async () => (await Bun.sleep(30), new Response("ok")))
    const a = setup()
    const b = setup({ state: a.state, locks: a.locks })
    await a.webhooks.register(U, "user", { url: hook.url })
    await a.webhooks.publish(U, event("evt_1"))
    await a.webhooks.publish(U, event("evt_2"))
    await Promise.all([a.webhooks.drain(), b.webhooks.drain()])
    expect(hook.received.map((r) => JSON.parse(r.body).id).sort()).toEqual(["evt_1", "evt_2"])
  })
})

describe("launch events", () => {
  const launch = (extra: Partial<Launch> = {}): Launch => ({
    id: "l_1",
    owner: U,
    spec: { workspace: { repo: "/p/hub", mode: "worktree", branch: "b" }, labels: {}, end: { when: "idle" } } as unknown as Launch["spec"],
    by: "app:aaaaaaaaaaaaaaaa",
    state: "running",
    reason: "Session started",
    at: T0 + 5,
    created: T0,
    history: [],
    sessionID: "ses_1",
    ...extra,
  })

  test("launchEvent: type launch.<state>, a stable id per step, the launch as data", () => {
    const e = launchEvent(SOURCE, launch(), { id: "l_1", state: "running" })
    expect(e).toEqual({ id: expect.stringMatching(/^evt_[0-9a-f]{24}$/), type: "launch.running", source: SOURCE, subject: "l_1", time: new Date(T0 + 5).toISOString(), user: U, schemaVersion: 1, data: { launch: { id: "l_1", state: "running" } } })
    expect(launchEvent(SOURCE, launch(), {}).id).toBe(e.id)
    expect(launchEvent(SOURCE, launch({ state: "ended", outcome: "idle", at: T0 + 9 }), {}).id).not.toBe(e.id)
  })

  test("onLaunch publishes the launch change for the launcher's registrations", async () => {
    const hook = receiver()
    const { webhooks } = setup({ appAlive: () => true })
    await webhooks.register(U, "app:aaaaaaaaaaaaaaaa", { url: hook.url })
    await webhooks.onLaunch(U, launch(), { id: "l_1" })
    await webhooks.drain()
    expect(hook.received.map((r) => r.headers.get("hub-event"))).toEqual(["launch.running"])
  })
})
