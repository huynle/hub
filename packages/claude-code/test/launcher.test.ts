// ClaudeLauncher: the Claude Code processes the daemon starts for hub launches, headless
// (`claude -p --input-format stream-json --output-format stream-json`): turns are user messages on stdin, their
// results come back as result lines, interrupts are control requests. Run against the fake claude only.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaudeLauncher } from "../src/launcher.ts"
import { fakeClaude } from "./fake-claude.ts"

const SID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"
const launchers: ClaudeLauncher[] = []
afterEach(async () => {
  for (const l of launchers.splice(0)) await l.stopAll()
})

function setup(env: Record<string, string> = {}) {
  const fake = fakeClaude()
  const exits: { sessionID: string; code: number | null }[] = []
  const launcher = new ClaudeLauncher({ bin: fake.bin, env: { PATH: process.env.PATH ?? "", BUN_BE_BUN: "1", HUB_CLAUDE_TEST: "kept", ...env }, onExit: (sessionID, code) => exits.push({ sessionID, code }) })
  launchers.push(launcher)
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "launch-ws-")))
  const starts = () => readFileSync(fake.log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  return { launcher, fake, directory, exits, starts }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met")
    await Bun.sleep(10)
  }
}

describe("ClaudeLauncher", () => {
  test("starts claude headless in the workspace with the session ID, the hub plugin, the model and agent, and the hub's environment", async () => {
    const { launcher, directory, starts } = setup()
    await launcher.start({ sessionID: SID, directory, launch: "cl_test1", pluginDir: "/plugins/plugin-abc", socketPath: "/tmp/d.sock", model: "claude-sonnet-4-5", agent: "reviewer" })
    expect(launcher.has(SID)).toBe(true)
    await until(() => {
      try {
        return starts().length > 0
      } catch {
        return false
      }
    })
    const [start] = starts()
    expect(start.cwd).toBe(directory)
    expect(start.argv).toEqual([
      "--plugin-dir",
      "/plugins/plugin-abc",
      "--session-id",
      SID,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-sonnet-4-5",
      "--agent",
      "reviewer",
    ])
    // The bun runtime switch of the hub CLI never reaches Claude Code; the launch and socket do.
    expect(start.env).toEqual({ HUB_CLAUDE_LAUNCH: "cl_test1", HUB_CLAUDE_SOCKET: "/tmp/d.sock", HUB_CLAUDE_TEST: "kept" })
  })

  test("a turn is a user message on stdin; its result line is the turn's result (in order)", async () => {
    const { launcher, directory } = setup()
    await launcher.start({ sessionID: SID, directory, launch: "cl_t", pluginDir: "/p", socketPath: "/s" })
    const [a, b] = await Promise.all([launcher.turn(SID, "one"), launcher.turn(SID, "two")])
    expect(a).toEqual({ outcome: "succeeded", reply: "echo: one" })
    expect(b).toEqual({ outcome: "succeeded", reply: "echo: two" })
    expect(await launcher.turn(SID, "look", [{ mime: "image/png", data: "iVBORw0KGgo=" }])).toEqual({ outcome: "succeeded", reply: "echo: look (+1 image)" })
  })

  test("an error result fails the turn with its message", async () => {
    const { launcher, directory } = setup()
    await launcher.start({ sessionID: SID, directory, launch: "cl_t", pluginDir: "/p", socketPath: "/s" })
    expect(await launcher.turn(SID, "FAIL now")).toEqual({ outcome: "failed", message: "model failed", reply: "" })
  })

  test("interrupt sends a control request: a running turn ends interrupted", async () => {
    const { launcher, directory } = setup()
    await launcher.start({ sessionID: SID, directory, launch: "cl_t", pluginDir: "/p", socketPath: "/s" })
    const turn = launcher.turn(SID, "SLOW work")
    await Bun.sleep(100)
    expect(launcher.running(SID)).toBe(true)
    expect(await launcher.interrupt(SID)).toBe(true)
    expect(await turn).toEqual({ outcome: "interrupted", message: "Interrupted from the hub", reply: "" })
    expect(launcher.running(SID)).toBe(false)
  })

  test("claude exiting fails its open turns and reports the exit; the session is gone", async () => {
    const { launcher, directory, exits } = setup()
    await launcher.start({ sessionID: SID, directory, launch: "cl_t", pluginDir: "/p", socketPath: "/s" })
    const turn = await launcher.turn(SID, "EXIT please")
    expect(turn.outcome).toBe("failed")
    expect((turn as { message: string }).message).toContain("exited")
    await until(() => exits.length > 0)
    expect(exits).toEqual([{ sessionID: SID, code: 3 }])
    expect(launcher.has(SID)).toBe(false)
  })

  test("turns and interrupts for a session it did not start are refused", async () => {
    const { launcher } = setup()
    await expect(launcher.turn(SID, "hi")).rejects.toThrow(/not started by the hub/)
    expect(await launcher.interrupt(SID)).toBe(false)
  })

  test("a claude that cannot run fails start; a second start of the same session is refused", async () => {
    const { launcher, directory } = setup()
    const broken = new ClaudeLauncher({ bin: path.join(directory, "no-claude"), env: {} })
    launchers.push(broken)
    await expect(broken.start({ sessionID: SID, directory, launch: "cl_t", pluginDir: "/p", socketPath: "/s" })).rejects.toThrow(/cannot run/)
    expect(broken.has(SID)).toBe(false)
    await launcher.start({ sessionID: SID, directory, launch: "cl_t", pluginDir: "/p", socketPath: "/s" })
    await expect(launcher.start({ sessionID: SID, directory, launch: "cl_u", pluginDir: "/p", socketPath: "/s" })).rejects.toThrow(/already/)
  })

  test("stopAll ends every process (stdin closed, then killed if it lingers)", async () => {
    const { launcher, directory, exits } = setup()
    await launcher.start({ sessionID: SID, directory, launch: "cl_t", pluginDir: "/p", socketPath: "/s" })
    await launcher.stopAll()
    expect(launcher.has(SID)).toBe(false)
    expect(exits.map((e) => e.sessionID)).toEqual([SID])
  })
})
