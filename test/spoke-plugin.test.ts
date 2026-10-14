import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, writeConfig } from "../src/config"
import plugin from "../src/index"
import { EventQueue, stopServer, until } from "./spoke-fake"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function fakeContext(overrides: { hookThrows?: boolean; registerThrows?: boolean } = {}) {
  const queue = new EventQueue<{ type: string; data: Record<string, unknown> }>()
  const hooks: Array<(event: any) => void> = []
  const transforms: Array<(editor: any) => void> = []
  const switches: unknown[] = []
  const sessionAgents = new Map<string, string>()
  let handlers: Record<string, (input: unknown, rpc: unknown) => Promise<unknown>> | undefined
  const ctx = {
    location: { directory: "/work/project" },
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
    permission: { reply: async () => {} },
    rpc: {
      register: async (_def: unknown, impl: typeof handlers) => {
        if (overrides.registerThrows) throw new Error("register failed")
        handlers = impl
        return { dispose: async () => {} }
      },
    },
  }
  const rpc = { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  return { ctx, hooks, transforms, switches, rpc, call: (name: string, input: unknown = {}) => handlers![name]!(input, rpc) }
}

function tempConfig(config: Partial<ReturnType<typeof defaults>>) {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-plugin-"))
  const file = path.join(dir, "config.json")
  writeConfig(file, { ...defaults("box"), ...config })
  const previous = process.env.OPENCODE_HUB_CONFIG
  process.env.OPENCODE_HUB_CONFIG = file
  cleanups.push(() => {
    if (previous === undefined) delete process.env.OPENCODE_HUB_CONFIG
    else process.env.OPENCODE_HUB_CONFIG = previous
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

  test("conversation RPC refuses sessions that are not shared", async () => {
    tempConfig({ mode: "session", sessions: ["ses_a"] })
    const fake = fakeContext()
    cleanups.push((await plugin.setup(fake.ctx as any)) as () => void)
    expect(await fake.call("conversation", { sessionID: "ses_b", on: true })).toMatchObject({ type: "invalid" })
    expect(fake.switches).toEqual([])
  })
})
