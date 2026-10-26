// The per-user daemon, end to end without Claude Code: a real hub (test/central-harness.ts), the daemon connected
// to it with the machine token as a claude-code hooks service, and the hook bridge talking to it over a real Unix
// socket with the spike's fixture hook inputs.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { harness, waitFor, type Harness } from "../../../test/central-harness.ts"
import { runHook } from "../src/bridge.ts"
import { startDaemon, type ClaudeDaemon, type DaemonOptions } from "../src/daemon.ts"
import { claudeSessionID } from "../src/ids.ts"
import { ask } from "../src/wire.ts"

const SID = "fdcdc49e-c7ea-4b8a-886d-7c5d3dbde164"
const HUB = claudeSessionID(SID)
const fixture = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", `${name}.json`), "utf8")), ...extra })

let h: Harness | undefined
const daemons: ClaudeDaemon[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop()
  await h?.stop()
  h = undefined
})

async function setup(options: Partial<DaemonOptions> = {}) {
  h = await harness()
  const { token } = await h.store.addMachine("mbp")
  const machineID = (await h.store.findMachine(token))!.id
  const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "hcd-")), "cc", "d.sock")
  const daemon = await startDaemon({ socketPath, server: h.url, token, harnessVersion: "2.1.296", pluginVersion: "0.6.1", directory: "/home/u", tokenWaitMs: 3000, ...options })
  daemons.push(daemon)
  await waitFor(() => daemon.state === "connected", 3000)
  const hook = async (name: string, extra: Record<string, unknown> = {}, more: { argv?: string[]; env?: Record<string, string> } = {}) => {
    const out = { stdout: "", stderr: "" }
    const code = await runHook({ argv: more.argv ?? [], stdin: fixture(name, extra), env: more.env ?? {}, socketPath, stdout: (s) => (out.stdout += s), stderr: (s) => (out.stderr += s) })
    return { code, ...out, json: out.stdout ? JSON.parse(out.stdout) : undefined }
  }
  return { hub: h, token, machineID, socketPath, daemon, hook }
}

const state = (hub: Harness) => hub.registry.status(HUB)?.find((s) => s.id === HUB)

describe("the daemon", () => {
  test("connects as the machine's claude-code hooks service; its socket is private (dir 0700, socket 0600)", async () => {
    const { hub, machineID, socketPath } = await setup()
    expect(hub.registry.serviceFor(machineID, "claude-code")).toBeDefined()
    expect(hub.registry.serviceFor(machineID)).toBeUndefined()
    expect(statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700)
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    expect(await ask(socketPath, { v: 1, kind: "ping" })).toMatchObject({ ok: true, pid: process.pid })
  })

  test("announces only what a hooks spoke can do: stop and permission among the core ops, deliver, prompts, reject messages", async () => {
    const { daemon } = await setup()
    expect([...daemon.spoke.features].sort()).toEqual(["actTokens", "deliver", "hubPrompt", "permission", "permissionMessage", "sessionTokens", "stop"])
  })

  test("a second daemon on the same socket refuses to start; a stale socket file is replaced", async () => {
    const { socketPath, token, hub } = await setup()
    await expect(startDaemon({ socketPath, server: hub.url, token, harnessVersion: "x", pluginVersion: "x", directory: "/" })).rejects.toThrow(/already running/)
    const stale = path.join(mkdtempSync(path.join(tmpdir(), "hcd-")), "d.sock")
    const old = createServer()
    await new Promise<void>((resolve) => old.listen(stale, resolve))
    await new Promise<void>((resolve) => old.close(() => resolve()))
    // A server that went away without removing its socket file (a crashed daemon).
    if (!existsSync(stale)) writeFileSync(stale, "")
    const second = await startDaemon({ socketPath: stale, server: hub.url, token, harnessVersion: "x", pluginVersion: "x", directory: "/" })
    daemons.push(second)
    expect(await ask(stale, { v: 1, kind: "ping" })).toMatchObject({ ok: true })
  })

  test("tightens a socket directory others can reach, and refuses a symlinked one", async () => {
    h = await harness()
    const { token } = await h.store.addMachine("mbp")
    const base = mkdtempSync(path.join(tmpdir(), "hcd-"))
    const open = path.join(base, "open")
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    const daemon = await startDaemon({ socketPath: path.join(open, "d.sock"), server: h.url, token, harnessVersion: "x", pluginVersion: "x", directory: "/" })
    daemons.push(daemon)
    expect(statSync(open).mode & 0o777).toBe(0o700)
    const link = path.join(base, "link")
    symlinkSync(open, link)
    await expect(startDaemon({ socketPath: path.join(link, "e.sock"), server: h.url, token, harnessVersion: "x", pluginVersion: "x", directory: "/" })).rejects.toThrow(/symlink|directory/)
  })
})

describe("hooks through the bridge", () => {
  test("SessionStart reports the session and writes its hub token to the env file; a turn is working until Stop", async () => {
    const { hub, hook } = await setup()
    const envFile = path.join(mkdtempSync(path.join(tmpdir(), "hce-")), "sessionstart-hook-1.sh")
    expect((await hook("session-start", {}, { env: { CLAUDE_ENV_FILE: envFile } })).code).toBe(0)
    expect(hub.registry.hasSession(HUB)).toBe(true)
    const env = readFileSync(envFile, "utf8")
    expect(env).toContain("export HUB_URL='http://voice.test'")
    expect(env).toMatch(/export HUB_SESSION_TOKEN='[^']+'/)
    await hook("user-prompt-submit")
    await waitFor(() => state(hub)?.state === "working")
    await hook("stop")
    await waitFor(() => state(hub)?.state === "idle")
    expect(hub.registry.idle(HUB)).toBe(true)
  })

  test("a PermissionRequest waits for the hub's answer from the console", async () => {
    const { hub, hook } = await setup()
    await hook("session-start")
    await hook("user-prompt-submit")
    await hook("pre-tool-use")
    const pending = hook("permission-request", {}, { argv: ["--wait", "5"] })
    await waitFor(() => (state(hub)?.blockers.length ?? 0) > 0, 3000)
    const blocker = state(hub)!.blockers[0]!
    expect(blocker).toMatchObject({ kind: "permission", action: "shell", resources: ["echo hi-from-bash; echo ENVV=$SPIKEVAR"] })
    const answer = await hub.api(`/api/sessions/${HUB}/permission`, { method: "POST", json: { requestID: blocker.id, decision: "once" } })
    expect(answer.status).toBe(204)
    expect((await pending).json).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })
    await waitFor(() => state(hub)?.blockers.length === 0)
  })

  test("a hub message wakes the idle session through the rewake Stop hook", async () => {
    const { hub, hook } = await setup()
    await hook("session-start")
    await hook("user-prompt-submit")
    await hook("stop")
    await waitFor(() => hub.registry.idle(HUB))
    const rewake = hook("stop", {}, { argv: ["--rewake"] })
    const sent = await hub.api("/api/agent/msg", { method: "POST", json: { to: HUB, text: "please look at the logs" } })
    expect(sent.status).toBe(201)
    const woke = await rewake
    expect(woke.code).toBe(2)
    expect(woke.stderr).toContain("please look at the logs")
    expect(woke.stderr).toContain("[hub]")
  })

  test("a hub stop applies at the running turn's next hook", async () => {
    const { hub, hook } = await setup()
    await hook("session-start")
    await hook("user-prompt-submit")
    await waitFor(() => state(hub)?.state === "working")
    const stopped = await hub.api(`/api/sessions/${HUB}/stop`, { method: "POST" })
    expect(stopped.status).toBeLessThan(300)
    expect((await hook("pre-tool-use")).json).toMatchObject({ continue: false, stopReason: expect.any(String), hookSpecificOutput: { permissionDecision: "deny" } })
    await waitFor(() => state(hub)?.state === "idle")
  })

  test("a launch whose process is gone ends its sessions", async () => {
    const { hub, hook, socketPath } = await setup({ livenessIntervalMs: 20 })
    const dead = Bun.spawn(["true"])
    await dead.exited
    expect(await ask(socketPath, { v: 1, kind: "launch", launch: "L1", pid: dead.pid })).toMatchObject({ ok: true })
    await hook("session-start", {}, { env: { HUB_CLAUDE_LAUNCH: "L1" } })
    await waitFor(() => !hub.registry.hasSession(HUB), 3000)
  })

  test("a launch's exit ends its sessions at once", async () => {
    const { hub, hook, socketPath } = await setup()
    await ask(socketPath, { v: 1, kind: "launch", launch: "L2", pid: process.pid })
    await hook("session-start", {}, { env: { HUB_CLAUDE_LAUNCH: "L2" } })
    expect(hub.registry.hasSession(HUB)).toBe(true)
    expect(await ask(socketPath, { v: 1, kind: "exit", launch: "L2" })).toMatchObject({ ok: true })
    await waitFor(() => !hub.registry.hasSession(HUB))
  })

  test("stop() closes the socket: hooks then fail open", async () => {
    const { hook, daemon, socketPath } = await setup()
    await daemon.stop()
    expect(existsSync(socketPath)).toBe(false)
    expect(await hook("pre-tool-use")).toEqual({ code: 0, stdout: "", stderr: "", json: undefined })
  })
})
