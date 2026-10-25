// The plugin directory `hub claude` loads with --plugin-dir (decision fx04e42c point 4: never the user's ~/.claude
// files). hooks/hooks.json runs the hook bridge (`hub claude-code hook`) for every event the spoke uses, with the
// absolute runtime and CLI entry quoted for sh and nothing else from outside in the command; PermissionRequest
// passes the permission wait (--wait <s>) under a hook timeout 2 s above it (the spike: wait ≤ hook timeout − 1 s);
// Stop also runs an asyncRewake bridge (--rewake) that blocks until the daemon has a message to wake the idle
// session with (exit 2). .mcp.json runs the daemon-backed MCP pipe. Each configuration gets its own directory
// (plugin-<hash>), written once.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ensurePrivateDir } from "./paths.ts"

export interface PluginOptions {
  /** What runs the hub CLI: the runtime and the CLI's entry file (absolute paths). */
  readonly program: { readonly execPath: string; readonly entry: string }
  /** How long a PermissionRequest waits for the hub (0: report only, the local dialog decides). */
  readonly permissionWaitS: number
  /** How long the asyncRewake Stop hook may wait for a message. */
  readonly rewakeTimeoutS: number
  readonly version: string
}

/** The hook events the spoke registers. */
export const HOOK_EVENTS: readonly string[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
]
/** Events with a tool matcher. */
const TOOL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"])
/** Timeout of the hooks that only report (seconds): the daemon answers at once. SessionStart waits for a token. */
const REPORT_TIMEOUT_S = 10
const SESSION_START_TIMEOUT_S = 15
const PERMISSION_SLACK_S = 2

/** An absolute path without quotes or control characters (safe single-quoted for sh); refused otherwise. */
function checked(p: string): string {
  if (!path.isAbsolute(p) || /['\u0000-\u001f\u007f]/.test(p)) throw new Error(`Cannot use ${JSON.stringify(p)} in a hook command: it must be an absolute path without quotes or control characters`)
  return p
}

const quoted = (p: string) => `'${checked(p)}'`

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** The plugin's files (relative path → content). */
export function pluginFiles(options: PluginOptions): Record<string, string> {
  const { execPath, entry } = options.program
  const bridge = `BUN_BE_BUN=1 ${quoted(execPath)} ${quoted(entry)} claude-code hook`
  const wait = Math.max(0, Math.round(options.permissionWaitS))
  const command = (cmd: string, timeout: number, extra: Record<string, unknown> = {}) => ({ type: "command", command: cmd, ...extra, timeout })
  const hooks: Record<string, unknown[]> = {}
  for (const event of HOOK_EVENTS) {
    const list =
      event === "PermissionRequest"
        ? [command(`${bridge} --wait ${wait}`, wait > 0 ? wait + PERMISSION_SLACK_S : REPORT_TIMEOUT_S)]
        : event === "Stop"
          ? [command(bridge, REPORT_TIMEOUT_S), command(`${bridge} --rewake`, Math.max(1, Math.round(options.rewakeTimeoutS)), { asyncRewake: true })]
          : [command(bridge, event === "SessionStart" ? SESSION_START_TIMEOUT_S : REPORT_TIMEOUT_S)]
    hooks[event] = [{ ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}), hooks: list }]
  }
  return {
    ".claude-plugin/plugin.json": json({ name: "hub", version: options.version, description: "Hub: follow, message and steer this Claude Code session from the hub (hooks spoke)" }),
    "hooks/hooks.json": json({ hooks }),
    ".mcp.json": json({ mcpServers: { hub: { command: checked(execPath), args: [checked(entry), "claude-code", "mcp"], env: { BUN_BE_BUN: "1" } } } }),
  }
}

/** Writes the plugin for `options` under `base` (once: plugin-<hash>) and returns its directory. */
export function writePlugin(base: string, options: PluginOptions): string {
  const files = pluginFiles(options)
  const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12)
  ensurePrivateDir(base)
  const dir = path.join(base, `plugin-${hash}`)
  if (existsSync(path.join(dir, "hooks", "hooks.json"))) return dir
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(tmp, file), content, { mode: 0o600 })
  }
  try {
    renameSync(tmp, dir)
  } catch (cause) {
    rmSync(tmp, { recursive: true, force: true })
    if (!existsSync(dir)) throw cause // another run wrote it first otherwise
  }
  ensurePrivateDir(dir)
  return dir
}
