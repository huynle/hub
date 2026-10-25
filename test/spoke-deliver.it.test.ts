// OPT-IN integration test for hub message delivery (P2-T3): runs only with HUB_IT_OPENCODE=1 and `opencode` on
// PATH. It starts a private `opencode serve` (own port, password and XDG dirs; never the user's service), loads this
// checkout as its plugin, connects the spoke to a fake hub that announces messaging, and talks to a local stub
// OpenAI-compatible model that records what it is sent. It re-checks what delivery relies on (decision 52aqsopo):
// session.synthetic admits the envelope as plain user text with the metadata hidden from the model, a repeated id
// is applied once, resume:false does not wake an idle session, and session.inbox.delivered reaches the hub with
// the item's origin (hub message or user prompt).
//
//   HUB_IT_OPENCODE=1 bun test test/spoke-deliver.it.test.ts
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

/** A stub OpenAI-compatible chat model that answers "ack" and records the user messages of every request. */
function stubModel() {
  const requests: string[][] = []
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
      const body = (await req.json()) as { messages?: Array<{ role: string; content?: unknown }> }
      // Title generation and other side requests carry no tools list either; record only user messages.
      requests.push((body.messages ?? []).filter((m) => m.role === "user").map((m) => text(m.content)))
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

describe.skipIf(!run)("hub message delivery against a private opencode serve", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("deliver admits the envelope once, wakes or not as asked, and reports inbox origins", async () => {
    const hub = fakeCentral({ hubFeatures: ["harness", "messaging"] })
    cleanups.push(() => stopServer(hub))
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-deliver-"))
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
    const delivered = () =>
      hub.frames.filter((f) => f.t === "event" && (f as any).event.type === "session.inbox.delivered").map((f) => (f as any).event.data as { inboxID: string; origin?: string })
    const sawUser = (text: string) => model.requests.some((r) => r.some((m) => m.includes(text)))

    try {
      await until(() => read(`${log}.out`).includes("listening") || read(log).includes("listening"), 30_000)
      const deadline = Date.now() + 60_000
      while (!hub.frames.some((f) => f.t === "sessions")) {
        if (Date.now() > deadline) throw new Error("the plugin's spoke never connected to the hub")
        await api("GET", "/api/agent").catch(() => undefined)
        await Bun.sleep(500)
      }
      expect((hub.frames.find((f) => f.t === "hello") as any).features).toContain("deliver")
      const session = await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })
      const sessionID = session.id as string
      await until(() => hub.frames.some((f) => f.t === "sessions" && (f as any).sessions.some((s: any) => s.id === sessionID)), 15_000)

      // 1. An idle session: the envelope becomes a turn; the model sees exactly the text, not the metadata.
      const ENVELOPE = "[hub] from @it-sender to @it → you · msg_ithub0000000000000001\n---\nIT-BODY-ONE\n---"
      const req = (messageID: string, text: string, wake: boolean) => ({ op: "deliver", sessionID, messageID, text, wake, meta: { kind: "msg", from: "@it-sender", to: "@it" } })
      const first = await hub.request(req("msg_ithub0000000000000001", ENVELOPE, true))
      expect(first).toMatchObject({ ok: true, result: { delivered: "turn", inboxID: "msg_ithub0000000000000001" } })
      await until(() => sawUser("IT-BODY-ONE"), 60_000)
      const seen = model.requests.find((r) => r.some((m) => m.includes("IT-BODY-ONE")))!
      expect(seen).toContain(ENVELOPE)
      expect(JSON.stringify(seen)).not.toContain("messageID")
      await until(() => delivered().some((d) => d.inboxID === "msg_ithub0000000000000001"), 15_000)
      expect(delivered().find((d) => d.inboxID === "msg_ithub0000000000000001")?.origin).toBe("hub")

      // 2. The same messageID again (the hub's retry) and OpenCode itself given the id with other text: one message.
      expect(await hub.request(req("msg_ithub0000000000000001", ENVELOPE, true))).toMatchObject({ ok: true, result: { delivered: "turn" } })
      const raw = await api("POST", `/api/session/${sessionID}/synthetic`, { id: "msg_ithub0000000000000001", text: "IT-DUPLICATE", resume: true })
      expect(raw.payload?.text).toBe(ENVELOPE)
      await Bun.sleep(1500)
      expect(sawUser("IT-DUPLICATE")).toBe(false)
      const messages = (await api("GET", `/api/session/${sessionID}/message`).catch(() => undefined)) as unknown
      if (Array.isArray(messages)) expect(messages.filter((m: any) => (m?.id ?? m?.info?.id) === "msg_ithub0000000000000001")).toHaveLength(1)

      // 3. wake:false on an idle session waits in the inbox (no model call) until the user's next prompt.
      const QUIET = "[hub] from @it-sender to @it → you · msg_ithub0000000000000002\n---\nIT-BODY-QUIET\n---"
      expect(await hub.request(req("msg_ithub0000000000000002", QUIET, false))).toMatchObject({ ok: true, result: { delivered: "queued" } })
      await Bun.sleep(1500)
      expect(sawUser("IT-BODY-QUIET")).toBe(false)
      const prompt = await api("POST", `/api/session/${sessionID}/prompt`, { text: "IT-USER-PROMPT" })
      // The session's turn (its history has the first message), not OpenCode's title request for the prompt.
      const turn = (r: string[]) => r.some((m) => m.includes("IT-BODY-ONE")) && r.some((m) => m.includes("IT-USER-PROMPT"))
      await until(() => model.requests.some(turn), 60_000)
      const woke = model.requests.find(turn)!
      expect(woke.findIndex((m) => m.includes("IT-BODY-QUIET"))).toBeGreaterThanOrEqual(0)
      expect(woke.findIndex((m) => m.includes("IT-BODY-QUIET"))).toBeLessThan(woke.findIndex((m) => m.includes("IT-USER-PROMPT")))
      await until(() => delivered().some((d) => d.inboxID === prompt.id) && delivered().some((d) => d.inboxID === "msg_ithub0000000000000002"), 15_000)
      expect(delivered().find((d) => d.inboxID === prompt.id)?.origin).toBe("user")
      expect(delivered().find((d) => d.inboxID === "msg_ithub0000000000000002")?.origin).toBe("hub")
    } catch (cause) {
      console.error(`[it] failed; model saw ${JSON.stringify(model.requests).slice(0, 800)}\n--- serve.log tail ---\n${read(log).split("\n").slice(-40).join("\n")}`)
      throw cause
    }
  }, 240_000)
})

if (!run) {
  describe("hub message delivery integration (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/spoke-deliver.it.test.ts", () => {})
  })
}
