// One-time migration from the opencode-voice locations to the opencode-hub ones. When the new file or
// directory is missing and the legacy one exists, it is copied (file modes kept, e.g. 0600 for tokens)
// through a temporary sibling that is renamed into place, so a partial copy never looks migrated. The
// legacy copy is never touched or deleted. Callers skip migration for paths set explicitly by env.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import path from "node:path"
import type { Env } from "./env"

export const APP_DIR = "opencode-hub"
export const LEGACY_APP_DIR = "opencode-voice"

/** $XDG_CONFIG_HOME or ~/.config. */
export const configBase = (env: Env, home: string): string => env.XDG_CONFIG_HOME || path.join(home, ".config")
/** ~/.local/state. */
export const stateBase = (home: string): string => path.join(home, ".local", "state")

export type MigrationResult = "migrated" | "none" | "failed"

export interface MigrateOptions {
  /** One line when something was copied or the copy failed (default console.log / console.warn). */
  readonly log?: (message: string) => void
  /** Top-level entry names of a legacy directory not to copy (e.g. a lock file). */
  readonly skip?: readonly string[]
}

const exists = (p: string) => existsSync(p) || isLink(p)
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function copyEntry(src: string, dst: string, skip: readonly string[] = []): void {
  const stat = lstatSync(src)
  if (stat.isDirectory()) {
    mkdirSync(dst, { mode: 0o700 })
    for (const name of readdirSync(src)) {
      if (!skip.includes(name)) copyEntry(path.join(src, name), path.join(dst, name))
    }
    chmodSync(dst, stat.mode & 0o7777)
  } else if (stat.isFile()) {
    copyFileSync(src, dst)
    chmodSync(dst, stat.mode & 0o7777)
  } else if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dst)
  }
  // sockets, FIFOs and devices are not state worth copying
}

/** Copies `legacy` to `target` when only the legacy one exists. Never throws. */
export function migrateLegacy(legacy: string, target: string, options: MigrateOptions = {}): MigrationResult {
  if (exists(target) || !exists(legacy)) return "none"
  const tmp = `${target}.migrating-${process.pid}-${Date.now()}`
  try {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    copyEntry(legacy, tmp, options.skip)
    try {
      renameSync(tmp, target)
    } catch (cause) {
      // Another process migrated first: theirs stands.
      if (exists(target)) {
        rmSync(tmp, { recursive: true, force: true })
        return "none"
      }
      throw cause
    }
  } catch (cause) {
    rmSync(tmp, { recursive: true, force: true })
    const message = `could not migrate ${legacy} to ${target}: ${cause instanceof Error ? cause.message : cause}`
    ;(options.log ?? ((m: string) => console.warn(`[opencode-hub] warning: ${m}`)))(message)
    return "failed"
  }
  ;(options.log ?? ((m: string) => console.log(`[opencode-hub] ${m}`)))(
    `migrated ${legacy} to ${target} (opencode-voice was renamed to opencode-hub; the old copy is kept)`,
  )
  return "migrated"
}
