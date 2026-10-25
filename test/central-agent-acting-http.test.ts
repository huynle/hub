// Kill switches over HTTP (design §5, §7): GET/PUT /api/agent/acting (users only) and the admin's hub-wide
// GET/PUT /api/admin/agents/acting. While either is on, reading and messaging keep working; the acting verbs
// (P3-T7) answer 423 paused through Central.acting.ensureActing. hub.json agents.never reaches Central.acting.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { BearerVerifier } from "../src/central/agent/actor"
import { centralConfig } from "../src/central/config"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

const USER = "local"
const TOKEN = "hst_fake_ses_1"
const verifiers: BearerVerifier[] = [
  { kind: "session", verify: (token) => (token === TOKEN ? { kind: "session", userID: USER, machineID: "mch_x", sessionID: "ses_1" } : undefined) },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const asSession = (pathname: string, init: RequestInit & { json?: unknown } = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${TOKEN}` } })
const put = (pathname: string, body: unknown) => h.api(pathname, { method: "PUT", json: body })

async function start(extra: Record<string, unknown> = {}) {
  h = await harness({ agent: { verifiers }, ...extra } as any)
  const client = await spoke(h, {
    hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver"] },
    sessions: [session("ses_1", { title: "API refactor", owned: true }), session("ses_2", { title: "Web work", owned: true })],
  })
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t === "req" && frame.req.op === "deliver") client.send({ t: "res", id: frame.id, ok: true, result: { delivered: "queued" } })
  })
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === 2)
}

describe("GET/PUT /api/agent/acting", () => {
  test("the user turns their agent actions off and on; sessions cannot", async () => {
    await start()
    expect(await json(await h.api("/api/agent/acting"))).toEqual({ enabled: true, hubEnabled: true })
    expect((await asSession("/api/agent/acting")).status).toBe(403)
    expect((await asSession("/api/agent/acting", { method: "PUT", json: { enabled: false } })).status).toBe(403)
    expect((await put("/api/agent/acting", { enabled: "off" })).status).toBe(400)
    const off = await put("/api/agent/acting", { enabled: false })
    expect(off.status).toBe(200)
    expect(await json(off)).toEqual({ enabled: false, hubEnabled: true })
    expect(h.acting.isActingPaused(USER)).toBe(true)
    expect(h.store.agentData(USER).actingPaused).toBe(true)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: USER, action: "agent.acting.pause" })
    const audit = await json(await h.api("/api/agent/audit"))
    expect(audit.entries[0]).toMatchObject({ verb: "acting.pause", actor: { kind: "user" }, decision: "allow", outcome: "ok" })
    expect(await json(await put("/api/agent/acting", { enabled: true }))).toEqual({ enabled: true, hubEnabled: true })
    expect(h.acting.isActingPaused(USER)).toBe(false)
  })

  test("cookie writes need the same origin", async () => {
    await start()
    expect((await h.api("/api/agent/acting", { method: "PUT", json: { enabled: false }, origin: "https://evil.example" })).status).toBe(403)
    expect(h.acting.isActingPaused(USER)).toBe(false)
  })
})

describe("GET/PUT /api/admin/agents/acting (hub-wide)", () => {
  test("the admin pauses agent actions for everyone; audited; validated", async () => {
    await start()
    expect(await json(await h.api("/api/admin/agents/acting"))).toEqual({ enabled: true })
    expect((await put("/api/admin/agents/acting", { enabled: 1 })).status).toBe(400)
    const off = await put("/api/admin/agents/acting", { enabled: false })
    expect(off.status).toBe(200)
    expect(await json(off)).toEqual({ enabled: false })
    expect(h.store.actingPaused()).toBe(true)
    expect(h.acting.isActingPaused(USER)).toBe(true)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: USER, action: "agents.acting.pause" })
    expect(await json(await h.api("/api/agent/acting"))).toEqual({ enabled: true, hubEnabled: false })
    expect(await json(await put("/api/admin/agents/acting", { enabled: true }))).toEqual({ enabled: true })
    expect(h.store.auditLog()[0]).toMatchObject({ actor: USER, action: "agents.acting.resume" })
    expect(h.acting.isActingPaused(USER)).toBe(false)
  })

  test("session tokens never reach the admin route", async () => {
    await start()
    expect((await asSession("/api/admin/agents/acting", { method: "PUT", json: { enabled: false } })).status).toBe(403)
    expect(h.store.actingPaused()).toBe(false)
  })
})

describe("while acting is paused, reading and messaging keep working", () => {
  test("user and hub switches on: whoami, sessions, msg and inbox answer as usual", async () => {
    await start()
    await put("/api/agent/acting", { enabled: false })
    await put("/api/admin/agents/acting", { enabled: false })
    expect((await asSession("/api/agent/whoami")).status).toBe(200)
    expect((await asSession("/api/agent/sessions")).status).toBe(200)
    const sent = await asSession("/api/agent/msg", { method: "POST", json: { to: "@web-work", text: "still here" } })
    expect(sent.status).toBe(201)
    expect((await asSession("/api/agent/inbox")).status).toBe(200)
    expect(() => h.acting.ensureActing(USER)).toThrow(/paused/)
  })
})

describe("hub.json agents.never", () => {
  test("reaches Central.acting.hubNever()", async () => {
    const config = {
      ...centralConfig({ HUB_PORT: "0", HUB_PUBLIC_URL: "http://127.0.0.1:4097", HUB_STATE_DIR: mkdtempSync(path.join(tmpdir(), "voice-state-")) }),
      agentsNever: ["shell:git push*", "external_directory"],
    }
    await start({ config })
    expect(h.acting.hubNever()).toEqual([
      { action: "shell", resource: "git push*" },
      { action: "external_directory", resource: "*" },
    ])
  })
})
