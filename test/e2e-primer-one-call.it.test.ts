// OPT-IN live check (Brain report 3xqld63r #2): the first hub message to an idle session that has not been primed
// reaches the model together with the identity primer, in ONE model request. Before the fix the primer (steer,
// resume:false) was answered in the waking turn and the queued message got a model call of its own (quirk hzmcqwpj).
// Runs only with HUB_IT_OPENCODE=1 and `opencode` on PATH: a real in-process hub, a private `opencode serve` (own
// port, password and XDG dirs; never the user's service) loading this checkout as its plugin, and the testkit stub
// model recording every request.
//
//   HUB_IT_OPENCODE=1 bun test test/e2e-primer-one-call.it.test.ts
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentActor } from "../src/central/agent/actor"
import { defaults, writeConfig } from "../src/config"
import { stubModel } from "../packages/testkit/src/index.ts"
import { harness, waitFor } from "./central-harness"
import { until } from "./spoke-fake"

const enabled = process.env.HUB_IT_OPENCODE === "1"
const opencode = enabled ? Bun.which("opencode") : null
if (enabled && !opencode) console.warn("[it] HUB_IT_OPENCODE=1 but `opencode` is not on PATH; skipping")
const run = enabled && opencode !== null
const ROOT = path.resolve(import.meta.dir, "..")
const USER = "local"
const asUser: AgentActor = { kind: "user", userID: USER, deviceID: "d1", via: "cookie" }
const BODY = "IT-FIRST-MESSAGE hello from the live check"
/** A phrase of the identity primer (renderPrimer). */
const PRIMER = "not from the user's prompt"

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port!
  s.stop(true)
  return port
}

describe.skipIf(!run)("live: primer and first message share one model call", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("a first message to an idle, unprimed session produces exactly one model request with both", async () => {
    const h = await harness()
    cleanups.push(() => h.stop())
    const machine = await h.store.addMachine("it-box")
    const model = stubModel()
    cleanups.push(() => model.stop())
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-primer-"))
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
          stub: { name: "Stub", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: model.openaiBaseURL, apiKey: "stub" }, models: { stub: { name: "Stub", modelID: "stub" } } },
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
    /** The requests that carry the primer or the message (a title-generation request would carry neither). */
    const relevant = () => model.requests.filter((r) => r.users.some((u) => u.includes(BODY) || u.includes(PRIMER)))

    try {
      await until(() => read(`${log}.out`).includes("listening") || read(log).includes("listening"), 30_000)
      const online = async () => ((await (await h.api("/api/machines")).json()) as { machines: Array<{ online: boolean }> }).machines.some((m) => m.online)
      const deadline = Date.now() + 60_000
      while (!(await online())) {
        if (Date.now() > deadline) throw new Error("the plugin's spoke never connected to the hub")
        await api("GET", "/api/agent").catch(() => undefined)
        await Bun.sleep(500)
      }
      const target = (await api("POST", "/api/session", { model: { providerID: "stub", id: "stub" } })).id as string
      await waitFor(() => h.registry.hasSession(target), 30_000)
      await waitFor(() => h.registry.sessionTargets(target).some((c) => h.registry.supports(c, "deliver")), 30_000)
      expect(model.requests).toHaveLength(0)

      const sent = await h.delivery.send(USER, asUser, target, "msg", BODY)
      expect(sent.delivery).toBe("turn")
      await until(() => relevant().length > 0, 90_000)
      // A second model call would follow the first turn's (instant, stubbed) reply at once: give it time to show.
      await Bun.sleep(5000)

      const calls = relevant()
      if (calls.length !== 1) console.error(`[it] model requests: ${JSON.stringify(model.requests.map((r) => r.users)).slice(0, 2000)}`)
      expect(calls).toHaveLength(1)
      const [only] = calls
      const user = only!.users.join("\n")
      expect(user).toContain(PRIMER)
      expect(user).toContain(BODY)
      expect(user).toContain(sent.message.id)
      // The primer comes first.
      expect(user.indexOf(PRIMER)).toBeLessThan(user.indexOf(BODY))
    } catch (cause) {
      console.error(`[it] failed\n--- serve.log tail ---\n${read(log).split("\n").slice(-60).join("\n")}`)
      throw cause
    }
  }, 300_000)
})

if (!run) {
  describe("primer one-call live check (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/e2e-primer-one-call.it.test.ts", () => {})
  })
}
