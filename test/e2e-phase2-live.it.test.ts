// OPT-IN live check of phase 2 messaging (P2-T16): runs only with HUB_IT_OPENCODE=1 and `opencode` on PATH. A real
// in-process hub, a private `opencode serve` (own port, password and XDG dirs; never the user's service) loading
// this checkout as its plugin, connected to the hub with a machine token, and a local stub OpenAI-compatible model.
// Two sessions: session 1's model calls the `hub` tool's msg verb to session 2 (as session 1, with the token the hub
// pushed); session 2's model is then handed the hub envelope (a turn the delivery started). The stub records it.
//
//   HUB_IT_OPENCODE=1 bun test test/e2e-phase2-live.it.test.ts
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, writeConfig } from "../src/config"
import { harness, waitFor } from "./central-harness"
import { until } from "./spoke-fake"

// End to end: real hubs, spokes, nodes and git; give each test room on a loaded machine.
setDefaultTimeout(30_000)

const enabled = process.env.HUB_IT_OPENCODE === "1"
const opencode = enabled ? Bun.which("opencode") : null
if (enabled && !opencode) console.warn("[it] HUB_IT_OPENCODE=1 but `opencode` is not on PATH; skipping")
const run = enabled && opencode !== null
const ROOT = path.resolve(import.meta.dir, "..")
const SEND = "IT-SEND-TO-PEER"
const BODY = "hello from session one (live check)"

/**
 * A stub chat model. A request whose user text asks to SEND (and has no tool result yet) calls the `hub` tool with
 * {verb: msg, to: <peer>, text: BODY}; everything else answers "ack". Every request's user text is recorded.
 */
function stubModel(peer: () => string) {
  const users: string[] = []
  const toolResults: string[] = []
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  const chunk = (delta: unknown, finish: string | null) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })
  const text = (content: unknown): string =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") : ""
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
      const messages = body.messages ?? []
      const user = messages.filter((m) => m.role === "user").map((m) => text(m.content)).join("\n")
      users.push(user)
      const results = messages.filter((m) => m.role === "tool").map((m) => text(m.content))
      toolResults.push(...results)
      const offersHub = (body.tools ?? []).some((t) => t.function?.name === "hub")
      if (offersHub && user.includes(SEND) && results.length === 0) {
        const call = { index: 0, id: "call_msg_1", type: "function", function: { name: "hub", arguments: JSON.stringify({ verb: "msg", to: peer(), text: BODY }) } }
        return sse([chunk({ role: "assistant", tool_calls: [call] }, null), chunk({}, "tool_calls")])
      }
      return sse([chunk({ role: "assistant", content: "ack" }, null), chunk({}, "stop")])
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, users, toolResults, stop: () => server.stop(true) }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port!
  s.stop(true)
  return port
}

describe.skipIf(!run)("live: a session messages another through a real hub", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("session 1's model calls hub msg; session 2's model is handed the envelope", async () => {
    const h = await harness()
    cleanups.push(() => h.stop())
    const machine = await h.store.addMachine("it-box")
    let peer = ""
    const model = stubModel(() => peer)
    cleanups.push(() => model.stop())
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-p2-"))
    cleanups.push(() => (process.env.HUB_IT_KEEP === "1" ? console.warn(`[it] kept ${base}`) : rmSync(base, { recursive: true, force: true })))
    const dirs = Object.fromEntries(["config", "data", "state", "cache", "hubstate", "proj"].map((d) => [d, path.join(base, d)]))
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

    const spokeConfig = path.join(base, "spoke.json")
    writeConfig(spokeConfig, { ...defaults("it-box"), server: h.url, mode: "always", token: machine.token, autoStartLocalHub: false, herdr: false })
    Bun.spawnSync(["git", "init", "-q", dirs.proj!])
    mkdirSync(path.join(dirs.proj!, ".opencode"), { recursive: true })
    writeFileSync(
      path.join(dirs.proj!, ".opencode", "opencode.jsonc"),
      JSON.stringify({
        plugins: [{ package: ROOT, options: {} }],
        providers: {
          stub: { name: "Stub", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: model.url, apiKey: "stub" }, models: { stub: { name: "Stub", modelID: "stub" } } },
        },
      }),
    )

    const port = await freePort()
    const password = crypto.randomUUID()
    const log = path.join(base, "serve.log")
    const env: Record<string, string | undefined> = {
      ...process.env,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_STATE_HOME: dirs.state,
      XDG_CACHE_HOME: dirs.cache,
      HUB_STATE_DIR: dirs.hubstate,
      HUB_SPOKE_CONFIG: spokeConfig,
      OPENCODE_PASSWORD: password,
    }
    delete env.OPENCODE_SERVER_PASSWORD
    delete env.HUB_SESSION_TOKEN
    delete env.HUB_URL
    const proc = Bun.spawn([opencode!, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "info"], {
      cwd: dirs.proj,
      env,
      stdout: Bun.file(`${log}.out`),
      stderr: Bun.file(log),
    })
    cleanups.push(async () => {
      proc.kill("SIGTERM")
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)])
      if (!exited) proc.kill("SIGKILL")
    })
    const read = (file: string) => {
      try {
        return readFileSync(file, "utf8")
      } catch {
        return ""
      }
    }
    const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" }
    const api = async (method: string, route: string, body?: unknown) => {
      const sep = route.includes("?") ? "&" : "?"
      const res = await fetch(`http://127.0.0.1:${port}${route}${sep}directory=${encodeURIComponent(dirs.proj!)}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      const text = await res.text()
      if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`)
      const json = text ? JSON.parse(text) : undefined
      return json && typeof json === "object" && "data" in json ? json.data : json
    }

    try {
      await until(() => read(`${log}.out`).includes("listening") || read(log).includes("listening"), 30_000)
      // The plugin loads on the first request; poke until its spoke is connected, then create the sessions.
      const online = async () => ((await (await h.api("/api/machines")).json()) as { machines: Array<{ online: boolean }> }).machines.some((m) => m.online)
      const deadline = Date.now() + 60_000
      while (!(await online())) {
        if (Date.now() > deadline) throw new Error("the plugin's spoke never connected to the hub")
        await api("GET", "/api/agent").catch(() => undefined)
        await Bun.sleep(500)
      }
      const one = (await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })).id as string
      const two = (await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })).id as string
      await waitFor(() => h.registry.hasSession(one) && h.registry.hasSession(two), 30_000)
      peer = two
      // The hub has a deliver-capable connection for the recipient.
      await waitFor(() => h.registry.sessionTargets(two).some((c) => h.registry.supports(c, "deliver")), 30_000)

      await api("POST", `/api/session/${one}/prompt`, { text: `${SEND}: tell the other session hello` })
      await until(() => model.toolResults.some((r) => r.includes("Sent msg_")), 90_000)
      const sent = model.toolResults.find((r) => r.includes("Sent msg_"))!
      const messageID = /Sent (msg_\w+)/.exec(sent)![1]!

      // Session 2's model is handed the envelope (a turn started by the delivery).
      await until(() => model.users.some((u) => u.includes(BODY) && u.includes(messageID)), 90_000)
      const handed = model.users.find((u) => u.includes(BODY) && u.includes(messageID))!
      // From session one: by its ID, or by the name derived from its title when the stub model titled it first.
      expect(handed).toMatch(new RegExp(`\\[hub\\] msg from (${one}|@[a-z0-9-]+) \\(it-box\\) to you`))
      expect(handed).toContain(`----- ${messageID} -----`)
      expect(handed).toContain(`↩ hub reply ${messageID}`)
      // The primer came along once (without a turn of its own) and says hub messages are not the user's.
      expect(handed).toContain("not from the user's prompt")
      // The model never saw a session token.
      expect(model.users.some((u) => /hst1\.[A-Za-z0-9_-]{10,}/.test(u))).toBe(false)
    } catch (cause) {
      console.error(`[it] failed; tool results ${JSON.stringify(model.toolResults).slice(0, 600)}\n--- serve.log tail ---\n${read(log).split("\n").slice(-60).join("\n")}`)
      throw cause
    }
  }, 300_000)
})

if (!run) {
  describe("phase 2 live check (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/e2e-phase2-live.it.test.ts", () => {})
  })
}
