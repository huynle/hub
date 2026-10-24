// The `hub` and `hubctl` launchers (P1-T10, Brain decision 31swaq28): POSIX sh scripts the plugin writes into the
// hub bin dir (hubBinDir(), first on PATH in every shell it prepares, see env-inject.ts) at start. They run the CLI
// bundle shipped in this package with the runtime running the plugin: OpenCode is a Bun-compiled binary that acts
// as bun under BUN_BE_BUN=1, so no `bun` (or node) needs to be on PATH. Without Bun the bundle runs on `node`.
// The CLI deletes BUN_BE_BUN from its own env at start, so nothing it starts inherits it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

export const LAUNCHERS = ["hub", "hubctl"] as const

/** The built CLI (`npm run build:cli`), relative to the package root; shipped in the npm package. */
export const CLI_BUNDLE = path.join("packages", "cli", "dist", "hub-cli.js")
/** The CLI's TypeScript entry, for checkouts without a build (bun runs it directly). */
export const CLI_SOURCE = path.join("packages", "cli", "src", "main.ts")

export interface LauncherOptions {
  /** The runtime binary (process.execPath). */
  readonly execPath: string
  /** Whether that runtime is Bun (process.versions.bun): then it runs as bun, else node runs the bundle. */
  readonly bun: boolean
  /** The CLI entry the runtime runs. */
  readonly entry: string
}

/** A word quoted for sh. */
const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

export function launcherScript({ execPath, bun, entry }: LauncherOptions): string {
  const command = bun ? `exec env BUN_BE_BUN=1 ${quote(execPath)} ${quote(entry)} "$@"` : `exec node ${quote(entry)} "$@"`
  return `#!/bin/sh\n# hub CLI launcher, written by the hub OpenCode plugin at start (edits are overwritten).\n${command}\n`
}

/** The entry to run from the package at `root`: the bundle, else (Bun only) the TypeScript source. */
export function cliEntry(root: string, bun: boolean): string | undefined {
  const bundle = path.join(root, CLI_BUNDLE)
  if (existsSync(bundle)) return bundle
  return bun ? path.join(root, CLI_SOURCE) : undefined
}

/**
 * Writes `hub` and `hubctl` into `binDir` (created 0700 when missing), mode 0755. A launcher whose content is
 * already right is left alone (only its mode fixed); others are replaced atomically (a shell starting one never
 * reads half a file). Returns the names written.
 */
export function installLaunchers(options: LauncherOptions & { readonly binDir: string }): { written: string[] } {
  const script = launcherScript(options)
  mkdirSync(options.binDir, { recursive: true, mode: 0o700 })
  const written: string[] = []
  for (const name of LAUNCHERS) {
    const file = path.join(options.binDir, name)
    let current: string | undefined
    try {
      current = readFileSync(file, "utf8")
    } catch {
      current = undefined
    }
    if (current === script) {
      if ((statSync(file).mode & 0o777) !== 0o755) chmodSync(file, 0o755)
      continue
    }
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, script, { mode: 0o755 })
    chmodSync(tmp, 0o755)
    renameSync(tmp, file)
    written.push(name)
  }
  return { written }
}
