// OPT-IN live check of phase 3 acting (P3-T13): runs only with HUB_IT_OPENCODE=1 and `opencode` on PATH. A real
// in-process hub, a private `opencode serve` (own port, password and XDG dirs; never the user's service) loading
// this checkout as its plugin, connected to the hub with a machine token, with shell permissions set to ask, and a
// local stub OpenAI-compatible model.
//
// Session A's model runs a shell command, which OpenCode asks permission for. The user has granted session B
// approve for `shell:echo *` in the project. Session B's model calls the `hub` tool's approve verb (the plugin sends
// B's act token, which the hub pushed; never its shell token); the hub checks the grant and replies to OpenCode,
// and session A's shell command runs: its output comes back to A's model as the tool result.
//
//   HUB_IT_OPENCODE=1 bun test test/e2e-phase3-live.it.test.ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, writeConfig } from "../src/config"
import { harness, waitFor } from "./central-harness"
import { until } from "./spoke-fake"

const enabled = process.env.HUB_IT_OPENCODE === "1"
const opencode = enabled ? Bun.which("opencode") : null
if (enabled && !opencode) console.warn("[it] HUB_IT_OPENCODE=1 but `opencode` is not on PATH; skipping")
const run = enabled && opencode !== null
const ROOT = path.resolve(import.meta.dir, "..")
const RUN_SHELL = "IT-RUN-SHELL"
const APPROVE = "IT-APPROVE-PEER"
const OUTPUT = "it-approved-by-the-orchestrator"

/**
 * A stub chat model. A request whose latest user text asks to RUN_SHELL (and has no tool result yet) calls the shell
 * tool with `echo OUTPUT`; one asking to APPROVE calls the `hub` tool's approve verb on the target's pending request.
 * Everything else answers "ack". Tool results are recorded.
 */
function stubModel(target: () => { session: string; id: string }) {
  const toolResults: string[] = []
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  const chunk = (delta: unknown, finish: string | null) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })
  const text = (content: unknown): string =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === "string" ? p.text : typeof p?.output === "string" ? p.output : JSON.stringify(p))).join("") : content === undefined ? "" : JSON.stringify(content)
  const call = (name: string, args: unknown) => sse([chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null), chunk({}, "tool_calls")])
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
      const messages = (body.messages ?? []).map((m) => ({ role: m.role, text: text(m.content) }))
      const results = messages.filter((m) => m.role === "tool").map((m) => m.text)
      toolResults.push(...results)
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.text ?? ""
      const tools = (body.tools ?? []).map((t) => t.function?.name ?? "")
      const shell = tools.find((name) => name === "shell" || name === "bash")
      if (results.length === 0 && shell && lastUser.includes(RUN_SHELL)) return call(shell, { command: `echo ${OUTPUT}`, description: "it" })
      if (results.length === 0 && tools.includes("hub") && lastUser.includes(APPROVE)) {
        const { session, id } = target()
        return call("hub", { verb: "approve", session, id, why: "only an echo" })
      }
      return sse([chunk({ role: "assistant", content: "ack" }, null), chunk({}, "stop")])
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, toolResults, stop: () => server.stop(true) }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port!
  s.stop(true)
  return port
}

describe.skipIf(!run)("live: an orchestrator session approves another session's permission through a real hub", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("session B's model calls hub approve with its act token; OpenCode runs session A's shell command", async () => {
    const h = await harness()
    cleanups.push(() => h.stop())
    const machine = await h.store.addMachine("it-box")
    let target = { session: "", id: "" }
    const model = stubModel(() => target)
    cleanups.push(() => model.stop())
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-p3-"))
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
    const hub = async (route: string, init: RequestInit & { json?: unknown } = {}) => (await (await h.api(route, init)).json()) as any

    try {
      await until(() => read(`${log}.out`).includes("listening") || read(log).includes("listening"), 30_000)
      const online = async () => (await hub("/api/machines")).machines.some((m: { online: boolean }) => m.online)
      const deadline = Date.now() + 60_000
      while (!(await online())) {
        if (Date.now() > deadline) throw new Error("the plugin's spoke never connected to the hub")
        await api("GET", "/api/agent").catch(() => undefined)
        await Bun.sleep(500)
      }
      const a = (await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })).id as string
      const b = (await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })).id as string
      await waitFor(() => h.registry.hasSession(a) && h.registry.hasSession(b), 30_000)
      // The plugin announces acting; the hub pushes act tokens to it.
      await waitFor(() => h.registry.sessionTargets(b).some((c) => h.registry.supports(c, "actTokens")), 30_000)
      const directory = h.registry.session(a)!.directory
      const grant = await h.api("/api/agent/grants", { method: "POST", json: { holder: b, scope: { projects: [directory] }, allow: ["approve"], permissions: { allow: ["shell:echo *"] } } })
      expect(grant.status).toBe(201)
      const grantID = ((await grant.json()) as any).grant.id as string

      // Session A runs a shell command: OpenCode asks.
      await api("POST", `/api/session/${a}/prompt`, { text: `${RUN_SHELL}: print the marker` })
      let requestID = ""
      for (const end = Date.now() + 90_000; !requestID; await Bun.sleep(200)) {
        if (Date.now() > end) throw new Error("session A never asked for the shell permission")
        const view = await hub(`/api/sessions/${a}`)
        requestID = view.blockers?.find((x: { kind: string }) => x.kind === "permission")?.id ?? ""
      }
      target = { session: a, id: requestID }
      expect(model.toolResults.some((r) => r.includes(OUTPUT))).toBe(false)

      // Session B's model approves it through the hub tool.
      await api("POST", `/api/session/${b}/prompt`, { text: `${APPROVE}: approve the other session's request` })
      await until(() => model.toolResults.some((r) => r.includes(`Approved ${requestID}`)), 90_000)
      expect(model.toolResults.find((r) => r.includes(`Approved ${requestID}`))).toContain(`under grant ${grantID}`)
      // OpenCode proceeds: the command ran and its output reached session A's model.
      await until(() => model.toolResults.some((r) => r.includes(OUTPUT) && !r.includes("echo")), 90_000)
      const entry = ((await hub("/api/agent/audit")).entries as any[]).find((e) => e.verb === "approve" && e.target.requestID === requestID)
      expect(entry).toMatchObject({ actor: { kind: "session", sessionID: b }, grant: grantID, decision: "allow", outcome: "ok" })
      // No model ever saw a hub token.
      expect(model.toolResults.some((r) => /hst1?\.[A-Za-z0-9_-]{10,}/.test(r))).toBe(false)
    } catch (cause) {
      console.error(`[it] failed; tool results ${JSON.stringify(model.toolResults).slice(0, 1500)}\n--- serve.log tail ---\n${read(log).split("\n").slice(-60).join("\n")}`)
      throw cause
    }
  }, 300_000)
})

if (!run) {
  describe("phase 3 live check (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/e2e-phase3-live.it.test.ts", () => {})
  })
}
