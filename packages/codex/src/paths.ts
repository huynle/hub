// Where the Codex spoke looks and keeps its files. It only reads Codex's home (CODEX_HOME, default ~/.codex) to find
// the shared daemon's socket; its own files live in <hub state dir>/codex (the hub state dir is $HUB_STATE_DIR, else
// ~/.local/state/hub), a private (0700) directory holding the service's pid file (spoke.pid) and its log.
// $HUB_CODEX_DAEMON_SOCKET names another daemon socket, or "off" for none.
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { hubEnv, type Env } from "../../../src/env.ts"
import { APP_DIR, stateBase } from "../../../src/migrate.ts"

export function codexHome(env: Env = process.env, home: string = homedir()): string {
  return env.CODEX_HOME || path.join(home, ".codex")
}

/** The shared daemon's control socket, or undefined when attaching to it is turned off. */
export function daemonSocketPath(env: Env = process.env, home: string = homedir()): string | undefined {
  const override = env.HUB_CODEX_DAEMON_SOCKET
  if (override === "off") return undefined
  return override || path.join(codexHome(env, home), "app-server-control", "app-server-control.sock")
}

export function codexStateDir(env: Env = process.env, home: string = homedir()): string {
  return path.join(hubEnv(env).HUB_STATE_DIR || path.join(stateBase(home), APP_DIR), "codex")
}

export const pidFile = (env: Env = process.env, home: string = homedir()) => path.join(codexStateDir(env, home), "spoke.pid")

/** A usable process ID: an integer above 1 (0 and negative IDs signal process groups or every process). */
export const isPid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 1

export function isAlive(pid: number): boolean {
  if (!isPid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The running service's pid from its pid file, or undefined when there is none or that process is gone. */
export function readServicePid(env: Env = process.env, home: string = homedir()): number | undefined {
  let text: string
  try {
    text = readFileSync(pidFile(env, home), "utf8").trim()
  } catch {
    return undefined
  }
  const pid = /^\d+$/.test(text) ? Number(text) : NaN
  return isPid(pid) && isAlive(pid) ? pid : undefined
}

/**
 * Makes `dir` (and its parents) and checks it is a real directory of this user that nobody else can reach: a
 * symlink or someone else's directory is refused, group or other permissions are removed (0700).
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink()) throw new Error(`${dir} is a symlink; the Codex spoke needs a real directory there`)
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`)
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} belongs to another user`)
  if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
}
