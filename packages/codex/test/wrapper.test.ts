// `hub codex [codex args…]` and `hub codex-spoke serve`: the wrapper makes sure the per-user Codex spoke runs
// (starting `hub codex-spoke serve` in the background when none does), then runs Codex with the shared daemon on
// (--enable daemon_auto_start: the TUI's threads live on the daemon, where the spoke attaches) and the user's
// arguments, its exit code passed through. Nothing is written under CODEX_HOME. No Codex binary: a fake `codex`
// (HUB_CODEX_BIN) records its arguments.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fakeHub, until, type FakeHub } from "../../testkit/src/index.ts"
import { run } from "../../cli/src/cli.ts"
import { codexMain } from "../src/main.ts"
import { codexHome, codexStateDir, daemonSocketPath, readServicePid } from "../src/paths.ts"

const ENTRY = path.join(import.meta.dir, "..", "..", "cli", "src", "main.ts")
const FAKE_APP_SERVER = path.join(import.meta.dir, "fixtures", "fake-app-server.ts")

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** A fake codex: `app-server …` runs the fake app-server; anything else records argv and exits 7. */
function fakeCodex(dir: string): string {
  const file = path.join(dir, "codex.ts")
  writeFileSync(
    file,
    `#!${process.execPath}
import { writeFileSync } from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
if (args[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0) }
if (args[0] === "app-server") { await import(${JSON.stringify(FAKE_APP_SERVER)}) }
else { writeFileSync(path.join(process.env.FAKE_OUT, "args.json"), JSON.stringify(args)); process.exit(7) }
`,
  )
  chmodSync(file, 0o755)
  return file
}

function setup(options: { enrolled?: boolean } = {}) {
  const hub = fakeHub({ hubFeatures: ["harness", "messaging", "launches"] })
  cleanup.push(() => hub.stop())
  const dir = mkdtempSync(path.join(tmpdir(), "hcx-"))
  const config = path.join(dir, "config.json")
  if (options.enrolled !== false) writeFileSync(config, JSON.stringify({ server: hub.url, mode: "always", token: "hmt1.MACHINE-SECRET" }), { mode: 0o600 })
  const codexHomeDir = path.join(dir, "codex-home")
  mkdirSync(codexHomeDir)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    HUB_SPOKE_CONFIG: config,
    HUB_STATE_DIR: path.join(dir, "state"),
    HUB_CODEX_BIN: fakeCodex(dir),
    CODEX_HOME: codexHomeDir,
    FAKE_OUT: dir,
  }
  cleanup.push(() => {
    const pid = readServicePid(env, dir)
    // Never signal pid <= 1 (kill(-1) reaches every process of this user) nor this process.
    if (pid !== undefined && Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
    }
  })
  return { hub, dir, env, codexHomeDir }
}

function io(env: Record<string, string>, home: string) {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { env, home, stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s), program: { execPath: process.execPath, entry: ENTRY } } }
}

const hello = (hub: FakeHub) => hub.frames.find((f) => f.t === "hello") as any

describe("paths", () => {
  test("the daemon socket is under CODEX_HOME (default ~/.codex); HUB_CODEX_DAEMON_SOCKET overrides it", () => {
    expect(codexHome({}, "/home/u")).toBe("/home/u/.codex")
    expect(daemonSocketPath({ CODEX_HOME: "/c" }, "/home/u")).toBe("/c/app-server-control/app-server-control.sock")
    expect(daemonSocketPath({ HUB_CODEX_DAEMON_SOCKET: "/tmp/d.sock" }, "/home/u")).toBe("/tmp/d.sock")
    expect(daemonSocketPath({ HUB_CODEX_DAEMON_SOCKET: "off" }, "/home/u")).toBeUndefined()
    expect(codexStateDir({ HUB_STATE_DIR: "/s" }, "/home/u")).toBe("/s/codex")
  })
})

describe("hub codex", () => {
  test("starts the spoke service when none runs, then runs codex with the daemon on and the user's arguments", async () => {
    const { hub, dir, env, codexHomeDir } = setup()
    const { io: cliIo, err } = io(env, dir)
    const code = await run(["codex", "--model", "o3", "fix it"], cliIo)
    expect(code).toBe(7)
    expect(JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8"))).toEqual(["--enable", "daemon_auto_start", "--model", "o3", "fix it"])
    expect(err.join("")).toBe("")
    await until(() => hello(hub) !== undefined, 10_000)
    expect(hello(hub)).toMatchObject({ harness: "codex", evidence: "rpc", kind: "service", harnessVersion: "0.160.0" })
    const pid = readServicePid(env, dir)
    expect(pid).toBeGreaterThan(0)
    // A second run finds it running and starts no other.
    expect(await run(["codex"], io(env, dir).io)).toBe(7)
    expect(readServicePid(env, dir)).toBe(pid)
    expect(hub.frames.filter((f) => f.t === "hello")).toHaveLength(1)
    // Codex's home is left alone.
    expect(readdirSync(codexHomeDir)).toEqual([])
  }, 20_000)

  test("on a machine that is not enrolled codex runs without the hub, and says why", async () => {
    const { dir, env } = setup({ enrolled: false })
    const { io: cliIo, err } = io(env, dir)
    expect(await run(["codex", "hi"], cliIo)).toBe(7)
    expect(JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8"))).toEqual(["hi"])
    expect(err.join("")).toMatch(/not enrolled/)
    expect(readServicePid(env, dir)).toBeUndefined()
  })

  test("a codex that cannot run exits 127 with the reason", async () => {
    const { dir, env } = setup({ enrolled: false })
    const { io: cliIo, err } = io({ ...env, HUB_CODEX_BIN: path.join(dir, "missing-codex") }, dir)
    expect(await run(["codex"], cliIo)).toBe(127)
    expect(err.join("")).toMatch(/cannot run/)
  })
})

describe("hub codex-spoke serve", () => {
  test("serves until aborted, with a pid file; a second one refuses while it runs", async () => {
    const { hub, dir, env } = setup()
    const controller = new AbortController()
    const logs: string[] = []
    const serving = codexMain(["serve"], { env: { ...env, HUB_CODEX_DAEMON_SOCKET: "off" }, home: dir, stdout: () => {}, stderr: (s) => void logs.push(s), signal: controller.signal })
    await until(() => hello(hub) !== undefined, 10_000)
    expect(readServicePid(env, dir)).toBe(process.pid)
    const second = await codexMain(["serve"], { env, home: dir, stdout: () => {}, stderr: (s) => void logs.push(s) })
    expect(second).toBe(1)
    expect(logs.join("")).toMatch(/already running/)
    controller.abort()
    expect(await serving).toBe(0)
    expect(readServicePid(env, dir)).toBeUndefined()
    expect(logs.join("")).not.toContain("MACHINE-SECRET")
  }, 20_000)

  test("refuses without an enrolled machine; unknown subcommands are usage errors", async () => {
    const { dir, env } = setup({ enrolled: false })
    const err: string[] = []
    expect(await codexMain(["serve"], { env, home: dir, stdout: () => {}, stderr: (s) => void err.push(s) })).toBe(1)
    expect(err.join("")).toMatch(/not enrolled/)
    expect(await codexMain(["nope"], { env, home: dir, stdout: () => {}, stderr: () => {} })).toBe(2)
    expect(existsSync(path.join(dir, "state", "codex", "spoke.pid"))).toBe(false)
  })
})
