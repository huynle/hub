// `hub codex [codex args…]`: runs Codex so the hub's Codex spoke can see its threads, without touching Codex's files
// (CODEX_HOME, default ~/.codex). It makes sure the per-user spoke service runs (starting `hub codex-spoke serve` in
// the background when none does), then runs codex with the shared app-server daemon turned on for this run
// (`--enable daemon_auto_start`: the TUI's threads live on the daemon, where the spoke attaches) and the user's
// arguments, its exit code passed through. On a machine that is not enrolled (no machine token) or when the service
// cannot be started, Codex runs as usual without the hub, and the command says why.
//
// Settings (environment): HUB_CODEX_BIN (default: the Codex `hubctl setup` installed, else `codex` on PATH); see main.ts for the service's.
import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import path from "node:path"
import { configPath } from "../../../src/config.ts"
import { readSpokeCredentials } from "../../node/src/config.ts"
import { codexBinary } from "../../node/src/harnesses.ts"
import { codexStateDir, ensurePrivateDir, readServicePid } from "./paths.ts"

const SERVICE_START_MS = 8000
/** Codex's own flag (a feature toggle for this run only; nothing is written). */
export const DAEMON_ARGS = ["--enable", "daemon_auto_start"] as const

type Env = Readonly<Record<string, string | undefined>>

export interface Program {
  readonly execPath: string
  readonly entry: string
}

export interface CodexIo {
  readonly env: Env
  readonly home: string
  stderr(s: string): void
  /** What runs the hub CLI (the service runs it too). */
  readonly program: Program
}

/** Starts `hub codex-spoke serve` detached, logging to spoke.log in the spoke's state directory. */
function spawnService(io: CodexIo): void {
  const dir = codexStateDir(io.env, io.home)
  ensurePrivateDir(dir)
  const log = openSync(path.join(dir, "spoke.log"), "a", 0o600)
  try {
    const child = spawn(io.program.execPath, [io.program.entry, "codex-spoke", "serve"], { detached: true, stdio: ["ignore", log, log], env: { ...io.env, BUN_BE_BUN: "1" } })
    child.on("error", () => {})
    child.unref()
  } finally {
    closeSync(log)
  }
}

/** True when the spoke service runs (started here when needed); else false with the reason on stderr. */
async function ensureService(io: CodexIo): Promise<boolean> {
  if (!readSpokeCredentials(io.env, io.home)) {
    io.stderr(`hub codex: this machine is not enrolled with a hub (no machine token in ${configPath(io.env, io.home)}); running Codex without the hub\n`)
    return false
  }
  if (readServicePid(io.env, io.home) !== undefined) return true
  spawnService(io)
  const deadline = Date.now() + SERVICE_START_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (readServicePid(io.env, io.home) !== undefined) return true
  }
  io.stderr(`hub codex: the Codex spoke did not start (see ${path.join(codexStateDir(io.env, io.home), "spoke.log")}); running Codex without the hub\n`)
  return false
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }

/** Runs `bin` with the terminal; resolves with its exit code (128 + signal number when a signal ended it). */
function spawnCodex(bin: string, args: readonly string[], env: Env, stderr: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit", env: env as NodeJS.ProcessEnv })
    // The terminal sends Ctrl-C to Codex too: it decides what that means; this process keeps waiting.
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
      stderr(`hub codex: cannot run ${bin}: ${cause.message}\n`)
      done(127)
    })
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (SIGNALS[signal] ?? 0) : 1)))
  })
}

export async function runCodex(args: readonly string[], given: CodexIo): Promise<number> {
  // A hub-installed Codex is what both this run and the spoke it starts use (HUB_CODEX_BIN is passed on).
  const bin = codexBinary(given.env, given.home)
  const io: CodexIo = path.isAbsolute(bin) && !given.env.HUB_CODEX_BIN ? { ...given, env: { ...given.env, HUB_CODEX_BIN: bin } } : given
  let hub = false
  try {
    hub = await ensureService(io)
  } catch (cause) {
    io.stderr(`hub codex: ${cause instanceof Error ? cause.message : String(cause)}; running Codex without the hub\n`)
  }
  const env: Record<string, string | undefined> = { ...io.env }
  delete env.BUN_BE_BUN
  return spawnCodex(bin, hub ? [...DAEMON_ARGS, ...args] : [...args], env, io.stderr)
}
