// The `hub` and `hubctl` launchers (P1-T10, Brain decision 31swaq28): POSIX sh scripts the plugin writes into the
// hub bin dir (hubBinDir(), first on PATH in every shell it prepares, see env-inject.ts) at start. They run the CLI
// bundle shipped in this package with the runtime running the plugin: OpenCode is a Bun-compiled binary that acts
// as bun under BUN_BE_BUN=1, so no `bun` (or node) needs to be on PATH. Without Bun the bundle runs on `node`.
// The CLI deletes BUN_BE_BUN from its own env at start, so nothing it starts inherits it.
//
// A standalone hubctl at user-bin:hubctl (~/.local/bin/hubctl, what `hubctl setup` installs) wins: the launchers exec
// it when it is there (checked at run time), so shells, services and MCP clients all run that one stable authority
// rather than the bundle in the plugin's install (cache) directory.
//
// For the user's own terminals (a plugin-only install, where `hubctl setup` never ran), linkUserBin links
// ~/.local/bin/hub to the `hub` launcher under the setup's user-bin rule (packages/cli/src/setup/user-bin.ts): only
// when nothing is there or it is hub's own link, and never when another `hub` is on PATH. ~/.local/bin/hubctl is left
// to `hubctl setup`: it is the standalone hubctl's install path (a link there would make that install refuse to write
// through it, and the launchers would exec themselves).
import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { userBinLinkDecision, type UserBinEntry } from "../../packages/cli/src/setup/user-bin.ts"

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
  /** The standalone hubctl to prefer when it exists (standaloneHubctl(home)). */
  readonly standalone?: string
}

/** Where `hubctl setup` installs the standalone hubctl (contract user-bin:hubctl). */
export const standaloneHubctl = (home: string): string => path.join(home, ".local", "bin", "hubctl")

/** A word quoted for sh. */
const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

const LAUNCHER_HEADER = "#!/bin/sh\n# hub CLI launcher"

export function launcherScript({ execPath, bun, entry, standalone }: LauncherOptions): string {
  const command = bun ? `exec env BUN_BE_BUN=1 ${quote(execPath)} ${quote(entry)} "$@"` : `exec node ${quote(entry)} "$@"`
  const prefer = standalone ? `if [ -x ${quote(standalone)} ]; then exec ${quote(standalone)} "$@"; fi\n` : ""
  return `${LAUNCHER_HEADER}, written by the hub OpenCode plugin at start (edits are overwritten).\n${prefer}${command}\n`
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

/** The user's own bin dir (contract root user-bin). */
export const userBinDir = (home: string): string => path.join(home, ".local", "bin")

function entryOf(file: string): UserBinEntry {
  try {
    const info = lstatSync(file)
    return info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : info.isDirectory() ? "directory" : "other"
  } catch {
    return "missing"
  }
}

/** A file that starts like the launchers hub writes. */
function isLauncher(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const buffer = Buffer.alloc(LAUNCHER_HEADER.length)
    return readSync(fd, buffer, 0, buffer.length, 0) === buffer.length && buffer.toString("utf8") === LAUNCHER_HEADER
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The first executable `name` on `searchPath`, outside `skip`, as found (not followed). */
function onPath(name: string, searchPath: string, skip: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || path.resolve(dir) === path.resolve(skip)) continue
    const file = path.join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
      return file
    } catch {}
  }
  return undefined
}

/**
 * Links ~/.local/bin/hub to `binDir`/hub (see the header). Returns what it linked, and one hint when the user's
 * terminal will not find it (~/.local/bin not on `path`, or another `hub` comes first). Small synchronous calls,
 * nothing when converged (the plugin runs this at start).
 */
export function linkUserBin(options: { readonly home: string; readonly binDir: string; readonly path: string | undefined }): { linked: string[]; hint?: string } {
  // Only the default hub bin dir (~/.local/state/hub/bin): a custom HUB_STATE_DIR (tests, containers, a throwaway
  // state) must never leave ~/.local/bin pointing into it.
  if (path.resolve(options.binDir) !== path.join(options.home, ".local", "state", "hub", "bin")) return { linked: [] }
  const userBin = userBinDir(options.home)
  const linkPath = path.join(userBin, "hub")
  const target = path.join(options.binDir, "hub")
  const entry = entryOf(linkPath)
  let pointsTo: string | undefined
  if (entry === "symlink") {
    try {
      pointsTo = path.resolve(userBin, readlinkSync(linkPath))
    } catch {}
  }
  const searchPath = options.path ?? ""
  const onUserPath = searchPath.split(path.delimiter).some((dir) => dir && path.resolve(dir) === path.resolve(userBin))
  const pathHint = onUserPath ? undefined : `${userBin} is not on PATH: add it to use \`hub\` in your terminal (export PATH="$HOME/.local/bin:$PATH")`
  // `hubctl setup` linked hub to the standalone hubctl: that is the better hub, keep it.
  if (pointsTo === standaloneHubctl(options.home)) return { linked: [], ...(pathHint ? { hint: pathHint } : {}) }
  const foundOnPath = onPath("hub", searchPath, options.binDir)
  const decision = userBinLinkDecision({ entry, ...(pointsTo !== undefined ? { pointsTo } : {}), target, linkPath, hubOwned: isLauncher, ...(foundOnPath !== undefined ? { foundOnPath } : {}) })
  if (decision === "foreign") return { linked: [] }
  if (decision === "shadowed") return { linked: [], hint: `\`hub\` on your PATH is ${foundOnPath}, not hub's CLI; hub's is ${target}` }
  if (decision === "in-place") return { linked: [], ...(pathHint ? { hint: pathHint } : {}) }
  mkdirSync(userBin, { recursive: true, mode: 0o755 })
  // A new link never replaces what may have appeared meanwhile (EEXIST); hub's own is re-pointed atomically.
  if (decision === "create") {
    symlinkSync(target, linkPath)
    return { linked: ["hub"], ...(pathHint ? { hint: pathHint } : {}) }
  }
  const tmp = `${linkPath}.${process.pid}.tmp`
  rmSync(tmp, { force: true })
  symlinkSync(target, tmp)
  try {
    renameSync(tmp, linkPath)
  } catch (cause) {
    rmSync(tmp, { force: true })
    throw cause
  }
  return { linked: ["hub"], ...(pathHint ? { hint: pathHint } : {}) }
}
