import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, readConfig, writeConfig, type VoiceConfig } from "../src/config"
import { PROTOCOL_VERSION } from "../src/protocol"
import type { HerdrRunner } from "../src/spoke/herdr"
import { detectKind, Spoke, SpokeError, type SpokeHost, type SpokeOptions } from "../src/spoke/spoke"
import { EventQueue, fakeCentral, until, type FakeCentral } from "./spoke-fake"

type Ev = { type: string; data: Record<string, unknown>; created?: number }

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function fakeHost(opts: { forms?: boolean } = {}) {
  const events = new EventQueue<Ev>()
  const calls = { form: [] as unknown[], prompt: [] as unknown[], permission: [] as unknown[], get: [] as string[], interrupt: [] as string[], switch: [] as unknown[], create: [] as unknown[], model: [] as unknown[], update: [] as unknown[] }
  /** Titles set through updateSession. */
  const titles = new Map<string, string>()
  /** Current model per session (absent: the default model). */
  const models = new Map<string, { providerID: string; id: string; variant?: string }>()
  const messages = new Map<string, unknown[]>()
  /** Current agent per session (absent: the default agent). */
  const agents = new Map<string, string>()
  const known = new Set(["build", "plan", "voice"])
  /** Parent of sessions as OpenCode reports them (subagent sessions). */
  const parents = new Map<string, string>()
  let inbox = 0
  const catalog = [
    { providerID: "anthropic", modelID: "claude-haiku", name: "Claude Haiku", enabled: true, status: "active", variants: [{ id: "fast" }] },
    { providerID: "anthropic", modelID: "claude-opus", name: "Claude Opus", enabled: true, status: "active", variants: [{ id: "thinking" }] },
  ]
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
    listModels: async () => catalog as any,
    getSession: async (sessionID) => {
      calls.get.push(sessionID)
      const agent = agents.get(sessionID)
      const model = models.get(sessionID)
      const parentID = parents.get(sessionID)
      return { id: sessionID, title: titles.get(sessionID) ?? `Fetched ${sessionID}`, location: { directory: "/fetched" }, time: { updated: 5 }, ...(parentID ? { parentID } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}) }
    },
    updateSession: async (sessionID, input) => {
      calls.update.push({ sessionID, ...input })
      if (input.title === "boom") throw new Error("OpenCode refused")
      if (input.title !== undefined) titles.set(sessionID, input.title)
    },
    ...(opts.forms === false
      ? {}
      : {
          replyForm: async (input: any) => {
            calls.form.push(input)
            return input.formID.startsWith("frm_gone") ? ("gone" as const) : ("replied" as const)
          },
        }),
    replyPermission: async (input) => {
      calls.permission.push(input)
      return input.requestID.startsWith("per_gone") ? "gone" : "replied"
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
  return { host, calls, messages, agents, known, models, catalog, parents }
}

function setup(
  config: Partial<VoiceConfig>,
  opts: { server?: FakeCentral; kind?: "service" | "standalone"; listRecent?: SpokeHost["listRecent"]; herdr?: HerdrRunner; options?: Partial<SpokeOptions>; forms?: boolean } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-spoke-"))
  const file = path.join(dir, "config.json")
  const server = opts.server ?? fakeCentral()
  writeConfig(file, { ...defaults("box"), server: server.url, ...config })
  const { host, calls, messages, agents, known, models, catalog, parents } = fakeHost({ forms: opts.forms })
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
    ...(opts.herdr ? { herdr: opts.herdr, herdrPollMs: { agents: 20, workspaces: 40 }, herdrSettleMs: 0 } : {}),
    ...opts.options,
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => server.stop())
  cleanups.push(() => spoke.stop())
  spoke.start()
  return { spoke, server, host, calls, messages, file, agents, known, models, catalog, parents }
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

  test("session mode marks Voice exposure; events of every known session are forwarded", async () => {
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
      "session.created:ses_b",
      "session.created:ses_kid",
      "session.execution.started:ses_b",
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
    expect(calls.prompt[0]).toEqual({ sessionID: "ses_a", text: "what's up", metadata: { source: "hub" } })
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

  test("turns on sessions this process does not know are refused", async () => {
    const { spoke, server, calls } = setup({ mode: "session", sessions: ["ses_a"], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    const res = await server.request({ op: "turn", sessionID: "ses_other", text: "x", voiceStyle: true })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown session/i)
    expect(calls.prompt).toHaveLength(0)
  })

  test("a subagent session this process has not seen yet is served when OpenCode says it descends from a known one", async () => {
    const { spoke, server, calls, parents } = setup({ mode: "session", sessions: ["ses_a"], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    parents.set("ses_kid", "ses_mid")
    parents.set("ses_mid", "ses_a")
    const res = await server.request({ op: "steer", sessionID: "ses_kid", text: "focus" })
    expect(res).toMatchObject({ ok: true })
    expect(calls.prompt).toEqual([expect.objectContaining({ sessionID: "ses_kid", text: "focus" })])
    const stranger = await server.request({ op: "steer", sessionID: "ses_stranger", text: "x" })
    expect(stranger.error).toMatch(/unknown session/i)
  })

  test("a permission request no location holds any more is reported as gone, not as an error", async () => {
    const { spoke, server } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    const res = await server.request({ op: "permission", sessionID: "ses_a", requestID: "per_gone1", decision: "once" })
    expect(res).toMatchObject({ ok: true, result: { gone: true } })
  })

  test("form replies go to OpenCode for pending forms; unknown or settled forms are gone", async () => {
    const { spoke, server, host, calls } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    host.push({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_a", title: "Q", fields: [] } } })
    host.push({ type: "form.created", data: { form: { id: "frm_gone1", sessionID: "ses_a", title: "Q", fields: [] } } })
    await until(() => forwarded(server).filter((e) => e.type === "form.created").length === 2)
    expect(await server.request({ op: "form", sessionID: "ses_a", formID: "frm_1", answer: { q0: "red" } })).toMatchObject({ ok: true, result: {} })
    expect(await server.request({ op: "form", sessionID: "ses_a", formID: "frm_1", cancel: true })).toMatchObject({ ok: true, result: {} })
    expect(await server.request({ op: "form", sessionID: "ses_a", formID: "frm_gone1", answer: {} })).toMatchObject({ ok: true, result: { gone: true } })
    expect(calls.form).toEqual([
      { sessionID: "ses_a", formID: "frm_1", answer: { q0: "red" } },
      { sessionID: "ses_a", formID: "frm_1", cancel: true },
      { sessionID: "ses_a", formID: "frm_gone1", answer: {} },
    ])
    host.push({ type: "form.replied", data: { id: "frm_1", sessionID: "ses_a", answer: {} } })
    await until(() => forwarded(server).some((e) => e.type === "form.replied"))
    expect(await server.request({ op: "form", sessionID: "ses_a", formID: "frm_1", answer: {} })).toMatchObject({ ok: true, result: { gone: true } })
    expect(calls.form).toHaveLength(3)
  })

  test("without its own way to answer forms, the spoke relays to a polling TUI and waits for the reply", async () => {
    const { spoke, server, host } = setup({ mode: "always", token: "tok" }, { forms: false })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    host.push({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_a", title: "Q", fields: [] } } })
    await until(() => forwarded(server).some((e) => e.type === "form.created"))
    // No TUI is polling: the user is told to answer in the terminal.
    const refused = await server.request({ op: "form", sessionID: "ses_a", formID: "frm_1", answer: { q0: "x" } })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/terminal/i)

    const polled = spoke.formActions(2000)
    const answered = server.request({ op: "form", sessionID: "ses_a", formID: "frm_1", answer: { q0: "x" } })
    expect(await polled).toEqual({ actions: [{ sessionID: "ses_a", formID: "frm_1", answer: { q0: "x" } }] })
    host.push({ type: "form.replied", data: { id: "frm_1", sessionID: "ses_a", answer: { q0: "x" } } })
    expect(await answered).toMatchObject({ ok: true, result: {} })
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
        const result = m.req.op === "pairCode" ? { code: "111222", url: "https://v/pair", expiresAt: 9 } : m.req.op === "handoff" ? { notified: 2 } : { url: m.req.sessionID ? `https://v/s/${m.req.sessionID}${m.req.voice ? "?voice=1" : ""}` : "https://v/" }
        ws.send(JSON.stringify({ t: "res", id: m.id, ok: true, result }))
      },
    })
    const { spoke } = setup({ mode: "always", token: "tok" }, { server })
    await until(() => spoke.status().connection === "connected")
    expect(await spoke.pairCode()).toEqual({ code: "111222", url: "https://v/pair", expiresAt: 9 })
    expect(await spoke.handoff("ses_a")).toEqual({ notified: 2 })
    expect(await spoke.openLink("ses_a")).toEqual({ url: "https://v/s/ses_a" })
    expect(await spoke.openLink()).toEqual({ url: "https://v/" }) // home page: no session
    expect(await spoke.openLink("ses_a", true)).toEqual({ url: "https://v/s/ses_a?voice=1" })
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
      metadata: { source: "hub", mode: "conversation" },
    })
  })

  test("rename sets the trimmed title in OpenCode and reports it at once", async () => {
    const { spoke, server, calls, host } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.some((s) => s.id === "ses_a") === true)
    const res = await server.request({ op: "rename", sessionID: "ses_a", title: "  Fix the login bug  " })
    expect(res).toMatchObject({ ok: true, result: { title: "Fix the login bug" } })
    expect(calls.update).toEqual([{ sessionID: "ses_a", title: "Fix the login bug" }])
    // The snapshot with the new title goes out before the reply (same socket, in order).
    const index = server.frames.findIndex((f) => f.t === "res" && (f as { result?: { title?: string } }).result?.title === "Fix the login bug")
    const before = server.frames.slice(0, index).filter((f) => f.t === "sessions").at(-1) as unknown as { sessions: Array<{ id: string; title: string }> }
    expect(before.sessions.find((s) => s.id === "ses_a")?.title).toBe("Fix the login bug")
  })

  test("rename refuses an empty or too long title and unknown sessions; OpenCode errors pass through", async () => {
    const { spoke, server, calls, host } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await Bun.sleep(30)
    for (const title of ["", "   ", "x".repeat(201)]) {
      const res = await server.request({ op: "rename", sessionID: "ses_a", title })
      expect(res.ok).toBe(false)
    }
    expect(await server.request({ op: "rename", sessionID: "ses_a", title: "y".repeat(200) })).toMatchObject({ ok: true })
    const failed = await server.request({ op: "rename", sessionID: "ses_a", title: "boom" })
    expect(failed).toMatchObject({ ok: false, error: "OpenCode refused" })
    expect(spoke.status().connection).toBe("connected")
    expect(calls.update).toHaveLength(2)
    expect(lastSessions(server)?.sessions.find((s) => s.id === "ses_a")?.title).toBe("y".repeat(200))
  })

  test("rename works for a known session without Voice", async () => {
    const { spoke, server, calls, host } = setup({ mode: "session", sessions: [], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_other"))
    await Bun.sleep(30)
    expect(await server.request({ op: "rename", sessionID: "ses_other", title: "Renamed" })).toMatchObject({ ok: true, result: { title: "Renamed" } })
    expect(calls.update).toEqual([{ sessionID: "ses_other", title: "Renamed" }])
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

  test("known sessions without Voice accept typed control and permissions; conversation stays Voice-only", async () => {
    const { spoke, server, calls, host } = setup({ mode: "session", sessions: ["ses_a"], token: "tok", voiceModel: "anthropic/claude-haiku" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_other"))
    await Bun.sleep(30)
    for (const req of [
      { op: "steer", sessionID: "ses_other", text: "x" },
      { op: "interrupt", sessionID: "ses_other" },
      { op: "permission", sessionID: "ses_other", requestID: "per_1", decision: "once" },
      { op: "context", sessionID: "ses_other" },
      { op: "timeline", sessionID: "ses_other" },
    ]) {
      const res = await server.request(req)
      expect(res).toMatchObject({ ok: true })
    }
    expect(calls.prompt).toEqual([{ sessionID: "ses_other", text: "x", delivery: "steer", metadata: { source: "hub", mode: "remote" } }])
    expect(calls.interrupt).toEqual(["ses_other"])
    expect(calls.permission).toHaveLength(1)
    expect(calls.model).toHaveLength(0)
    const convo = await server.request({ op: "conversation", sessionID: "ses_other", on: true })
    expect(convo.ok).toBe(false)
    expect(convo.error).toMatch(/not shared/i)
    await expect(spoke.setConversation("ses_other", true)).rejects.toMatchObject({ name: "invalid" })
    expect(calls.switch).toHaveLength(0)
  })

  test("stop interrupts running descendants deepest first, then the root, and is idempotent", async () => {
    const { spoke, server, calls, host } = setup({ mode: "session", sessions: [], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_r"))
    host.push(created("ses_c", { parentID: "ses_r" }))
    host.push(created("ses_g", { parentID: "ses_c" }))
    host.push(created("ses_idle", { parentID: "ses_r" }))
    for (const id of ["ses_r", "ses_c", "ses_g"]) host.push({ type: "session.execution.started", data: { sessionID: id } })
    await Bun.sleep(30)
    const res = await server.request({ op: "stop", sessionID: "ses_c" })
    expect(res).toMatchObject({ ok: true, result: { stopped: ["ses_g", "ses_c", "ses_r"] } })
    expect(calls.interrupt).toEqual(["ses_g", "ses_c", "ses_r"])
    for (const id of ["ses_r", "ses_c", "ses_g"]) host.push({ type: "session.execution.interrupted", data: { sessionID: id } })
    await Bun.sleep(30)
    expect(await server.request({ op: "stop", sessionID: "ses_r" })).toMatchObject({ ok: true, result: { stopped: ["ses_r"] } })
  })

  test("summary and diff read the session's directory; missing host features leave parts out", async () => {
    const { spoke, server, host, messages } = setup({ mode: "session", sessions: [], token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_r"))
    await Bun.sleep(30)
    messages.set("ses_r", [{ type: "assistant", model: { providerID: "anthropic", id: "claude-opus" }, tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } }])
    const seen: string[] = []
    const diffs = [{ file: "a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" }]
    Object.assign(host, {
      mcpList: async (dir: string) => (seen.push(`mcp ${dir}`), [{ name: "github", status: { status: "connected" } }]),
      vcsDiff: async (dir: string) => (seen.push(`diff ${dir}`), diffs),
      vcsBranch: async (dir: string) => (seen.push(`branch ${dir}`), "main"),
    })
    const summary = await server.request({ op: "summary", sessionID: "ses_r" })
    expect(summary).toMatchObject({
      ok: true,
      result: {
        directory: "/work/project",
        branch: "main",
        context: { used: 1000, model: "Claude Opus" },
        mcp: [{ name: "github", status: "connected" }],
        changes: { files: [{ file: "a.ts", status: "modified", additions: 3, deletions: 1 }], additions: 3, deletions: 1 },
      },
    })
    expect(seen.sort()).toEqual(["branch /work/project", "diff /work/project", "mcp /work/project"])
    expect(await server.request({ op: "diff", sessionID: "ses_r", file: "a.ts" })).toMatchObject({ ok: true, result: { patch: { file: "a.ts", patch: "@@ -1 +1 @@", truncated: false } } })
    expect(await server.request({ op: "diff", sessionID: "ses_r", file: "zzz" })).toMatchObject({ ok: true, result: {} })
    // A failing part is left out instead of failing the whole summary.
    Object.assign(host, { vcsDiff: async () => { throw new Error("not a git repo") } })
    const partial = await server.request({ op: "summary", sessionID: "ses_r" })
    expect(partial.ok).toBe(true)
    expect((partial.result as any).changes).toBeUndefined()
    expect((partial.result as any).mcp).toHaveLength(1)
  })

  test("stop keeps going when a descendant finished meanwhile", async () => {
    const { spoke, server, calls, host } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_r"))
    host.push(created("ses_c", { parentID: "ses_r" }))
    host.push({ type: "session.execution.started", data: { sessionID: "ses_c" } })
    await Bun.sleep(30)
    const original = host.interrupt
    host.interrupt = async (id) => {
      await original(id)
      if (id === "ses_c") throw new Error("not running")
    }
    expect(await server.request({ op: "stop", sessionID: "ses_r" })).toMatchObject({ ok: true, result: { stopped: ["ses_c", "ses_r"] } })
    expect(calls.interrupt).toEqual(["ses_c", "ses_r"])
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
      { type: "session.tool.called", data: { sessionID: "ses_b", id: "tool_b", summary: "ls", background: false } },
    ])
    expect(JSON.stringify(server.frames)).not.toContain("SECRET")
  })

  test("subagent follows the machine config", async () => {
    const { spoke, file } = setup({ mode: "off", subagent: "tdd-dev" })
    expect(spoke.subagent()).toBe("tdd-dev")
    writeConfig(file, { ...readConfig(file, "box"), subagent: "explore" })
    await until(() => spoke.subagent() === "explore")
  })

  test("lists normalized models and uses per-session Voice and Worker model preferences", async () => {
    const { spoke, server, host, calls, models } = setup({
      mode: "always",
      token: "tok",
      voiceModel: "fallback/voice",
      workModel: "fallback/worker",
    })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)

    const listed = await server.request({ op: "models", sessionID: "ses_a" })
    expect(listed.result).toEqual({
      models: [
        { providerID: "anthropic", modelID: "claude-haiku", name: "Claude Haiku", enabled: true, status: "active", variants: ["fast"] },
        { providerID: "anthropic", modelID: "claude-opus", name: "Claude Opus", enabled: true, status: "active", variants: ["thinking"] },
      ],
    })

    const prefs = {
      voice: { providerID: "anthropic", modelID: "claude-haiku", variant: "fast" },
      worker: { providerID: "anthropic", modelID: "claude-opus", variant: "thinking" },
    }
    expect((await server.request({ op: "setModelPrefs", sessionID: "ses_a", ...prefs })).result).toEqual({
      prefs,
      defaults: {
        voice: { providerID: "fallback", modelID: "voice" },
        worker: { providerID: "fallback", modelID: "worker" },
      },
    })
    expect(spoke.workModelFor("ses_a")).toBe("anthropic/claude-opus#thinking")

    models.set("ses_a", { providerID: "fallback", id: "voice" })
    host.push({ type: "session.execution.started", data: { sessionID: "ses_a" } })
    await server.request({ op: "steer", sessionID: "ses_a", text: "while busy" })
    expect(calls.model).toEqual([])
    host.push({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    await Bun.sleep(10)
    await server.request({ op: "steer", sessionID: "ses_a", text: "next turn" })
    expect(calls.model.at(-1)).toEqual({ sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-haiku", variant: "fast" } })
    const beforeTurn = calls.model.length
    models.set("ses_a", { providerID: "fallback", id: "voice" })
    host.push({ type: "session.model.selected", data: { sessionID: "ses_a", model: { providerID: "fallback", id: "voice" } } })
    await Bun.sleep(10)
    const turn = server.request({ op: "turn", sessionID: "ses_a", text: "push to talk", voiceStyle: true })
    await until(() => calls.prompt.length >= 3)
    expect(calls.model).toHaveLength(beforeTurn + 1)
    host.push({ type: "session.inbox.delivered", data: { sessionID: "ses_a", inboxID: "msg_3" } })
    host.push({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    await turn
  })

  test("clearing a Voice model override restores the model the session had before it", async () => {
    const { spoke, server, host, calls, models } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    models.set("ses_a", { providerID: "anthropic", id: "claude-opus", variant: "thinking" })
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: { providerID: "bad", modelID: "model" } })
    await server.request({ op: "steer", sessionID: "ses_a", text: "hi" })
    expect(models.get("ses_a")).toEqual({ providerID: "bad", id: "model" })
    // Another override keeps the original model as the one to restore.
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: { providerID: "anthropic", modelID: "claude-haiku" } })
    await server.request({ op: "steer", sessionID: "ses_a", text: "again" })
    expect(models.get("ses_a")).toEqual({ providerID: "anthropic", id: "claude-haiku" })
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: null })
    expect(models.get("ses_a")).toEqual({ providerID: "anthropic", id: "claude-opus", variant: "thinking" })
    // Clearing again changes nothing.
    const switches = calls.model.length
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: null })
    expect(calls.model).toHaveLength(switches)
  })

  test("clearing a Voice override keeps a model the user picked meanwhile", async () => {
    const { spoke, server, host, calls, models } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    models.set("ses_a", { providerID: "anthropic", id: "claude-opus" })
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: { providerID: "anthropic", modelID: "claude-haiku" } })
    await server.request({ op: "steer", sessionID: "ses_a", text: "hi" })
    // The user picks a model in the TUI: OpenCode reports it.
    models.set("ses_a", { providerID: "user", id: "choice" })
    host.push({ type: "session.model.selected", data: { sessionID: "ses_a", model: { providerID: "user", id: "choice" } } })
    await Bun.sleep(20)
    const switches = calls.model.length
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: null })
    expect(calls.model).toHaveLength(switches)
    expect(models.get("ses_a")).toEqual({ providerID: "user", id: "choice" })
  })

  test("utterances with a Voice model ask OpenCode for the session's model once, not on every steer", async () => {
    const { spoke, server, host, calls, models } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    models.set("ses_a", { providerID: "anthropic", id: "claude-opus" })
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: { providerID: "anthropic", modelID: "claude-haiku" } })
    await server.request({ op: "steer", sessionID: "ses_a", text: "first" })
    expect(models.get("ses_a")).toEqual({ providerID: "anthropic", id: "claude-haiku" })
    const gets = calls.get.filter((id) => id === "ses_a").length
    await server.request({ op: "steer", sessionID: "ses_a", text: "second" })
    await server.request({ op: "steer", sessionID: "ses_a", text: "third" })
    expect(calls.get.filter((id) => id === "ses_a").length).toBe(gets)
    expect(calls.model).toHaveLength(1)
    expect(calls.prompt).toHaveLength(3)
  })

  test("a model change OpenCode reports is applied from the cache: the Voice model is switched back in without asking", async () => {
    const { spoke, server, host, calls, models } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    models.set("ses_a", { providerID: "anthropic", id: "claude-opus" })
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: { providerID: "anthropic", modelID: "claude-haiku" } })
    await server.request({ op: "steer", sessionID: "ses_a", text: "first" })
    const gets = calls.get.filter((id) => id === "ses_a").length
    models.set("ses_a", { providerID: "user", id: "choice" })
    host.push({ type: "session.model.selected", data: { sessionID: "ses_a", model: { providerID: "user", id: "choice" } } })
    await Bun.sleep(20)
    await server.request({ op: "steer", sessionID: "ses_a", text: "second" })
    expect(calls.model.at(-1)).toEqual({ sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-haiku" } })
    expect(calls.get.filter((id) => id === "ses_a").length).toBe(gets)
  })

  test("clearing a Voice override while the session runs restores it at the next turn boundary", async () => {
    const { spoke, server, host, models } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    models.set("ses_a", { providerID: "anthropic", id: "claude-opus" })
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: { providerID: "anthropic", modelID: "claude-haiku" } })
    await server.request({ op: "steer", sessionID: "ses_a", text: "hi" })
    host.push({ type: "session.execution.started", data: { sessionID: "ses_a" } })
    await until(() => forwarded(server).some((e) => e.type === "session.execution.started"))
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: null })
    expect(models.get("ses_a")).toEqual({ providerID: "anthropic", id: "claude-haiku" })
    host.push({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    await until(() => forwarded(server).some((e) => e.type === "session.execution.succeeded"))
    await server.request({ op: "steer", sessionID: "ses_a", text: "next" })
    expect(models.get("ses_a")).toEqual({ providerID: "anthropic", id: "claude-opus" })
  })

  test("model catalog entries are keyed by their OpenCode id, not the upstream modelID (gateway aliases)", async () => {
    const { spoke, server, host, calls, catalog } = setup({ mode: "always", token: "tok" })
    // A gateway provider: OpenCode id "claude-opus-5-5" sends modelID "claude/claude-opus-5-5" upstream.
    catalog.splice(0, catalog.length, { id: "claude-opus-5-5", providerID: "omniroute", modelID: "claude/claude-opus-5-5", name: "Claude Opus 5.5", enabled: true, status: "active", variants: [{ id: "high" }] } as never)
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    const listed = await server.request({ op: "models", sessionID: "ses_a" })
    expect(listed.result).toEqual({ models: [{ providerID: "omniroute", modelID: "claude-opus-5-5", name: "Claude Opus 5.5", enabled: true, status: "active", variants: ["high"] }] })
    await server.request({ op: "setModelPrefs", sessionID: "ses_a", voice: { providerID: "omniroute", modelID: "claude-opus-5-5", variant: "high" } })
    await server.request({ op: "steer", sessionID: "ses_a", text: "hi" })
    expect(calls.model.at(-1)).toEqual({ sessionID: "ses_a", model: { providerID: "omniroute", id: "claude-opus-5-5", variant: "high" } })
  })

  test("normalizes timeline history, paginates it, and returns full tool detail", async () => {
    const { spoke, server, host, messages } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    messages.set("ses_a", [
      { id: "u1", type: "user", text: "Please inspect it", time: { created: 1 } },
      { id: "a1", type: "assistant", agent: "voice", model: { providerID: "anthropic", id: "claude" }, time: { created: 2, completed: 8 }, content: [
        { type: "reasoning", text: "## Inspecting\nI will read the file.", time: { created: 2, completed: 4 } },
        { type: "tool", id: "tool_1", name: "read", state: { status: "completed", input: { filePath: "/work/a.ts" }, content: [{ type: "text", text: "FULL OUTPUT" }] }, time: { created: 4, completed: 6 } },
        { type: "text", text: "It looks good." },
      ] },
    ])
    const page = await server.request({ op: "timeline", sessionID: "ses_a", limit: 2 })
    expect(page.result).toEqual({
      items: [
        { key: "u1:text", messageID: "u1", sessionID: "ses_a", kind: "user", text: "Please inspect it", at: 1 },
        { key: "a1:0", messageID: "a1", partID: "0", sessionID: "ses_a", kind: "reasoning", text: "## Inspecting\nI will read the file.", state: "done", at: 2, completed: 4 },
      ],
      cursor: "2",
    })
    const second = await server.request({ op: "timeline", sessionID: "ses_a", limit: 20, cursor: "2" })
    expect((second.result as any).items.map((x: any) => x.kind)).toEqual(["tool", "assistant"])
    const detail = await server.request({ op: "timelinePart", sessionID: "ses_a", messageID: "a1", partID: "1" })
    expect(detail.result).toEqual({ detail: { name: "read", state: { status: "completed", input: { filePath: "/work/a.ts" }, content: [{ type: "text", text: "FULL OUTPUT" }] }, time: { created: 4, completed: 6 } } })
    expect((await server.request({ op: "timelinePart", sessionID: "ses_a", messageID: "other", partID: "1" })).ok).toBe(false)
  })

  test("newest-first pages walk back by key, stay stable as messages arrive, and read OpenCode once while paging", async () => {
    const { spoke, server, host, messages } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    let reads = 0
    const read = host.context.bind(host)
    host.context = async (sessionID) => {
      reads++
      return read(sessionID)
    }
    const conversation = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? { id: `a${i}`, type: "assistant", content: [{ type: "text", text: `answer ${i}` }] } : { id: `u${i}`, type: "user", text: `question ${i}` }))
    messages.set("ses_a", conversation(10))
    const first = (await server.request({ op: "timeline", sessionID: "ses_a", limit: 4, order: "desc" })).result as any
    expect(first.items.map((x: any) => x.key)).toEqual(["u6:text", "a7:0", "u8:text", "a9:0"])
    expect(first.older).toBe("u6:text")
    expect(first.cursor).toBeUndefined()
    // New messages arrive (in OpenCode) before the older page is asked for: the cursor still points at the same place.
    messages.set("ses_a", conversation(14))
    const second = (await server.request({ op: "timeline", sessionID: "ses_a", limit: 4, before: first.older })).result as any
    expect(second.items.map((x: any) => x.key)).toEqual(["u2:text", "a3:0", "u4:text", "a5:0"])
    const third = (await server.request({ op: "timeline", sessionID: "ses_a", limit: 4, before: second.older })).result as any
    expect(third.items.map((x: any) => x.key)).toEqual(["u0:text", "a1:0"])
    expect(third.older).toBeUndefined()
    // The first page read OpenCode; the older pages came from the short-lived cache.
    expect(reads).toBe(1)
    // A change of the session drops the cache: the next older page reads again.
    host.push({ type: "session.text.ended", data: { sessionID: "ses_a", messageID: "a13" } })
    await Bun.sleep(20)
    await server.request({ op: "timeline", sessionID: "ses_a", limit: 4, before: "u4:text" })
    expect(reads).toBe(2)
    // A new first page always reads OpenCode (it shows the newest rows).
    const fresh = (await server.request({ op: "timeline", sessionID: "ses_a", limit: 2, order: "desc" })).result as any
    expect(fresh.items.map((x: any) => x.key)).toEqual(["u12:text", "a13:0"])
    expect(reads).toBe(3)
    const bad = await server.request({ op: "timeline", sessionID: "ses_a", limit: 4, before: "gone:text" })
    expect(bad.ok).toBe(false)
    expect((bad as any).error).toContain("Invalid timeline cursor")
  })
})

// ---------- image attachments ----------

describe("prompt images", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64")
  const images = [{ mime: "image/png", data: png, name: "shot.png" }, { mime: "image/png", data: png }]
  const files = [{ uri: `data:image/png;base64,${png}`, name: "shot.png" }, { uri: `data:image/png;base64,${png}` }]

  test("turn passes images to OpenCode as inline data-URL attachments", async () => {
    const { spoke, server, host, calls, messages } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    const response = server.request({ op: "turn", sessionID: "ses_a", text: "", voiceStyle: false, images })
    await until(() => calls.prompt.length === 1)
    expect(calls.prompt[0]).toEqual({ sessionID: "ses_a", text: "", files, metadata: { source: "hub" } })
    messages.set("ses_a", [{ id: "msg_1", type: "user", text: "" }, { id: "a1", type: "assistant", content: [{ type: "text", text: "A screenshot." }] }])
    host.push({ type: "session.inbox.delivered", data: { sessionID: "ses_a", inboxID: "msg_1" } })
    host.push({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    expect(await response).toMatchObject({ ok: true, result: { outcome: "succeeded", reply: "A screenshot." } })
  })

  test("steer passes images too; prompts without images carry no files", async () => {
    const { spoke, server, calls } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    await server.request({ op: "steer", sessionID: "ses_a", text: "look", images })
    await server.request({ op: "steer", sessionID: "ses_a", text: "plain" })
    expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_a", text: "look", delivery: "steer", files })
    expect(calls.prompt[1]).not.toHaveProperty("files")
  })

  test("timeline lists user attachments (image-only messages too) and timelineFile serves image bytes", async () => {
    const { spoke, server, host, messages } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    const big = "A".repeat(950_000)
    messages.set("ses_a", [
      { id: "u1", type: "user", text: "what is this?", time: { created: 1 }, files: [
        { data: png, mime: "image/png", source: { type: "inline" }, name: "shot.png" },
        { data: "aGVsbG8=", mime: "text/plain", source: { type: "uri", uri: "file:///work/notes.txt" }, name: "notes.txt" },
      ] },
      { id: "u2", type: "user", text: "", time: { created: 2 }, files: [{ data: big, mime: "image/jpeg", source: { type: "inline" } }] },
      { id: "u3", type: "user", text: "", time: { created: 3 } },
    ])
    const page = await server.request({ op: "timeline", sessionID: "ses_a" })
    expect((page.result as any).items).toEqual([
      { key: "u1:text", messageID: "u1", sessionID: "ses_a", kind: "user", text: "what is this?", at: 1, files: [
        { index: 0, mime: "image/png", name: "shot.png" },
        { index: 1, mime: "text/plain", name: "notes.txt" },
      ] },
      { key: "u2:text", messageID: "u2", sessionID: "ses_a", kind: "user", text: "", at: 2, files: [{ index: 0, mime: "image/jpeg" }] },
    ])
    const file = await server.request({ op: "timelineFile", sessionID: "ses_a", messageID: "u1", index: 0 })
    expect(file.result).toEqual({ file: { mime: "image/png", data: png, name: "shot.png" } })
    // Only images are served; missing ones answer without a file; too big ones say so.
    expect((await server.request({ op: "timelineFile", sessionID: "ses_a", messageID: "u1", index: 1 })).result).toEqual({})
    expect((await server.request({ op: "timelineFile", sessionID: "ses_a", messageID: "u1", index: 5 })).result).toEqual({})
    expect((await server.request({ op: "timelineFile", sessionID: "ses_a", messageID: "nope", index: 0 })).result).toEqual({})
    expect((await server.request({ op: "timelineFile", sessionID: "ses_a", messageID: "u2", index: 0 })).result).toEqual({ tooLarge: true })
  })
})

// ---------- 0.4: open sessions first ----------

const herdrAgent = (sessionID: string, extra: Record<string, unknown> = {}) => ({
  agent: "opencode",
  agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: sessionID },
  agent_status: "working",
  cwd: "/home/user/app",
  pane_id: "w5:p1",
  tab_id: "w5:t1",
  terminal_title_stripped: "OC | Fix login",
  workspace_id: "w5",
  ...extra,
})

/** A fake `herdr` answering list commands from mutable state and recording every call. */
function fakeHerdr(state: { agents: unknown[]; down?: boolean; tab?: string | Error; start?: string | Error }) {
  const calls: string[][] = []
  const run: HerdrRunner = async (args) => {
    calls.push(args)
    if (state.down) throw new Error("herdr server is not running")
    const key = `${args[0]} ${args[1]}`
    if (key === "agent list") return JSON.stringify({ result: { agents: state.agents, type: "agent_list" } })
    if (key === "workspace list")
      return JSON.stringify({ result: { workspaces: [{ workspace_id: "w5", label: "app", number: 1 }, { workspace_id: "w7", label: "notes", number: 2 }] } })
    if (key === "pane list") return JSON.stringify({ result: { panes: [{ workspace_id: "w5", cwd: "/home/user/app" }, { workspace_id: "w7", cwd: "/home/user/notes" }] } })
    const answer = key === "tab create" ? state.tab : key === "agent start" ? state.start : undefined
    if (answer instanceof Error) throw answer
    if (answer !== undefined) return answer
    throw new Error(`unexpected herdr ${args.join(" ")}`)
  }
  return { run, calls }
}

const lastTerminals = (server: FakeCentral) => server.frames.filter((f) => f.t === "terminals").at(-1) as any

describe("open sessions (0.4)", () => {
  test("the service marks sessions open in Herdr, fetches open sessions outside the window, and sends the workspaces", async () => {
    const herdr = fakeHerdr({ agents: [herdrAgent("ses_open")] })
    const listings: unknown[] = []
    const listRecent: SpokeHost["listRecent"] = async (options) => {
      listings.push(options)
      const include = options?.include ?? []
      return [
        { id: "ses_recent", title: "Recent", directory: "/home/user/app", updated: 10, project: "/home/user/app", projectName: "app" },
        ...(include.includes("ses_open") ? [{ id: "ses_open", title: "Old but open", directory: "/home/user/app", updated: 1, project: "/home/user/app", projectName: "app" }] : []),
      ]
    }
    const { spoke, server } = setup({ mode: "always", token: "tok", list: { days: 7, max: 20 } }, { kind: "service", listRecent, herdr: herdr.run })
    await until(() => spoke.status().connection === "connected")
    await until(() => lastSessions(server)?.sessions.some((s) => s.id === "ses_open") === true)
    expect(lastSessions(server)?.sessions.find((s) => s.id === "ses_open")).toMatchObject({
      open: true,
      terminal: { source: "herdr", workspaceID: "w5", workspace: "app", title: "Fix login", status: "working" },
    })
    expect(lastSessions(server)?.sessions.find((s) => s.id === "ses_recent")).not.toHaveProperty("open")
    expect(listings.at(-1)).toMatchObject({ days: 7, max: 20, include: ["ses_open"] })
    await until(() => lastTerminals(server) !== undefined)
    expect(lastTerminals(server)).toEqual({
      t: "terminals",
      herdr: {
        workspaces: [
          { id: "w5", label: "app", directories: ["/home/user/app"] },
          { id: "w7", label: "notes", directories: ["/home/user/notes"] },
        ],
      },
    })
  })

  test("closing the Herdr pane or losing Herdr clears open and the terminals", async () => {
    const state: { agents: unknown[]; down?: boolean } = { agents: [herdrAgent("ses_a")] }
    const herdr = fakeHerdr(state)
    const { spoke, server, host } = setup({ mode: "always", token: "tok" }, { kind: "service", herdr: herdr.run })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.find((s) => s.id === "ses_a")?.open === true)
    state.agents = []
    await until(() => lastSessions(server)?.sessions.find((s) => s.id === "ses_a")?.open === undefined)
    state.down = true
    await until(() => lastTerminals(server)?.herdr === undefined)
    expect(lastTerminals(server)).toEqual({ t: "terminals" })
  })

  test("standalone processes never run herdr; config herdr:false turns the service's reader off", async () => {
    const standalone = fakeHerdr({ agents: [herdrAgent("ses_a")] })
    const a = setup({ mode: "always", token: "tok" }, { herdr: standalone.run })
    const off = fakeHerdr({ agents: [herdrAgent("ses_a")] })
    const b = setup({ mode: "always", token: "tok", herdr: false }, { kind: "service", herdr: off.run })
    await until(() => a.spoke.status().connection === "connected" && b.spoke.status().connection === "connected")
    await Bun.sleep(100)
    expect(standalone.calls).toEqual([])
    expect(off.calls).toEqual([])
    expect(a.server.frames.some((f) => f.t === "terminals")).toBe(false)
  })

  test("TUI presence marks sessions open (source tui), fetches unknown ones, and a new report replaces the old", async () => {
    const { spoke, server, host, calls } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    await until(() => lastSessions(server)?.sessions.length === 1)
    spoke.presence(["ses_a", "ses_unknown", "bogus"], "tui_1")
    await until(() => lastSessions(server)?.sessions.length === 2)
    const sessions = lastSessions(server)!.sessions
    expect(sessions.find((s) => s.id === "ses_a")).toMatchObject({ open: true, terminal: { source: "tui" } })
    expect(sessions.find((s) => s.id === "ses_unknown")).toMatchObject({ title: "Fetched ses_unknown", open: true, owned: false })
    expect(calls.get).toContain("ses_unknown")
    spoke.presence(["ses_unknown"], "tui_1")
    await until(() => lastSessions(server)?.sessions.find((s) => s.id === "ses_a")?.open === undefined)
  })

  test("Herdr wins over TUI presence", async () => {
    const herdr = fakeHerdr({ agents: [herdrAgent("ses_a")] })
    const { spoke, server, host } = setup({ mode: "always", token: "tok" }, { kind: "service", herdr: herdr.run })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    spoke.presence(["ses_a"], "tui_1")
    await until(() => lastSessions(server)?.sessions.find((s) => s.id === "ses_a")?.open === true)
    await Bun.sleep(60)
    expect((lastSessions(server)?.sessions.find((s) => s.id === "ses_a") as any).terminal.source).toBe("herdr")
  })

  test("the listing keeps conversation, session-mode and running sessions and asks for them by ID", async () => {
    const listings: Array<{ include?: readonly string[] }> = []
    const listRecent: SpokeHost["listRecent"] = async (options) => {
      listings.push(options ?? {})
      return []
    }
    const { spoke, host } = setup({ mode: "session", token: "tok", sessions: ["ses_shared"] }, { kind: "service", listRecent, options: { seedIntervalMs: 30 } })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_run"))
    host.push({ type: "session.execution.started", data: { sessionID: "ses_run" } })
    await until(() => (listings.at(-1)?.include ?? []).includes("ses_run"))
    expect(listings.at(-1)?.include).toContain("ses_shared")
  })

  test("create opens the session in a new Herdr tab; a Herdr pane folder is a valid directory", async () => {
    const herdr = fakeHerdr({
      agents: [],
      tab: JSON.stringify({ result: { type: "tab_created", tab: { tab_id: "w7:t9" }, root_pane: { pane_id: "w7:p9" } } }),
      start: JSON.stringify({ result: { type: "agent_started" } }),
    })
    const { spoke, server, calls } = setup({ mode: "always", token: "tok" }, { kind: "service", listRecent: async () => [], herdr: herdr.run })
    await until(() => spoke.status().connection === "connected")
    await until(() => lastTerminals(server)?.herdr !== undefined)
    const res = await server.request({ op: "create", directory: "/home/user/notes", title: "Notes idea", herdrWorkspace: "w7" })
    expect(res).toMatchObject({ ok: true, result: { sessionID: "ses_new1", openedIn: "herdr" } })
    expect(calls.create).toEqual([{ directory: "/home/user/notes", title: "Notes idea" }])
    expect(herdr.calls.find((c) => c[0] === "tab")).toEqual(["tab", "create", "--workspace", "w7", "--cwd", "/home/user/notes", "--label", "Notes idea", "--no-focus"])
    expect(herdr.calls.find((c) => c[0] === "agent" && c[1] === "start")?.slice(-3)).toEqual(["--", "--session", "ses_new1"])
    const plain = await server.request({ op: "create", directory: "/home/user/app" })
    expect(plain).toMatchObject({ ok: true, result: { sessionID: "ses_new2" } })
    expect((plain.result as any).openedIn).toBeUndefined()
  })

  test("when Herdr fails the session still exists: no openedIn, a warning", async () => {
    const herdr = fakeHerdr({ agents: [], tab: new Error("workspace_not_found") })
    const { spoke, server, calls } = setup({ mode: "always", token: "tok" }, { kind: "service", listRecent: async () => [], herdr: herdr.run })
    await until(() => spoke.status().connection === "connected")
    await until(() => lastTerminals(server)?.herdr !== undefined)
    const res = await server.request({ op: "create", directory: "/home/user/app", herdrWorkspace: "w5" })
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ sessionID: "ses_new1" })
    expect((res.result as any).openedIn).toBeUndefined()
    expect((res.result as any).warning).toMatch(/herdr/i)
    expect(calls.create).toHaveLength(1)
    const unknown = await server.request({ op: "create", directory: "/home/user/app", herdrWorkspace: "w99" })
    expect((unknown.result as any).warning).toMatch(/w99|workspace/i)
  })
})

describe("running detection: forwarding and seeding", () => {
  const shellInfo = (id: string, sessionID: string) => ({ id, status: "running", command: "sleep 60", cwd: "/w", shell: "bash", file: "/tmp/out", metadata: { sessionID, background: true }, time: { started: 100 } })

  test("shell events go out compact, and an exit without a sessionID is attributed to the shell's session", async () => {
    const { spoke, server, host } = setup({ mode: "always", token: "tok" })
    await until(() => spoke.status().connection === "connected")
    host.push(created("ses_a"))
    host.push({ type: "shell.created", data: { info: shellInfo("sh_1", "ses_a") } })
    host.push({ type: "shell.exited", data: { id: "sh_1", status: "exited", exit: 0 } })
    host.push({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } })
    await until(() => forwarded(server).some((e) => e.type === "session.status"))
    const jobs = forwarded(server).filter((e) => e.type.startsWith("shell."))
    expect(jobs.map((e) => e.data)).toEqual([
      { sessionID: "ses_a", id: "sh_1", kind: "shell", command: "sleep 60", status: "running", background: true, at: 100 },
      { sessionID: "ses_a", id: "sh_1", kind: "shell", status: "exited", exit: 0, at: expect.any(Number) },
    ])
    expect(JSON.stringify(forwarded(server))).not.toContain("/tmp/out")
  })

  test("seeds running sessions and their running shells when connected, and again after reconnecting", async () => {
    let calls = 0
    const { spoke, server, host } = setup({ mode: "always", token: "tok" }, {
      options: {},
    })
    ;(host as any).activity = async () => {
      calls++
      return { active: ["ses_a"], jobs: [{ sessionID: "ses_a", id: "sh_9", kind: "shell", command: "make", status: "running", started: 50 }] }
    }
    host.push(created("ses_a"))
    host.push(created("ses_b"))
    await until(() => spoke.status().connection === "connected")
    await until(() => forwarded(server).some((e) => e.type === "session.seed"), 3000)
    const seed = forwarded(server).find((e) => e.type === "session.seed")!
    expect(seed.data).toEqual({ sessionID: "ses_a", status: { type: "busy" }, jobs: [{ id: "sh_9", kind: "shell", command: "make", status: "running", started: 50 }] })
    // A later exit of the seeded shell is attributed to its session.
    host.push({ type: "shell.exited", data: { id: "sh_9", status: "exited", exit: 0 } })
    await until(() => forwarded(server).some((e) => e.type === "shell.exited"))
    expect(forwarded(server).find((e) => e.type === "shell.exited")!.data.sessionID).toBe("ses_a")
    // Reconnect: seeds again.
    const before = forwarded(server).filter((e) => e.type === "session.seed").length
    server.sockets.at(-1)!.close()
    await until(() => forwarded(server).filter((e) => e.type === "session.seed").length > before, 3000)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test("a session the tracker thought busy is seeded idle when OpenCode no longer lists it as active", async () => {
    let active: string[] = ["ses_a"]
    const { spoke, server, host } = setup({ mode: "always", token: "tok" })
    ;(host as any).activity = async () => ({ active, jobs: [] })
    host.push(created("ses_a"))
    await until(() => spoke.status().connection === "connected")
    await until(() => forwarded(server).some((e) => e.type === "session.seed"))
    active = []
    server.sockets.at(-1)!.close()
    await until(() => forwarded(server).some((e) => e.type === "session.seed" && e.data.status.type === "idle"), 3000)
  })
})
