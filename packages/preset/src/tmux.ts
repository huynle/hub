// The tmux terminal backend of the preset spoke: start a harness in a pane, paste text into it, send Ctrl-C, read
// its screen, tell whether it still runs. Every call is `tmux <args>` with an argv (node's execFile, no shell).
//
// Where: by default a private tmux server (`-L <socket>`, e.g. hub-preset), so the user's own tmux server is never
// touched; attach with `tmux -L <socket> attach`. Only when explicitly asked (`current`), a new window in the tmux
// session this process runs in ($TMUX).
//
// tmux runs a command given as one argument through the shell (`sh -c`) and one given as several arguments directly
// (execvp). A preset's argv has no shell syntax, but a lone argument could still hold glob or other characters, so a
// one-element argv must be a plain program name. tmux also splits its own command line at arguments ending in ";"
// (see tmuxArg).
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"

export interface TmuxResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}
/** Runs `tmux <args>` (argv, no shell) and resolves with its exit code and output; never rejects for a non-zero exit. */
export type TmuxRunner = (args: string[]) => Promise<TmuxResult>

export const TMUX_TIMEOUT_MS = 5000

export function tmuxRunner(bin = "tmux", env: NodeJS.ProcessEnv = process.env, timeoutMs = TMUX_TIMEOUT_MS): TmuxRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        // A missing binary or a timeout has no numeric exit code: report 1 with the error's message.
        const exit = (error as { code?: unknown } | null)?.code
        const code = !error ? 0 : typeof exit === "number" ? exit : 1
        resolve({ code, stdout: stdout ?? "", stderr: stderr || (error ? error.message : "") })
      })
    })
}

/** A pane the backend started: its tmux session, window and pane IDs (`%N`, the target of every later call). */
export interface TerminalPane {
  readonly session: string
  readonly window: string
  readonly target: string
}

export interface LaunchRequest {
  /** The program and its arguments; never run through a shell (see above). */
  readonly argv: readonly string[]
  readonly cwd: string
  /** The tmux session (private socket) or window (current session) name. */
  readonly name: string
  /** Extra environment for the harness. */
  readonly env?: Readonly<Record<string, string>>
}

export interface TerminalBackend {
  readonly kind: "tmux"
  /** Whether it can send keys (Ctrl-C): the spoke announces interrupt and stop only then. */
  readonly canSendKeys: boolean
  launch(req: LaunchRequest): Promise<TerminalPane>
  /** Pastes `text` into the pane; `submit` presses Enter after it. */
  paste(pane: TerminalPane, text: string, options: { readonly submit: boolean }): Promise<void>
  interrupt(pane: TerminalPane): Promise<void>
  /** The pane's last `lines` lines (wrapped lines joined). */
  capture(pane: TerminalPane, lines: number): Promise<string>
  alive(pane: TerminalPane): Promise<boolean>
  kill(pane: TerminalPane): Promise<void>
  /** The command a user runs to look at the pane. */
  attachHint(pane: TerminalPane): string
}

export interface TmuxBackendOptions {
  /** The private tmux socket name (`tmux -L <socket>`). Required unless `current`. */
  readonly socket?: string
  /** The tmux config file of the private server (e.g. /dev/null in tests); default tmux's own lookup. */
  readonly config?: string
  /** Use the tmux session this process runs in ($TMUX) instead of a private server. Only when explicitly asked. */
  readonly current?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly run: TmuxRunner
  /** Size of a new private session. */
  readonly width?: number
  readonly height?: number
}

const SOCKET = /^[A-Za-z0-9_.-]{1,64}$/
const PLAIN_PROGRAM = /^[A-Za-z0-9_.\/+:@%,-]+$/
const FORMAT = "#{session_name}\t#{window_id}\t#{pane_id}"

/**
 * tmux reads an argument ending in ";" as a command separator, and one ending in "\;" as that argument ending in ";".
 * Every argument goes through this, so an argv element (or pasted text) ending in ";" reaches tmux as itself.
 */
export const tmuxArg = (arg: string): string => (arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg)

const failure = (what: string, r: TmuxResult) => new Error(`tmux ${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`)

export function tmuxBackend(options: TmuxBackendOptions): TerminalBackend {
  const current = options.current === true
  if (current && !options.env?.TMUX) throw new Error("Not inside tmux ($TMUX is not set): cannot use the current tmux session")
  if (!current && (typeof options.socket !== "string" || !SOCKET.test(options.socket))) throw new Error(`The tmux socket name must be 1–64 letters, digits, ".", "_" or "-" (got ${JSON.stringify(options.socket)})`)
  const base = current ? [] : ["-L", options.socket!]
  const tmux = (args: string[]) => options.run([...base, ...args.map(tmuxArg)])
  const must = async (what: string, args: string[]) => {
    const r = await tmux(args)
    if (r.code !== 0) throw failure(what, r)
    return r
  }

  return {
    kind: "tmux",
    canSendKeys: true,

    async launch(req) {
      if (req.argv.length === 0) throw new Error("Nothing to launch: the argv is empty")
      if (req.argv.length === 1 && !PLAIN_PROGRAM.test(req.argv[0]!)) {
        throw new Error(`tmux runs a lone command through the shell: ${JSON.stringify(req.argv[0])} must be a plain program name (letters, digits, / . _ + : @ % , -) or come with arguments`)
      }
      const env = Object.entries(req.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
      const where = current
        ? ["new-window", "-d", "-P", "-F", FORMAT, "-n", req.name, "-c", req.cwd]
        : [...(options.config ? ["-f", options.config] : []), "new-session", "-d", "-P", "-F", FORMAT, "-s", req.name, "-c", req.cwd, "-x", String(options.width ?? 200), "-y", String(options.height ?? 50)]
      const r = await must(current ? "new-window" : "new-session", [...where, ...env, "--", ...req.argv])
      const [session, window, target] = r.stdout.trim().split("\t")
      if (!session || !window || !target) throw new Error(`tmux did not report the new pane (got ${JSON.stringify(r.stdout.trim().slice(0, 100))})`)
      return { session, window, target }
    },

    async paste(pane, text, { submit }) {
      const buffer = `hub-preset-${randomBytes(6).toString("hex")}`
      await must("set-buffer", ["set-buffer", "-b", buffer, "--", text])
      await must("paste-buffer", ["paste-buffer", "-d", "-p", "-b", buffer, "-t", pane.target])
      if (submit) await must("send-keys", ["send-keys", "-t", pane.target, "Enter"])
    },

    async interrupt(pane) {
      await must("send-keys", ["send-keys", "-t", pane.target, "C-c"])
    },

    async capture(pane, lines) {
      return (await must("capture-pane", ["capture-pane", "-p", "-J", "-t", pane.target, "-S", `-${Math.max(1, Math.floor(lines))}`])).stdout
    },

    async alive(pane) {
      const r = await tmux(["display-message", "-p", "-t", pane.target, "#{pane_dead}"])
      return r.code === 0 && r.stdout.trim() === "0"
    },

    async kill(pane) {
      await must("kill-pane", ["kill-pane", "-t", pane.target])
    },

    attachHint(pane) {
      return current ? `tmux select-window -t ${pane.window}` : `tmux -L ${options.socket} attach -t ${pane.session}`
    },
  }
}
