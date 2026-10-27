// Webhooks wired into the hub (P4-T10): /api/agent/webhooks for users (all of theirs) and app tokens with
// sessions:launch (only their own); every launch change goes to matching webhooks, signed; private receivers
// (these tests' local Bun.serve) only with hub.json agents.webhooks.allowPrivate.
import { afterEach, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseWebhookSignature, webhookSignedPayload } from "../src/protocol"
import { centralConfig } from "../src/central/config"
import { harness, PUBLIC, waitFor, type Harness } from "./central-harness"

let h: Harness
let server: ReturnType<typeof Bun.serve> | undefined
afterEach(async () => {
  await h?.stop()
  server?.stop(true)
  server = undefined
})

const json = async (r: Response) => (await r.json()) as any
const launchBody = { key: "k1", workspace: { repo: "/p/hub", branch: "feat/x" }, prompt: "Go", labels: { app: "brain" } }

function receiver() {
  const received: Array<{ headers: Headers; body: string }> = []
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({ headers: request.headers, body: await request.text() })
      return new Response("ok")
    },
  })
  return { url: `http://127.0.0.1:${server.port}/hook`, received }
}

/** A hub whose hub.json sets agents.webhooks.allowPrivate. */
async function privateHub(allowPrivate = true): Promise<Harness> {
  const config = centralConfig(
    { HUB_PORT: "0", HUB_PUBLIC_URL: PUBLIC, HUB_STATE_DIR: mkdtempSync(path.join(tmpdir(), "voice-state-")) },
    "/home/none",
    allowPrivate ? { agents: { webhooks: { allowPrivate: true } } } : {},
  )
  return await harness({ config })
}

test("a user registers a webhook (secret once), and each launch change is POSTed to it, signed", async () => {
  h = await privateHub()
  const hook = receiver()
  const created = await h.api("/api/agent/webhooks", { method: "POST", json: { url: hook.url, events: ["launch.*"], label: "ci" } })
  expect(created.status).toBe(201)
  const { webhook, secret } = await json(created)
  expect(webhook).toMatchObject({ url: hook.url, events: ["launch.*"], by: "user", label: "ci" })
  expect(secret).toMatch(/^whsec_/)
  const listed = await json(await h.api("/api/agent/webhooks"))
  expect(listed.webhooks.map((w: any) => w.id)).toEqual([webhook.id])
  expect(JSON.stringify(listed)).not.toContain(secret)

  const { launch } = await json(await h.api("/api/agent/launches", { method: "POST", json: launchBody }))
  await waitFor(() => hook.received.length >= 1)
  const got = hook.received[0]!
  const evt = JSON.parse(got.body)
  expect(evt).toMatchObject({ type: "launch.changed", source: PUBLIC, subject: launch.id, schemaVersion: 1, data: { subject: { launchID: launch.id }, data: { state: "queued" } } })
  expect(got.headers.get("hub-event")).toBe("launch.changed")
  const sig = parseWebhookSignature(got.headers.get("hub-signature"))!
  expect(sig.v1).toEqual([createHmac("sha256", secret).update(webhookSignedPayload(sig.t, got.body)).digest("hex")])

  await h.api(`/api/agent/launches/${launch.id}`, { method: "DELETE" })
  await waitFor(() => hook.received.some((r) => JSON.parse(r.body).data?.data?.state === "ended"))
  const detail = await json(await h.api(`/api/agent/webhooks/${webhook.id}`))
  expect(detail.webhook.id).toBe(webhook.id)
  expect(detail.deliveries.map((d: any) => d.type)).toContain("launch.changed")

  expect((await h.api(`/api/agent/webhooks/${webhook.id}`, { method: "DELETE" })).status).toBe(204)
  expect((await h.api(`/api/agent/webhooks/${webhook.id}`)).status).toBe(404)
  expect((await h.api(`/api/agent/webhooks/${webhook.id}`, { method: "DELETE" })).status).toBe(404)
})

test("without allowPrivate a private or http URL is refused", async () => {
  h = await privateHub(false)
  const res = await h.api("/api/agent/webhooks", { method: "POST", json: { url: "http://127.0.0.1:9/hook" } })
  expect(res.status).toBe(400)
  expect((await json(res)).error.code).toBe("invalid")
  expect((await h.api("/api/agent/webhooks", { method: "POST", json: { url: "https://10.1.2.3/hook" } })).status).toBe(400)
})

test("app tokens need sessions:launch, manage only their own webhooks and get only their own launches' events", async () => {
  h = await privateHub()
  const hook = receiver()
  const readOnly = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["sessions:read"] } }))
  const token = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["events:subscribe", "sessions:launch"] } }))
  const as = (t: string) => (pathname: string, init: RequestInit & { json?: unknown } = {}) => h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${t}` } })
  const asApp = as(token.token)
  expect((await as(readOnly.token)("/api/agent/webhooks", { method: "POST", json: { url: hook.url } })).status).toBe(403)

  const mine = await h.api("/api/agent/webhooks", { method: "POST", json: { url: "http://127.0.0.1:9/user" } })
  const userHook = (await json(mine)).webhook
  const created = await asApp("/api/agent/webhooks", { method: "POST", json: { url: hook.url } })
  expect(created.status).toBe(201)
  const appHook = (await json(created)).webhook
  expect(appHook.by).toBe(`app:${token.id}`)
  expect((await json(await asApp("/api/agent/webhooks"))).webhooks.map((w: any) => w.id)).toEqual([appHook.id])
  expect((await json(await h.api("/api/agent/webhooks"))).webhooks.map((w: any) => w.id).sort()).toEqual([userHook.id, appHook.id].sort())
  expect((await asApp(`/api/agent/webhooks/${userHook.id}`)).status).toBe(404)
  expect((await asApp(`/api/agent/webhooks/${userHook.id}`, { method: "DELETE" })).status).toBe(404)

  // The user's own launch is not the app's: the app's webhook gets nothing.
  await h.api("/api/agent/launches", { method: "POST", json: launchBody })
  await h.api("/api/agent/grants", { method: "POST", json: { holder: `app:${token.id}`, scope: { projects: ["/p/hub"] }, allow: ["launch"] } })
  const { launch } = await json(await asApp("/api/agent/launches", { method: "POST", json: { ...launchBody, key: "k2" } }))
  await waitFor(() => hook.received.length >= 1)
  expect(hook.received.map((r) => JSON.parse(r.body).subject)).toEqual([launch.id])

  // A revoked token's webhooks stop.
  expect((await h.api(`/api/agent/app-tokens/${token.id}`, { method: "DELETE" })).status).toBe(204)
  await h.api(`/api/agent/launches/${launch.id}`, { method: "DELETE" })
  const remaining = async () => (await json(await h.api("/api/agent/webhooks"))).webhooks.map((w: any) => w.id)
  for (let i = 0; i < 100 && (await remaining()).length > 1; i++) await Bun.sleep(20)
  expect(await remaining()).toEqual([userHook.id])
  await h.webhooks.drain()
  expect(hook.received).toHaveLength(1)
})

test("app registrations need events:subscribe plus every selected canonical family's scope", async () => {
  h = await privateHub()
  const hook = receiver()
  const as = (t: string) => (pathname: string, init: RequestInit & { json?: unknown } = {}) => h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${t}` } })
  const missingSubscribe = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["messages:read"] } }))
  const missingFamily = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["events:subscribe", "messages:read"] } }))
  const complete = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["events:subscribe", "messages:read", "sessions:manage"] } }))
  expect((await as(missingSubscribe.token)("/api/agent/webhooks", { method: "POST", json: { url: hook.url, events: ["message.*"] } })).status).toBe(403)
  expect((await as(missingFamily.token)("/api/agent/webhooks", { method: "POST", json: { url: hook.url, events: ["message.*", "role.*"] } })).status).toBe(403)
  expect((await as(complete.token)("/api/agent/webhooks", { method: "POST", json: { url: hook.url, events: ["message.*", "role.*"] } })).status).toBe(201)
})

test("the webhook routes are in the route table as agent routes", async () => {
  h = await privateHub()
  const keys = h.routes.filter((r) => r.access === "agent").map((r) => `${r.method} ${r.path}`)
  for (const route of ["POST /api/agent/webhooks", "GET /api/agent/webhooks", "GET /api/agent/webhooks/:id", "DELETE /api/agent/webhooks/:id"]) expect(keys).toContain(route)
})
