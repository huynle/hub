import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, writeConfig } from "../src/config"
import plugin from "../src/index"
import { EventQueue, fakeCentral, stopServer, until } from "./spoke-fake"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function fakeContext(overrides: { hookThrows?: boolean; registerThrows?: boolean; directory?: string; pending?: Record<string, string> } = {}) {
  const queue = new EventQueue<{ type: string; data: Record<string, unknown> }>()
  const hooks: Array<(event: any) => void> = []
  const transforms: Array<(editor: any) => void> = []
  const switches: unknown[] = []
  const sessionAgents = new Map<string, string>()
  let handlers: Record<string, (input: unknown, rpc: unknown) => Promise<unknown>> | undefined
  const registered: string[] = []
  const replies: unknown[] = []
  const ctx = {
    location: { directory: overrides.directory ?? "/work/project" },
    app: { name: "opencode", version: "2.0.25", channel: "latest" },
    options: {},
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => queue.iterate(signal) },
    agent: {
      transform: async (fn: (editor: any) => void) => {
        transforms.push(fn)
        return { dispose: async () => {} }
      },
      // Wrapped like the HTTP API; the plugin must unwrap both shapes.
      get: async (input: { agentID: string }) => {
        if (input.agentID !== "voice") throw new Error("not found")
        return { location: {}, data: { id: "voice" } }
      },
      list: async () => ({ location: {}, data: [{ id: "build", mode: "primary", hidden: false }, { id: "voice", mode: "primary", hidden: false }] }),
    },
    session: {
      hook: async (_name: string, fn: (event: any) => void) => {
        if (overrides.hookThrows) throw new Error("hook failed")
        hooks.push(fn)
      },
      prompt: async () => ({ id: "msg_1" }),
      context: async () => [],
      get: async (input: { sessionID: string }) => {
        const agent = sessionAgents.get(input.sessionID)
        return { id: input.sessionID, title: "t", location: { directory: "/d" }, time: { updated: 1 }, ...(agent ? { agent } : {}) }
      },
      switchAgent: async (input: { sessionID: string; agent: string }) => {
        switches.push(input)
        sessionAgents.set(input.sessionID, input.agent)
      },
      interrupt: async () => ({ interrupted: true }),
    },
    // Location-scoped like OpenCode's: only requests pending in this instance's location are found.
    permission: {
      get: async (input: { sessionID: string; requestID: string }) => {
        if (overrides.pending?.[input.requestID] !== input.sessionID) throw new Error(`Permission request not found: ${input.requestID}`)
        return { id: input.requestID }
      },
      reply: async (input: { sessionID: string; requestID: string; decision: string }) => {
        if (overrides.pending?.[input.requestID] !== input.sessionID) throw new Error(`Permission request not found: ${input.requestID}`)
        replies.push(input)
        delete overrides.pending[input.requestID]
      },
    },
    rpc: {
      register: async (def: { id: string }, impl: typeof handlers) => {
        if (overrides.registerThrows) throw new Error("register failed")
        registered.push(def.id)
        handlers = impl
        return { dispose: async () => {} }
      },
    },
  }
  const rpc = { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  return { ctx, hooks, transforms, switches, rpc, registered, replies, queue, call: (name: string, input: unknown = {}) => handlers![name]!(input, rpc) }
}

function tempConfig(config: Partial<ReturnType<typeof defaults>>) {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-plugin-"))
  const file = path.join(dir, "config.json")
  writeConfig(file, { ...defaults("box"), ...config })
  const previous = process.env.HUB_SPOKE_CONFIG
  process.env.HUB_SPOKE_CONFIG = file
  cleanups.push(() => {
    if (previous === undefined) delete process.env.HUB_SPOKE_CONFIG
    else process.env.HUB_SPOKE_CONFIG = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return file
}

describe("plugin setup", () => {
  test("never throws or blocks when the server is unreachable; RPC reports the error", async () => {
    tempConfig({ server: "http://127.0.0.1:1", mode: "always", token: "tok" })
    const fake = fakeContext()
    const started = Date.now()
    const cleanup = await plugin.setup(fake.ctx as any)
    cleanups.push(() => (cleanup as () => void)?.())
    expect(Date.now() - started).toBeLessThan(500)
    expect(fake.hooks).toHaveLength(1)
    let status: any
    await until(() => {
      void fake.call("status").then((s) => (status = s))
      return status?.connection === "error"
    })
    expect(status).toMatchObject({ server: "http://127.0.0.1:1", mode: "always", enrolled: true, kind: "standalone" })
    expect(status.lastError).toBeTruthy()
  })

  test("is the hub plugin and serves its RPC as \"hub\" and the legacy \"voice\" id", async () => {
    tempConfig({ mode: "off" })
    const fake = fakeContext()
    expect(plugin.id).toBe("hub")
    const cleanup = (await plugin.setup(fake.ctx as any)) as () => void
    cleanups.push(cleanup)
    expect(fake.registered).toEqual(["hub", "voice"])
  })

  test("survives hook and RPC registration failures", async () => {
    tempConfig({ mode: "off" })
    const fake = fakeContext({ hookThrows: true, registerThrows: true })
    const cleanup = await plugin.setup(fake.ctx as any)
    expect(typeof cleanup).toBe("function")
    ;(cleanup as () => void)()
  })

  test("a second instance in the process is passive and delegates RPC to the active spoke", async () => {
    tempConfig({ mode: "off" })
    const a = fakeContext()
    const b = fakeContext()
    const cleanA = (await plugin.setup(a.ctx as any)) as () => void
    const cleanB = (await plugin.setup(b.ctx as any)) as () => void
    expect(await b.call("status")).toMatchObject({ mode: "off", connection: "off" })
    expect(await b.call("setMode", { mode: "loud" })).toMatchObject({ type: "invalid" })
    expect(await b.call("pairCode")).toMatchObject({ type: "not_connected" })
    cleanA()
    expect(await b.call("status")).toMatchObject({ mode: "off" })
    cleanB()
    expect(await b.call("status")).toMatchObject({ type: "unavailable" })
  })

  test("a permission is answered through the plugin instance of the location that holds it", async () => {
    const server = fakeCentral()
    cleanups.push(() => stopServer(server))
    tempConfig({ server: server.url, mode: "always", token: "tok" })
    const a = fakeContext({ directory: "/a" })
    const b = fakeContext({ directory: "/b", pending: { per_1: "ses_child" } })
    cleanups.push((await plugin.setup(a.ctx as any)) as () => void)
    cleanups.push((await plugin.setup(b.ctx as any)) as () => void)
    // Connected once the spoke got the welcome (it answers with its sessions frame).
    await until(() => server.frames.some((f) => f.t === "sessions"))
    const res = await server.request({ op: "permission", sessionID: "ses_child", requestID: "per_1", decision: "once" })
    expect(res).toMatchObject({ ok: true, result: {} })
    expect(b.replies).toEqual([{ sessionID: "ses_child", requestID: "per_1", decision: "once" }])
    expect(a.replies).toEqual([])
    const again = await server.request({ op: "permission", sessionID: "ses_child", requestID: "per_1", decision: "once" })
    expect(again).toMatchObject({ ok: true, result: { gone: true } })
  })

  test("formActions RPC hands relayed form replies to a polling TUI", async () => {
    tempConfig({ mode: "off" })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(await fake.call("formActions", { waitMs: 0 })).toEqual({ actions: [] })
    expect(await fake.call("formActions", { waitMs: "soon" })).toMatchObject({ type: "invalid" })
  })

  test("presence RPC takes the TUI's sessions; anything but a list is refused", async () => {
    tempConfig({ mode: "off" })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(await fake.call("presence", { sessionIDs: ["ses_a", 3], reporter: "tui_1" })).toEqual({})
    expect(await fake.call("presence", { sessionIDs: "ses_a" })).toMatchObject({ type: "invalid" })
  })

  test("checkServer validates the URL and asks <server>/healthz from this machine", async () => {
    tempConfig({ mode: "off" })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(await fake.call("checkServer", { server: "ftp://x.example" })).toMatchObject({ type: "invalid" })
    const hub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, version: "1.2.3" }) })
    cleanups.push(() => stopServer(hub))
    expect(await fake.call("checkServer", { server: `http://127.0.0.1:${hub.port}/` })).toEqual({ ok: true, version: "1.2.3" })
  })

  test("the context hook adds the voice style only during voice turns", async () => {
    tempConfig({ mode: "off" })
    const fake = fakeContext()
    const cleanup = (await plugin.setup(fake.ctx as any)) as () => void
    cleanups.push(cleanup)
    const event = { sessionID: "ses_a", system: [] as unknown[] }
    fake.hooks[0]!(event)
    expect(event.system).toEqual([])
  })

  test("registers the voice agent through an agent transform", async () => {
    tempConfig({ mode: "off" })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(fake.transforms).toHaveLength(1)
    const agents = new Map<string, any>([["build", { id: "build", permissions: ["rule"] }]])
    fake.transforms[0]!({
      get: (id: string) => agents.get(id),
      update: (id: string, fn: (a: any) => void) => {
        const a = agents.get(id) ?? { id, permissions: [] }
        agents.set(id, a)
        fn(a)
      },
    })
    expect(agents.get("voice")).toMatchObject({ name: "Voice", mode: "primary", permissions: ["rule"] })
  })

  test("conversation RPC switches to the voice agent; the context hook adds the delegate note", async () => {
    tempConfig({ mode: "always", subagent: "tdd-dev" })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(await fake.call("conversation", { sessionID: "ses_a", on: true })).toEqual({ agent: "voice" })
    expect(fake.switches).toEqual([{ sessionID: "ses_a", agent: "voice" }])
    expect(await fake.call("status", { sessionID: "ses_a" })).toMatchObject({ conversation: true })

    const voice = { sessionID: "ses_a", agent: "voice", system: [] as Array<{ text: string }> }
    fake.hooks[0]!(voice)
    expect(voice.system).toHaveLength(1)
    expect(voice.system[0]!.text).toContain('agent "tdd-dev"')

    expect(await fake.call("conversation", { sessionID: "ses_a", on: false })).toEqual({ agent: "build" })
    expect(await fake.call("status", { sessionID: "ses_a" })).toMatchObject({ conversation: false })
    const plain = { sessionID: "ses_a", agent: "build", system: [] as unknown[] }
    fake.hooks[0]!(plain)
    expect(plain.system).toEqual([])
  })

  test("conversation mode on another agent gets the whole orchestrator prompt from the hook", async () => {
    tempConfig({ mode: "always" })
    const fake = fakeContext()
    ;(fake.ctx.agent as any).get = async () => {
      throw new Error("not found")
    }
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(await fake.call("conversation", { sessionID: "ses_a", on: true })).toEqual({ agent: "build" })
    expect(fake.switches).toEqual([])
    const event = { sessionID: "ses_a", agent: "build", system: [] as Array<{ text: string }> }
    fake.hooks[0]!(event)
    expect(event.system).toHaveLength(2)
    expect(event.system[0]!.text).toContain("read aloud")
    expect(event.system[1]!.text).toContain('agent "general"')
  })

  test("the context hook gives the voice agent a live task board of its workers (not other sessions')", async () => {
    tempConfig({ mode: "always" })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    await fake.call("conversation", { sessionID: "ses_a", on: true })
    fake.queue.push({ type: "session.created", data: { sessionID: "ses_w1", parentID: "ses_a", title: "Deploy check" } })
    fake.queue.push({ type: "session.execution.started", data: { sessionID: "ses_w1" } })
    fake.queue.push({ type: "session.created", data: { sessionID: "ses_w2", parentID: "ses_a", title: "Changelog" } })
    fake.queue.push({ type: "session.execution.started", data: { sessionID: "ses_w2" } })
    fake.queue.push({ type: "session.created", data: { sessionID: "ses_x", parentID: "ses_other", title: "Someone else" } })
    const board = () => {
      const event = { sessionID: "ses_a", agent: "voice", system: [] as Array<{ text: string }> }
      fake.hooks[0]!(event)
      return event.system.map((p) => p.text).find((t) => t.startsWith("Task board"))
    }
    await until(() => board()?.includes("Changelog") ?? false)
    expect(board()).toContain('"Deploy check" (sessionID ses_w1): working')
    expect(board()).not.toContain("Someone else")
    // A plain session (no conversation, not the voice agent) gets nothing.
    const plain = { sessionID: "ses_other", agent: "build", system: [] as unknown[] }
    fake.hooks[0]!(plain)
    expect(plain.system).toEqual([])
  })

  test("conversation RPC refuses sessions that are not shared", async () => {
    tempConfig({ mode: "session", sessions: ["ses_a"] })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(await fake.call("conversation", { sessionID: "ses_b", on: true })).toMatchObject({ type: "invalid" })
    expect(fake.switches).toEqual([])
  })
})
