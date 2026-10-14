// Auto-start of a local hub for a loopback voice server. When nothing answers on the configured
// http://127.0.0.1:<port> (or localhost / [::1]), start `bun <this repo>/bin/hub.ts` as a detached
// background process bound to that address, with output appended to hub.log. Without a bun install it
// runs the hub with the current executable (OpenCode is a compiled Bun binary) and BUN_BE_BUN=1. A lockfile (hub.pid)
// makes sure only one process on the machine starts it. Never used for non-loopback servers.
import { spawn as nodeSpawn } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { hubEnv } from "../env"
import { isLoopbackURL } from "../loopback"
import { APP_DIR, LEGACY_APP_DIR, migrateLegacy, stateBase } from "../migrate"

export interface ChildLike {
  readonly pid?: number
  unref(): void
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
}

export type SpawnLike = (command: string, args: readonly string[], options: object) => ChildLike

export interface LocalHubOptions {
  /**
   * Where hub.pid and hub.log live (default $HUB_STATE_DIR or ~/.local/state/opencode-hub, migrated from
   * ~/.local/state/opencode-voice first so the hub does not find a fresh, empty state directory).
   */
  readonly stateDir?: string
  /** Home directory for the default state directory (default os.homedir()). */
  readonly home?: string
  /** Where a one-time migration notice goes (default console). */
  readonly log?: (message: string) => void
  /** This plugin's repository (default: resolved from this file). */
  readonly repoRoot?: string
  /** bun executable; shorthand for `runtime: {command: bun, env: {}}`. */
  readonly bun?: string
  /** How to run bin/hub.ts (default: resolveHubRuntime for this process). */
  readonly runtime?: HubRuntime
  readonly spawn?: SpawnLike
  readonly fetch?: typeof globalThis.fetch
  readonly isAlive?: (pid: number) => boolean
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** How long to wait for the started hub to answer (default 15 s). */
  readonly waitMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  /** This process's pid (written to the lock while starting). */
  readonly pid?: number
}

export type LocalHubResult =
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "running" }
  | { readonly status: "started"; readonly pid: number }
  | { readonly status: "busy"; readonly pid: number }
  | { readonly status: "failed"; readonly error: string }

interface Lock {
  readonly pid: number
  readonly port: number
  readonly started: number
}

/** A lock whose hub has not answered for this long is stale, even if its pid is alive (pid reuse). */
export const LOCK_STALE_MS = 60_000
const PROBE_TIMEOUT_MS = 1500
const POLL_MS = 250

export function repoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "")
}

export function hubScript(root: string = repoRoot()): string {
  return path.join(root, "bin", "hub.ts")
}

export function defaultStateDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  return hubEnv(env).HUB_STATE_DIR || path.join(stateBase(home), APP_DIR)
}

/** The runtime for this process: probes the real executable, PATH and home directory. */
export function currentHubRuntime(env: Readonly<Record<string, string | undefined>> = process.env): HubRuntime {
  const isBun = typeof Bun !== "undefined"
  return resolveHubRuntime({
    execPath: process.execPath,
    home: homedir(),
    isBun,
    which: (name) => (isBun ? Bun.which(name, env.PATH ? { PATH: env.PATH } : {}) : null),
    exists: existsSync,
  })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The listen address and port the hub needs to serve `server`. */
function bindFor(url: URL): { host: string; port: number; probe: string } {
  const name = url.hostname.replace(/^\[(.*)\]$/, "$1")
  const host = name === "localhost" ? "127.0.0.1" : name
  const port = Number(url.port || 80)
  return { host, port, probe: `http://${host.includes(":") ? `[${host}]` : host}:${port}` }
}

/**
 * Makes sure a hub answers on the loopback `server`, starting one if nothing does and no other process
 * is already starting it. Resolves once the hub answers, or with why it did not.
 */
export async function ensureLocalHub(server: string, options: LocalHubOptions = {}): Promise<LocalHubResult> {
  if (!isLoopbackURL(server)) return { status: "skipped", reason: "not a loopback server" }
  const url = new URL(server)
  if (url.protocol !== "http:") return { status: "skipped", reason: "a local hub serves http only" }

  const env = options.env ?? process.env
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const alive = options.isAlive ?? pidAlive
  const home = options.home ?? homedir()
  const stateDir = options.stateDir ?? defaultStateDir(env, home)
  const lockFile = path.join(stateDir, "hub.pid")
  const logFile = path.join(stateDir, "hub.log")
  const bind = bindFor(url)

  const answers = async (origin: string) => {
    try {
      await doFetch(`${origin}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      return true // any HTTP answer: something listens there, so never start a second server
    } catch {
      return false
    }
  }

  if (await answers(url.origin)) return { status: "running" }

  if (options.stateDir === undefined && !hubEnv(env).HUB_STATE_DIR) {
    migrateLegacy(path.join(stateBase(home), LEGACY_APP_DIR), stateDir, { skip: ["hub.pid"], ...(options.log ? { log: options.log } : {}) })
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  // ---- the lock ----
  const existing = readLock(lockFile)
  if (existing === "unreadable") {
    if (now() - statSync(lockFile).mtimeMs < LOCK_STALE_MS) return { status: "busy", pid: 0 }
    removeLock(lockFile)
  } else if (existing) {
    if (alive(existing.pid)) {
      if (existing.port !== bind.port && (await answers(`http://127.0.0.1:${existing.port}`))) {
        return {
          status: "failed",
          error:
            `A local hub (pid ${existing.pid}) already runs on port ${existing.port}. ` +
            `Point /hub → Server at http://127.0.0.1:${existing.port}, or stop that hub first.`,
        }
      }
      if (now() - existing.started < LOCK_STALE_MS) return { status: "busy", pid: existing.pid }
    }
    removeLock(lockFile)
  }
  const own = options.pid ?? process.pid
  try {
    writeFileSync(lockFile, JSON.stringify({ pid: own, port: bind.port, started: now() } satisfies Lock), { flag: "wx", mode: 0o600 })
  } catch {
    const holder = readLock(lockFile)
    return { status: "busy", pid: holder && holder !== "unreadable" ? holder.pid : 0 }
  }

  // ---- start ----
  const root = options.repoRoot ?? repoRoot()
  let child: ChildLike
  let exited: string | undefined
  let log: number | undefined
  try {
    log = openSync(logFile, "a", 0o600)
    chmodSync(logFile, 0o600)
    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      // The hub needs none of OpenCode's own settings or credentials.
      if (value !== undefined && !key.startsWith("OPENCODE_")) childEnv[key] = value
    }
    const runtime = options.runtime ?? (options.bun ? { command: options.bun, env: {} } : currentHubRuntime(env))
    delete childEnv.BUN_BE_BUN // only the runtime decides whether its executable acts as bun
    // The address this hub must serve; legacy names would only lose to these and warn.
    for (const legacy of ["VOICE_HOST", "VOICE_PORT", "VOICE_PUBLIC_URL"]) delete childEnv[legacy]
    Object.assign(childEnv, runtime.env, { HUB_HOST: bind.host, HUB_PORT: String(bind.port), HUB_PUBLIC_URL: url.origin })
    child = (options.spawn ?? (nodeSpawn as unknown as SpawnLike))(runtime.command, [hubScript(root)], {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
      env: childEnv,
    })
    child.on("error", (error) => {
      exited = error.message
    })
    child.on("exit", (code, signal) => {
      exited = `exited with ${signal ?? `code ${code}`}`
    })
    child.unref()
  } catch (cause) {
    removeLock(lockFile)
    return { status: "failed", error: `Could not start the local hub: ${cause instanceof Error ? cause.message : cause}` }
  } finally {
    if (log !== undefined) closeSync(log)
  }
  const pid = child.pid ?? own
  writeFileSync(lockFile, JSON.stringify({ pid, port: bind.port, started: now() } satisfies Lock), { mode: 0o600 })

  // ---- wait until it answers ----
  const deadline = now() + (options.waitMs ?? 15_000)
  for (;;) {
    if (exited !== undefined) {
      const lock = readLock(lockFile)
      if (lock && lock !== "unreadable" && lock.pid === pid) removeLock(lockFile)
      return { status: "failed", error: `The local hub ${exited}; see ${logFile}` }
    }
    if (await answers(bind.probe)) return { status: "started", pid }
    if (now() >= deadline) {
      return { status: "failed", error: `The local hub (pid ${pid}) did not answer on ${bind.probe} yet; see ${logFile}` }
    }
    await sleep(POLL_MS)
  }
}

function readLock(file: string): Lock | "unreadable" | undefined {
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Lock>
    if (Number.isInteger(raw.pid) && Number.isInteger(raw.port) && typeof raw.started === "number") return raw as Lock
  } catch {
    // fall through
  }
  return "unreadable"
}

function removeLock(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // already gone
  }
}

export interface HubRuntime {
  readonly command: string
  readonly env: Readonly<Record<string, string>>
}

export interface RuntimeProbe {
  readonly execPath: string
  readonly home: string
  readonly isBun: boolean
  readonly which: (name: string) => string | null
  readonly exists: (file: string) => boolean
}

/**
 * How to run bin/hub.ts: this runtime when it is bun, else bun on PATH, else ~/.bun/bin/bun, else this
 * executable with BUN_BE_BUN=1 when it is a Bun runtime (inside OpenCode, process.execPath is the
 * compiled `opencode` binary, which then runs scripts as bun), else plain `bun`.
 */
export function resolveHubRuntime(probe: RuntimeProbe): HubRuntime {
  const base = probe.execPath.split(/[\\/]/).pop() ?? ""
  if (/^bun(\.exe)?$/i.test(base)) return { command: probe.execPath, env: {} }
  const found = probe.which("bun")
  if (found) return { command: found, env: {} }
  const home = path.join(probe.home, ".bun", "bin", "bun")
  if (probe.exists(home)) return { command: home, env: {} }
  if (probe.isBun) return { command: probe.execPath, env: { BUN_BE_BUN: "1" } }
  return { command: "bun", env: {} }
}
