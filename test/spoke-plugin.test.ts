import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, writeConfig } from "../src/config"
import plugin from "../src/index"
import { EventQueue, fakeCentral, stopServer, until } from "./spoke-fake"

const cleanups: Array<() => unknown> = []

// Plugin setup writes the hub bin dir and the `hub`/`hubctl` launchers under HUB_STATE_DIR: keep them out of ~.
const previousStateDir = process.env.HUB_STATE_DIR
const stateDir = mkdtempSync(path.join(tmpdir(), "voice-plugin-state-"))
beforeAll(() => {
  process.env.HUB_STATE_DIR = stateDir
})
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.HUB_STATE_DIR
  else process.env.HUB_STATE_DIR = previousStateDir
  rmSync(stateDir, { recursive: true, force: true })
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function fakeContext(overrides: { hookThrows?: boolean; registerThrows?: boolean; directory?: string; pending?: Record<string, string>; synthetic?: boolean } = {}) {
  const queue = new EventQueue<{ type: string; data: Record<string, unknown> }>()
  const hooks: Array<(event: any) => void> = []
  const promptHooks: Array<(event: any) => unknown> = []
  const toolHooks: Record<string, (event: any) => void> = {}
  const shellHooks: Record<string, (event: any) => void> = {}
  const transforms: Array<(editor: any) => void> = []
  const tools: Array<{ name: string; description: string; input: unknown; execute: (input: any, context: any) => Promise<any> }> = []
  const interrupts: string[] = []
  const switches: unknown[] = []
  const sessionAgents = new Map<string, string>()
  let handlers: Record<string, (input: unknown, rpc: unknown) => Promise<unknown>> | undefined
  const registered: string[] = []
  const replies: unknown[] = []
  const synthetics: unknown[] = []
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
      hook: async (name: string, fn: (event: any) => void) => {
        if (overrides.hookThrows) throw new Error("hook failed")
        if (name === "prompt") promptHooks.push(fn)
        else hooks.push(fn)
      },
      prompt: async () => ({ id: "msg_1" }),
      // Wrapped like the HTTP API (the plugin unwraps both shapes).
      ...(overrides.synthetic
        ? {
            synthetic: async (input: { sessionID: string; id: string }) => {
              synthetics.push(input)
              return { location: {}, data: { id: input.id, sessionID: input.sessionID, type: "synthetic", time: { created: 1 } } }
            },
          }
        : {}),
      context: async () => [],
      get: async (input: { sessionID: string }) => {
        const agent = sessionAgents.get(input.sessionID)
        return { id: input.sessionID, title: "t", location: { directory: "/d" }, time: { updated: 1 }, ...(agent ? { agent } : {}) }
      },
      switchAgent: async (input: { sessionID: string; agent: string }) => {
        switches.push(input)
        sessionAgents.set(input.sessionID, input.agent)
      },
      interrupt: async (input: { sessionID: string }) => {
        interrupts.push(input.sessionID)
        return { interrupted: true }
      },
    },
    tool: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (tool: (typeof tools)[number]) => tools.push(tool) })
        return { dispose: async () => {} }
      },
      hook: async (name: string, fn: (event: any) => void) => {
        toolHooks[name] = fn
        return { dispose: async () => {} }
      },
    },
    shell: {
      hook: async (name: string, fn: (event: any) => void) => {
        shellHooks[name] = fn
        return { dispose: async () => {} }
      },
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
  return { ctx, hooks, promptHooks, toolHooks, shellHooks, transforms, tools, interrupts, switches, rpc, registered, replies, synthetics, queue, call: (name: string, input: unknown = {}) => handlers![name]!(input, rpc) }
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

  test("hub messages are admitted through OpenCode's session.synthetic; deliver is announced only when it exists", async () => {
    const server = fakeCentral()
    cleanups.push(() => stopServer(server))
    tempConfig({ server: server.url, mode: "always", token: "tok" })
    const fake = fakeContext({ synthetic: true })
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    await until(() => server.frames.some((f) => f.t === "sessions"))
    expect((server.frames.find((f) => f.t === "hello") as any).features).toContain("deliver")
    fake.queue.push({ type: "session.created", data: { sessionID: "ses_a", title: "A" } })
    await until(() => server.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === "ses_a")))
    const res = await server.request({ op: "deliver", sessionID: "ses_a", messageID: "msg_abc", text: "[hub] hi", wake: true, meta: { kind: "msg", from: "@x", to: "@y" } })
    expect(res).toMatchObject({ ok: true, result: { delivered: "turn", inboxID: "msg_abc" } })
    expect(fake.synthetics).toEqual([
      { sessionID: "ses_a", id: "msg_abc", text: "[hub] hi", metadata: { source: "hub", messageID: "msg_abc", kind: "msg", from: "@x", to: "@y" }, delivery: "queue", resume: true },
    ])
  })

  test("an OpenCode without session.synthetic does not announce deliver", async () => {
    const server = fakeCentral()
    cleanups.push(() => stopServer(server))
    tempConfig({ server: server.url, mode: "always", token: "tok" })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    await until(() => server.frames.some((f) => f.t === "sessions"))
    expect((server.frames.find((f) => f.t === "hello") as any).features).not.toContain("deliver")
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

  describe("hub tool (agents message other sessions as themselves)", () => {
    const toolContext = (sessionID: string) => ({ sessionID, signal: new AbortController().signal })

    test("is registered as one hub tool with a verb input, outside code mode", async () => {
      tempConfig({ mode: "off" })
      const fake = fakeContext()
      cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
      const tool = fake.tools.find((t) => t.name === "hub") as any
      expect(tool).toBeDefined()
      expect(tool.description).toMatch(/not from the user/i)
      expect(tool.input.properties.verb.enum).toContain("ask")
      expect(tool.options).toEqual({ codemode: false })
      // No session token without a connected hub: a readable error.
      const result = await tool.execute({ verb: "whoami" }, toolContext("ses_a"))
      expect(result.content).toMatch(/no hub token yet/i)
    })

    async function connected(hubFeatures: readonly string[]) {
      const auth: Array<string | null> = []
      const server = fakeCentral({
        hubFeatures,
        http: (req) => {
          if (new URL(req.url).pathname !== "/api/agent/whoami") return undefined
          auth.push(req.headers.get("authorization"))
          return Response.json({ actor: { kind: "session", userID: "u_1", machineID: "m_1", sessionID: "ses_a" }, user: { id: "u_1" } })
        },
      })
      cleanups.push(() => stopServer(server))
      tempConfig({ server: server.url, mode: "always", token: "tok" })
      const fake = fakeContext()
      cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
      await until(() => server.frames.some((f) => f.t === "sessions"))
      fake.queue.push({ type: "session.created", data: { sessionID: "ses_a", title: "A" } })
      await until(() => server.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === "ses_a")))
      const res = await server.request({ op: "sessionTokens", tokens: [{ sessionID: "ses_a", token: "hst.a-secret", exp: Date.now() + 60_000 }] })
      expect(res).toMatchObject({ ok: true, result: { applied: ["ses_a"] } })
      return { auth, tool: fake.tools.find((t) => t.name === "hub")! }
    }

    test("acts with the calling session's token and never shows it", async () => {
      const { auth, tool } = await connected(["harness", "messaging"])
      const result = await tool.execute({ verb: "whoami" }, toolContext("ses_a"))
      expect(result.content).toContain("ses_a")
      expect(auth).toEqual(["Bearer hst.a-secret"])
      expect(JSON.stringify(result)).not.toContain("hst.a-secret")
      // Another session of this process has no token of its own: it never borrows ses_a's.
      const other = await tool.execute({ verb: "whoami" }, toolContext("ses_b"))
      expect(other.content).toMatch(/no hub token yet/i)
      expect(auth).toHaveLength(1)
    })

    test("refuses messaging verbs when the hub does not announce messaging", async () => {
      const { tool } = await connected(["harness"])
      const result = await tool.execute({ verb: "msg", to: "@bob", text: "hi" }, toolContext("ses_a"))
      expect(result.content).toMatch(/does not support messaging/i)
    })
  })

  describe("prompt references (design §2.4)", () => {
    test("a prompt hook is registered", async () => {
      tempConfig({ mode: "off" })
      const fake = fakeContext()
      cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
      expect(fake.promptHooks).toHaveLength(1)
      // Without a hub it fails open: nothing added, the text unchanged.
      const event = { sessionID: "ses_a", messageID: "msg_1", delivery: "steer", prompt: { text: "ask @bob", files: [], agents: [] } }
      await fake.promptHooks[0]!(event)
      expect(event.prompt).toEqual({ text: "ask @bob", files: [], agents: [] })
    })

    test("a connected session's prompt gets the context file, looked up with its own token", async () => {
      const auth: Array<string | null> = []
      const server = fakeCentral({
        hubFeatures: ["harness", "messaging"],
        http: (req) => {
          const { pathname } = new URL(req.url)
          if (!pathname.startsWith("/api/agent/")) return undefined
          auth.push(req.headers.get("authorization"))
          if (pathname === "/api/agent/who") return Response.json({ sessions: [{ sessionID: "ses_bob", name: "bob", project: "hub", online: true, state: "idle", roles: [] }] })
          if (pathname === "/api/agent/status") return Response.json({ machines: [], attention: [] })
          if (pathname === "/api/agent/inbox") return Response.json({ asks: [], waiting: [], messages: [], muted: [] })
          return undefined
        },
      })
      cleanups.push(() => stopServer(server))
      tempConfig({ server: server.url, mode: "always", token: "tok" })
      const fake = fakeContext()
      cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
      await until(() => server.frames.some((f) => f.t === "sessions"))
      fake.queue.push({ type: "session.created", data: { sessionID: "ses_a", title: "A" } })
      await until(() => server.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === "ses_a")))
      await server.request({ op: "sessionTokens", tokens: [{ sessionID: "ses_a", token: "hst.a-secret", exp: Date.now() + 60_000 }] })
      const event: any = { sessionID: "ses_a", messageID: "msg_1", delivery: "steer", prompt: { text: "ask @bob", files: [], agents: [] } }
      await fake.promptHooks[0]!(event)
      expect(event.prompt.text).toBe("ask @bob")
      expect(event.prompt.files).toHaveLength(1)
      expect(Buffer.from(event.prompt.files[0].uri.split(",")[1], "base64").toString()).toContain("@bob = session ses_bob")
      expect(auth.every((a) => a === "Bearer hst.a-secret")).toBe(true)
      expect(JSON.stringify(event)).not.toContain("hst.a-secret")
    })
  })

  describe("hub_task_stop (the voice agent stops one of its workers)", () => {
    async function setupWorkers() {
      tempConfig({ mode: "always" })
      const fake = fakeContext()
      cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
      const tool = fake.tools.find((t) => t.name === "hub_task_stop")!
      expect(tool).toBeDefined()
      expect(tool.description).toContain("background worker")
      const push = (type: string, data: Record<string, unknown>) => fake.queue.push({ type, data })
      push("session.created", { sessionID: "ses_w1", parentID: "ses_a", title: "Deploy check" })
      push("session.execution.started", { sessionID: "ses_w1" })
      push("session.created", { sessionID: "ses_w1_kid", parentID: "ses_w1", title: "nested" })
      push("session.execution.started", { sessionID: "ses_w1_kid" })
      push("session.created", { sessionID: "ses_w2", parentID: "ses_a", title: "Changelog" })
      push("session.execution.started", { sessionID: "ses_w2" })
      push("session.created", { sessionID: "ses_x", parentID: "ses_other", title: "Someone else's" })
      push("session.execution.started", { sessionID: "ses_x" })
      push("session.execution.started", { sessionID: "ses_a" })
      await until(() => {
        const event = { sessionID: "ses_a", agent: "voice", system: [] as Array<{ text: string }> }
        fake.hooks[0]!(event)
        return event.system.some((p) => p.text.includes("Changelog"))
      })
      const run = (input: unknown, caller = "ses_a") => tool.execute(input, { sessionID: caller, agent: "voice", messageID: "msg", id: "call", signal: new AbortController().signal, progress: async () => {} })
      return { fake, run }
    }

    test("stops the named worker and what runs below it, never the calling session", async () => {
      const { fake, run } = await setupWorkers()
      const result = await run({ sessionID: "ses_w1" })
      expect(fake.interrupts).toEqual(["ses_w1_kid", "ses_w1"])
      expect(JSON.stringify(result)).toContain("Deploy check")
    })

    test("all: true stops every running worker of the caller only", async () => {
      const { fake, run } = await setupWorkers()
      await run({ all: true })
      expect(new Set(fake.interrupts)).toEqual(new Set(["ses_w1_kid", "ses_w1", "ses_w2"]))
      expect(fake.interrupts).not.toContain("ses_a")
      expect(fake.interrupts).not.toContain("ses_x")
    })

    test("refuses the caller itself, other sessions' workers and unknown IDs", async () => {
      const { fake, run } = await setupWorkers()
      for (const sessionID of ["ses_a", "ses_x", "ses_nope"]) {
        const result = await run({ sessionID })
        expect(JSON.stringify(result)).toContain("not one of your workers")
      }
      // Another session cannot stop ses_a's workers either.
      expect(JSON.stringify(await run({ sessionID: "ses_w1" }, "ses_other"))).toContain("not one of your workers")
      expect(JSON.stringify(await run({}))).toContain("sessionID")
      expect(fake.interrupts).toEqual([])
    })
  })

  test("conversation RPC refuses sessions that are not shared", async () => {
    tempConfig({ mode: "session", sessions: ["ses_a"] })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(await fake.call("conversation", { sessionID: "ses_b", on: true })).toMatchObject({ type: "invalid" })
    expect(fake.switches).toEqual([])
  })
})

describe("session env injection hooks", () => {
  function tempStateDir() {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-state-"))
    const previous = process.env.HUB_STATE_DIR
    process.env.HUB_STATE_DIR = dir
    cleanups.push(() => {
      if (previous === undefined) delete process.env.HUB_STATE_DIR
      else process.env.HUB_STATE_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    })
    return dir
  }
  const shellCall = (sessionID: string, command: string) => ({ tool: "shell", sessionID, agent: "build", messageID: "msg_1", id: `call_${sessionID}`, input: { command } })
  const invocation = (command: string, env: Record<string, string | undefined>) => ({ command, cwd: "/w", timeout: 0, shell: "/bin/sh", env })

  test("setup strips an inherited HUB_URL/HUB_SESSION_TOKEN from the process and creates the hub bin dir", async () => {
    tempConfig({ mode: "off" })
    const state = tempStateDir()
    const saved = { url: process.env.HUB_URL, token: process.env.HUB_SESSION_TOKEN }
    cleanups.push(() => {
      for (const [name, value] of [["HUB_URL", saved.url], ["HUB_SESSION_TOKEN", saved.token]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })
    process.env.HUB_URL = "http://outer.example"
    process.env.HUB_SESSION_TOKEN = "outer-token"
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(process.env.HUB_URL).toBeUndefined()
    expect(process.env.HUB_SESSION_TOKEN).toBeUndefined()
    const bin = path.join(state, "bin")
    expect(existsSync(bin) && statSync(bin).isDirectory()).toBe(true)
  })

  test("setup writes the hub and hubctl launchers running the CLI with this runtime", async () => {
    tempConfig({ mode: "off" })
    const state = tempStateDir()
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    for (const name of ["hub", "hubctl"]) {
      const file = path.join(state, "bin", name)
      expect(statSync(file).mode & 0o777).toBe(0o755)
      const script = readFileSync(file, "utf8")
      expect(script).toContain(`BUN_BE_BUN=1 '${process.execPath}'`)
      expect(script).toMatch(/packages\/cli\/(dist\/hub-cli\.js|src\/main\.ts)'/)
    }
  })

  test("registers tool execute.before/after and shell create.before; an unmatched shell is stripped and gets PATH", async () => {
    tempConfig({ mode: "off" })
    const state = tempStateDir()
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(Object.keys(fake.toolHooks).sort()).toEqual(["execute.after", "execute.before"])
    expect(Object.keys(fake.shellHooks)).toEqual(["create.before"])
    const inv = invocation("ls", { HUB_SESSION_TOKEN: "outer", HUB_URL: "http://outer", PATH: "/usr/bin" })
    fake.shellHooks["create.before"]!(inv)
    expect(inv.env.HUB_SESSION_TOKEN).toBeUndefined()
    expect(inv.env.HUB_URL).toBeUndefined()
    expect(inv.env.PATH).toBe(`${path.join(state, "bin")}${path.delimiter}/usr/bin`)
  })

  test("a session's shell tool call gets the session's token and the spoke's server as HUB_URL", async () => {
    const server = fakeCentral()
    cleanups.push(() => stopServer(server))
    tempConfig({ server: server.url, mode: "always", token: "tok" })
    tempStateDir()
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    await until(() => server.frames.some((f) => f.t === "sessions"))
    fake.queue.push({ type: "session.created", data: { sessionID: "ses_a", title: "A" } })
    await until(() => server.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === "ses_a")))
    const res = await server.request({ op: "sessionTokens", tokens: [{ sessionID: "ses_a", token: "hst.a", exp: Date.now() + 60_000 }] })
    expect(res).toMatchObject({ ok: true, result: { applied: ["ses_a"] } })

    fake.toolHooks["execute.before"]!(shellCall("ses_a", "hub whoami"))
    const inv = invocation("hub whoami", { HUB_SESSION_TOKEN: "outer", PATH: "/usr/bin" })
    fake.shellHooks["create.before"]!(inv)
    expect(inv.env.HUB_SESSION_TOKEN).toBe("hst.a")
    expect(inv.env.HUB_URL).toBe(server.url)

    // The same command later without a tool call (e.g. a user ! command) gets no token.
    const again = invocation("hub whoami", {})
    fake.shellHooks["create.before"]!(again)
    expect(again.env.HUB_SESSION_TOKEN).toBeUndefined()
  })

  test("survives a server without tool/shell hooks", async () => {
    tempConfig({ mode: "off" })
    tempStateDir()
    const fake = fakeContext()
    delete (fake.ctx as any).shell
    ;(fake.ctx as any).tool.hook = async () => {
      throw new Error("no hooks")
    }
    const cleanup = await plugin.setup(fake.ctx as any)
    expect(typeof cleanup).toBe("function")
    ;(cleanup as () => void)()
  })
})
