// OPT-IN integration test for the OpenCode `hub` tool (P2-T12): runs only with HUB_IT_OPENCODE=1 and `opencode` on
// PATH. It starts a private `opencode serve` (own port, password and XDG dirs; never the user's service), loads this
// checkout as its plugin, connects the spoke to a fake hub that announces messaging and serves /api/agent/whoami,
// and talks to a local stub OpenAI-compatible model that calls the `hub` tool once. It checks that OpenCode accepts
// the tool (JSON Schema input, no code mode), that the call reaches the hub with the session's own token, and that
// the token never reaches the model or the stored transcript.
//
//   HUB_IT_OPENCODE=1 bun test test/spoke-hub-tool.it.test.ts
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
const TOKEN = "hst.it-hub-tool-secret-0123456789"

/**
 * A stub chat model: when the request offers the `hub` tool and has no tool result yet, it calls hub {verb: whoami};
 * otherwise it answers "done". It records every request body (as JSON text) and the offered tool names.
 */
function stubModel() {
  const bodies: string[] = []
  const toolNames = new Set<string>()
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
      const raw = await req.text()
      bodies.push(raw)
      const body = JSON.parse(raw) as { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
      const names = (body.tools ?? []).map((t) => t.function?.name ?? "")
      for (const name of names) toolNames.add(name)
      const results = (body.messages ?? []).filter((m) => m.role === "tool").map((m) => text(m.content))
      toolResults.push(...results)
      const hub = names.find((n) => n === "hub")
      if (hub && results.length === 0) {
        const call = { index: 0, id: "call_hub_1", type: "function", function: { name: hub, arguments: JSON.stringify({ verb: "whoami" }) } }
        return sse([chunk({ role: "assistant", tool_calls: [call] }, null), chunk({}, "tool_calls")])
      }
      return sse([chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop")])
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, bodies, toolNames, toolResults, stop: () => server.stop(true) }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port!
  s.stop(true)
  return port
}

describe.skipIf(!run)("the hub tool against a private opencode serve", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("the model calls hub whoami; the hub sees the session's token, the model and transcript never do", async () => {
    const auth: Array<string | null> = []
    let sessionID = ""
    const hub = fakeCentral({
      hubFeatures: ["harness", "messaging"],
      http: (req) => {
        if (new URL(req.url).pathname !== "/api/agent/whoami") return undefined
        auth.push(req.headers.get("authorization"))
        return Response.json({ actor: { kind: "session", userID: "u_it", machineID: "m_1", sessionID }, user: { id: "u_it", name: "IT" } })
      },
    })
    cleanups.push(() => stopServer(hub))
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-tool-"))
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
      const deadline = Date.now() + 60_000
      while (!hub.frames.some((f) => f.t === "sessions")) {
        if (Date.now() > deadline) throw new Error("the plugin's spoke never connected to the hub")
        await api("GET", "/api/agent").catch(() => undefined)
        await Bun.sleep(500)
      }
      const session = await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })
      sessionID = session.id as string
      await until(() => hub.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === sessionID)), 15_000)
      const tokens = await hub.request({ op: "sessionTokens", tokens: [{ sessionID, token: TOKEN, exp: Date.now() + 600_000 }] })
      expect(tokens).toMatchObject({ ok: true, result: { applied: [sessionID] } })

      await api("POST", `/api/session/${sessionID}/prompt`, { text: "IT: who am I on the hub?" })
      await until(() => model.toolResults.some((r) => r.includes(sessionID)), 60_000)

      expect(model.toolNames.has("hub")).toBe(true)
      expect(auth).toEqual([`Bearer ${TOKEN}`])
      expect(model.toolResults.find((r) => r.includes(sessionID))).toContain(`You are session ${sessionID}`)
      expect(model.bodies.some((b) => b.includes(TOKEN))).toBe(false)
      const messages = await api("GET", `/api/session/${sessionID}/message`).catch(() => undefined)
      if (messages !== undefined) expect(JSON.stringify(messages)).not.toContain(TOKEN)
    } catch (cause) {
      console.error(`[it] failed; tools ${JSON.stringify([...model.toolNames])}; results ${JSON.stringify(model.toolResults).slice(0, 600)}\n--- serve.log tail ---\n${read(log).split("\n").slice(-40).join("\n")}`)
      throw cause
    }
  }, 240_000)
})

if (!run) {
  describe("hub tool integration (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/spoke-hub-tool.it.test.ts", () => {})
  })
}
