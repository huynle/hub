// The hook bridge: the command Claude Code runs for every hook of the plugin (`hub claude-code hook [--rewake]
// [--wait <seconds>]`, an absolute path in hooks.json). It reads the hook's stdin JSON, sends it to the per-user
// daemon over its Unix socket, and does what the daemon answers: print the hook output JSON, write the session's
// env file (SessionStart's CLAUDE_ENV_FILE, mode 0600), print stderr and exit 2 (the asyncRewake Stop hook only:
// exit 2 from any other hook would block Claude Code; HUB_CLAUDE_REWAKE=off turns that hook into a no-op). It fails open: no daemon, a bad or late reply, any error →
// exit 0 without output, as if the hook were not there.
import { chmodSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseHookInput } from "./hook-input.ts"
import { ask, WIRE_VERSION, type BridgeRequest } from "./wire.ts"

export interface HookIo {
  readonly argv: readonly string[]
  readonly stdin: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly socketPath: string
  stdout(s: string): void
  stderr(s: string): void
  /** Give up on the daemon after this long (default: never; Claude Code's hook timeout ends the hook). */
  readonly timeoutMs?: number
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
/** Hook input fields the daemon never needs (a tool's whole output). */
const DROPPED = ["tool_response"] as const

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The hook's flags: --rewake, --wait <seconds>. */
function flags(argv: readonly string[]): { rewake: boolean; waitMs?: number } {
  const rewake = argv.includes("--rewake")
  const at = argv.indexOf("--wait")
  const seconds = at >= 0 ? Number(argv[at + 1]) : NaN
  return { rewake, ...(Number.isFinite(seconds) && seconds >= 0 ? { waitMs: Math.round(seconds * 1000) } : {}) }
}

/** Writes `export NAME='value'` lines for the valid names to the env file (0600). */
function writeEnvFile(file: string | undefined, env: Record<string, unknown>): void {
  if (!file || !path.isAbsolute(file)) return
  const lines = Object.entries(env)
    .filter(([name, value]) => ENV_NAME.test(name) && typeof value === "string" && !value.includes("\n"))
    .map(([name, value]) => `export ${name}=${quote(value as string)}\n`)
  if (!lines.length) return
  writeFileSync(file, lines.join(""), { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Runs one hook; resolves with its exit code (0 unless a rewake reply says 2). Never throws. */
export async function runHook(io: HookIo): Promise<number> {
  try {
    let raw: unknown
    try {
      raw = JSON.parse(io.stdin)
    } catch {
      return 0
    }
    const input = parseHookInput(raw)
    if (!input) return 0
    const sent: Record<string, unknown> = { ...input }
    for (const key of DROPPED) delete sent[key]
    const { rewake, waitMs } = flags(io.argv)
    // A print run without streaming input (`hub claude -p`) waits on an asyncRewake hook until it ends: nothing to wake.
    if (rewake && io.env.HUB_CLAUDE_REWAKE === "off") return 0
    const launch = io.env.HUB_CLAUDE_LAUNCH
    const req: BridgeRequest = { v: WIRE_VERSION, kind: "hook", input: sent, ...(launch ? { launch } : {}), ...(rewake ? { rewake: true as const } : {}), ...(waitMs !== undefined ? { waitMs } : {}) }
    const reply = await ask(io.socketPath, req, io.timeoutMs !== undefined ? { timeoutMs: io.timeoutMs } : {})
    if (!isObject(reply)) return 0
    if (isObject(reply.env)) writeEnvFile(io.env.CLAUDE_ENV_FILE, reply.env)
    if (rewake && reply.exit === 2) {
      if (typeof reply.stderr === "string") io.stderr(reply.stderr)
      return 2
    }
    if (isObject(reply.output)) io.stdout(`${JSON.stringify(reply.output)}\n`)
    return 0
  } catch {
    return 0
  }
}
