// `hub claude [claude args…]`: makes sure the per-user daemon runs (starting it when none answers), writes the plugin
// directory and runs Claude Code with --plugin-dir (never touching ~/.claude) as a launch the daemon knows. No Claude
// Code binary: a fake `claude` (HUB_CLAUDE_BIN) records its arguments and environment and, as a fixture-hook driver,
// runs the plugin's hook commands from hooks.json through sh exactly as Claude Code would, with the spike's stdin.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harness, waitFor, type Harness } from "../../../test/central-harness.ts"
import { run } from "../../cli/src/cli.ts"
import { startDaemon, type ClaudeDaemon } from "../src/daemon.ts"
import { claudeSessionID } from "../src/ids.ts"
import { socketPath } from "../src/paths.ts"
import { ask } from "../src/wire.ts"

const SID = "fdcdc49e-c7ea-4b8a-886d-7c5d3dbde164"
const HUB = claudeSessionID(SID)
const ENTRY = path.join(import.meta.dir, "..", "..", "cli", "src", "main.ts")
const FIXTURES = path.join(import.meta.dir, "fixtures")

let h: Harness | undefined
const daemons: ClaudeDaemon[] = []
const pids: number[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop()
  for (const pid of pids.splice(0)) {
    // Never a pid ≤ 1 (0 and negative IDs signal process groups or every process: quirk wqnafwvz).
    if (!Number.isInteger(pid) || pid <= 1) continue
    try {
      process.kill(pid)
    } catch {}
  }
  await h?.stop()
  h = undefined
})

/** A fake claude: records argv and HUB_CLAUDE_* env; with DRIVE, runs those hook events' commands from the plugin. */
function fakeClaude(dir: string): string {
  const file = path.join(dir, "claude.ts")
  writeFileSync(
    file,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
const args = process.argv.slice(2)
if (args[0] === "--version") { console.log("2.1.296 (Claude Code)"); process.exit(0) }
const out = process.env.FAKE_OUT
writeFileSync(path.join(out, "args.json"), JSON.stringify(args))
writeFileSync(path.join(out, "env.json"), JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("HUB_CLAUDE")))))
const at = args.indexOf("--plugin-dir")
const results = []
if (at >= 0 && process.env.DRIVE) {
  const hooks = JSON.parse(readFileSync(path.join(args[at + 1], "hooks", "hooks.json"), "utf8")).hooks
  for (const name of process.env.DRIVE.split(",")) {
    const [event, fixtureName] = name.split(":")
    const stdin = readFileSync(path.join(${JSON.stringify(FIXTURES)}, fixtureName + ".json"), "utf8")
    for (const group of hooks[event]) for (const hook of group.hooks) {
      if (hook.asyncRewake) continue
      const r = spawnSync("sh", ["-c", hook.command], { input: stdin, encoding: "utf8", env: { ...process.env, CLAUDE_ENV_FILE: path.join(out, "env.sh") }, timeout: hook.timeout * 1000 })
      results.push({ event, status: r.status, stdout: r.stdout, stderr: r.stderr })
    }
  }
}
writeFileSync(path.join(out, "hooks.json"), JSON.stringify(results))
process.exit(7)
`,
  )
  chmodSync(file, 0o755)
  return file
}

async function setup(options: { enrolled?: boolean; daemon?: boolean } = {}) {
  h = await harness()
  const { token } = await h.store.addMachine("mbp")
  const dir = mkdtempSync(path.join(tmpdir(), "hcw-"))
  const config = path.join(dir, "config.json")
  if (options.enrolled !== false) writeFileSync(config, JSON.stringify({ server: h.url, mode: "always", token }), { mode: 0o600 })
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, HUB_SPOKE_CONFIG: config, HUB_STATE_DIR: path.join(dir, "state"), HUB_CLAUDE_BIN: fakeClaude(dir), FAKE_OUT: dir }
  if (options.daemon) {
    const daemon = await startDaemon({ socketPath: socketPath(env, dir), server: h.url, token, harnessVersion: "2.1.296", pluginVersion: "0.6.1", directory: dir, tokenWaitMs: 3000 })
    daemons.push(daemon)
    await waitFor(() => daemon.state === "connected", 3000)
  }
  const err: string[] = []
  const claude = (args: string[], extra: Record<string, string> = {}) =>
    run(["claude", ...args], { env: { ...env, ...extra }, home: dir, stdout: () => {}, stderr: (s) => err.push(s), program: { execPath: process.execPath, entry: ENTRY } })
  const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"))
  return { hub: h, env, dir, claude, read, err }
}

describe("hub claude", () => {
  test("runs claude with the plugin dir and the user's arguments; claude's exit code is the command's", async () => {
    const { claude, read } = await setup({ daemon: true })
    expect(await claude(["-p", "hi there"])).toBe(7)
    const args = read("args.json") as string[]
    expect(args.slice(0, 1)).toEqual(["--plugin-dir"])
    expect(args.slice(2)).toEqual(["-p", "hi there"])
    expect(existsSync(path.join(args[1]!, "hooks", "hooks.json"))).toBe(true)
    const env = read("env.json")
    expect(env.HUB_CLAUDE_LAUNCH).toMatch(/^cl_[0-9a-f]+$/)
    expect(env.HUB_CLAUDE_SOCKET).toMatch(/daemon\.sock$/)
  })

  test("the plugin's hook commands reach the daemon and the hub; the session ends with the run", async () => {
    const { claude, read, hub, dir } = await setup({ daemon: true })
    let during = false
    const watcher = waitFor(() => (during ||= hub.registry.hasSession(HUB)), 20_000)
    expect(await claude([], { DRIVE: "SessionStart:session-start,UserPromptSubmit:user-prompt-submit,PreToolUse:pre-tool-use" })).toBe(7)
    await watcher
    const results = read("hooks.json") as { event: string; status: number; stdout: string }[]
    expect(results.map((r) => [r.event, r.status])).toEqual([["SessionStart", 0], ["UserPromptSubmit", 0], ["PreToolUse", 0]])
    expect(readFileSync(path.join(dir, "env.sh"), "utf8")).toMatch(/^export HUB_URL='[^']+'\nexport HUB_SESSION_TOKEN='[^']+'\n$/)
    await waitFor(() => !hub.registry.hasSession(HUB), 3000)
  }, 30_000)

  test("starts the daemon when none answers", async () => {
    const { claude, env, dir, hub } = await setup()
    expect(await claude([])).toBe(7)
    const ping = (await ask(socketPath(env, dir), { v: 1, kind: "ping" }, { timeoutMs: 2000 })) as { ok: boolean; pid: number }
    expect(ping.ok).toBe(true)
    pids.push(ping.pid)
    const machineID = (await hub.store.findMachine(JSON.parse(readFileSync(env.HUB_SPOKE_CONFIG!, "utf8")).token))!.id
    await waitFor(() => hub.registry.serviceFor(machineID, "claude-code") !== undefined, 5000)
  }, 20_000)

  test("on a machine that is not enrolled, runs claude without the hub and says so", async () => {
    const { claude, read, err } = await setup({ enrolled: false })
    expect(await claude(["--resume"])).toBe(7)
    expect(read("args.json")).toEqual(["--resume"])
    expect(err.join("")).toMatch(/not enrolled/)
  })

  test("a print run without streaming input turns the rewake hook off (it would hold -p until its timeout); others keep it", async () => {
    const { claude, read } = await setup({ daemon: true })
    for (const [args, rewake] of [
      [["-p", "hi"], "off"],
      [["--print", "hi"], "off"],
      [["-p", "--input-format", "stream-json", "--output-format", "stream-json"], undefined],
      [["-p", "--input-format=stream-json"], undefined],
      [["--resume"], undefined],
    ] as const) {
      await claude([...args])
      expect({ args, rewake: read("env.json").HUB_CLAUDE_REWAKE }).toEqual({ args, rewake })
    }
  })

  test("HUB_CLAUDE_PERMISSION_WAIT sets the PermissionRequest wait (seconds)", async () => {
    const { claude, read } = await setup({ daemon: true })
    await claude([], { HUB_CLAUDE_PERMISSION_WAIT: "30" })
    const dir = (read("args.json") as string[])[1]!
    const hooks = JSON.parse(readFileSync(path.join(dir, "hooks", "hooks.json"), "utf8")).hooks
    expect(hooks.PermissionRequest[0].hooks[0].command).toEndWith("--wait 30")
  })
})

describe("hub claude-code", () => {
  test("hook without a daemon fails open; an unknown subcommand is a usage error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hcw-"))
    const out: string[] = []
    const io = { env: { HUB_STATE_DIR: dir }, home: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), stdin: async () => readFileSync(path.join(FIXTURES, "stop.json"), "utf8") }
    expect(await run(["claude-code", "hook"], io)).toBe(0)
    expect(out).toEqual([])
    expect(await run(["claude-code", "nope"], io)).toBe(2)
  })

  test("daemon on a machine that is not enrolled exits 1 with the reason", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hcw-"))
    const err: string[] = []
    expect(await run(["claude-code", "daemon"], { env: { HUB_STATE_DIR: dir, HUB_SPOKE_CONFIG: path.join(dir, "none.json") }, home: dir, stdout: () => {}, stderr: (s) => err.push(s) })).toBe(1)
    expect(err.join("")).toMatch(/not enrolled/)
  })
})
