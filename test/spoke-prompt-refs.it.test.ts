// OPT-IN integration test for prompt references (P2-T13, src/spoke/prompt-refs.ts): runs only with HUB_IT_OPENCODE=1
// and `opencode` on PATH. It starts a private `opencode serve` (own port, password and XDG dirs; never the user's
// service), loads this checkout as its plugin, connects the spoke to a fake hub that serves /api/agent/who, status
// and inbox, and talks to a local stub OpenAI-compatible model that records what it receives. It checks that a
// prompt naming @it-peer reaches the model unchanged with the hub context attached in the same user message, that a
// hub-sourced prompt gets none, and that the session token never reaches the model.
//
//   HUB_IT_OPENCODE=1 bun test test/spoke-prompt-refs.it.test.ts
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
const TOKEN = "hst.it-prompt-refs-secret-0123456789"

/** A stub chat model that answers "done" and records every request body (as JSON text). */
function stubModel() {
  const bodies: string[] = []
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  const chunk = (delta: unknown, finish: string | null) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      bodies.push(await req.text())
      return sse([chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop")])
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, bodies, stop: () => server.stop(true) }
}

/** The user messages' text of a recorded request, in order. */
function userTexts(raw: string): string[] {
  const body = JSON.parse(raw) as { messages?: Array<{ role: string; content?: unknown }> }
  const text = (content: unknown): string =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n") : ""
  return (body.messages ?? []).filter((m) => m.role === "user").map((m) => text(m.content))
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port!
  s.stop(true)
  return port
}

describe.skipIf(!run)("prompt references against a private opencode serve", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("a prompt naming @it-peer reaches the model unchanged, with the hub context attached", async () => {
    const auth: Array<string | null> = []
    const hub = fakeCentral({
      hubFeatures: ["harness", "messaging"],
      http: (req) => {
        const { pathname } = new URL(req.url)
        if (!pathname.startsWith("/api/agent/")) return undefined
        auth.push(req.headers.get("authorization"))
        if (pathname === "/api/agent/who") return Response.json({ sessions: [{ sessionID: "ses_itpeer", name: "it-peer", project: "proj", machineID: "m_it", online: true, state: "idle", roles: [] }] })
        if (pathname === "/api/agent/status")
          return Response.json({ attention: [], machines: [{ id: "m_it", name: "it-box", online: true, projects: [{ root: "/p", name: "proj", sessions: [{ id: "ses_itpeer", state: "working", harness: "opencode" }] }] }] })
        if (pathname === "/api/agent/inbox") return Response.json({ asks: [], waiting: [{ id: "m_1", kind: "ask", state: "open", recipient: { kind: "session", sessionID: "ses_itpeer" } }], messages: [], muted: [] })
        return undefined
      },
    })
    cleanups.push(() => stopServer(hub))
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-refs-"))
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
      const sessionID = session.id as string
      await until(() => hub.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === sessionID)), 15_000)
      const tokens = await hub.request({ op: "sessionTokens", tokens: [{ sessionID, token: TOKEN, exp: Date.now() + 600_000 }] })
      expect(tokens).toMatchObject({ ok: true, result: { applied: [sessionID] } })

      const text = "IT-REF: please coordinate with @it-peer on this"
      await api("POST", `/api/session/${sessionID}/prompt`, { text })
      // The agent loop's request (not the title request, which quotes the prompt).
      await until(() => model.bodies.some((b) => userTexts(b).some((t) => t.startsWith("IT-REF"))), 60_000)
      const user = model.bodies.flatMap(userTexts).find((t) => t.startsWith("IT-REF"))!
      expect(user.startsWith(text)).toBe(true)
      expect(user).toContain("hub-references.txt")
      expect(user).toContain("@it-peer = session ses_itpeer (opencode · it-box · project proj), working, 1 open ask from you.")
      expect(user).toContain("`hub` tool")
      expect(auth.length).toBeGreaterThan(0)
      expect(auth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true)

      // A hub-sourced prompt is never looked up.
      const before = auth.length
      await api("POST", `/api/session/${sessionID}/prompt`, { text: "IT-HUBSRC: from @it-peer", metadata: { source: "hub" } })
      await until(() => model.bodies.some((b) => userTexts(b).some((t) => t.startsWith("IT-HUBSRC"))), 60_000)
      const hubUser = model.bodies.flatMap(userTexts).find((t) => t.startsWith("IT-HUBSRC"))!
      expect(hubUser).not.toContain("hub-references.txt")
      expect(auth.length).toBe(before)

      expect(model.bodies.some((b) => b.includes(TOKEN))).toBe(false)
    } catch (cause) {
      console.error(`[it] failed; bodies ${JSON.stringify(model.bodies.map(userTexts)).slice(0, 1200)}\n--- serve.log tail ---\n${read(log).split("\n").slice(-40).join("\n")}`)
      throw cause
    }
  }, 240_000)
})

if (!run) {
  describe("prompt references integration (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/spoke-prompt-refs.it.test.ts", () => {})
  })
}
