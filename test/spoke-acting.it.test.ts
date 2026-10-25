// OPT-IN integration test for hub prompts and deny reasons (P3-T10): runs only with HUB_IT_OPENCODE=1 and
// `opencode` on PATH. Like test/spoke-deliver.it.test.ts it starts a private `opencode serve` (own port, password and
// XDG dirs; never the user's service) with this checkout as its plugin, a fake hub that announces messaging, and a
// stub OpenAI-compatible model that records every message it is sent. It checks that:
// - the spoke announces hubPrompt and permissionMessage;
// - a deliver of kind "prompt" reaches the model in the provenance envelope (sender and grant), and its inbox
//   delivery is reported with origin "hub" (never "user", so the hub resets no hop chain);
// - a reject's message reaches the model as the rejected tool call's feedback (OpenCode's reply message).
//
//   HUB_IT_OPENCODE=1 bun test test/spoke-acting.it.test.ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, writeConfig } from "../src/config"
import { fakeCentral, stopServer, until } from "./spoke-fake"

const enabled = process.env.HUB_IT_OPENCODE === "1"
const opencode = enabled ? Bun.which("opencode") : null
if (enabled && !opencode) console.warn("[it] HUB_IT_OPENCODE=1 but `opencode` is not on PATH; skipping")
const run = enabled && opencode !== null
const ROOT = path.resolve(import.meta.dir, "..")

/**
 * A stub chat model. It records every request's messages (role and text). When the latest user message asks for
 * IT-RUN-SHELL and the request has no tool result yet, it calls the shell tool once; otherwise it answers "ack".
 */
function stubModel() {
  const requests: Array<Array<{ role: string; text: string }>> = []
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  const chunk = (delta: unknown, finish: string | null) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })
  const text = (content: unknown): string =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === "string" ? p.text : typeof p?.output === "string" ? p.output : JSON.stringify(p))).join("") : content === undefined ? "" : JSON.stringify(content)
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
      const messages = (body.messages ?? []).map((m) => ({ role: m.role, text: text(m.content) }))
      requests.push(messages)
      const lastUser = [...messages].reverse().find((m) => m.role === "user")
      const shell = (body.tools ?? []).map((t) => t.function?.name ?? "").find((name) => name === "shell" || name === "bash")
      if (shell && lastUser?.text.includes("IT-RUN-SHELL") && !messages.some((m) => m.role === "tool")) {
        const call = { index: 0, id: "call_it1", type: "function", function: { name: shell, arguments: JSON.stringify({ command: "echo it", description: "it" }) } }
        return sse([chunk({ role: "assistant", tool_calls: [call] }, null), chunk({}, "tool_calls")])
      }
      return sse([chunk({ role: "assistant", content: "ack" }, null), chunk({}, "stop")])
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port!
  s.stop(true)
  return port
}

describe.skipIf(!run)("hub prompts and deny reasons against a private opencode serve", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("a hub prompt arrives with its provenance as the hub's, and a deny reason reaches the model", async () => {
    const hub = fakeCentral({ hubFeatures: ["harness", "messaging"] })
    cleanups.push(() => stopServer(hub))
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-acting-"))
    cleanups.push(() => (process.env.HUB_IT_KEEP === "1" ? console.warn(`[it] kept ${base}`) : rmSync(base, { recursive: true, force: true })))
    const dirs = Object.fromEntries(["config", "data", "state", "cache", "hubstate", "proj"].map((d) => [d, path.join(base, d)]))
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
    const model = stubModel()
    cleanups.push(() => model.stop())

    const spokeConfig = path.join(base, "spoke.json")
    writeConfig(spokeConfig, { ...defaults("it-box"), server: hub.url, mode: "always", token: "tok", autoStartLocalHub: false, herdr: false })
    Bun.spawnSync(["git", "init", "-q", dirs.proj!])
    mkdirSync(path.join(dirs.proj!, ".opencode"), { recursive: true })
    writeFileSync(
      path.join(dirs.proj!, ".opencode", "opencode.jsonc"),
      JSON.stringify({
        plugins: [{ package: ROOT, options: {} }],
        permissions: [
          { action: "shell", resource: "*", effect: "ask" },
          { action: "bash", resource: "*", effect: "ask" },
        ],
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
    const events = (type: string) => hub.frames.filter((f) => f.t === "event" && (f as any).event.type === type).map((f) => (f as any).event.data as Record<string, any>)
    const saw = (needle: string, role?: string) => model.requests.some((r) => r.some((m) => (!role || m.role === role) && m.text.includes(needle)))

    try {
      await until(() => read(`${log}.out`).includes("listening") || read(log).includes("listening"), 30_000)
      const deadline = Date.now() + 60_000
      while (!hub.frames.some((f) => f.t === "sessions")) {
        if (Date.now() > deadline) throw new Error("the plugin's spoke never connected to the hub")
        await api("GET", "/api/agent").catch(() => undefined)
        await Bun.sleep(500)
      }
      const features = (hub.frames.find((f) => f.t === "hello") as any).features as string[]
      expect(features).toEqual(expect.arrayContaining(["deliver", "hubPrompt", "permissionMessage"]))
      const session = await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })
      const sessionID = session.id as string
      await until(() => hub.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === sessionID)), 15_000)

      // 1. A hub prompt: the model sees the provenance header and the body; the delivery is the hub's.
      const messageID = "msg_itprompt00000000000001"
      const res = await hub.request({ op: "deliver", sessionID, messageID, text: "IT-PROMPT-BODY please IT-RUN-SHELL", wake: true, meta: { kind: "prompt", from: "@it-orchestrator", to: "@it", grant: "g_it1" } })
      expect(res).toMatchObject({ ok: true, result: { delivered: "turn", inboxID: messageID } })
      await until(() => saw("IT-PROMPT-BODY", "user"), 60_000)
      const user = model.requests.flatMap((r) => r).find((m) => m.role === "user" && m.text.includes("IT-PROMPT-BODY"))!
      expect(user.text).toBe(`[hub] prompt from @it-orchestrator · grant g_it1 · ${messageID}\n----- ${messageID} -----\nIT-PROMPT-BODY please IT-RUN-SHELL\n----- ${messageID} -----`)
      await until(() => events("session.inbox.delivered").some((d) => d.inboxID === messageID), 15_000)
      expect(events("session.inbox.delivered").find((d) => d.inboxID === messageID)?.origin).toBe("hub")

      // 2. The prompt makes the model call the shell tool; the permission is rejected with a reason.
      await until(() => events("permission.asked").some((d) => d.sessionID === sessionID), 60_000)
      const asked = events("permission.asked").find((d) => d.sessionID === sessionID)!
      const reply = await hub.request({ op: "permission", sessionID, requestID: asked.id, decision: "reject", message: "IT-DENY-REASON only tests may run" })
      expect(reply).toMatchObject({ ok: true })
      expect((reply as any).result?.gone).toBeUndefined()
      await until(() => model.requests.some((r) => r.some((m) => m.role === "tool")), 60_000)
      const toolResult = model.requests.flatMap((r) => r).find((m) => m.role === "tool")!
      expect(toolResult.text).toContain("IT-DENY-REASON only tests may run")
    } catch (cause) {
      console.error(`[it] failed; model saw ${JSON.stringify(model.requests).slice(0, 1500)}\n--- serve.log tail ---\n${read(log).split("\n").slice(-40).join("\n")}`)
      throw cause
    }
  }, 300_000)
})

if (!run) {
  describe("hub prompts and deny reasons integration (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/spoke-acting.it.test.ts", () => {})
  })
}
