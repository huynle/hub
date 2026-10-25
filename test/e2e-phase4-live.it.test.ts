// OPT-IN live check of phase 4 launches (P4-T12): runs only with HUB_IT_OPENCODE=1 and `opencode` on PATH. A real
// in-process hub; a private `opencode serve --service` (own port, password and XDG dirs; never the user's service)
// loading this checkout as its plugin, connected with the machine's token, with node.json workspace roots beside its
// config; a real `hub node` daemon (NodeDaemon, host runtime) for the same machine; and a local stub
// OpenAI-compatible model.
//
// `hub launch` (the CLI, as the user) places the launch on the node, which makes a git worktree; the service spoke
// creates a real OpenCode session in it; the hub primes and prompts it, and the stub model receives the prompt.
//
//   HUB_IT_OPENCODE=1 bun test test/e2e-phase4-live.it.test.ts
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run as cli } from "../packages/cli/src/cli"
import { NodeDaemon, nodeConfigPath, readNodeConfig, readSpokeCredentials } from "../packages/node/src/index.ts"
import { defaults, writeConfig } from "../src/config"
import { harness, waitFor } from "./central-harness"
import { until } from "./spoke-fake"

const enabled = process.env.HUB_IT_OPENCODE === "1"
const opencode = enabled ? Bun.which("opencode") : null
if (enabled && !opencode) console.warn("[it] HUB_IT_OPENCODE=1 but `opencode` is not on PATH; skipping")
const run = enabled && opencode !== null
const ROOT = path.resolve(import.meta.dir, "..")
const PROMPT = "IT-LAUNCH-PROMPT: say hello from the launched worktree"

/** A stub chat model that answers "ack" and records the user texts it was sent. */
function stubModel() {
  const userTexts: string[] = []
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  const chunk = (delta: unknown, finish: string | null) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })
  const text = (content: unknown): string =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === "string" ? p.text : JSON.stringify(p))).join("") : content === undefined ? "" : JSON.stringify(content)
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as { messages?: Array<{ role: string; content?: unknown }> }
      for (const m of body.messages ?? []) if (m.role === "user") userTexts.push(text(m.content))
      return sse([chunk({ role: "assistant", content: "ack" }, null), chunk({}, "stop")])
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, userTexts, stop: () => server.stop(true) }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port!
  s.stop(true)
  return port
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "it", GIT_AUTHOR_EMAIL: "it@example.com", GIT_COMMITTER_NAME: "it", GIT_COMMITTER_EMAIL: "it@example.com" } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

describe.skipIf(!run)("live: hub launch starts a real OpenCode session in a worktree the real node made", () => {
  const cleanups: Array<() => unknown> = []
  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  test("the session runs in <repo>/.worktrees/<branch> and the model receives the launch's prompt", async () => {
    const h = harness()
    cleanups.push(() => h.stop())
    const machine = h.store.addMachine("it-box")
    const model = stubModel()
    cleanups.push(() => model.stop())
    const base = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-it-p4-")))
    cleanups.push(() => (process.env.HUB_IT_KEEP === "1" ? console.warn(`[it] kept ${base}`) : rmSync(base, { recursive: true, force: true })))
    const dirs = Object.fromEntries(["home", "config", "data", "state", "cache", "hubstate", "spoke", "work", "cli"].map((d) => [d, path.join(base, d)]))
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

    // The machine's config.json and node.json (workspace roots) side by side, as `hub node` and the spoke read them.
    const spokeConfig = path.join(dirs.spoke!, "config.json")
    writeConfig(spokeConfig, { ...defaults("it-box"), server: h.url, mode: "always", token: machine.token, autoStartLocalHub: false, herdr: false })
    writeFileSync(path.join(dirs.spoke!, "node.json"), JSON.stringify({ workspaceRoots: [dirs.work] }))

    // The service's global OpenCode config (a --service server runs in its home, not in a project): this checkout
    // as its plugin, and the stub provider.
    mkdirSync(path.join(dirs.config!, "opencode"), { recursive: true })
    writeFileSync(
      path.join(dirs.config!, "opencode", "opencode.jsonc"),
      JSON.stringify({
        plugins: [{ package: ROOT, options: {} }],
        providers: {
          stub: { name: "Stub", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: model.url, apiKey: "stub" }, models: { stub: { name: "Stub", modelID: "stub" } } },
        },
      }),
    )
    const repo = path.join(dirs.work!, "app")
    mkdirSync(repo, { recursive: true })
    git(repo, "init", "-q", "-b", "main")
    writeFileSync(path.join(repo, "README.md"), "# live\n")
    writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")

    const env = { HUB_SPOKE_CONFIG: spokeConfig }
    const { config } = readNodeConfig(nodeConfigPath(env, base))
    const node = new NodeDaemon({ config, credentials: readSpokeCredentials(env, base)! })
    node.start()
    cleanups.push(() => node.stop())

    const port = await freePort()
    const log = path.join(base, "serve.log")
    const serveEnv: Record<string, string | undefined> = {
      ...process.env,
      HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_STATE_HOME: dirs.state,
      XDG_CACHE_HOME: dirs.cache,
      HUB_STATE_DIR: dirs.hubstate,
      HUB_SPOKE_CONFIG: spokeConfig,
      OPENCODE_PASSWORD: crypto.randomUUID(),
    }
    delete serveEnv.OPENCODE_SERVER_PASSWORD
    delete serveEnv.HUB_SESSION_TOKEN
    delete serveEnv.HUB_URL
    const proc = Bun.spawn([opencode!, "serve", "--service", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "info"], {
      cwd: repo,
      env: serveEnv,
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

    try {
      await until(() => read(`${log}.out`).includes("listening") || read(log).includes("listening"), 30_000)
      const machineID = machine.machine.id
      await waitFor(() => h.nodes.forMachine(machineID) !== undefined, 30_000)
      // OpenCode loads the plugin with its instance: a request starts it.
      // A --service server keeps its own password in $XDG_CONFIG_HOME/opencode/service.json.
      const servicePassword = () => {
        try {
          return (JSON.parse(read(path.join(dirs.config!, "opencode", "service.json"))) as { password?: string }).password ?? serveEnv.OPENCODE_PASSWORD
        } catch {
          return serveEnv.OPENCODE_PASSWORD
        }
      }
      const service = () => {
        const connID = h.registry.serviceFor(machineID)
        return connID !== undefined && h.registry.supports(connID, "launch")
      }
      for (const end = Date.now() + 60_000; !service(); await Bun.sleep(500)) {
        if (Date.now() > end) throw new Error("the plugin's service spoke never connected with launch")
        await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization: `Basic ${btoa(`opencode:${servicePassword()}`)}` } }).catch(() => undefined)
      }

      // The user's CLI (a device token).
      const { code } = (await (await h.api("/api/devices/link", { method: "POST", json: {} })).json()) as any
      const { token } = (await (await h.api("/api/devices/redeem", { method: "POST", json: { code }, cookie: null, origin: null })).json()) as any
      const io = { env: { XDG_CONFIG_HOME: dirs.cli! }, home: dirs.cli!, cwd: repo, stdout: (_: string) => {}, stderr: (s: string) => void process.stderr.write(s) }
      expect(await cli(["login", "--url", h.url, "--token", token], io)).toBe(0)
      let out = ""
      expect(await cli(["launch", "--branch", "feat/live", "--name", "live", "--model", "stub/stub", "--prompt", PROMPT, "--end", "never", "--json"], { ...io, stdout: (s) => (out += s) })).toBe(0)
      const id = JSON.parse(out).launch.id as string

      const worktree = path.join(repo, ".worktrees", "feat", "live")
      let launch = (await h.launches.view("local", id))!
      for (const end = Date.now() + 120_000; launch.state !== "running" && launch.state !== "ended"; await Bun.sleep(250)) {
        if (Date.now() > end) throw new Error(`launch still ${launch.state}: ${launch.reason}`)
        launch = (await h.launches.view("local", id))!
      }
      expect(launch).toMatchObject({ state: "running", directory: worktree, name: "live" })
      expect(existsSync(path.join(worktree, "README.md"))).toBe(true)
      expect(h.registry.session(launch.sessionID!)?.directory).toBe(worktree)
      await until(() => model.userTexts.some((t) => t.includes(PROMPT)), 90_000)

      const stopped = (await h.launches.stop("local", id))!
      expect(stopped).toMatchObject({ state: "ended", outcome: "stopped", artifacts: { branch: "feat/live" } })
    } catch (cause) {
      console.error(`[it] failed; model saw ${JSON.stringify(model.userTexts).slice(0, 1500)}\n--- serve.log tail ---\n${read(log).split("\n").slice(-80).join("\n")}`)
      throw cause
    }
  }, 300_000)
})

if (!run) {
  describe("phase 4 live check (opt-in)", () => {
    test.skip("set HUB_IT_OPENCODE=1 with `opencode` on PATH to run test/e2e-phase4-live.it.test.ts", () => {})
  })
}
