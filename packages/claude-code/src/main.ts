// `hub claude-code <daemon | hook | mcp>`: the Claude Code spoke's own processes, run by `hub claude` (the daemon)
// and by the plugin (the hook bridge, the MCP pipe), never typed by hand in normal use.
//   daemon  the per-user daemon until SIGINT/SIGTERM (needs an enrolled machine: the machine token in the spoke's
//           config.json, read-only)
//   hook    the hook bridge (stdin: the hook's JSON; --rewake, --wait <seconds>)
//   mcp     the MCP pipe on stdio
import { spawnSync } from "node:child_process"
import { configPath } from "../../../src/config.ts"
import { readSpokeCredentials } from "../../node/src/config.ts"
import { runHook } from "./bridge.ts"
import { startDaemon } from "./daemon.ts"
import { runMcpPipe } from "./mcp.ts"
import { socketPath } from "./paths.ts"
import { VERSION } from "./wrapper.ts"

export interface ClaudeCodeIo {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  stdout(s: string): void
  stderr(s: string): void
  readonly stdin?: () => Promise<string>
  readonly input?: AsyncIterable<Uint8Array | string>
  readonly signal?: AbortSignal
}

export const CLAUDE_CODE_USAGE = "Usage: hub claude-code daemon | hook [--rewake] [--wait <seconds>] | mcp"

/** `claude --version` → "2.1.296", or "" when it cannot be told. */
export function claudeVersion(bin: string, env: ClaudeCodeIo["env"]): string {
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, env: env as NodeJS.ProcessEnv })
    return /\d+\.\d+\.\d+[\w.+-]*/.exec(r.stdout ?? "")?.[0]?.slice(0, 100) ?? ""
  } catch {
    return ""
  }
}

async function daemon(io: ClaudeCodeIo): Promise<number> {
  const credentials = readSpokeCredentials(io.env, io.home)
  if (!credentials) {
    io.stderr(`hub claude-code daemon: this machine is not enrolled with a hub (no machine token in ${configPath(io.env, io.home)})\n`)
    return 1
  }
  const log = (line: string) => io.stderr(`[hub claude-code] ${new Date().toISOString()} ${line}\n`)
  let running
  try {
    running = await startDaemon({
      socketPath: socketPath(io.env, io.home),
      server: credentials.server,
      token: credentials.token,
      harnessVersion: claudeVersion(io.env.HUB_CLAUDE_BIN || "claude", io.env),
      pluginVersion: VERSION,
      directory: io.home,
      log,
    })
  } catch (cause) {
    io.stderr(`hub claude-code daemon: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  log(`listening on ${socketPath(io.env, io.home)}`)
  await new Promise<void>((resolve) => {
    if (!io.signal) return
    if (io.signal.aborted) return resolve()
    io.signal.addEventListener("abort", () => resolve(), { once: true })
  })
  await running.stop()
  return 0
}

export async function claudeCodeMain(argv: readonly string[], io: ClaudeCodeIo): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case "hook": {
      const stdin = io.stdin ? await io.stdin().catch(() => "") : ""
      return runHook({ argv: rest, stdin, env: io.env, socketPath: socketPath(io.env, io.home), stdout: io.stdout, stderr: io.stderr })
    }
    case "mcp":
      if (!io.input) {
        io.stderr("hub claude-code mcp: needs stdin\n")
        return 2
      }
      await runMcpPipe({ input: io.input, write: io.stdout, socketPath: socketPath(io.env, io.home), env: io.env, version: VERSION, ...(io.signal ? { signal: io.signal } : {}) })
      return 0
    case "daemon":
      return daemon(io)
    default:
      io.stderr(`${CLAUDE_CODE_USAGE}\n`)
      return 2
  }
}
