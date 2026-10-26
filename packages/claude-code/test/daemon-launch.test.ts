// The daemon's launch features ("create", "launch", "turn", "interrupt"): a real hub (test/central-harness.ts), the
// daemon connected to it as the machine's claude-code service, and the fake claude (never the real one) started by
// the daemon in a workspace under the node's roots. The fake runs its hooks through the real bridge, so the hub sees
// the session's turns the way it would see Claude Code's.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ServerRequest } from "../../protocol/src/index.ts"
import { harness, waitFor, type Harness } from "../../../test/central-harness.ts"
import { startDaemon, type ClaudeDaemon, type DaemonOptions } from "../src/daemon.ts"
import { claudeSessionID } from "../src/ids.ts"
import { fakeClaude } from "./fake-claude.ts"

let h: Harness | undefined
const daemons: ClaudeDaemon[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop()
  await h?.stop()
  h = undefined
})

async function setup(options: Partial<DaemonOptions> = {}) {
  h = await harness()
  const hub = h
  const { token } = await hub.store.addMachine("mbp")
  const machineID = (await hub.store.findMachine(token))!.id
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "hcl-")))
  const root = path.join(base, "work")
  const workspace = path.join(root, "app")
  mkdirSync(workspace, { recursive: true })
  const socketPath = path.join(base, "cc", "d.sock")
  const fake = fakeClaude()
  const daemon = await startDaemon({
    socketPath,
    server: hub.url,
    token,
    harnessVersion: "2.1.296",
    pluginVersion: "0.6.1",
    directory: "/home/u",
    tokenWaitMs: 500,
    launch: { bin: fake.bin, pluginDir: () => "/plugins/plugin-test", roots: () => [root], env: { PATH: process.env.PATH ?? "" } },
    ...options,
  })
  daemons.push(daemon)
  await waitFor(() => daemon.state === "connected", 3000)
  const connID = () => hub.registry.serviceFor(machineID, "claude-code")!
  const request = <R extends ServerRequest>(req: R) => hub.spokes.request(connID(), req) as Promise<any>
  const starts = () => {
    try {
      return readFileSync(fake.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { hub, machineID, root, workspace, daemon, request, starts, socketPath }
}

const errorOf = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => e.message)

describe("launch features", () => {
  test("announced with a launcher: create, launch, turn and interrupt besides the hooks spoke's", async () => {
    const { daemon } = await setup()
    expect([...daemon.spoke.features].sort()).toEqual(["actTokens", "create", "deliver", "hubPrompt", "interrupt", "launch", "permission", "permissionMessage", "sessionTokens", "stop", "turn"])
  })

  test("a launch create starts claude headless in the workspace and reports the session at once", async () => {
    const { hub, workspace, request, starts, socketPath } = await setup()
    const { sessionID } = await request({ op: "create", directory: workspace, title: "fix-tests", launchID: "l_1", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" }, agent: "reviewer" })
    expect(hub.registry.hasSession(sessionID)).toBe(true)
    await waitFor(() => starts().length === 1, 5000)
    const [start] = starts()
    const native = start.argv[start.argv.indexOf("--session-id") + 1]
    expect(claudeSessionID(native)).toBe(sessionID)
    expect(start.cwd).toBe(workspace)
    expect(start.argv).toContain("--plugin-dir")
    expect(start.argv.slice(start.argv.indexOf("--model"), start.argv.indexOf("--model") + 2)).toEqual(["--model", "claude-sonnet-4-5"])
    expect(start.argv.slice(start.argv.indexOf("--agent"), start.argv.indexOf("--agent") + 2)).toEqual(["--agent", "reviewer"])
    expect(start.env.HUB_CLAUDE_SOCKET).toBe(socketPath)
    expect(start.env.HUB_CLAUDE_LAUNCH).toMatch(/^cl_/)
    expect(hub.registry.session(sessionID)).toMatchObject({ title: "fix-tests", directory: workspace })
  })

  test("a turn is the launched session's prompt: working through its hooks, then idle, with claude's reply", async () => {
    const { hub, workspace, request } = await setup()
    const { sessionID } = await request({ op: "create", directory: workspace, launchID: "l_2" })
    const result = await request({ op: "turn", sessionID, text: "hello there", voiceStyle: false })
    expect(result).toEqual({ outcome: "succeeded", reply: "echo: hello there" })
    await waitFor(() => hub.registry.idle(sessionID), 3000)
  })

  test("interrupt (a control request) and stop end a running turn as interrupted", async () => {
    const { hub, workspace, request } = await setup()
    const { sessionID } = await request({ op: "create", directory: workspace, launchID: "l_3" })
    const slow = request({ op: "turn", sessionID, text: "SLOW one", voiceStyle: false })
    await waitFor(() => hub.registry.running(sessionID), 5000)
    expect(await request({ op: "interrupt", sessionID })).toEqual({})
    expect(await slow).toMatchObject({ outcome: "interrupted" })
    await waitFor(() => !hub.registry.running(sessionID), 3000)

    const slower = request({ op: "turn", sessionID, text: "SLOW two", voiceStyle: false })
    await waitFor(() => hub.registry.running(sessionID), 5000)
    expect(await request({ op: "stop", sessionID })).toEqual({ stopped: [sessionID] })
    expect(await slower).toMatchObject({ outcome: "interrupted" })
  })

  test("claude exiting ends the session", async () => {
    const { hub, workspace, request } = await setup()
    const { sessionID } = await request({ op: "create", directory: workspace, launchID: "l_4" })
    expect((await request({ op: "turn", sessionID, text: "EXIT", voiceStyle: false })).outcome).toBe("failed")
    await waitFor(() => !hub.registry.hasSession(sessionID), 3000)
  })

  test("refuses a directory outside the node's workspace roots, a missing one, and agents or models Claude Code cannot take", async () => {
    const { root, workspace, request, starts } = await setup()
    expect(await errorOf(request({ op: "create", directory: tmpdir(), launchID: "l_5" }))).toMatch(/workspace roots/)
    expect(await errorOf(request({ op: "create", directory: path.join(root, "missing"), launchID: "l_5" }))).toMatch(/not a directory|does not exist/)
    expect(await errorOf(request({ op: "create", directory: path.join(root, "app", "..", "..", ".."), launchID: "l_5" }))).toMatch(/workspace roots|absolute/)
    expect(await errorOf(request({ op: "create", directory: workspace, launchID: "l_5", agent: "two words" }))).toMatch(/agent/)
    expect(await errorOf(request({ op: "create", directory: workspace, launchID: "l_5", model: { providerID: "openai", modelID: "gpt-5" } }))).toMatch(/model/)
    expect(await errorOf(request({ op: "create", directory: workspace, launchID: "l_5", model: { providerID: "anthropic", modelID: "-x" } }))).toMatch(/model/)
    expect(await errorOf(request({ op: "create", directory: workspace, herdrWorkspace: "w1" }))).toMatch(/Herdr/)
    expect(starts()).toEqual([])
  })

  test("turns and interrupts reach only sessions the hub launched (a terminal session refuses them)", async () => {
    const { hub, request, socketPath } = await setup()
    const { runHook } = await import("../src/bridge.ts")
    const sid = "fdcdc49e-c7ea-4b8a-886d-7c5d3dbde164"
    await runHook({ argv: [], stdin: JSON.stringify({ session_id: sid, transcript_path: "/t", cwd: "/work", hook_event_name: "SessionStart", source: "startup" }), env: {}, socketPath, stdout: () => {}, stderr: () => {} })
    await waitFor(() => hub.registry.hasSession(claudeSessionID(sid)))
    expect(await errorOf(request({ op: "turn", sessionID: claudeSessionID(sid), text: "hi", voiceStyle: false }))).toMatch(/launched/)
    expect(await errorOf(request({ op: "interrupt", sessionID: claudeSessionID(sid) }))).toMatch(/launched/)
  })

  test("without a launcher the daemon announces no launch features (and refuses create)", async () => {
    const { daemon } = await setup({ launch: undefined })
    expect(daemon.spoke.features).not.toContain("create")
    expect(daemon.spoke.features).not.toContain("launch")
    expect(daemon.spoke.features).not.toContain("turn")
  })

  test("stop() ends the claude processes it started", async () => {
    const { workspace, request, daemon, starts } = await setup()
    const { sessionID } = await request({ op: "create", directory: workspace, launchID: "l_6" })
    await request({ op: "turn", sessionID, text: "warm up", voiceStyle: false })
    const pid = starts()[0].pid as number
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive()).toBe(true)
    await daemon.stop()
    expect(alive()).toBe(false)
  })
})
