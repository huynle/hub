// `hub claude [claude args…]` (decision fx04e42c point 4): runs Claude Code with the hub plugin loaded through
// --plugin-dir, never by editing the user's ~/.claude files. It makes sure the per-user daemon answers on its socket
// (starting `hub claude-code daemon` in the background when none does), writes the plugin directory for the
// current settings, registers the run with the daemon (a launch: its pid, so the daemon ends the run's sessions if it
// dies) and runs `claude` with the user's arguments, its exit code passed through. Claude Code and its hooks get
// HUB_CLAUDE_LAUNCH and HUB_CLAUDE_SOCKET. On a machine that is not enrolled (no machine token) or when the daemon
// cannot be started, Claude Code runs without the hub, and the command says why.
//
// Settings (environment): HUB_CLAUDE_BIN (default `claude` on PATH), HUB_CLAUDE_PERMISSION_WAIT (seconds a
// permission request waits for the hub, default 120; 0: report only), HUB_CLAUDE_REWAKE_TIMEOUT (seconds the
// asyncRewake Stop hook may wait for a message, default 3600).
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, openSync } from "node:fs"
import path from "node:path"
import { configPath } from "../../../src/config.ts"
import { readSpokeCredentials } from "../../node/src/config.ts"
import pkg from "../package.json" with { type: "json" }
import { writePlugin } from "./plugin.ts"
import { claudeStateDir, ensurePrivateDir, socketPath } from "./paths.ts"
import { ask, WIRE_VERSION } from "./wire.ts"

export const VERSION: string = pkg.version
export const DEFAULT_PERMISSION_WAIT_S = 120
export const DEFAULT_REWAKE_TIMEOUT_S = 3600
const DAEMON_START_MS = 8000
const ASK_MS = 2000

type Env = Readonly<Record<string, string | undefined>>

export interface Program {
  readonly execPath: string
  readonly entry: string
}

export interface ClaudeIo {
  readonly env: Env
  readonly home: string
  stderr(s: string): void
  /** What runs the hub CLI (the daemon and the hooks run it too). */
  readonly program: Program
}

/** A non-negative number of seconds from the environment, else the default. */
export function seconds(value: string | undefined, fallback: number): number {
  const n = value === undefined || value.trim() === "" ? NaN : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const pingOk = async (socket: string) => ((await ask(socket, { v: WIRE_VERSION, kind: "ping" }, { timeoutMs: ASK_MS })) as { ok?: unknown } | undefined)?.ok === true

/** Starts `hub claude-code daemon` detached, logging to daemon.log in the spoke's state directory. */
function spawnDaemon(io: ClaudeIo): void {
  const dir = claudeStateDir(io.env, io.home)
  ensurePrivateDir(dir)
  const log = openSync(path.join(dir, "daemon.log"), "a", 0o600)
  try {
    const child = spawn(io.program.execPath, [io.program.entry, "claude-code", "daemon"], { detached: true, stdio: ["ignore", log, log], env: { ...io.env, BUN_BE_BUN: "1" } })
    child.on("error", () => {})
    child.unref()
  } finally {
    closeSync(log)
  }
}

/** The plugin directory when the hub can be used, else undefined (with the reason on stderr). */
async function prepare(io: ClaudeIo, socket: string): Promise<string | undefined> {
  if (!readSpokeCredentials(io.env, io.home)) {
    io.stderr(`hub claude: this machine is not enrolled with a hub (no machine token in ${configPath(io.env, io.home)}); running Claude Code without the hub\n`)
    return undefined
  }
  if (!(await pingOk(socket))) {
    spawnDaemon(io)
    const deadline = Date.now() + DAEMON_START_MS
    let up = false
    while (!up && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      up = await pingOk(socket)
    }
    if (!up) {
      io.stderr(`hub claude: the Claude Code spoke daemon did not start (see ${path.join(claudeStateDir(io.env, io.home), "daemon.log")}); running Claude Code without the hub\n`)
      return undefined
    }
  }
  return writePlugin(path.join(claudeStateDir(io.env, io.home), "plugins"), {
    program: io.program,
    permissionWaitS: seconds(io.env.HUB_CLAUDE_PERMISSION_WAIT, DEFAULT_PERMISSION_WAIT_S),
    rewakeTimeoutS: seconds(io.env.HUB_CLAUDE_REWAKE_TIMEOUT, DEFAULT_REWAKE_TIMEOUT_S) || DEFAULT_REWAKE_TIMEOUT_S,
    version: VERSION,
  })
}

/** Runs `bin` with the terminal; resolves with its exit code (128 + signal number when a signal ended it). */
function spawnClaude(bin: string, args: readonly string[], env: Env, stderr: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit", env: env as NodeJS.ProcessEnv })
    // The terminal sends Ctrl-C to Claude Code too: it decides what that means; this process keeps waiting.
    const ignore = () => {}
    const forward = () => child.kill("SIGTERM")
    process.on("SIGINT", ignore)
    process.on("SIGTERM", forward)
    const done = (code: number) => {
      process.off("SIGINT", ignore)
      process.off("SIGTERM", forward)
      resolve(code)
    }
    child.on("error", (cause) => {
      stderr(`hub claude: cannot run ${bin}: ${cause.message}\n`)
      done(127)
    })
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1)))
  })
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }
const signalNumber = (signal: string) => SIGNALS[signal]

export async function runClaude(args: readonly string[], io: ClaudeIo): Promise<number> {
  const socket = socketPath(io.env, io.home)
  let plugin: string | undefined
  try {
    plugin = await prepare(io, socket)
  } catch (cause) {
    io.stderr(`hub claude: ${cause instanceof Error ? cause.message : String(cause)}; running Claude Code without the hub\n`)
  }
  if (args.includes("--bare") && plugin) io.stderr("hub claude: --bare turns off Claude Code's hooks and plugins: this session will not reach the hub\n")
  const env: Record<string, string | undefined> = { ...io.env }
  delete env.BUN_BE_BUN
  const launch = `cl_${randomBytes(8).toString("hex")}`
  if (plugin) {
    env.HUB_CLAUDE_LAUNCH = launch
    env.HUB_CLAUDE_SOCKET = socket
    await ask(socket, { v: WIRE_VERSION, kind: "launch", launch, pid: process.pid }, { timeoutMs: ASK_MS })
  }
  const code = await spawnClaude(io.env.HUB_CLAUDE_BIN || "claude", plugin ? ["--plugin-dir", plugin, ...args] : [...args], env, io.stderr)
  if (plugin) await ask(socket, { v: WIRE_VERSION, kind: "exit", launch }, { timeoutMs: ASK_MS })
  return code
}
