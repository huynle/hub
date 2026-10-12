import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  agentName,
  HerdrWatcher,
  herdrRunner,
  openInHerdr,
  parseAgents,
  parsePanes,
  parseWorkspaces,
  type HerdrRunner,
} from "../src/spoke/herdr"

// Output shapes as printed by `herdr agent list`, `herdr workspace list`, `herdr pane list`, `herdr tab create`.
const agent = (extra: Record<string, unknown> = {}) => ({
  agent: "opencode",
  agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: "ses_a" },
  agent_status: "idle",
  cwd: "/home/user/app",
  focused: false,
  pane_id: "w5:p14",
  tab_id: "w5:tB",
  terminal_title_stripped: "OC | Fix the login redirect",
  workspace_id: "w5",
  ...extra,
})
const agents = (...list: unknown[]) => JSON.stringify({ id: "cli:agent:list", result: { agents: list, type: "agent_list" } })
const workspace = (id: string, label: string, number: number) => ({
  workspace_id: id,
  label,
  number,
  pane_count: 2,
  tab_count: 1,
  agent_status: "idle",
  focused: false,
  active_tab_id: `${id}:t1`,
})
const workspaces = (...list: unknown[]) => JSON.stringify({ id: "cli:workspace:list", result: { workspaces: list, type: "workspace_list" } })
const pane = (workspaceID: string, cwd: string | null) => ({ pane_id: `${workspaceID}:p${Math.random()}`, workspace_id: workspaceID, tab_id: `${workspaceID}:t1`, cwd, agent_status: "unknown" })
const panes = (...list: unknown[]) => JSON.stringify({ id: "cli:pane:list", result: { panes: list, type: "pane_list" } })

/** A runner answering per subcommand; records every call. */
function fakeRunner(answers: Record<string, string | Error | ((args: string[]) => string | Error)>) {
  const calls: Array<{ args: string[]; timeoutMs: number }> = []
  const run: HerdrRunner = async (args, timeoutMs) => {
    calls.push({ args, timeoutMs })
    const answer = answers[`${args[0]} ${args[1]}`]
    const value = typeof answer === "function" ? answer(args) : answer
    if (value === undefined) throw new Error(`unexpected herdr ${args.join(" ")}`)
    if (value instanceof Error) throw value
    return value
  }
  return { run, calls }
}

describe("parsing", () => {
  test("agents: OpenCode panes with a session ID; title without the 'OC | ' prefix; unknown statuses become unknown", () => {
    const out = agents(
      agent(),
      agent({ pane_id: "w5:p2", agent_session: { value: "ses_b" }, agent_status: "working", terminal_title_stripped: "Plain title" }),
      agent({ pane_id: "w6:p1", workspace_id: "w6", agent_session: { value: "ses_c" }, agent_status: "sleepy", terminal_title_stripped: null }),
      agent({ agent: "claude", agent_session: { value: "ses_x" } }),
      agent({ agent_session: null }),
      agent({ agent_session: { value: "not-a-session" } }),
      agent({ workspace_id: 5 }),
      "junk",
    )
    expect(parseAgents(out)).toEqual([
      { sessionID: "ses_a", paneID: "w5:p14", workspaceID: "w5", cwd: "/home/user/app", title: "Fix the login redirect", status: "idle" },
      { sessionID: "ses_b", paneID: "w5:p2", workspaceID: "w5", cwd: "/home/user/app", title: "Plain title", status: "working" },
      { sessionID: "ses_c", paneID: "w6:p1", workspaceID: "w6", cwd: "/home/user/app", status: "unknown" },
    ])
  })

  test("garbage in, nothing out", () => {
    for (const bad of ["", "not json", "null", "[]", '{"result":null}', '{"result":{"agents":"x"}}', '{"error":{"code":"x"}}']) {
      expect(parseAgents(bad)).toEqual([])
      expect(parseWorkspaces(bad)).toEqual([])
      expect(parsePanes(bad)).toEqual([])
    }
  })

  test("workspaces in Herdr's order (number); panes with their folder", () => {
    expect(parseWorkspaces(workspaces(workspace("w7", "notes", 2), workspace("w5", "app", 1), { label: "no id" }))).toEqual([
      { id: "w5", label: "app", number: 1 },
      { id: "w7", label: "notes", number: 2 },
    ])
    expect(parsePanes(panes(pane("w5", "/home/user/app"), pane("w5", null), { cwd: "/x" }))).toEqual([{ workspaceID: "w5", cwd: "/home/user/app" }])
  })

  test("agent names: a slug of the title plus the end of the session ID", () => {
    expect(agentName("Fix the login redirect!", "ses_0123456789abcdef")).toBe("fix-the-login-redirect-abcdef")
    expect(agentName(undefined, "ses_0123456789abcdef")).toBe("opencode-abcdef")
    expect(agentName("   ", "ses_0123456789abcdef")).toBe("opencode-abcdef")
    expect(agentName("x".repeat(100), "ses_0123456789abcdef").length).toBeLessThanOrEqual(48)
  })
})

describe("HerdrWatcher", () => {
  const watchers: HerdrWatcher[] = []
  afterEach(() => {
    for (const w of watchers.splice(0)) w.stop()
  })

  test("refresh: open sessions with terminal info, workspaces with pane folders by frequency, 3 s timeouts", async () => {
    const { run, calls } = fakeRunner({
      "agent list": agents(agent(), agent({ pane_id: "w7:p1", workspace_id: "w7", agent_session: { value: "ses_b" }, agent_status: "blocked", cwd: "/home/user/notes" })),
      "workspace list": workspaces(workspace("w5", "app", 1), workspace("w7", "notes", 2)),
      "pane list": panes(pane("w5", "/home/user/app/web"), pane("w5", "/home/user/app"), pane("w5", "/home/user/app"), pane("w7", "/home/user/notes")),
    })
    let changes = 0
    const watcher = new HerdrWatcher({ run, onChange: () => changes++ })
    watchers.push(watcher)
    await watcher.refresh()
    expect(calls.every((c) => c.timeoutMs === 3000)).toBe(true)
    expect(Object.fromEntries(watcher.open())).toEqual({
      ses_a: { source: "herdr", workspaceID: "w5", workspace: "app", title: "Fix the login redirect", status: "idle" },
      ses_b: { source: "herdr", workspaceID: "w7", workspace: "notes", title: "Fix the login redirect", status: "blocked" },
    })
    expect(watcher.workspaces()).toEqual([
      { id: "w5", label: "app", directories: ["/home/user/app", "/home/user/app/web"] },
      { id: "w7", label: "notes", directories: ["/home/user/notes"] },
    ])
    expect(watcher.hasDirectory("/home/user/app/web")).toBe(true)
    expect(watcher.hasDirectory("/home/user/app/web/")).toBe(true)
    expect(watcher.hasDirectory("/etc")).toBe(false)
    expect(watcher.hasWorkspace("w7")).toBe(true)
    expect(watcher.hasWorkspace("w9")).toBe(false)
    expect(changes).toBe(1)
    await watcher.refresh()
    expect(changes).toBe(1) // nothing changed
  })

  test("agents from a workspace the panes list missed still contribute their folder", async () => {
    const { run } = fakeRunner({
      "agent list": agents(agent({ cwd: "/home/user/other" })),
      "workspace list": workspaces(workspace("w5", "app", 1)),
      "pane list": new Error("old herdr"),
    })
    const watcher = new HerdrWatcher({ run, onChange: () => {} })
    watchers.push(watcher)
    await watcher.refresh()
    expect(watcher.workspaces()).toEqual([{ id: "w5", label: "app", directories: ["/home/user/other"] }])
  })

  test("errors are silent: no herdr or server down means no Herdr data", async () => {
    let up = true
    const { run } = fakeRunner({
      "agent list": () => (up ? agents(agent()) : new Error("connect ECONNREFUSED")),
      "workspace list": () => (up ? workspaces(workspace("w5", "app", 1)) : new Error("server not running")),
      "pane list": () => (up ? panes() : new Error("server not running")),
    })
    const changed: number[] = []
    const watcher = new HerdrWatcher({ run, onChange: () => changed.push(watcher.open().size) })
    watchers.push(watcher)
    await watcher.refresh()
    expect(watcher.open().size).toBe(1)
    up = false
    await watcher.refresh()
    expect(watcher.open().size).toBe(0)
    expect(watcher.workspaces()).toBeUndefined()
    expect(changed).toEqual([1, 0])
  })

  test("start polls agents and workspaces on their own intervals; stop clears", async () => {
    const { run, calls } = fakeRunner({ "agent list": agents(agent()), "workspace list": workspaces(), "pane list": panes() })
    const watcher = new HerdrWatcher({ run, onChange: () => {}, agentsMs: 20, workspacesMs: 1000 })
    watchers.push(watcher)
    watcher.start()
    await Bun.sleep(110)
    const agentCalls = calls.filter((c) => c.args[0] === "agent").length
    const workspaceCalls = calls.filter((c) => c.args[0] === "workspace").length
    expect(agentCalls).toBeGreaterThanOrEqual(3)
    expect(workspaceCalls).toBe(1)
    watcher.stop()
    expect(watcher.open().size).toBe(0)
    const after = calls.length
    await Bun.sleep(60)
    expect(calls.length).toBe(after)
  })
})

describe("openInHerdr", () => {
  test("creates a tab in the workspace at the directory, then starts OpenCode on the session in its pane", async () => {
    const { run, calls } = fakeRunner({
      "tab create": JSON.stringify({ id: "cli:tab:create", result: { type: "tab_created", tab: { tab_id: "w5:t9" }, root_pane: { pane_id: "w5:p31" } } }),
      "agent start": JSON.stringify({ id: "cli:agent:start", result: { type: "agent_started" } }),
    })
    await openInHerdr(run, { workspaceID: "w5", directory: "/home/user/app", sessionID: "ses_0123456789abcdef", title: "Voice idea" }, { settleMs: 0 })
    expect(calls.map((c) => c.args)).toEqual([
      ["tab", "create", "--workspace", "w5", "--cwd", "/home/user/app", "--label", "Voice idea", "--no-focus"],
      ["agent", "start", "voice-idea-abcdef", "--kind", "opencode", "--pane", "w5:p31", "--timeout", "20000", "--", "--session", "ses_0123456789abcdef"],
    ])
    expect(calls[1]!.timeoutMs).toBeGreaterThan(20000)
  })

  test("fails when the tab answer has no pane, or a step fails", async () => {
    const noPane = fakeRunner({ "tab create": JSON.stringify({ result: { type: "tab_created" } }) })
    await expect(openInHerdr(noPane.run, { workspaceID: "w5", directory: "/a", sessionID: "ses_1" }, { settleMs: 0 })).rejects.toThrow(/pane/)
    const failing = fakeRunner({ "tab create": new Error("workspace_not_found") })
    await expect(openInHerdr(failing.run, { workspaceID: "w5", directory: "/a", sessionID: "ses_1" }, { settleMs: 0 })).rejects.toThrow(/workspace_not_found/)
    const refused = fakeRunner({ "tab create": JSON.stringify({ error: { code: "workspace_not_found", message: "no such workspace" } }) })
    await expect(openInHerdr(refused.run, { workspaceID: "w5", directory: "/a", sessionID: "ses_1" }, { settleMs: 0 })).rejects.toThrow(/no such workspace/)
  })
})

describe("herdrRunner", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const fakeBin = (script: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "voice-herdr-"))
    dirs.push(dir)
    const file = path.join(dir, "herdr")
    writeFileSync(file, `#!/bin/sh\n${script}\n`)
    chmodSync(file, 0o755)
    return file
  }

  test("returns stdout and passes arguments", async () => {
    const bin = fakeBin('printf \'{"args":"%s"}\' "$*"')
    expect(await herdrRunner(bin)(["agent", "list"], 3000)).toBe('{"args":"agent list"}')
  })

  test("non-zero exit, timeout and a missing executable reject", async () => {
    await expect(herdrRunner(fakeBin("echo boom >&2; exit 3"))(["x"], 3000)).rejects.toThrow(/boom|3/)
    const started = Date.now()
    await expect(herdrRunner(fakeBin("sleep 5"))(["x"], 100)).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(2000)
    await expect(herdrRunner("/nonexistent/herdr")(["x"], 1000)).rejects.toThrow()
  })
})
