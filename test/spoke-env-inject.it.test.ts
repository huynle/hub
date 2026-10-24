// OPT-IN integration test for session env injection (P1-T6): runs only with HUB_IT_OPENCODE=1 and `opencode` on
// PATH. It starts a private `opencode serve` (own port, password and XDG dirs; never the user's service), loads
// this checkout as its plugin, connects the spoke to a fake hub, has the hub send a session token, and runs one
// model turn against a local stub OpenAI-compatible model that calls the shell tool. The shell's output (the tool
// result the stub model gets back) must show the session's token, the spoke's server as HUB_URL, the hub bin dir
// first on PATH, and no trace of the HUB_* the server inherited. This catches upstream changes to the hook order
// (tool execute.before → shell create.before) the injection relies on.
//
//   HUB_IT_OPENCODE=1 bun test test/spoke-env-inject.it.test.ts
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
const MARK = "HUBIT"
const COMMAND = `echo "${MARK}|$HUB_SESSION_TOKEN|$HUB_URL|\${PATH%%:*}|$HUB_LEAK_CHECK"`

/** A stub OpenAI-compatible chat model: first turn calls the shell tool, then answers "done"; records tool results. */
function stubModel() {
  const toolResults: string[] = []
  const requests: unknown[] = []
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  const chunk = (delta: unknown, finish: string | null) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
      requests.push({ tools: body.tools?.map((t) => t.function?.name), roles: body.messages?.map((m) => m.role) })
      const tool = body.messages?.filter((m) => m.role === "tool") ?? []
      for (const m of tool) toolResults.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content))
      const shell = body.tools?.map((t) => t.function?.name).find((n) => n === "shell" || n === "bash")
      if (tool.length === 0 && shell) {
        return sse([
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_it_1", type: "function", function: { name: shell, arguments: JSON.stringify({ command: COMMAND, description: "print env" }) } }] }, null),
          chunk({}, "tool_calls"),
        ])
      }
      return sse([chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop")])
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, toolResults, requests, stop: () => server.stop(true) }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port!
  s.stop(true)
  return port
}

describe.skipIf(!run)("session env injection against a private opencode serve", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("a session's shell tool call sees its HUB_SESSION_TOKEN; inherited HUB_* is stripped; hub bin is first on PATH", async () => {
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-env-"))
    // HUB_IT_KEEP=1 keeps the server's dirs and logs for debugging.
    cleanups.push(() => (process.env.HUB_IT_KEEP === "1" ? console.warn(`[it] kept ${base}`) : rmSync(base, { recursive: true, force: true })))
    const dirs = Object.fromEntries(["config", "data", "state", "cache", "hubstate", "proj"].map((d) => [d, path.join(base, d)]))
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

    const hub = fakeCentral()
    cleanups.push(() => stopServer(hub))
    const model = stubModel()
    cleanups.push(() => model.stop())

    const spokeConfig = path.join(base, "spoke.json")
    writeConfig(spokeConfig, { ...defaults("it-box"), server: hub.url, mode: "always", token: "tok", autoStartLocalHub: false, herdr: false })
    // OpenCode finds the project config (.opencode/) at the project's git root.
    Bun.spawnSync(["git", "init", "-q", dirs.proj!])
    mkdirSync(path.join(dirs.proj!, ".opencode"), { recursive: true })
    writeFileSync(
      path.join(dirs.proj!, ".opencode", "opencode.jsonc"),
      JSON.stringify({
        plugins: [{ package: ROOT, options: {} }],
        providers: {
          stub: {
            name: "Stub",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: model.url, apiKey: "stub" },
            models: { stub: { name: "Stub", modelID: "stub" } },
          },
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
      // An identity this server "inherited" from an outer session: must never reach its shells.
      HUB_SESSION_TOKEN: "LEAKED-OUTER-TOKEN",
      HUB_URL: "http://leaked.example",
      HUB_LEAK_CHECK: "env-ok",
    }
    delete env.OPENCODE_SERVER_PASSWORD
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
    const tail = () => {
      try {
        return readFileSync(log, "utf8").split("\n").slice(-40).join("\n")
      } catch {
        return "(no log)"
      }
    }

    const baseUrl = `http://127.0.0.1:${port}`
    const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" }
    const api = async (method: string, route: string, body?: unknown) => {
      const sep = route.includes("?") ? "&" : "?"
      const res = await fetch(`${baseUrl}${route}${sep}directory=${encodeURIComponent(dirs.proj!)}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      const text = await res.text()
      if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`)
      const json = text ? JSON.parse(text) : undefined
      return json && typeof json === "object" && "data" in json ? json.data : json
    }

    try {
      await until(() => readFileSync(`${log}.out`, "utf8").includes("listening") || readFileSync(log, "utf8").includes("listening"), 30_000)
      // Listing the directory's agents loads its plugins (asynchronously); our spoke then connects to the fake hub.
      const deadline = Date.now() + 60_000
      while (!hub.frames.some((f) => f.t === "sessions")) {
        if (Date.now() > deadline) throw new Error("the plugin's spoke never connected to the fake hub")
        await api("GET", "/api/agent").catch(() => undefined)
        await Bun.sleep(500)
      }
      const session = await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })
      expect(typeof session.id).toBe("string")
      await until(() => hub.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === session.id)), 15_000)
      const res = await hub.request({ op: "sessionTokens", tokens: [{ sessionID: session.id, token: "hst.it-token", exp: Date.now() + 10 * 60_000 }], hubURL: "https://advertised.example" })
      expect(res).toMatchObject({ ok: true, result: { applied: [session.id] } })

      await api("POST", `/api/session/${session.id}/prompt`, { text: "print the env" })
      await until(() => model.toolResults.some((r) => r.includes(MARK)), 60_000)
    } catch (cause) {
      console.error(`[it] failed; stub model saw ${JSON.stringify(model.requests).slice(0, 500)}\n--- serve.log tail ---\n${tail()}`)
      throw cause
    }

    const line = model.toolResults.find((r) => r.includes(MARK))!
    const match = new RegExp(`${MARK}\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|"\\\\\\s]*)`).exec(line)
    expect(match).not.toBeNull()
    const [, token, url, firstPath, leakCheck] = match!
    expect(token).toBe("hst.it-token")
    expect(url).toBe(hub.url)
    expect(firstPath).toBe(path.join(dirs.hubstate!, "bin"))
    expect(leakCheck).toBe("env-ok")
    expect(line).not.toContain("LEAKED-OUTER-TOKEN")
    expect(line).not.toContain("leaked.example")
  }, 180_000)
})

if (!run) {
  describe("session env injection integration (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/spoke-env-inject.it.test.ts", () => {})
  })
}
