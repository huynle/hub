// Session identity for shells (P1-T6, Brain decision 31swaq28): every shell an agent runs through the shell tool
// gets HUB_URL and HUB_SESSION_TOKEN for its own session, so `hub` there acts as that session; the hub bin dir
// (where the spoke writes the `hub`/`hubctl` launchers, P1-T10) goes first on PATH for every shell.
//
// OpenCode's `shell.create.before` hook has a mutable env but no sessionID; the tool `execute.before` hook has the
// sessionID and the command. In the shell tool the two run back to back (execute.before, then Shell.create runs
// create.before, then the tool's own env tweaks and the permission check), so a shell is matched to the most recent
// pending shell tool call with the same command. Not used: the OPENCODE_SESSION_ID in the create.before env — the
// shell tool sets it only after our hook, so at that point it is the server process's inherited one (of the
// session that started this OpenCode, if any), which would hand out the wrong identity.
//
// Fail closed: the same command pending from two different sessions gives neither a token; so does a command that
// another plugin rewrote in a way we cannot see. Known gap: user `!` commands (session.shell) have no tool call, so
// they get only the stripped env and PATH, no token.
import { homedir } from "node:os"
import path from "node:path"
import { defaultStateDir } from "./localhub"

type Env = Record<string, string | undefined>

/** What the tool `execute.before`/`execute.after` hooks report (the fields used here). */
export interface ToolCall {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly input: unknown
}

/** The shell `create.before` invocation (the fields used here). */
export interface ShellInvocation {
  readonly command: string
  env: Env
}

/** A session's identity for its shells. */
export interface Identity {
  readonly token: string
  readonly url?: string
}

/** The OpenCode tool names that run a command in a shell. */
const SHELL_TOOLS = new Set(["shell", "bash"])
const HUB_VARS = ["HUB_URL", "HUB_SESSION_TOKEN"] as const
const DEFAULT_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

interface Pending {
  readonly call: ToolCall
  readonly at: number
}

const commandOf = (call: ToolCall): string | undefined => {
  const input = call.input as { command?: unknown } | null | undefined
  return input && typeof input === "object" && typeof input.command === "string" ? input.command : undefined
}

/** Pairs shells with the shell tool calls that create them (see the file comment). */
export class ShellCorrelator {
  readonly #pending: Pending[] = []
  readonly #ttlMs: number
  readonly #max: number
  readonly #now: () => number

  constructor(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000
    this.#max = options.max ?? 256
    this.#now = options.now ?? Date.now
  }

  /** Remembers a shell tool call (other tools are ignored). */
  record(call: ToolCall): void {
    if (!SHELL_TOOLS.has(call.tool) || typeof call.sessionID !== "string" || commandOf(call) === undefined) return
    this.#prune()
    this.#pending.push({ call, at: this.#now() })
    if (this.#pending.length > this.#max) this.#pending.splice(0, this.#pending.length - this.#max)
  }

  /** Forgets a tool call once it finished (its shell, if any, was created long before). */
  done(callID: string): void {
    const index = this.#pending.findIndex((p) => p.call.id === callID)
    if (index >= 0) this.#pending.splice(index, 1)
  }

  /**
   * The session of the pending shell tool call with this command, consuming it; undefined when none or when calls
   * from different sessions are pending with it (then all of them are dropped). The command is read now, so input
   * rewrites by hooks that ran after ours count.
   */
  match(command: string): string | undefined {
    this.#prune()
    const matches = this.#pending.filter((p) => commandOf(p.call) === command)
    if (matches.length === 0) return undefined
    const sessions = new Set(matches.map((p) => p.call.sessionID))
    if (sessions.size > 1) {
      for (const p of matches) this.#pending.splice(this.#pending.indexOf(p), 1)
      return undefined
    }
    this.#pending.splice(this.#pending.indexOf(matches[0]!), 1)
    return matches[0]!.call.sessionID
  }

  get size(): number {
    this.#prune()
    return this.#pending.length
  }

  #prune(): void {
    const oldest = this.#now() - this.#ttlMs
    while (this.#pending.length > 0 && this.#pending[0]!.at <= oldest) this.#pending.shift()
  }
}

/** Deletes HUB_URL and HUB_SESSION_TOKEN (an identity inherited from an outer session must never leak). */
export function stripInheritedHubEnv(env: Env): void {
  for (const name of HUB_VARS) delete env[name]
}

/** Strips inherited HUB_*, sets the session's identity when it has one, and puts `binDir` first on PATH once. */
export function applyHubEnv(env: Env, identity: Identity | undefined, binDir: string): void {
  stripInheritedHubEnv(env)
  if (identity) {
    if (identity.url) env.HUB_URL = identity.url
    env.HUB_SESSION_TOKEN = identity.token
  }
  const rest = env.PATH === undefined ? DEFAULT_PATH : env.PATH.split(path.delimiter).filter((dir) => dir !== binDir)
  env.PATH = [binDir, ...rest].join(path.delimiter)
}

/** Where the `hub`/`hubctl` launchers live: bin under the hub state dir ($HUB_STATE_DIR or ~/.local/state/hub). */
export function hubBinDir(env: Env = process.env, home: string = homedir()): string {
  return path.join(defaultStateDir(env, home), "bin")
}

/** The hook handlers: tool execute.before/after and shell create.before. They never throw. */
export function envInjector(options: { correlator: ShellCorrelator; binDir: string; identity: (sessionID: string) => Identity | undefined }) {
  const { correlator, binDir, identity } = options
  return {
    toolBefore(call: ToolCall): void {
      try {
        correlator.record(call)
      } catch (cause) {
        console.error("[hub] shell env: could not record a tool call", cause)
      }
    },
    toolAfter(call: ToolCall): void {
      try {
        correlator.done(call.id)
      } catch {
        // nothing to forget
      }
    },
    shellBefore(invocation: ShellInvocation): void {
      try {
        if (!invocation.env || typeof invocation.env !== "object") return
        const sessionID = typeof invocation.command === "string" ? correlator.match(invocation.command) : undefined
        applyHubEnv(invocation.env, sessionID ? identity(sessionID) : undefined, binDir)
      } catch (cause) {
        console.error("[hub] shell env: could not prepare a shell", cause)
      }
    },
  }
}
