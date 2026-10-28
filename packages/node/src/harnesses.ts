// Which harnesses the host runtime offers (the node hello's runtimes[host].harnesses, design §6.3). The host
// runtime starts nothing itself: a host launch's session is created by the machine's service spoke of its harness
// (placement also needs that spoke connected with "launch"), so this only says what can run here:
// - opencode: always (its service spoke is the OpenCode plugin, which the node cannot see);
// - claude-code: when the Claude Code CLI is found (claudeBinary: HUB_CLAUDE_BIN, hub's claude-code.json, else `claude` on
//   PATH); the Claude Code spoke daemon (`hub claude-code daemon`) creates its launch sessions;
// - codex: when the Codex CLI is found (codexBinary); the Codex spoke (`hub codex-spoke serve`) creates them;
// - node.json `harnesses` overrides detection either way (true offers a harness, false withholds it).
//
// Which binary (claudeBinary, codexBinary): the explicit setting, then the one `hubctl setup` installed, then PATH.
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { configPath } from "../../../src/config.ts"

type Env = Readonly<Record<string, string | undefined>>

/** The order harnesses are listed in; others follow in node.json's order. */
const KNOWN = ["opencode", "claude-code", "codex"]

export interface DetectHarnessesOptions {
  /** The environment to look in (PATH, HUB_CLAUDE_BIN); default process.env. */
  readonly env?: Env
  /** node.json `harnesses`. */
  readonly overrides?: Readonly<Record<string, boolean>>
  /** Where hub's config and data are (default os.homedir()). */
  readonly home?: string
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
  const home = options.home ?? homedir()
  if (findExecutable(claudeBinary(env, home), env)) found.add("claude-code")
  if (findExecutable(codexBinary(env, home), env)) found.add("codex")
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

/**
 * The Claude Code CLI to run: HUB_CLAUDE_BIN, else the absolute `binary` in hub's own claude-code.json (next to
 * config.json, so it follows HUB_SPOKE_CONFIG; `hubctl setup` writes it when it installed Claude Code), else `claude`
 * on PATH. A claude-code.json that is unreadable, or names a relative path, is ignored.
 */
export function claudeBinary(env: Env, home: string = homedir()): string {
  if (env.HUB_CLAUDE_BIN) return env.HUB_CLAUDE_BIN
  try {
    const file = path.join(path.dirname(configPath(env as Record<string, string | undefined>, home)), "claude-code.json")
    const binary = (JSON.parse(readFileSync(file, "utf8")) as { binary?: unknown }).binary
    if (typeof binary === "string" && path.isAbsolute(binary)) return binary
  } catch {}
  return "claude"
}

/**
 * The Codex CLI to run: HUB_CODEX_BIN, else the Codex `hubctl setup` installed (data/hub/harnesses/codex/current/
 * bin/codex, under XDG_DATA_HOME or ~/.local/share) when it is there, else `codex` on PATH.
 */
export function codexBinary(env: Env, home: string = homedir()): string {
  if (env.HUB_CODEX_BIN) return env.HUB_CODEX_BIN
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share")
  const current = path.join(data, "hub", "harnesses", "codex", "current", "bin", "codex")
  return executable(current) ? current : "codex"
}
