// The tmux backend against a real tmux, always on a private socket (-L hub-it-<random>, -f /dev/null): the user's
// tmux server is never touched. Runs a harmless `cat`. Skipped when tmux is not installed.
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { tmuxBackend, tmuxRunner } from "../src/tmux.ts"

const hasTmux = spawnSync("tmux", ["-V"]).status === 0
const socket = `hub-it-${randomBytes(4).toString("hex")}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

afterAll(() => {
  if (hasTmux) spawnSync("tmux", ["-L", socket, "kill-server"])
})

describe.skipIf(!hasTmux)("tmux backend, live (private socket)", () => {
  test("launches cat, pastes text it echoes, Ctrl-C ends it", async () => {
    const backend = tmuxBackend({ socket, config: "/dev/null", run: tmuxRunner() })
    const pane = await backend.launch({ argv: ["cat", "-u"], cwd: tmpdir(), name: `cat-${randomBytes(3).toString("hex")}` })
    expect(pane.target).toMatch(/^%\d+$/)
    expect(await backend.alive(pane)).toBe(true)
    await backend.paste(pane, "hello from the hub; $(not run) `nor this`", { submit: true })
    const echoed = await until(async () => (await backend.capture(pane, 50)).split("hello from the hub; $(not run) `nor this`").length >= 3)
    expect(echoed).toBe(true)
    await backend.interrupt(pane)
    expect(await until(async () => !(await backend.alive(pane)))).toBe(true)
  })

  test("argv elements reach the program unchanged (no shell between tmux and the program)", async () => {
    const backend = tmuxBackend({ socket, config: "/dev/null", run: tmuxRunner() })
    // sh only prints its positional arguments ("$@" is never expanded further); then sleeps so the pane stays.
    const pane = await backend.launch({ argv: ["sh", "-c", 'printf "%s|" "$@"; sleep 30', "sh", "a b", "$HOME", ";", "*"], cwd: tmpdir(), name: `argv-${randomBytes(3).toString("hex")}` })
    expect(await until(async () => (await backend.capture(pane, 10)).includes("a b|$HOME|;|*|"))).toBe(true)
    await backend.kill(pane)
    expect(await until(async () => !(await backend.alive(pane)))).toBe(true)
  })
})
