// `hub claude-code <daemon | hook | mcp>`: the Claude Code spoke's own processes, run by `hub claude` (the daemon)
// and by the plugin (the hook bridge, the MCP pipe), never typed by hand in normal use.
//   daemon  the per-user daemon until SIGINT/SIGTERM (needs an enrolled machine: the machine token in the spoke's
//           config.json, read-only); with the Claude Code CLI found it also starts Claude Code for hub launches
//           (daemonLaunchOptions)
//   hook    the hook bridge (stdin: the hook's JSON; --rewake, --wait <seconds>)
//   mcp     the MCP pipe on stdio
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { configPath } from "../../../src/config.ts"
import { nodeConfigPath, readNodeConfig, readSpokeCredentials } from "../../node/src/config.ts"
import { findExecutable } from "../../node/src/harnesses.ts"
import { runHook } from "./bridge.ts"
import { startDaemon, type DaemonLaunchOptions } from "./daemon.ts"
import { runMcpPipe } from "./mcp.ts"
import { socketPath } from "./paths.ts"
import { hubPlugin, VERSION, type Program } from "./wrapper.ts"

export interface ClaudeCodeIo {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  stdout(s: string): void
  stderr(s: string): void
  readonly stdin?: () => Promise<string>
  readonly input?: AsyncIterable<Uint8Array | string>
  readonly signal?: AbortSignal
  /** What runs the hub CLI (the plugin's hooks run it); default this process (the runtime and its entry). */
  readonly program?: Program
}

export const CLAUDE_CODE_USAGE = "Usage: hub claude-code daemon | hook [--rewake] [--wait <seconds>] | mcp | install [--dry-run] | uninstall [--dry-run] | status"

/** `claude --version` → "2.1.296", or "" when it cannot be told. */
export function claudeVersion(bin: string, env: ClaudeCodeIo["env"]): string {
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, env: env as NodeJS.ProcessEnv })
    return /\d+\.\d+\.\d+[\w.+-]*/.exec(r.stdout ?? "")?.[0]?.slice(0, 100) ?? ""
  } catch {
    return ""
  }
}

/**
 * How the daemon starts Claude Code for hub launches, or undefined when it does not: the Claude Code CLI must be
 * found (HUB_CLAUDE_BIN, else `claude` on PATH) and node.json must not withhold claude-code (harnesses). Launch
 * directories must be under node.json's workspaceRoots (read again at each create); launched sessions load the hub
 * plugin `hub claude` loads (written when the first launch needs it).
 */
export function daemonLaunchOptions(io: { readonly env: ClaudeCodeIo["env"]; readonly home: string; readonly program: Program }): DaemonLaunchOptions | undefined {
  const bin = findExecutable(io.env.HUB_CLAUDE_BIN || "claude", io.env)
  if (!bin) return undefined
  const file = nodeConfigPath(io.env, io.home)
  if (readNodeConfig(file).config.harnesses?.["claude-code"] === false) return undefined
  return {
    bin,
    roots: () => readNodeConfig(file).config.workspaceRoots,
    pluginDir: () => hubPlugin(io.env, io.home, io.program),
    env: io.env,
  }
}

/** This process as the hub CLI (its runtime and entry, resolved), as `hub claude` started the daemon. */
function currentProgram(): Program {
  const entry = process.argv[1] ?? ""
  try {
    return { execPath: process.execPath, entry: realpathSync(entry) }
  } catch {
    return { execPath: process.execPath, entry }
  }
}

async function daemon(io: ClaudeCodeIo): Promise<number> {
  const credentials = readSpokeCredentials(io.env, io.home)
  if (!credentials) {
    io.stderr(`hub claude-code daemon: this machine is not enrolled with a hub (no machine token in ${configPath(io.env, io.home)})\n`)
    return 1
  }
  const log = (line: string) => io.stderr(`[hub claude-code] ${new Date().toISOString()} ${line}\n`)
  const launch = daemonLaunchOptions({ env: io.env, home: io.home, program: io.program ?? currentProgram() })
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
      ...(launch ? { launch } : {}),
    })
  } catch (cause) {
    io.stderr(`hub claude-code daemon: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  log(`listening on ${socketPath(io.env, io.home)}; ${launch ? `starts ${launch.bin} for hub launches` : "no hub launches (Claude Code CLI not found, or node.json withholds claude-code)"}`)
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

