// Auto-starting a local hub: only for loopback servers nothing answers on, one starter at a time
// (hub.pid lock), detached `bun bin/hub.ts` with output to hub.log, then wait for /healthz.
import { beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultStateDir, ensureLocalHub, hubScript, resolveHubRuntime, type LocalHubOptions, type SpawnLike } from "../src/spoke/localhub"

interface Spawned {
  command: string
  args: readonly string[]
  options: Record<string, any>
  child: FakeChild
}

class FakeChild extends EventEmitter {
  unrefed = false
  constructor(readonly pid: number | undefined) {
    super()
  }
  unref() {
    this.unrefed = true
  }
}

let dir: string
let spawned: Spawned[]
let up: Set<string> // origins that answer /healthz
let alive: Set<number>
let probes: string[]
let clock: number
let nextPid: number
let onSpawn: (s: Spawned) => void

const spawn: SpawnLike = (command, args, options) => {
  const child = new FakeChild(nextPid++)
  const s = { command, args, options: options as Record<string, any>, child }
  spawned.push(s)
  alive.add(child.pid!)
  onSpawn(s)
  return child
}

const fetch = (async (url: string | URL | Request) => {
  const u = new URL(String(url))
  probes.push(String(url))
  if (!up.has(u.origin)) throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" })
  return Response.json({ ok: true })
}) as unknown as typeof globalThis.fetch

const options = (extra: Partial<LocalHubOptions> = {}): LocalHubOptions => ({
  stateDir: dir,
  repoRoot: "/repo/opencode-voice",
  bun: "/usr/local/bin/bun",
  spawn,
  fetch,
  isAlive: (pid) => alive.has(pid),
  now: () => clock,
  sleep: async (ms) => {
    clock += ms
  },
  waitMs: 10_000,
  env: { PATH: "/usr/bin", HUB_PORT: "9999", HUB_HOST: "0.0.0.0" },
  pid: 4242,
  ...extra,
})

const lock = () => JSON.parse(readFileSync(path.join(dir, "hub.pid"), "utf8"))

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "voice-localhub-"))
  spawned = []
  up = new Set()
  alive = new Set([4242])
  probes = []
  clock = 1_000_000
  nextPid = 5000
  // By default the hub comes up as soon as it is spawned.
  onSpawn = (s) => up.add(`http://127.0.0.1:${s.options.env.HUB_PORT}`)
})

describe("ensureLocalHub", () => {
  test("never for a non-loopback or https server", async () => {
    for (const server of ["https://voice.example.com", "http://192.168.1.5:4097", "https://localhost:4097"]) {
      expect((await ensureLocalHub(server, options())).status).toBe("skipped")
    }
    expect(spawned).toHaveLength(0)
    expect(probes).toHaveLength(0)
  })

  test("does nothing when something already answers", async () => {
    up.add("http://127.0.0.1:4097")
    expect(await ensureLocalHub("http://127.0.0.1:4097", options())).toEqual({ status: "running" })
    expect(spawned).toHaveLength(0)
  })

  test("refused: starts `bun <repo>/bin/hub.ts` detached on the server's port, logs to hub.log, records the pid", async () => {
    const result = await ensureLocalHub("http://127.0.0.1:4321", options())
    expect(result).toEqual({ status: "started", pid: 5000 })
    expect(spawned).toHaveLength(1)
    const s = spawned[0]!
    expect(s.command).toBe("/usr/local/bin/bun")
    expect(s.args).toEqual(["/repo/opencode-voice/bin/hub.ts"])
    expect(s.options.detached).toBe(true)
    expect(s.options.cwd).toBe("/repo/opencode-voice")
    expect(s.options.stdio[0]).toBe("ignore")
    expect(typeof s.options.stdio[1]).toBe("number")
    expect(s.options.env).toMatchObject({ PATH: "/usr/bin", HUB_HOST: "127.0.0.1", HUB_PORT: "4321", HUB_PUBLIC_URL: "http://127.0.0.1:4321" })
    expect(s.child.unrefed).toBe(true)
    expect(statSync(path.join(dir, "hub.log")).mode & 0o777).toBe(0o600)
    expect(lock()).toMatchObject({ pid: 5000, port: 4321 })
  })

  test("localhost and [::1] servers bind the matching loopback address and keep their public origin", async () => {
    onSpawn = (s) => up.add(`http://${s.options.env.HUB_HOST === "::1" ? "[::1]" : s.options.env.HUB_HOST}:${s.options.env.HUB_PORT}`)
    up.add("http://localhost:4400") // never consulted for the readiness check: we probe what we started
    await ensureLocalHub("http://localhost:4401/", options())
    expect(spawned[0]!.options.env).toMatchObject({ HUB_HOST: "127.0.0.1", HUB_PORT: "4401", HUB_PUBLIC_URL: "http://localhost:4401" })
    // a separate machine state: the first hub's live lock would (rightly) block a second hub on another port
    await ensureLocalHub("http://[::1]:4402", options({ stateDir: mkdtempSync(path.join(tmpdir(), "voice-localhub-")) }))
    expect(spawned[1]!.options.env).toMatchObject({ HUB_HOST: "::1", HUB_PORT: "4402", HUB_PUBLIC_URL: "http://[::1]:4402" })
  })

  test("legacy VOICE_HOST/PORT/PUBLIC_URL of the parent never reach the hub (they would only warn)", async () => {
    await ensureLocalHub("http://127.0.0.1:4321", options({ env: { PATH: "/usr/bin", VOICE_PORT: "9999", VOICE_HOST: "0.0.0.0", VOICE_PUBLIC_URL: "https://x.example.com" } }))
    const env = spawned[0]!.options.env
    expect(env).toMatchObject({ HUB_HOST: "127.0.0.1", HUB_PORT: "4321", HUB_PUBLIC_URL: "http://127.0.0.1:4321" })
    expect(env.VOICE_PORT).toBeUndefined()
    expect(env.VOICE_HOST).toBeUndefined()
    expect(env.VOICE_PUBLIC_URL).toBeUndefined()
  })

  test("without a state dir: ~/.local/state/opencode-hub, migrated from opencode-voice first (without its lock)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hub-home-"))
    const legacy = path.join(home, ".local", "state", "opencode-voice")
    mkdirSync(legacy, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(legacy, "machines.json"), "[]", { mode: 0o600 })
    writeFileSync(path.join(legacy, "hub.pid"), JSON.stringify({ pid: 4242, port: 4321, started: clock }))
    const lines: string[] = []
    const result = await ensureLocalHub("http://127.0.0.1:4321", options({ stateDir: undefined, home, env: { PATH: "/usr/bin" }, log: (m) => lines.push(m) }))
    expect(result).toEqual({ status: "started", pid: 5000 })
    const state = path.join(home, ".local", "state", "opencode-hub")
    expect(readFileSync(path.join(state, "machines.json"), "utf8")).toBe("[]")
    expect(existsSync(path.join(state, "hub.log"))).toBe(true)
    expect(existsSync(path.join(legacy, "machines.json"))).toBe(true)
    expect(lines).toHaveLength(1)
  })

  test("defaultStateDir: HUB_STATE_DIR, then the legacy VOICE_STATE_DIR, then ~/.local/state/opencode-hub", () => {
    expect(defaultStateDir({ HUB_STATE_DIR: "/new", VOICE_STATE_DIR: "/old" }, "/home/me")).toBe("/new")
    expect(defaultStateDir({ VOICE_STATE_DIR: "/old" }, "/home/me")).toBe("/old")
    expect(defaultStateDir({}, "/home/me")).toBe("/home/me/.local/state/opencode-hub")
  })

  test("only one starter: a fresh lock held by a live process means busy", async () => {
    writeFileSync(path.join(dir, "hub.pid"), JSON.stringify({ pid: 777, port: 4321, started: clock - 1000 }))
    alive.add(777)
    expect(await ensureLocalHub("http://127.0.0.1:4321", options())).toEqual({ status: "busy", pid: 777 })
    expect(spawned).toHaveLength(0)
  })

  test("two callers at once spawn one hub", async () => {
    onSpawn = () => {} // slow hub: not answering yet
    const a = ensureLocalHub("http://127.0.0.1:4321", options({ waitMs: 2000 }))
    const b = ensureLocalHub("http://127.0.0.1:4321", options({ waitMs: 2000, pid: 4343 }))
    const results = await Promise.all([a, b])
    expect(spawned).toHaveLength(1)
    expect(results.map((r) => r.status).sort()).toEqual(["busy", "failed"])
  })

  test("a lock left by a dead process is replaced", async () => {
    writeFileSync(path.join(dir, "hub.pid"), JSON.stringify({ pid: 777, port: 4321, started: clock - 1000 }))
    expect((await ensureLocalHub("http://127.0.0.1:4321", options())).status).toBe("started")
    expect(lock().pid).toBe(5000)
  })

  test("a live pid that has not answered for over a minute is treated as stale (pid reuse)", async () => {
    writeFileSync(path.join(dir, "hub.pid"), JSON.stringify({ pid: 777, port: 4321, started: clock - 120_000 }))
    alive.add(777)
    expect((await ensureLocalHub("http://127.0.0.1:4321", options())).status).toBe("started")
  })

  test("an unreadable lock is busy while fresh and replaced once old", async () => {
    const file = path.join(dir, "hub.pid")
    writeFileSync(file, "garbage")
    const t = new Date()
    utimesSync(file, t, t)
    expect((await ensureLocalHub("http://127.0.0.1:4321", options({ now: () => t.getTime() + 1000 }))).status).toBe("busy")
    const old = new Date(t.getTime() - 120_000)
    utimesSync(file, old, old)
    expect((await ensureLocalHub("http://127.0.0.1:4321", options({ now: () => t.getTime() }))).status).toBe("started")
  })

  test("a hub already running on another port is not doubled (it would share the state)", async () => {
    writeFileSync(path.join(dir, "hub.pid"), JSON.stringify({ pid: 777, port: 4097, started: clock - 600_000 }))
    alive.add(777)
    up.add("http://127.0.0.1:4097")
    const result = await ensureLocalHub("http://127.0.0.1:4321", options())
    expect(result.status).toBe("failed")
    expect((result as { error: string }).error).toContain("4097")
    expect(spawned).toHaveLength(0)
    expect(lock().pid).toBe(777)
  })

  test("a hub that exits at once fails with a pointer to hub.log and frees the lock", async () => {
    onSpawn = (s) => queueMicrotask(() => s.child.emit("exit", 1, null))
    const result = await ensureLocalHub("http://127.0.0.1:4321", options())
    expect(result.status).toBe("failed")
    expect((result as { error: string }).error).toContain("hub.log")
    expect(existsSync(path.join(dir, "hub.pid"))).toBe(false)
  })

  test("spawn errors fail and free the lock", async () => {
    const result = await ensureLocalHub("http://127.0.0.1:4321", options({ spawn: () => { throw new Error("ENOENT bun") } }))
    expect(result).toEqual({ status: "failed", error: expect.stringContaining("ENOENT bun") })
    expect(existsSync(path.join(dir, "hub.pid"))).toBe(false)
  })

  test("a hub that never answers fails after waitMs and keeps its lock (it may still be starting)", async () => {
    onSpawn = () => {}
    const result = await ensureLocalHub("http://127.0.0.1:4321", options({ waitMs: 3000 }))
    expect(result.status).toBe("failed")
    expect(lock().pid).toBe(5000)
  })

  test("the hub script is this repo's bin/hub.ts", () => {
    expect(existsSync(hubScript())).toBe(true)
    expect(hubScript()).toEndWith(path.join("bin", "hub.ts"))
  })

  test("an injected runtime is spawned with its extra env (e.g. OpenCode's binary as Bun)", async () => {
    const env = { PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: "x" }
    const result = await ensureLocalHub("http://127.0.0.1:4321", options({ bun: undefined, env, runtime: { command: "/opt/opencode/bin/opencode", env: { BUN_BE_BUN: "1" } } }))
    expect(result.status).toBe("started")
    const s = spawned[0]!
    expect(s.command).toBe("/opt/opencode/bin/opencode")
    expect(s.args).toEqual(["/repo/opencode-voice/bin/hub.ts"])
    expect(s.options.env).toMatchObject({ BUN_BE_BUN: "1", HUB_PORT: "4321" })
    expect(s.options.env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  })

  test("with a plain bun runtime, an inherited BUN_BE_BUN is not passed on", async () => {
    await ensureLocalHub("http://127.0.0.1:4321", options({ env: { PATH: "/usr/bin", BUN_BE_BUN: "1" } }))
    expect(spawned[0]!.options.env.BUN_BE_BUN).toBeUndefined()
  })
})

describe("resolveHubRuntime", () => {
  const base = { execPath: "/opt/opencode/bin/opencode", home: "/home/user", isBun: true, which: () => null, exists: () => false }

  test("this runtime when it is bun", () => {
    expect(resolveHubRuntime({ ...base, execPath: "/usr/local/bin/bun", which: () => "/elsewhere/bun" })).toEqual({ command: "/usr/local/bin/bun", env: {} })
    expect(resolveHubRuntime({ ...base, execPath: "C:\\bun\\bun.exe" })).toEqual({ command: "C:\\bun\\bun.exe", env: {} })
  })

  test("else bun on PATH", () => {
    expect(resolveHubRuntime({ ...base, which: (name) => (name === "bun" ? "/usr/bin/bun" : null) })).toEqual({ command: "/usr/bin/bun", env: {} })
  })

  test("else ~/.bun/bin/bun when installed there", () => {
    expect(resolveHubRuntime({ ...base, exists: (p) => p === path.join("/home/user", ".bun", "bin", "bun") })).toEqual({
      command: path.join("/home/user", ".bun", "bin", "bun"),
      env: {},
    })
  })

  test("else this compiled Bun executable (OpenCode) running as bun via BUN_BE_BUN=1: nothing else to install", () => {
    expect(resolveHubRuntime(base)).toEqual({ command: "/opt/opencode/bin/opencode", env: { BUN_BE_BUN: "1" } })
  })

  test("outside a Bun runtime with no bun anywhere: plain `bun` (the start fails with a clear error)", () => {
    expect(resolveHubRuntime({ ...base, isBun: false, execPath: "/usr/bin/node" })).toEqual({ command: "bun", env: {} })
  })
})
