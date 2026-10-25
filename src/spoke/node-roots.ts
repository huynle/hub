// The machine's node workspace roots, for launch creates (feature "launch"): a launch's session may start in a new
// workspace (a worktree or clone `hub node` just prepared) the spoke never reported, but only under a root.
// node.json is owned by `hub node` (packages/node): {workspaceRoots: string[], labels?, slots?, memoryMB?}. The spoke
// reads it, read-only and only workspaceRoots, from next to its own config (configPath: ~/.config/hub, or the
// directory of $HUB_SPOKE_CONFIG; a launch-bound spoke: the directory of its launch config).
import { readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { configPath } from "../config"
import type { Env } from "../env"

export const NODE_CONFIG_FILE = "node.json"

/** node.json next to the spoke config file. */
export function nodeConfigPath(env: Env = process.env, home: string = homedir()): string {
  return nodeConfigPathNextTo(configPath(env, home))
}

/** node.json in the directory of `configFile` (a launch-bound spoke: next to its launch config). */
export function nodeConfigPathNextTo(configFile: string): string {
  return path.join(path.dirname(configFile), NODE_CONFIG_FILE)
}

/** The absolute workspace roots in a node.json; none when the file is missing or unreadable. */
export function readWorkspaceRoots(file: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return []
  }
  const roots = (parsed as { workspaceRoots?: unknown } | null)?.workspaceRoots
  if (!Array.isArray(roots)) return []
  return roots.filter((r): r is string => typeof r === "string" && r.length > 0 && path.isAbsolute(r))
}

function real(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

const within = (dir: string, root: string) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * Why `directory` cannot host a launch session, or undefined when it is an existing directory at or under one of
 * `roots`. Both sides are compared by real path, so a symlink cannot lead out of a root.
 */
export function launchDirectoryProblem(directory: string, roots: readonly string[]): string | undefined {
  if (roots.length === 0) return "This machine has no node workspace roots"
  const dir = real(directory)
  if (!dir) return `Directory ${directory} does not exist`
  if (!statSync(dir).isDirectory()) return `${directory} is not a directory`
  for (const root of roots) {
    const r = real(root)
    if (r && within(dir, r)) return undefined
  }
  return `Directory ${directory} is not under the node workspace roots`
}
