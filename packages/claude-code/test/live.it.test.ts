// OPT-IN live test of the Claude Code spoke against the real `claude` (2.1.296): runs only with HUB_IT_CLAUDE=1 and
// claude on PATH. A real in-process hub (test/central-harness.ts) and the per-user daemon (in this process, on a
// private socket) connected to it with the machine token; then `hub claude -p …` (the CLI's own entry, as a user runs
// it) with the hub plugin dir, a throwaway HOME and CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL to the testkit's stub
// Anthropic Messages model (ANTHROPIC_API_KEY=dummy), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 and the testkit's
// deny-all proxy (Claude Code tries downloads.claude.ai). The environment is built from scratch: nothing of the
// user's (no ~/.claude, no real keys). Runs use --permission-mode default (a fresh config dir starts in "auto", where a
// classifier, not the user, decides). A recorder hook (--settings, additive to the plugin's) logs every hook event.
//
// Checks: the stub model's tool_use asks permission, the hub's console answers it, the tool runs (its shell has the
// session's hub URL and token from the env file), a hub message reaches the model at PostToolUse, the turn ends with
// Stop; the plugin's MCP server (`hub claude-code mcp`) serves hub tools as the session (it sees HUB_CLAUDE_LAUNCH)
// including an act verb with the act token; a hub stop ends the turn with continue:false (and whether Stop fires
// then); and how long the asyncRewake Stop hook holds a -p run (HUB_CLAUDE_REWAKE_TIMEOUT). Every process started
// is stopped; the throwaway directory is removed (HUB_IT_KEEP=1 keeps it).
//
//   HUB_IT_CLAUDE=1 bun test ./packages/claude-code/test/live.it.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harness, waitFor, type Harness } from "../../../test/central-harness.ts"
import { denyProxy, stubModel, type DenyProxy, type ModelRequest, type StubModel } from "../../testkit/src/index.ts"
import { startDaemon, type ClaudeDaemon } from "../src/daemon.ts"
import { claudeSessionID } from "../src/ids.ts"

const enabled = process.env.HUB_IT_CLAUDE === "1"
const claudeBin = enabled ? (Bun.which("claude") ?? "") : ""
if (enabled && !claudeBin) console.warn("[it] HUB_IT_CLAUDE=1 but `claude` is not on PATH; skipping")
const run = enabled && claudeBin !== ""
const CLI = path.resolve(import.meta.dir, "..", "..", "cli", "src", "main.ts")
const REWAKE_S = 6
const RUN_MS = 120_000

describe.skipIf(!run)("Claude Code spoke against the real claude", () => {
  let base: string
  let work: string
  let events: string
  let settings: string
  let h: Harness
  let stub: StubModel
  let proxy: DenyProxy
  let daemon: ClaudeDaemon
  let env: Record<string, string>
  const children: Bun.Subprocess[] = []

  /** Every hook input the recorder saw, in order. */
  const recorded = (): Array<{ event: string; at: number; launch: boolean; input: any }> =>
    existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
  const state = (id: string) => h.registry.status(id)?.find((s) => s.id === id)
  /** The hub's HTTP API as the user's device, from the hub's own origin. */
  const api = (pathname: string, init: RequestInit & { json?: unknown } = {}) => h.api(pathname, { ...init, origin: h.publicURL })
  const text = (req: ModelRequest) => JSON.stringify(req.body)

  /** `hub claude -p <prompt> …` as the user runs it; resolves with exit code, output and when it ended. */
  function hubClaude(sessionUUID: string, prompt: string, extra: string[] = []) {
    const child = Bun.spawn([process.execPath, CLI, "claude", "-p", prompt, "--session-id", sessionUUID, "--output-format", "json", "--settings", settings, "--permission-mode", "default", ...extra], {
      cwd: work,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    const timer = setTimeout(() => {
      if (Number.isInteger(child.pid) && child.pid > 1) child.kill("SIGTERM")
    }, RUN_MS)
    const done = (async () => {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      clearTimeout(timer)
      return { code, stdout, stderr, endedAt: Date.now() }
    })()
    return { child, done }
  }

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-it-cc-")))
    work = path.join(base, "work")
    const home = path.join(base, "home")
    const config = path.join(base, "claude-config")
    for (const dir of [work, home, config]) mkdirSync(dir)
    Bun.spawnSync(["git", "init", "-q"], { cwd: work })
    // Claude Code's own state in the throwaway config dir: onboarding done, the work dir trusted.
    writeFileSync(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [work]: { hasTrustDialogAccepted: true } } }))
    // The recorder: an additive hook for every event (the plugin's hooks run too).
    events = path.join(base, "events.jsonl")
    const recorder = path.join(base, "recorder.mjs")
    writeFileSync(
      recorder,
      `import { appendFileSync } from "node:fs"\nlet s = ""\nfor await (const c of process.stdin) s += c\nlet input = {}\ntry { input = JSON.parse(s) } catch {}\nappendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: input.hook_event_name, at: Date.now(), launch: Boolean(process.env.HUB_CLAUDE_LAUNCH), input }) + "\\n")\n`,
    )
    const command = { type: "command", command: `'${process.execPath}' '${recorder}'`, timeout: 10 }
    const hooks: Record<string, unknown> = {}
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd", "Notification"]) {
      hooks[event] = [{ ...(["PreToolUse", "PermissionRequest", "PostToolUse"].includes(event) ? { matcher: "*" } : {}), hooks: [command] }]
    }
    settings = path.join(base, "settings.json")
    writeFileSync(settings, JSON.stringify({ hooks }))

    // The hub's public URL is its real address: session tokens carry it, and the session's shells and MCP tools call it.
    h = await harness({ env: { HUB_PUBLIC_URL: "http://127.0.0.1:0" } })
    const machine = await h.store.addMachine("live")
    const hubConfig = path.join(base, "hub", "config.json")
    mkdirSync(path.dirname(hubConfig))
    writeFileSync(hubConfig, JSON.stringify({ server: h.url, token: machine.token, mode: "always" }))
    stub = stubModel({ defaultText: "ok" })
    proxy = await denyProxy()
    const socket = path.join(base, "d.sock")
    env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: path.join(base, "tmp"),
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_BASE_URL: stub.anthropicBaseURL,
      ANTHROPIC_API_KEY: "dummy",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ...proxy.env(),
      HUB_SPOKE_CONFIG: hubConfig,
      HUB_STATE_DIR: path.join(base, "state"),
      HUB_CLAUDE_SOCKET: socket,
      HUB_CLAUDE_BIN: claudeBin,
      HUB_CLAUDE_PERMISSION_WAIT: "30",
      HUB_CLAUDE_REWAKE_TIMEOUT: String(REWAKE_S),
    }
    mkdirSync(env.TMPDIR!)
    const version = spawnSync(claudeBin, ["--version"], { encoding: "utf8", env, timeout: 15_000 }).stdout ?? ""
    daemon = await startDaemon({ socketPath: socket, server: h.url, token: machine.token, harnessVersion: /\d+\.\d+\.\d+/.exec(version)?.[0] ?? "", pluginVersion: "it", directory: home, log: (l) => console.error(`[daemon] ${l}`) })
    await waitFor(() => daemon.state === "connected", 5000)
  }, 60_000)

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null && Number.isInteger(child.pid) && child.pid > 1) child.kill("SIGTERM")
    await Promise.allSettled(children.map((c) => c.exited))
    await daemon?.stop()
    await h?.stop()
    await Promise.allSettled([stub?.stop(), proxy?.stop()])
    if (base) {
      if (process.env.HUB_IT_KEEP === "1") console.warn(`[it] kept ${base}`)
      else rmSync(base, { recursive: true, force: true })
    }
  }, 30_000)

  test(
    "claude 2.1.296: tool_use → PermissionRequest answered from the hub → the tool runs (hub env in its shell) → a hub message at PostToolUse → Stop",
    async () => {
      const uuid = randomUUID()
      const id = claudeSessionID(uuid)
      stub.queue(
        { toolCalls: [{ name: "Bash", input: { command: "touch approved.txt && echo HUBURL=$HUB_URL HUBTOKEN=$HUB_SESSION_TOKEN", description: "make a file" }, id: "toolu_live1" }] },
        { text: "all done" },
      )
      const from = stub.requests.length
      const runA = hubClaude(uuid, "make the file")
      await waitFor(() => (state(id)?.blockers.length ?? 0) > 0, 60_000)
      const blocker = state(id)!.blockers[0]!
      expect(blocker).toMatchObject({ kind: "permission", action: "shell" })
      // The session's hub token while it runs (the daemon forgets it when the session ends).
      const token = daemon.spoke.sessionToken(id)?.token
      expect(token).toBeString()
      // A message while the tool waits: queued, it reaches the model at the tool's PostToolUse.
      const sent = await api("/api/agent/msg", { method: "POST", json: { to: id, text: "LIVE_MESSAGE_MARKER from the hub" } })
      expect(sent.status).toBe(201)
      expect(((await sent.json()) as any).delivery).toBe("queued")
      const answered = await api(`/api/sessions/${id}/permission`, { method: "POST", json: { requestID: blocker.id, decision: "once" } })
      expect(answered.status).toBe(204)
      const result = await runA.done
      const stop = recorded().find((e) => e.event === "Stop" && e.input.session_id === uuid)
      console.error(`[it] run A exit ${result.code}; Stop→exit ${stop ? result.endedAt - stop.at : "?"} ms; stderr: ${result.stderr.slice(0, 500)}`)
      expect(result.code).toBe(0)
      expect(existsSync(path.join(work, "approved.txt"))).toBe(true)

      const after = stub.requests.slice(from)
      const toolTurn = after.find((r) => text(r).includes("toolu_live1") && text(r).includes("tool_result"))
      expect(toolTurn).toBeDefined()
      expect(text(toolTurn!)).toContain(`HUBURL=${h.publicURL}`)
      expect(text(toolTurn!)).toContain(`HUBTOKEN=${token}`)
      expect(text(toolTurn!)).toContain("LIVE_MESSAGE_MARKER")
      const order = recorded()
        .filter((e) => e.input.session_id === uuid)
        .map((e) => e.event)
      expect(order).toEqual(expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"]))
      expect(order.indexOf("PermissionRequest")).toBeLessThan(order.indexOf("PostToolUse"))
      expect(recorded().every((e) => e.launch)).toBe(true)
      // T6 open question: the asyncRewake Stop hook holds a plain -p run until HUB_CLAUDE_REWAKE_TIMEOUT.
      if (stop) expect(result.endedAt - stop.at).toBeGreaterThanOrEqual(REWAKE_S * 1000 - 1500)
      // Every model request went to the stub (none to Anthropic); the deny proxy refused what else claude tried.
      expect(after.every((r) => r.path.endsWith("/v1/messages"))).toBe(true)
      console.error(`[it] proxy refused: ${proxy.hosts().join(", ") || "nothing"}`)
    },
    RUN_MS + 30_000,
  )

  test(
    "the plugin's MCP server serves hub tools as the session (HUB_CLAUDE_LAUNCH reaches it), act verbs with the act token",
    async () => {
      const tools: string[] = (stub.requests.at(-1)!.body.tools ?? []).map((t: any) => t.name)
      const whoami = tools.find((n) => /hub/.test(n) && n.endsWith("whoami"))
      const approve = tools.find((n) => /hub/.test(n) && n.endsWith("__approve"))
      console.error(`[it] hub MCP tools: ${tools.filter((n) => n.startsWith("mcp__")).join(", ")}`)
      expect(whoami).toBeDefined()
      expect(approve).toBeDefined()
      const uuid = randomUUID()
      const id = claudeSessionID(uuid)
      stub.queue(
        { toolCalls: [{ name: whoami!, input: {}, id: "toolu_mcp1" }] },
        { toolCalls: [{ name: approve!, input: { addr: id, requestID: "per_live_none" }, id: "toolu_mcp2" }] },
        { text: "checked" },
      )
      const from = stub.requests.length
      const result = await hubClaude(uuid, "who am I", ["--allowedTools", `${whoami},${approve}`]).done
      expect(result.code).toBe(0)
      const after = stub.requests.slice(from)
      const who = after.find((r) => text(r).includes("toolu_mcp1") && text(r).includes("tool_result"))
      const act = after.find((r) => text(r).includes("toolu_mcp2") && text(r).includes("tool_result"))
      console.error(`[it] whoami: ${who ? text(who).slice(text(who).indexOf("toolu_mcp1"), text(who).indexOf("toolu_mcp1") + 600) : "none"}`)
      console.error(`[it] approve: ${act ? text(act).slice(text(act).indexOf("toolu_mcp2"), text(act).indexOf("toolu_mcp2") + 600) : "none"}`)
      // whoami answered as this session: the MCP process had HUB_CLAUDE_LAUNCH, the daemon mapped it to the session.
      expect(text(who!)).toContain(id)
      // approve went out with the act token: the hub refused the request ID, not the credential.
      expect(text(act!)).not.toContain("no hub session act token")
      expect(text(act!)).not.toContain("unauthorized")
    },
    RUN_MS + 30_000,
  )

  test(
    "a hub stop during a turn: the next PreToolUse denies the call and ends the turn (continue:false); no Stop hook follows",
    async () => {
      const uuid = randomUUID()
      const id = claudeSessionID(uuid)
      // The model takes its time: the session is working when the hub stops it. The call is allowed up front, so only
      // the hub's PreToolUse answer can keep it from running.
      stub.queue({ toolCalls: [{ name: "Bash", input: { command: "touch stopped.txt", description: "x" }, id: "toolu_stop1" }], delayMs: 5000 }, { text: "after stop" })
      const from = stub.requests.length
      const runC = hubClaude(uuid, "slowly make another file", ["--allowedTools", "Bash(touch stopped.txt)"])
      await waitFor(() => state(id)?.state === "working", 60_000)
      const stopped = await api(`/api/sessions/${id}/stop`, { method: "POST" })
      expect(stopped.status).toBeLessThan(300)
      await waitFor(() => state(id)?.state !== "working", 30_000)
      const result = await runC.done
      const order = recorded()
        .filter((e) => e.input.session_id === uuid)
        .map((e) => e.event)
      console.error(`[it] run C exit ${result.code}; hooks: ${order.join(", ")}; model requests: ${stub.requests.length - from}; stdout: ${result.stdout.slice(0, 300)}`)
      expect(result.code).toBe(0)
      expect(existsSync(path.join(work, "stopped.txt"))).toBe(false)
      expect(order).toContain("PreToolUse")
      expect(order).not.toContain("PostToolUse")
      // T6 open question: after continue:false Claude Code fires no Stop hook (the daemon ends the turn itself).
      expect(order).not.toContain("Stop")
      expect(stub.requests.length - from).toBe(1)
    },
    RUN_MS + 30_000,
  )
})

if (!run) {
  describe("Claude Code spoke against the real claude", () => {
    test.skip("set HUB_IT_CLAUDE=1 with `claude` on PATH to run packages/claude-code/test/live.it.test.ts", () => {})
  })
}
