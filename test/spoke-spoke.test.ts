import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, readConfig, writeConfig, type VoiceConfig } from "../src/config"
import { PROTOCOL_VERSION } from "../src/protocol"
import { detectKind, Spoke, SpokeError, type SpokeHost } from "../src/spoke/spoke"
import { EventQueue, fakeCentral, until, type FakeCentral } from "./spoke-fake"

type Ev = { type: string; data: Record<string, unknown>; created?: number }

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function fakeHost() {
  const events = new EventQueue<Ev>()
  const calls = { prompt: [] as unknown[], permission: [] as unknown[], get: [] as string[], interrupt: [] as string[], switch: [] as unknown[], create: [] as unknown[], model: [] as unknown[] }
  /** Current model per session (absent: the default model). */
  const models = new Map<string, { providerID: string; id: string; variant?: string }>()
  const messages = new Map<string, unknown[]>()
  /** Current agent per session (absent: the default agent). */
  const agents = new Map<string, string>()
  const known = new Set(["build", "plan", "voice"])
  let inbox = 0
  const host: SpokeHost & { push(e: Ev): void } = {
    directory: "/work/project",
    opencodeVersion: "2.0.25",
    events: (signal) => events.iterate(signal),
    push: (e) => events.push(e),
    prompt: async (input) => {
      calls.prompt.push(input)
      return { id: `msg_${++inbox}` }
    },
    context: async (sessionID) => (messages.get(sessionID) ?? []) as any,
    getSession: async (sessionID) => {
      calls.get.push(sessionID)
      const agent = agents.get(sessionID)
      const model = models.get(sessionID)
      return { id: sessionID, title: `Fetched ${sessionID}`, location: { directory: "/fetched" }, time: { updated: 5 }, ...(agent ? { agent } : {}), ...(model ? { model } : {}) }
    },
    replyPermission: async (input) => {
      calls.permission.push(input)
    },
    interrupt: async (sessionID) => {
      calls.interrupt.push(sessionID)
    },
    switchAgent: async (sessionID, agent) => {
      calls.switch.push({ sessionID, agent })
      agents.set(sessionID, agent)
    },
    switchModel: async (sessionID, model) => {
      calls.model.push({ sessionID, model })
      models.set(sessionID, model)
    },
    hasAgent: async (id) => known.has(id),
    defaultAgent: async () => "build",
    createSession: async (input) => {
      calls.create.push(input)
      return { id: `ses_new${calls.create.length}` }
    },
  }
  return { host, calls, messages, agents, known, models }
}

function setup(config: Partial<VoiceConfig>, opts: { server?: FakeCentral; kind?: "service" | "standalone"; listRecent?: SpokeHost["listRecent"] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-spoke-"))
  const file = path.join(dir, "config.json")
  const server = opts.server ?? fakeCentral()
  writeConfig(file, { ...defaults("box"), server: server.url, ...config })
  const { host, calls, messages, agents, known, models } = fakeHost()
  if (opts.listRecent) (host as { listRecent?: SpokeHost["listRecent"] }).listRecent = opts.listRecent
  const spoke = new Spoke(host, {
    configFile: file,
    machineName: "box",
    kind: opts.kind ?? "standalone",
    processID: "proc_test",
    pid: 4242,
    pluginVersion: "9.9.9",
    turnTimeoutMs: 2000,
    snapshotDebounceMs: 10,
    snapshotIntervalMs: 60_000,
    seedDebounceMs: 10,
    pollMs: 20,
    backoff: { minMs: 10, maxMs: 50 },
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => server.stop())
  cleanups.push(() => spoke.stop())
  spoke.start()
  return { spoke, server, host, calls, messages, file, agents, known, models }
}

const created = (sessionID: string, extra: Record<string, unknown> = {}): Ev => ({
  type: "session.created",
  data: { sessionID, title: `T ${sessionID}`, location: { directory: "/work/project" }, slug: "s", ...extra },
})
const lastSessions = (server: FakeCentral) =>
  server.frames.filter((f) => f.t === "sessions").at(-1) as { sessions: Array<{ id: string } & Record<string, unknown>> } | undefined
const forwarded = (server: FakeCentral) => server.frames.filter((f) => f.t === "event").map((f) => (f as { event: { type: string; data: any } }).event)

describe("detectKind", () => {
  test("--service marks the shared background service; anything else is standalone", () => {
    expect(detectKind(["/bin/opencode", "serve", "--service", "--port", "0"])).toBe("service")
    expect(detectKind(["/bin/opencode", "serve", "--stdio", "--port", "0"])).toBe("standalone")
    expect(detectKind(["bun", "x"])).toBe("standalone")
  })
})

describe("Spoke", () => {
  test("connects with a complete hello and sends a sessions snapshot", async () => {
    const { spoke, server, host } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    expect(server.auth[0]).toBe("Bearer tok")
    expect(server.frames[0]).toEqual({
      t: "hello",
      v: PROTOCOL_VERSION,
      processID: "proc_test",
      kind: "standalone",
      directory: "/work/project",
      pid: 4242,
      mode: "always",
      opencodeVersion: "2.0.25",
      pluginVersion: "9.9.9",
    })
    await until(() => lastSessions(server) !== undefined)
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    expect(lastSessions(server)?.sessions[0]).toMatchObject({ id: "ses_a", title: "T ses_a", owned: true })
  })

  test("does not connect when mode is off or there is no token", async () => {
    const server = fakeCentral()
    const off = setup({ mode: "off", token: "tok" }, { server })
    const noToken = setup({ mode: "always" }, { server })
    await Bun.sleep(100)
    expect(server.auth).toHaveLength(0)
    expect(off.spoke.status().connection).toBe("off")
    expect(noToken.spoke.status()).toMatchObject({ connection: "off", enrolled: false })
  })

  test("session mode exposes only listed sessions and their children, in snapshots and events", async () => {
    const { spoke, server, host } = setup({ mode: "session", sessions: ["ses_a"], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    host.push(created("ses_b"))
    host.push(created("ses_kid", { parentID: "ses_a" }))
    host.push({ type: "session.execution.started", data: { sessionID: "ses_b" } })
    host.push({ type: "session.execution.started", data: { sessionID: "ses_kid" } })
    await until(() => forwarded(server).some((e) => e.type === "session.execution.started"))
    await until(() => lastSessions(server)?.sessions.length === 3)
    // Unexposed root sessions are listed for discovery (the phone can enable voice for them).
    expect(lastSessions(server)?.sessions.map((s) => `${s.id}:${s.exposed}`).sort()).toEqual(["ses_a:true", "ses_b:false", "ses_kid:true"])
    await Bun.sleep(30)
    const events = forwarded(server)
    expect(events.map((e) => `${e.type}:${e.data.sessionID}`)).toEqual([
      "session.created:ses_a",
      "session.created:ses_kid",
      "session.execution.started:ses_kid",
    ])
    expect(spoke.status("ses_kid").sessionExposed).toBe(true)
    expect(spoke.status("ses_b").sessionExposed).toBe(false)
  })

  test("fetches title and directory for sessions first seen through activity", async () => {
    const { spoke, server, host, calls } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push({ type: "session.viewed", data: { sessionID: "ses_v", idle: 0 } })
    await until(() => lastSessions(server)?.sessions.length === 1)
    expect(calls.get).toEqual(["ses_v"])
    expect(lastSessions(server)?.sessions[0]).toMatchObject({ id: "ses_v", title: "Fetched ses_v", directory: "/fetched", owned: true })
  })

  test("a turn request prompts the session, applies voice style while running, and returns the reply", async () => {
    const { spoke, server, host, calls, messages } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    const response = server.request({ op: "turn", sessionID: "ses_a", text: "what's up", voiceStyle: true })
    await until(() => calls.prompt.length === 1)
    expect(calls.prompt[0]).toEqual({ sessionID: "ses_a", text: "what's up", metadata: { source: "opencode-voice" } })
    expect(spoke.isVoiceTurn("ses_a")).toBe(true)
    messages.set("ses_a", [
      { id: "msg_1", type: "user", text: "what's up" },
      { id: "a1", type: "assistant", content: [{ type: "text", text: "All good." }] },
    ])
    host.push({ type: "session.inbox.delivered", data: { sessionID: "ses_a", inboxID: "msg_1" } })
    host.push({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    const res = await response
    expect(res).toMatchObject({ ok: true, result: { outcome: "succeeded", reply: "All good." } })
    expect(spoke.isVoiceTurn("ses_a")).toBe(false)
  })

  test("turn failures and interruptions carry a message", async () => {
    const { spoke, server, host } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    const response = server.request({ op: "turn", sessionID: "ses_a", text: "x", voiceStyle: false })
    await Bun.sleep(30)
    expect(spoke.isVoiceTurn("ses_a")).toBe(false)
    host.push({ type: "session.inbox.delivered", data: { sessionID: "ses_a", inboxID: "msg_1" } })
    host.push({ type: "session.execution.failed", data: { sessionID: "ses_a", error: { message: "model exploded" } } })
    expect(await response).toMatchObject({ ok: true, result: { outcome: "failed", message: "model exploded", reply: "" } })
  })

  test("turns on sessions that are not exposed are refused", async () => {
    const { spoke, server, calls } = setup({ mode: "session", sessions: ["ses_a"], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    const res = await server.request({ op: "turn", sessionID: "ses_other", text: "x", voiceStyle: true })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not shared/i)
    expect(calls.prompt).toHaveLength(0)
  })

  test("permission and context requests", async () => {
    const { spoke, server, calls, messages } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    const perm = await server.request({ op: "permission", sessionID: "ses_a", requestID: "per_1", decision: "once" })
    expect(perm).toMatchObject({ ok: true, result: {} })
    expect(calls.permission).toEqual([{ sessionID: "ses_a", requestID: "per_1", decision: "once" }])

    const many = Array.from({ length: 25 }, (_, i) => ({ id: `u${i}`, type: "user", text: `q${i}` }))
    messages.set("ses_a", [
      ...many,
      { id: "a", type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "answer" }] },
      { id: "t", type: "assistant", content: [{ type: "tool", name: "x" }] },
      { id: "s", type: "synthetic", text: "ignored" },
    ])
    const ctx = await server.request({ op: "context", sessionID: "ses_a" })
    const list = (ctx.result as { messages: Array<{ role: string; text: string }> }).messages
    expect(list).toHaveLength(20)
    expect(list.at(-1)).toEqual({ role: "assistant", text: "answer" })
    expect(list[0]).toEqual({ role: "user", text: "q6" })
  })

  test("switching mode to off disconnects; back on reconnects", async () => {
    const { spoke, server } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    spoke.setMode("off")
    await until(() => server.closed === 1)
    expect(spoke.status().connection).toBe("off")
    expect(spoke.status().mode).toBe("off")
    spoke.setMode("session")
    await until(() => spoke.status().connection === "connected")
    expect(server.frames.filter((f) => f.t === "hello").at(-1)).toMatchObject({ mode: "session" })
  })

  test("reacts to config edits made by another process", async () => {
    const { spoke, server, file } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    writeConfig(file, { ...readConfig(file, "box"), mode: "off" })
    await until(() => spoke.status().connection === "off")
    await until(() => server.closed === 1)
  })

  test("bye revoked marks the status revoked and does not reconnect", async () => {
    const { spoke, server } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    server.send({ t: "bye", reason: "revoked" })
    await until(() => spoke.status().connection === "revoked")
    await Bun.sleep(80)
    expect(server.auth).toHaveLength(1)
  })

  test("setServer, setSession and validation", async () => {
    const { spoke, file } = setup({ mode: "session", token: "tok", machineID: "m" })
    spoke.setSession("ses_a", true)
    expect(readConfig(file, "box").sessions).toEqual(["ses_a"])
    expect(spoke.status("ses_a").sessionExposed).toBe(true)
    spoke.setSession("ses_a", false)
    expect(readConfig(file, "box").sessions).toEqual([])
    expect(() => spoke.setServer("not a url")).toThrow(SpokeError)
    expect(() => spoke.setMode("loud" as never)).toThrow(SpokeError)
    spoke.setServer("https://voice.example.com/")
    const config = readConfig(file, "box")
    expect(config.server).toBe("https://voice.example.com")
    expect(config.token).toBeUndefined()
    expect(spoke.status()).toMatchObject({ server: "https://voice.example.com", enrolled: false, connection: "off" })
  })

  test("enroll returns the user code, then stores the token on approval and connects", async () => {
    const server = fakeCentral()
    server.pollReplies = [{ status: "pending" }, { status: "approved", machineID: "m_9", machineToken: "tok_new" }]
    const { spoke, file } = setup({ mode: "always" }, { server })
    expect(await spoke.enroll()).toEqual({ userCode: "ABCD-EFGH", approveURL: `${server.url}/approve` })
    expect(spoke.status().enrollment).toBe("pending")
    await until(() => spoke.status().connection === "connected")
    expect(readConfig(file, "box")).toMatchObject({ token: "tok_new", machineID: "m_9" })
    expect(spoke.status()).toMatchObject({ enrolled: true, enrollment: "approved" })
    expect(server.auth.at(-1)).toBe("Bearer tok_new")
  })

  test("enroll reports denial", async () => {
    const server = fakeCentral()
    server.pollReplies = [{ status: "denied" }]
    const { spoke } = setup({ mode: "always" }, { server })
    await spoke.enroll()
    await until(() => spoke.status().enrollment === "denied")
    expect(spoke.status().enrolled).toBe(false)
  })

  test("pairCode, handoff and openLink go to the server; not_connected otherwise", async () => {
    const server = fakeCentral({
      onFrame: (m, ws) => {
        if (m.t !== "req") return
        const result = m.req.op === "pairCode" ? { code: "111222", url: "https://v/pair", expiresAt: 9 } : m.req.op === "handoff" ? { notified: 2 } : { url: m.req.sessionID ? `https://v/s/${m.req.sessionID}` : "https://v/" }
        ws.send(JSON.stringify({ t: "res", id: m.id, ok: true, result }))
      },
    })
    const { spoke } = setup({ mode: "always", token: "tok" }, { server })
    await until(() => spoke.status().connection === "connected")
    expect(await spoke.pairCode()).toEqual({ code: "111222", url: "https://v/pair", expiresAt: 9 })
    expect(await spoke.handoff("ses_a")).toEqual({ notified: 2 })
    expect(await spoke.openLink("ses_a")).toEqual({ url: "https://v/s/ses_a" })
    expect(await spoke.openLink()).toEqual({ url: "https://v/" }) // home page: no session
    spoke.setMode("off")
    await expect(spoke.pairCode()).rejects.toMatchObject({ name: "not_connected" })
  })

  test("an unreachable server never throws and reports an error", async () => {
    const { spoke } = setup({ mode: "always", token: "tok", server: "http://127.0.0.1:1" })
    await until(() => spoke.status().connection === "error")
    expect(spoke.status().lastError).toBeTruthy()
  })

  test("the service seeds recent sessions as not owned", async () => {
    const { spoke, server } = setup(
      { mode: "always", token: "tok" },
      { kind: "service", listRecent: async () => [{ id: "ses_old", title: "Old", directory: "/old", updated: 1 }] },
    )
    await until(() => spoke.status().connection === "connected")
    await until(() => lastSessions(server)?.sessions.length === 1)
    expect(lastSessions(server)?.sessions[0]).toEqual({ id: "ses_old", title: "Old", directory: "/old", updated: 1, owned: false, exposed: true })
    expect(server.frames[0]).toMatchObject({ kind: "service" })
  })

  test("the service lists sessions with their workspace and refreshes the listing on session events", async () => {
    let listing = [{ id: "ses_l", title: "Listed", directory: "/u/voice/web", updated: 1, project: "/u/voice", projectName: "voice" }]
    let lists = 0
    const listRecent = async () => {
      lists++
      return listing
    }
    const { spoke, server, host } = setup({ mode: "session", token: "tok" }, { kind: "service", listRecent })
    await until(() => spoke.status().connection === "connected")
    await until(() => lastSessions(server)?.sessions.length === 1)
    expect(lastSessions(server)?.sessions[0]).toEqual({ ...listing[0]!, owned: false, exposed: false })
    const before = lists
    listing = [{ id: "ses_l", title: "Renamed elsewhere", directory: "/u/voice/web", updated: 2, project: "/u/voice", projectName: "voice" }]
    host.push({ type: "session.renamed", data: { sessionID: "ses_l", title: "Renamed elsewhere" } })
    host.push({ type: "session.deleted", data: { sessionID: "ses_zzz" } })
    await until(() => lastSessions(server)?.sessions[0]?.title === "Renamed elsewhere")
    await Bun.sleep(40)
    // Debounced: the burst of events causes one more listing.
    expect(lists - before).toBe(1)
  })

  test("expose turns voice on and off for a reported session in session mode", async () => {
    const { spoke, server, host, file } = setup({ mode: "session", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_b"))
    await until(() => lastSessions(server)?.sessions.some((s) => s.id === "ses_b" && s.exposed === false) === true)
    const on = await server.request({ op: "expose", sessionID: "ses_b", on: true })
    expect(on).toMatchObject({ ok: true, result: { exposed: true } })
    expect(readConfig(file, "box").sessions).toEqual(["ses_b"])
    // The fresh snapshot goes out before the result.
    const index = server.frames.findIndex((f) => f.t === "res" && f.id === on.id)
    const snapshot = server.frames.slice(0, index).filter((f) => f.t === "sessions").at(-1) as any
    expect(snapshot.sessions.find((s: any) => s.id === "ses_b").exposed).toBe(true)
    const off = await server.request({ op: "expose", sessionID: "ses_b", on: false })
    expect(off).toMatchObject({ ok: true, result: { exposed: false } })
    expect(readConfig(file, "box").sessions).toEqual([])
  })

  test("expose refuses sessions this process did not report; mode always is always exposed", async () => {
    const session = setup({ mode: "session", token: "tok" })
    await until(() => session.spoke.status().connection === "connected")
    const unknown = await session.server.request({ op: "expose", sessionID: "ses_nope", on: true })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatch(/unknown session/i)
    expect(readConfig(session.file, "box").sessions).toEqual([])

    const always = setup({ mode: "always", token: "tok" })
    await until(() => always.spoke.status().connection === "connected")
    always.host.push(created("ses_a"))
    await until(() => lastSessions(always.server)?.sessions.length === 1)
    expect(await always.server.request({ op: "expose", sessionID: "ses_a", on: false })).toMatchObject({ ok: true, result: { exposed: true } })
    expect(readConfig(always.file, "box").sessions).toEqual([])
  })

  test("create makes a session in a reported workspace (service only) and exposes it in session mode", async () => {
    const standalone = setup({ mode: "session", token: "tok" })
    await until(() => standalone.spoke.status().connection === "connected")
    const refused = await standalone.server.request({ op: "create", directory: "/work/project" })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/background service/i)
    expect(standalone.calls.create).toHaveLength(0)

    const listRecent = async () => [{ id: "ses_l", title: "Listed", directory: "/u/voice/web", updated: 1, project: "/u/voice", projectName: "voice" }]
    const { spoke, server, calls, file } = setup({ mode: "session", token: "tok" }, { kind: "service", listRecent })
    await until(() => spoke.status().connection === "connected")
    await until(() => lastSessions(server)?.sessions.length === 1)
    const unknown = await server.request({ op: "create", directory: "/etc" })
    expect(unknown).toMatchObject({ ok: false, error: "unknown workspace" })
    const sub = await server.request({ op: "create", directory: "/u/voice/other" })
    expect(sub.ok).toBe(false)

    const res = await server.request({ op: "create", directory: "/u/voice/", title: "Voice idea" })
    expect(res).toMatchObject({ ok: true, result: { sessionID: "ses_new1" } })
    expect(calls.create).toEqual([{ directory: "/u/voice", title: "Voice idea" }])
    expect(readConfig(file, "box").sessions).toEqual(["ses_new1"])
    const index = server.frames.findIndex((f) => f.t === "res" && f.id === res.id)
    const snapshot = server.frames.slice(0, index).filter((f) => f.t === "sessions").at(-1) as any
    expect(snapshot.sessions.find((s: any) => s.id === "ses_new1")).toMatchObject({
      title: "Voice idea",
      directory: "/u/voice",
      project: "/u/voice",
      projectName: "voice",
      exposed: true,
    })
    // A session directory is a valid workspace too.
    expect(await server.request({ op: "create", directory: "/u/voice/web" })).toMatchObject({ ok: true, result: { sessionID: "ses_new2" } })
  })

  test("steer prompts with steer delivery and returns the inbox ID without waiting for the turn", async () => {
    const { spoke, server, calls } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    const first = await server.request({ op: "steer", sessionID: "ses_a", text: "make it blue" })
    const second = await server.request({ op: "steer", sessionID: "ses_a", text: "actually green" })
    expect(first).toMatchObject({ ok: true, result: { inboxID: "msg_1" } })
    expect(second).toMatchObject({ ok: true, result: { inboxID: "msg_2" } })
    expect(calls.prompt[0]).toEqual({
      sessionID: "ses_a",
      text: "make it blue",
      delivery: "steer",
      metadata: { source: "opencode-voice", mode: "conversation" },
    })
  })

  test("interrupt interrupts the session", async () => {
    const { spoke, server, calls } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    expect(await server.request({ op: "interrupt", sessionID: "ses_a" })).toMatchObject({ ok: true, result: {} })
    expect(calls.interrupt).toEqual(["ses_a"])
  })

  test("conversation on switches to the voice agent and off restores the previous one", async () => {
    const { spoke, server, calls, agents } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    agents.set("ses_a", "plan")
    expect(await server.request({ op: "conversation", sessionID: "ses_a", on: true })).toMatchObject({ ok: true, result: { agent: "voice" } })
    expect(spoke.inConversation("ses_a")).toBe(true)
    expect(calls.switch).toEqual([{ sessionID: "ses_a", agent: "voice" }])
    // re-sent after a reconnect: idempotent, previous agent kept
    expect(await server.request({ op: "conversation", sessionID: "ses_a", on: true })).toMatchObject({ ok: true, result: { agent: "voice" } })
    expect(calls.switch).toHaveLength(1)
    expect(await server.request({ op: "conversation", sessionID: "ses_a", on: false })).toMatchObject({ ok: true, result: { agent: "plan" } })
    expect(spoke.inConversation("ses_a")).toBe(false)
    expect(calls.switch.at(-1)).toEqual({ sessionID: "ses_a", agent: "plan" })
  })

  test("conversation off falls back to the default agent and leaves a manually chosen agent alone", async () => {
    const { spoke, calls, agents } = setup({ mode: "always", token: "tok" })
    expect(await spoke.setConversation("ses_a", true)).toEqual({ agent: "voice" })
    expect(await spoke.setConversation("ses_a", false)).toEqual({ agent: "build" })
    expect(calls.switch.at(-1)).toEqual({ sessionID: "ses_a", agent: "build" })
    await spoke.setConversation("ses_a", true)
    agents.set("ses_a", "plan")
    expect(await spoke.setConversation("ses_a", false)).toEqual({ agent: "plan" })
    expect(calls.switch).toHaveLength(3)
  })

  test("voiceModel: conversation runs on the fast model and subagent work keeps the session's previous model", async () => {
    // OpenCode reports the selected model with variant "default"; that means no explicit variant.
    const opus = { providerID: "anthropic", id: "claude-opus-5-5", variant: "default" }
    const { spoke, calls, models } = setup({ mode: "always", token: "tok", voiceModel: "anthropic/claude-haiku-5-5" })
    models.set("ses_a", opus)
    await spoke.setConversation("ses_a", true)
    expect(calls.model).toEqual([{ sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-haiku-5-5" } }])
    expect(spoke.workModelFor("ses_a")).toBe("anthropic/claude-opus-5-5")
    // idempotent re-send keeps the remembered work model
    await spoke.setConversation("ses_a", true)
    expect(calls.model).toHaveLength(1)
    expect(spoke.workModelFor("ses_a")).toBe("anthropic/claude-opus-5-5")
    // OpenCode then reports the voice model with variant "default" too
    models.set("ses_a", { providerID: "anthropic", id: "claude-haiku-5-5", variant: "default" })
    await spoke.setConversation("ses_a", false)
    expect(calls.model.at(-1)).toEqual({ sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5" } })
    expect(spoke.workModelFor("ses_a")).toBeUndefined()
  })

  test("voiceModel: workModel from config wins; a model changed by the user is left alone on exit", async () => {
    const { spoke, calls, models } = setup({ mode: "always", token: "tok", voiceModel: "anthropic/claude-haiku-5-5", workModel: "anthropic/claude-sonnet-5-5#high" })
    models.set("ses_a", { providerID: "anthropic", id: "claude-opus-5-5" })
    await spoke.setConversation("ses_a", true)
    expect(spoke.workModelFor("ses_a")).toBe("anthropic/claude-sonnet-5-5#high")
    models.set("ses_a", { providerID: "other", id: "picked" })
    await spoke.setConversation("ses_a", false)
    expect(calls.model).toHaveLength(1)
  })

  test("without voiceModel the session model is untouched", async () => {
    const { spoke, calls, models } = setup({ mode: "always", token: "tok" })
    models.set("ses_a", { providerID: "anthropic", id: "claude-opus-5-5" })
    await spoke.setConversation("ses_a", true)
    await spoke.setConversation("ses_a", false)
    expect(calls.model).toHaveLength(0)
    expect(spoke.workModelFor("ses_a")).toBeUndefined()
  })

  test("without a voice agent conversation mode stays on the current agent (context hook fallback)", async () => {
    const { spoke, calls, known } = setup({ mode: "always", token: "tok" })
    known.delete("voice")
    expect(await spoke.setConversation("ses_a", true)).toEqual({ agent: "build" })
    expect(spoke.inConversation("ses_a")).toBe(true)
    expect(await spoke.setConversation("ses_a", false)).toEqual({ agent: "build" })
    expect(spoke.inConversation("ses_a")).toBe(false)
    expect(calls.switch).toHaveLength(0)
  })

  test("steer, interrupt and conversation are refused for sessions that are not exposed", async () => {
    const { spoke, server, calls } = setup({ mode: "session", sessions: ["ses_a"], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    for (const req of [
      { op: "steer", sessionID: "ses_other", text: "x" },
      { op: "interrupt", sessionID: "ses_other" },
      { op: "conversation", sessionID: "ses_other", on: true },
    ]) {
      const res = await server.request(req)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/not shared/i)
    }
    await expect(spoke.setConversation("ses_other", true)).rejects.toMatchObject({ name: "invalid" })
    expect(spoke.inConversation("ses_other")).toBe(false)
    expect(calls.prompt).toHaveLength(0)
    expect(calls.interrupt).toHaveLength(0)
    expect(calls.switch).toHaveLength(0)
  })

  test("text.ended, inbox.delivered and agent.selected are forwarded for exposed sessions", async () => {
    const { spoke, server, host } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push({ type: "session.text.ended", data: { sessionID: "ses_a", text: "Done." } })
    host.push({ type: "session.inbox.delivered", data: { sessionID: "ses_a", inboxID: "msg_1" } })
    host.push({ type: "session.agent.selected", data: { sessionID: "ses_a", agent: "voice", previous: "build" } })
    await until(() => forwarded(server).length === 3)
    expect(forwarded(server)).toEqual([
      { type: "session.text.ended", data: { sessionID: "ses_a", text: "Done." } },
      { type: "session.inbox.delivered", data: { sessionID: "ses_a", inboxID: "msg_1" } },
      { type: "session.agent.selected", data: { sessionID: "ses_a", agent: "voice", previous: "build" } },
    ])
  })

  test("activity events leave the machine compact: tool summaries only, never inputs or outputs", async () => {
    const { spoke, server, host } = setup({ mode: "session", sessions: ["ses_a"], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    host.push(created("ses_kid", { parentID: "ses_a" }))
    host.push(created("ses_b"))
    const base = { sessionID: "ses_kid", assistantMessageID: "msg_1", id: "tool_1" }
    host.push({ type: "session.tool.input.started", data: { ...base, name: "write", raw: "partial SECRET" } })
    host.push({ type: "session.tool.called", data: { ...base, input: { filePath: "/x/a.ts", content: "SECRET FILE BODY" }, executed: true } })
    host.push({ type: "session.tool.success", data: { ...base, content: [{ type: "text", text: "SECRET OUTPUT" }] } })
    host.push({ type: "session.tool.failed", data: { ...base, id: "tool_2", error: { type: "x", message: "boom" }, content: "SECRET" } })
    host.push({ type: "session.reasoning.started", data: { sessionID: "ses_a", assistantMessageID: "msg_0", text: "SECRET THOUGHT" } })
    host.push({ type: "session.tool.called", data: { sessionID: "ses_b", id: "tool_b", input: { command: "ls" } } })
    await until(() => forwarded(server).some((e) => e.type === "session.reasoning.started"))
    await Bun.sleep(30)
    const activity = forwarded(server).filter((e) => e.type.startsWith("session.tool") || e.type.startsWith("session.reasoning"))
    expect(activity).toEqual([
      { type: "session.tool.input.started", data: { ...base, name: "write" } },
      { type: "session.tool.called", data: { ...base, summary: "/x/a.ts", background: false } },
      { type: "session.tool.success", data: base },
      { type: "session.tool.failed", data: { ...base, id: "tool_2", error: "boom" } },
      { type: "session.reasoning.started", data: { sessionID: "ses_a", assistantMessageID: "msg_0" } },
    ])
    expect(JSON.stringify(server.frames)).not.toContain("SECRET")
  })

  test("subagent follows the machine config", async () => {
    const { spoke, file } = setup({ mode: "off", subagent: "tdd-dev" })
    expect(spoke.subagent()).toBe("tdd-dev")
    writeConfig(file, { ...readConfig(file, "box"), subagent: "explore" })
    await until(() => spoke.subagent() === "explore")
  })
})
