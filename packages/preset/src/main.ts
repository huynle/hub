// `hub preset <list | check | run>`: the preset spoke's command line.
//   list                        the official presets
//   check <name|file>           validate a preset (presetProblem); exit 1 when it is not valid
//   run <name|file> [options] [-- harness args…]
//       starts the preset's command (an argv, never through a shell) in a new tmux pane and connects it to the hub
//       as a preset spoke (evidence screen) until the pane ends or Ctrl-C/SIGTERM (which leaves the harness running).
//       --socket <name>   the private tmux server (`tmux -L <name>`, default hub-preset): the user's own tmux server
//                         is never touched, unless
//       --current         a new window in the tmux session this runs in ($TMUX), only when asked
//       --cwd <dir>       the harness's directory (default the current one)
//       --resume <id>     resume a native session (the preset's resumeFlag)
//       --no-hub          only start the pane and report it (no hub connection; no enrolment needed)
// The native session ID is reported as the spoke knows it: passed on the command line or resumed ("reported, not
// observed"), or read off the screen once it shows.
import path from "node:path"
import { readSpokeCredentials } from "../../node/src/config.ts"
import { configPath } from "../../../src/config.ts"
import pkg from "../package.json" with { type: "json" }
import { findPreset, OFFICIAL_PRESETS } from "./presets.ts"
import { PresetSpoke } from "./spoke.ts"
import { tmuxBackend, tmuxRunner, type TerminalBackend, type TmuxRunner } from "./tmux.ts"

export interface PresetIo {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** The working directory (default process.cwd()). */
  readonly cwd?: string
  stdout(s: string): void
  stderr(s: string): void
  /** Ends `run` (main.ts aborts it on SIGINT/SIGTERM). */
  readonly signal?: AbortSignal
  /** Runs tmux (default the `tmux` on PATH). */
  readonly tmux?: TmuxRunner
  readonly newID?: () => string
  /** How often the pane is sampled (default the spoke's). */
  readonly sampleMs?: number
}

export const PRESET_USAGE = `Usage: hub preset list
       hub preset check <name|file>
       hub preset run <name|file> [--socket <name> | --current] [--cwd <dir>] [--resume <id>] [--no-hub] [-- harness args…]`

export const DEFAULT_SOCKET = "hub-preset"

interface RunArgs {
  readonly ref: string
  readonly socket?: string
  readonly current: boolean
  readonly cwd?: string
  readonly resume?: string
  readonly noHub: boolean
  readonly args: string[]
}

function parseRun(argv: readonly string[]): RunArgs | { error: string } {
  const dash = argv.indexOf("--")
  const own = dash >= 0 ? argv.slice(0, dash) : [...argv]
  const args = dash >= 0 ? argv.slice(dash + 1) : []
  let ref: string | undefined
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!
    if (arg === "--socket" || arg === "--cwd" || arg === "--resume") {
      const value = own[++i]
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` }
      values[arg] = value
    } else if (arg === "--current" || arg === "--no-hub") flags.add(arg)
    else if (arg.startsWith("-")) return { error: `unknown option ${arg} (harness arguments go after --)` }
    else if (ref === undefined) ref = arg
    else return { error: `unexpected ${JSON.stringify(arg)} (harness arguments go after --)` }
  }
  if (ref === undefined) return { error: "run needs a preset name or file" }
  if (flags.has("--current") && values["--socket"] !== undefined) return { error: "--current and --socket exclude each other" }
  return {
    ref,
    current: flags.has("--current"),
    noHub: flags.has("--no-hub"),
    args,
    ...(values["--socket"] !== undefined ? { socket: values["--socket"] } : {}),
    ...(values["--cwd"] !== undefined ? { cwd: values["--cwd"] } : {}),
    ...(values["--resume"] !== undefined ? { resume: values["--resume"] } : {}),
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function run(argv: readonly string[], io: PresetIo): Promise<number> {
  const parsed = parseRun(argv)
  if ("error" in parsed) {
    io.stderr(`hub preset: ${parsed.error}\n${PRESET_USAGE}\n`)
    return 2
  }
  const cwd = io.cwd ?? process.cwd()
  const found = findPreset(parsed.ref, { cwd })
  if ("error" in found) {
    io.stderr(`hub preset: ${found.error}\n`)
    return 1
  }
  const preset = found.preset
  if (parsed.resume !== undefined && !preset.resumeFlag) {
    io.stderr(`hub preset: the ${preset.name} preset cannot resume a session (it has no resumeFlag)\n`)
    return 1
  }
  let backend: TerminalBackend
  try {
    backend = tmuxBackend({
      ...(parsed.current ? { current: true } : { socket: parsed.socket ?? DEFAULT_SOCKET }),
      env: io.env,
      run: io.tmux ?? tmuxRunner("tmux", io.env as NodeJS.ProcessEnv),
    })
  } catch (cause) {
    io.stderr(`hub preset: ${message(cause)}\n`)
    return 1
  }
  const credentials = parsed.noHub ? undefined : readSpokeCredentials(io.env, io.home)
  if (!parsed.noHub && !credentials) {
    io.stderr(`hub preset: this machine is not enrolled with a hub (no machine token in ${configPath(io.env, io.home)}); use --no-hub to only start the pane\n`)
    return 1
  }
  const log = (line: string) => io.stderr(`[hub preset] ${line}\n`)
  const spoke = new PresetSpoke({
    preset,
    backend,
    server: credentials?.server ?? "http://127.0.0.1:1",
    token: credentials?.token ?? "",
    pluginVersion: pkg.version,
    directory: cwd,
    ...(io.newID ? { newID: io.newID } : {}),
    ...(io.sampleMs !== undefined ? { sampleMs: io.sampleMs } : {}),
    log,
    onState: (state, error) => log(`hub connection ${state}${error ? `: ${error}` : ""}`),
  })
  if (credentials) spoke.start()
  let launched
  try {
    launched = await spoke.launch({ cwd: parsed.cwd ? path.resolve(cwd, parsed.cwd) : cwd, args: parsed.args, ...(parsed.resume !== undefined ? { resume: parsed.resume } : {}) })
  } catch (cause) {
    spoke.stop()
    io.stderr(`hub preset: ${message(cause)}\n`)
    return 1
  }
  const where = parsed.current ? "the current tmux session" : `tmux session ${launched.pane.session} on socket ${parsed.socket ?? DEFAULT_SOCKET}`
  const native = launched.nativeID
    ? `${launched.nativeID.id} (${launched.nativeID.how})`
    : preset.nativeID.source === "screen"
      ? "not seen yet (read off the screen when it shows)"
      : `none (the ${preset.name} preset has no session IDs)`
  const lines = [
    `started ${preset.name} in ${where}${parsed.current ? ` (window ${launched.pane.window})` : ""}, pane ${launched.pane.target}`,
    credentials ? `session: ${launched.sessionID} (evidence screen: hub messages are pasted, never confirmed)` : "not connected to a hub (--no-hub): the pane runs on its own",
    `native ID: ${native}`,
    `attach: ${launched.attach}`,
  ]
  io.stdout(`${lines.join("\n")}\n`)
  if (!credentials) return 0

  const outcome = await new Promise<"ended" | "signal">((resolve) => {
    spoke.onEnd((id) => id === launched.sessionID && resolve("ended"))
    if (io.signal?.aborted) return resolve("signal")
    io.signal?.addEventListener("abort", () => resolve("signal"), { once: true })
  })
  spoke.stop()
  io.stdout(outcome === "ended" ? `${preset.name} ended (its pane is gone)\n` : `disconnected from the hub; ${preset.name} is still running in its pane (attach: ${launched.attach})\n`)
  return 0
}

export async function presetMain(argv: readonly string[], io: PresetIo): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case "list": {
      const width = Math.max(...OFFICIAL_PRESETS.map((p) => p.name.length))
      io.stdout(`${OFFICIAL_PRESETS.map((p) => `${p.name.padEnd(width)}  ${p.description ?? ""}`.trimEnd()).join("\n")}\n`)
      return 0
    }
    case "check": {
      if (rest.length !== 1) {
        io.stderr(`hub preset: check needs one preset name or file\n${PRESET_USAGE}\n`)
        return 2
      }
      const found = findPreset(rest[0]!, { cwd: io.cwd ?? process.cwd() })
      if ("error" in found) {
        io.stderr(`hub preset: ${found.error}\n`)
        return 1
      }
      io.stdout(`${found.preset.name}: a valid preset (${found.source === "official" ? "official" : found.source})\n`)
      return 0
    }
    case "run":
      return run(rest, io)
    default:
      io.stderr(`${PRESET_USAGE}\n`)
      return 2
  }
}
