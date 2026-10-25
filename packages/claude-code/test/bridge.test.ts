// The hook bridge (`hub claude-code hook`): the command Claude Code runs for each hook. It sends the hook's stdin
// JSON to the per-user daemon over its Unix socket and does what the daemon answers (print JSON, write the env file,
// exit 2 for a rewake). It fails open: no daemon, a bad reply or a slow one → exit 0 without output, so Claude Code
// carries on as if there were no hook.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { runHook } from "../src/bridge.ts"

const fixture = (name: string) => readFileSync(path.join(import.meta.dir, "fixtures", `${name}.json`), "utf8")
const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

const dir = () => mkdtempSync(path.join(tmpdir(), "hcb-"))

/** A fake daemon: records each request line and answers with reply(request) (a raw line, or nothing). */
async function daemon(reply: (req: any) => string | undefined | Promise<string | undefined>) {
  const socketPath = path.join(dir(), "d.sock")
  const seen: any[] = []
  const server = createServer((conn) => {
    let buffer = ""
    conn.on("data", async (chunk) => {
      buffer += chunk.toString("utf8")
      const end = buffer.indexOf("\n")
      if (end < 0) return
      const req = JSON.parse(buffer.slice(0, end))
      seen.push(req)
      const line = await reply(req)
      if (line === undefined) conn.end()
      else conn.end(`${line}\n`)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return { socketPath, seen }
}

function io(socketPath: string, stdin: string, options: { argv?: string[]; env?: Record<string, string>; timeoutMs?: number } = {}) {
  const out = { stdout: "", stderr: "" }
  return {
    out,
    run: () =>
      runHook({
        argv: options.argv ?? [],
        stdin,
        env: options.env ?? {},
        socketPath,
        stdout: (s) => (out.stdout += s),
        stderr: (s) => (out.stderr += s),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }),
  }
}

describe("fail open", () => {
  test("no daemon: exit 0 and no output", async () => {
    const hook = io(path.join(dir(), "missing.sock"), fixture("pre-tool-use"))
    expect(await hook.run()).toBe(0)
    expect(hook.out).toEqual({ stdout: "", stderr: "" })
  })

  test("stdin that is not a hook input never reaches the daemon", async () => {
    const d = await daemon(() => "{}")
    for (const stdin of ["", "not json", "[]", JSON.stringify({ hook_event_name: "Stop" })]) {
      const hook = io(d.socketPath, stdin)
      expect(await hook.run()).toBe(0)
      expect(hook.out.stdout).toBe("")
    }
    expect(d.seen).toEqual([])
  })

  test("a daemon that closes without a reply, answers garbage, or is too slow: exit 0, no output", async () => {
    for (const reply of [() => undefined, () => "garbage", () => "[1]", () => new Promise<string>((r) => setTimeout(() => r('{"output":{"continue":false}}'), 300))]) {
      const d = await daemon(reply)
      const hook = io(d.socketPath, fixture("pre-tool-use"), { timeoutMs: 100 })
      expect(await hook.run()).toBe(0)
      expect(hook.out).toEqual({ stdout: "", stderr: "" })
    }
  })
})

describe("talking to the daemon", () => {
  test("sends the hook input (without the tool's output) with the launch, and prints the reply's JSON", async () => {
    const d = await daemon(() => JSON.stringify({ output: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hi" } } }))
    const hook = io(d.socketPath, fixture("post-tool-use"), { env: { HUB_CLAUDE_LAUNCH: "L1" } })
    expect(await hook.run()).toBe(0)
    expect(JSON.parse(hook.out.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hi" } })
    expect(d.seen).toHaveLength(1)
    expect(d.seen[0]).toMatchObject({ v: 1, kind: "hook", launch: "L1", input: { hook_event_name: "PostToolUse", tool_use_id: "toolu_stub5" } })
    expect(d.seen[0].input.tool_response).toBeUndefined()
  })

  test("--wait passes the permission wait in ms; --rewake marks the rewake Stop hook", async () => {
    const d = await daemon(() => "{}")
    await io(d.socketPath, fixture("permission-request"), { argv: ["--wait", "30"] }).run()
    await io(d.socketPath, fixture("stop"), { argv: ["--rewake"] }).run()
    expect(d.seen[0]).toMatchObject({ waitMs: 30_000 })
    expect(d.seen[0].rewake).toBeUndefined()
    expect(d.seen[1]).toMatchObject({ rewake: true })
  })

  test("exit 2 with stderr only for the rewake hook (a normal hook's exit 2 would block Claude Code)", async () => {
    const d = await daemon(() => JSON.stringify({ exit: 2, stderr: "hub message" }))
    const rewake = io(d.socketPath, fixture("stop"), { argv: ["--rewake"] })
    expect(await rewake.run()).toBe(2)
    expect(rewake.out.stderr).toBe("hub message")
    const normal = io(d.socketPath, fixture("pre-tool-use"))
    expect(await normal.run()).toBe(0)
    expect(normal.out).toEqual({ stdout: "", stderr: "" })
  })
})

describe("the env file (SessionStart)", () => {
  test("is written mode 0600 with the reply's variables, shell-quoted; bad names are skipped", async () => {
    const d = await daemon(() => JSON.stringify({ env: { HUB_URL: "https://hub.example", HUB_SESSION_TOKEN: "hst1.a'b", "bad name": "x", "X;rm": "y" } }))
    const file = path.join(dir(), "sessionstart-hook-1.sh")
    const hook = io(d.socketPath, fixture("session-start"), { env: { CLAUDE_ENV_FILE: file } })
    expect(await hook.run()).toBe(0)
    expect(hook.out.stdout).toBe("")
    expect(readFileSync(file, "utf8")).toBe("export HUB_URL='https://hub.example'\nexport HUB_SESSION_TOKEN='hst1.a'\\''b'\n")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("is not written without CLAUDE_ENV_FILE (or with a relative one)", async () => {
    const d = await daemon(() => JSON.stringify({ env: { HUB_SESSION_TOKEN: "t" } }))
    expect(await io(d.socketPath, fixture("session-start")).run()).toBe(0)
    expect(await io(d.socketPath, fixture("session-start"), { env: { CLAUDE_ENV_FILE: "rel.sh" } }).run()).toBe(0)
    expect(existsSync("rel.sh")).toBe(false)
  })
})
