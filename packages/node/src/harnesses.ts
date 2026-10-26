// Which harnesses the host runtime offers (the node hello's runtimes[host].harnesses, design §6.3). The host
// runtime starts nothing itself: a host launch's session is created by the machine's service spoke of its harness
// (placement also needs that spoke connected with "launch"), so this only says what can run here:
// - opencode: always (its service spoke is the OpenCode plugin, which the node cannot see);
// - claude-code: when the Claude Code CLI is found: HUB_CLAUDE_BIN (absolute, or a name on PATH), else `claude` on
//   PATH; the Claude Code spoke daemon (`hub claude-code daemon`) creates its launch sessions;
// - node.json `harnesses` overrides detection either way (true offers a harness, false withholds it).
import { accessSync, constants, statSync } from "node:fs"
import path from "node:path"

type Env = Readonly<Record<string, string | undefined>>

/** The order harnesses are listed in; others follow in node.json's order. */
const KNOWN = ["opencode", "claude-code", "codex"]

export interface DetectHarnessesOptions {
  /** The environment to look in (PATH, HUB_CLAUDE_BIN); default process.env. */
  readonly env?: Env
  /** node.json `harnesses`. */
  readonly overrides?: Readonly<Record<string, boolean>>
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The executable `name` runs as: an absolute path checked as it is, else the first match on PATH. */
export function findExecutable(name: string, env: Env): string | undefined {
  if (!name) return undefined
  if (path.isAbsolute(name)) return executable(name) ? name : undefined
  if (name.includes("/")) return undefined
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    const file = path.join(dir, name)
    if (executable(file)) return file
  }
  return undefined
}

/** The harnesses this machine's host runtime offers. */
export function detectHarnesses(options: DetectHarnessesOptions = {}): string[] {
  const env = options.env ?? process.env
  const found = new Set<string>(["opencode"])
  if (findExecutable(env.HUB_CLAUDE_BIN || "claude", env)) found.add("claude-code")
  for (const [name, on] of Object.entries(options.overrides ?? {})) {
    if (on) found.add(name)
    else found.delete(name)
  }
  const rank = (name: string) => {
    const i = KNOWN.indexOf(name)
    return i < 0 ? KNOWN.length : i
  }
  return [...found].sort((a, b) => rank(a) - rank(b))
}
