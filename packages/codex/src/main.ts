// `hub codex-spoke serve`: the per-user Codex spoke service until SIGINT/SIGTERM (main.ts aborts io.signal), started
// in the background by `hub codex` and never typed by hand in normal use. It needs an enrolled machine (the machine
// token in the spoke's config.json, read-only), keeps a pid file in <hub state dir>/codex/spoke.pid (one service per
// user: a second one refuses while the first runs) and attaches to the shared Codex daemon's socket when present.
//
// Settings (environment): HUB_CODEX_BIN (default `codex` on PATH), HUB_CODEX_DAEMON_SOCKET (another socket, or
// "off"), HUB_CODEX_CONFIG (Codex config overrides for the app-server the spoke starts, one key=value per line,
// passed as -c; Codex's files are never written).
import { spawnSync } from "node:child_process"
import { openSync, closeSync, readFileSync, rmSync, writeSync } from "node:fs"
import { configPath } from "../../../src/config.ts"
import { readSpokeCredentials } from "../../node/src/config.ts"
import pkg from "../package.json" with { type: "json" }
import { codexStateDir, ensurePrivateDir, daemonSocketPath, pidFile, readServicePid } from "./paths.ts"
import { startCodexSpoke } from "./spoke.ts"

export const VERSION: string = pkg.version

export interface CodexMainIo {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  stdout(s: string): void
  stderr(s: string): void
  readonly signal?: AbortSignal
}

export const CODEX_SPOKE_USAGE = "Usage: hub codex-spoke serve | install [--dry-run] | uninstall [--dry-run] | status"

/** `codex --version` → "0.160.0", or "" when it cannot be told. */
export function codexVersion(bin: string, env: CodexMainIo["env"]): string {
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, env: env as NodeJS.ProcessEnv })
    return /\d+\.\d+\.\d+[\w.+-]*/.exec(r.stdout ?? "")?.[0]?.slice(0, 100) ?? ""
  } catch {
    return ""
  }
}

/** HUB_CODEX_CONFIG's lines as `-c key=value` arguments. */
export function configOverrides(value: string | undefined): string[] {
  return (value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.includes("="))
    .flatMap((line) => ["-c", line])
}

/** Claims the pid file for this process; false when another live service holds it. */
function claimPidFile(file: string, env: CodexMainIo["env"], home: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600)
      try {
        writeSync(fd, `${process.pid}\n`)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
      if (readServicePid(env, home) !== undefined) return false
      rmSync(file, { force: true }) // a stale file: its process is gone
    }
  }
  return false
}

function releasePidFile(file: string): void {
  try {
    if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file, { force: true })
  } catch {}
}

async function serve(io: CodexMainIo): Promise<number> {
  const credentials = readSpokeCredentials(io.env, io.home)
  if (!credentials) {
    io.stderr(`hub codex-spoke serve: this machine is not enrolled with a hub (no machine token in ${configPath(io.env, io.home)})\n`)
    return 1
  }
  const log = (line: string) => io.stderr(`[hub codex-spoke] ${new Date().toISOString()} ${line}\n`)
  ensurePrivateDir(codexStateDir(io.env, io.home))
  const file = pidFile(io.env, io.home)
  if (!claimPidFile(file, io.env, io.home)) {
    io.stderr(`hub codex-spoke serve: already running (pid ${readServicePid(io.env, io.home) ?? "?"})\n`)
    return 1
  }
  try {
    const codexBin = io.env.HUB_CODEX_BIN || "codex"
    const env: Record<string, string | undefined> = { ...io.env }
    delete env.BUN_BE_BUN
    const daemonSocket = daemonSocketPath(io.env, io.home)
    const running = startCodexSpoke({
      server: credentials.server,
      token: credentials.token,
      harnessVersion: codexVersion(codexBin, env),
      pluginVersion: VERSION,
      directory: io.home,
      codexBin,
      codexArgs: configOverrides(io.env.HUB_CODEX_CONFIG),
      env,
      ...(daemonSocket ? { daemonSocket } : {}),
      log,
    })
    log(daemonSocket ? `serving; the Codex daemon socket is ${daemonSocket}` : "serving; not attaching to a Codex daemon")
    await new Promise<void>((resolve) => {
      if (!io.signal) return
      if (io.signal.aborted) return resolve()
      io.signal.addEventListener("abort", () => resolve(), { once: true })
    })
    await running.stop()
    return 0
  } finally {
    releasePidFile(file)
  }
}

export async function codexMain(argv: readonly string[], io: CodexMainIo): Promise<number> {
  const [command] = argv
  if (command === "serve") return serve(io)
  io.stderr(`${CODEX_SPOKE_USAGE}\n`)
  return 2
}
