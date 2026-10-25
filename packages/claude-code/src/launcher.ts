// ClaudeLauncher: the Claude Code processes the daemon starts for hub launches (feature "launch", report v0hsdqhm).
// Each runs headless in the launch's workspace: `claude --plugin-dir <hub plugin> --session-id <uuid> -p
// --input-format stream-json --output-format stream-json --verbose [--model m] [--agent a]`, so its hooks reach the
// daemon like any `hub claude` run (HUB_CLAUDE_LAUNCH, HUB_CLAUDE_SOCKET), a turn is a user message written to its
// stdin, the turn's end is the result line on its stdout, and an interrupt is a control request (Esc has no hook,
// a control request works). Turns are answered in order (Claude Code runs queued user messages one after another).
// When claude exits its open turns fail and onExit reports it; stopAll closes stdin (claude ends after the running
// turn) and kills what lingers.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { PromptImage, TurnResult } from "../../protocol/src/index.ts"

type Env = Readonly<Record<string, string | undefined>>

export interface LauncherOptions {
  /** The claude executable. */
  readonly bin: string
  /** The environment claude starts with (the daemon's), before the hub's variables. */
  readonly env: Env
  /** A launched claude exited (its sessions end). */
  readonly onExit?: (sessionID: string, code: number | null) => void
  readonly log?: (line: string) => void
}

export interface LaunchInput {
  /** The Claude Code session UUID (--session-id). */
  readonly sessionID: string
  /** The prepared workspace (claude's cwd). */
  readonly directory: string
  /** The launch key its hooks report (HUB_CLAUDE_LAUNCH). */
  readonly launch: string
  readonly pluginDir: string
  readonly socketPath: string
  readonly model?: string
  readonly agent?: string
}

interface Turn {
  resolve(result: TurnResult): void
  interrupted: boolean
}

interface Proc {
  readonly child: ChildProcessWithoutNullStreams
  readonly turns: Turn[]
  readonly controls: Map<string, () => void>
  readonly exited: Promise<void>
  stderr: string
}

const INTERRUPTED = "Interrupted from the hub"
const CONTROL_WAIT_MS = 5000
const STOP_GRACE_MS = 2000
const KILL_GRACE_MS = 1000
const LINE_MAX = 16 * 1024 * 1024
const STDERR_KEEP = 2000

const record = (v: unknown): Record<string, any> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {})
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The claude arguments of a headless launch. */
export function launchArgs(input: LaunchInput): string[] {
  return [
    "--plugin-dir",
    input.pluginDir,
    "--session-id",
    input.sessionID,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(input.model ? ["--model", input.model] : []),
    ...(input.agent ? ["--agent", input.agent] : []),
  ]
}

/** A stream-json user message. */
export function userMessage(sessionID: string, text: string, images: readonly PromptImage[] = []): Record<string, unknown> {
  const content = images.length
    ? [...(text ? [{ type: "text", text }] : []), ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } }))]
    : text
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionID }
}

/** The turn's result for a stream-json result line. */
export function turnResult(line: Record<string, any>, interrupted: boolean): TurnResult {
  const reply = typeof line.result === "string" ? line.result : ""
  if (line.subtype === "success" && line.is_error !== true) return { outcome: "succeeded", reply }
  if (interrupted) return { outcome: "interrupted", message: INTERRUPTED, reply: "" }
  const errors = Array.isArray(line.errors) ? line.errors.filter((e: unknown): e is string => typeof e === "string") : []
  return { outcome: "failed", message: reply || errors.join("; ") || String(line.subtype ?? "the turn failed"), reply: "" }
}

export class ClaudeLauncher {
  readonly #options: LauncherOptions
  readonly #procs = new Map<string, Proc>()
  #controlID = 0

  constructor(options: LauncherOptions) {
    this.#options = options
  }

  /** Starts claude for a launch; rejects when it cannot run (or the session already runs). */
  async start(input: LaunchInput): Promise<void> {
    if (this.#procs.has(input.sessionID)) throw new Error(`Session ${input.sessionID} is already running`)
    const env: Record<string, string | undefined> = { ...this.#options.env, HUB_CLAUDE_LAUNCH: input.launch, HUB_CLAUDE_SOCKET: input.socketPath }
    delete env.BUN_BE_BUN
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.#options.bin, launchArgs(input), { cwd: input.directory, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] })
    } catch (cause) {
      throw new Error(`cannot run ${this.#options.bin}: ${(cause as Error).message}`)
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", (cause) => reject(new Error(`cannot run ${this.#options.bin}: ${cause.message}`)))
    })
    let exited!: () => void
    const proc: Proc = { child, turns: [], controls: new Map(), exited: new Promise<void>((resolve) => (exited = resolve)), stderr: "" }
    this.#procs.set(input.sessionID, proc)
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      proc.stderr = (proc.stderr + chunk).slice(-STDERR_KEEP)
    })
    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (text.trim()) this.#line(proc, text)
      }
      if (buffer.length > LINE_MAX) buffer = ""
    })
    child.once("exit", (code) => {
      if (this.#procs.get(input.sessionID) === proc) this.#procs.delete(input.sessionID)
      const detail = proc.stderr.trim().split("\n").pop()
      const message = `Claude Code exited (code ${code ?? "none"})${detail ? `: ${detail.slice(0, 300)}` : ""}`
      for (const turn of proc.turns.splice(0)) turn.resolve(turn.interrupted ? { outcome: "interrupted", message: INTERRUPTED, reply: "" } : { outcome: "failed", message, reply: "" })
      for (const done of proc.controls.values()) done()
      proc.controls.clear()
      this.#options.log?.(`claude for ${input.sessionID} exited (code ${code ?? "none"})`)
      exited()
      this.#options.onExit?.(input.sessionID, code)
    })
  }

  /** Whether the hub started this session here (and it still runs). */
  has(sessionID: string): boolean {
    return this.#procs.has(sessionID)
  }

  /** Whether a turn is running (or queued) in it. */
  running(sessionID: string): boolean {
    return (this.#procs.get(sessionID)?.turns.length ?? 0) > 0
  }

  /** Writes a user message; resolves with the turn's result. */
  turn(sessionID: string, text: string, images: readonly PromptImage[] = []): Promise<TurnResult> {
    const proc = this.#procs.get(sessionID)
    if (!proc) return Promise.reject(new Error(`Session ${sessionID} was not started by the hub here (turns reach only hub-launched Claude Code sessions)`))
    return new Promise<TurnResult>((resolve) => {
      proc.turns.push({ resolve, interrupted: false })
      proc.child.stdin.write(`${JSON.stringify(userMessage(sessionID, text, images))}\n`)
    })
  }

  /** Interrupts the running turn (a control request); false when the hub did not start the session. */
  async interrupt(sessionID: string): Promise<boolean> {
    const proc = this.#procs.get(sessionID)
    if (!proc) return false
    for (const turn of proc.turns) turn.interrupted = true
    const id = `hub_int_${++this.#controlID}`
    const answered = new Promise<void>((resolve) => proc.controls.set(id, resolve))
    proc.child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "interrupt" } })}\n`)
    await Promise.race([answered, sleep(CONTROL_WAIT_MS)])
    proc.controls.delete(id)
    return true
  }

  /** Ends every process: stdin closed, then SIGTERM and SIGKILL for what lingers. */
  async stopAll(): Promise<void> {
    const procs = [...this.#procs.values()]
    for (const proc of procs) proc.child.stdin.end()
    await Promise.all(
      procs.map(async (proc) => {
        if (await Promise.race([proc.exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)])) return
        proc.child.kill("SIGTERM")
        if (await Promise.race([proc.exited.then(() => true), sleep(KILL_GRACE_MS).then(() => false)])) return
        proc.child.kill("SIGKILL")
        await proc.exited
      }),
    )
  }

  #line(proc: Proc, text: string): void {
    let line: Record<string, any>
    try {
      line = record(JSON.parse(text))
    } catch {
      return
    }
    if (line.type === "result") {
      const turn = proc.turns.shift()
      turn?.resolve(turnResult(line, turn.interrupted))
    } else if (line.type === "control_response") {
      const id = record(line.response).request_id
      if (typeof id === "string") proc.controls.get(id)?.()
    }
  }
}
