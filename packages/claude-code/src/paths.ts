// Where the Claude Code spoke keeps its files: <hub state dir>/claude-code (the hub state dir is $HUB_STATE_DIR, else
// ~/.local/state/hub), a private (0700) directory holding the daemon's socket (daemon.sock, 0600), its log and the
// plugin directories the wrapper loads with --plugin-dir. $HUB_CLAUDE_SOCKET names another socket (tests, or a
// short path when the state dir is too deep for a Unix socket path).
import { chmodSync, lstatSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { hubEnv, type Env } from "../../../src/env.ts"
import { APP_DIR, stateBase } from "../../../src/migrate.ts"

/** Longest Unix socket path (macOS sun_path is 104 bytes with the terminating NUL). */
export const SOCKET_PATH_MAX = 103

export function claudeStateDir(env: Env = process.env, home: string = homedir()): string {
  return path.join(hubEnv(env).HUB_STATE_DIR || path.join(stateBase(home), APP_DIR), "claude-code")
}

export function socketPath(env: Env = process.env, home: string = homedir()): string {
  return env.HUB_CLAUDE_SOCKET || path.join(claudeStateDir(env, home), "daemon.sock")
}

/**
 * Makes `dir` (and its parents) and checks it is a real directory of this user that nobody else can reach: a
 * symlink or someone else's directory is refused, group or other permissions are removed (0700).
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink()) throw new Error(`${dir} is a symlink; the Claude Code spoke needs a real directory there`)
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`)
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} belongs to another user`)
  if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
}
