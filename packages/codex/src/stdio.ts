// A child process's stdio as a channel of lines: `codex app-server --listen stdio://` reads one JSON message per line
// on stdin and writes one per line on stdout. Its stderr goes to `log` line by line (never parsed); its exit (or a
// failure to start) closes the channel; closing the channel ends the child (SIGTERM, then SIGKILL after a grace).
import { spawn } from "node:child_process"
import type { Channel } from "./jsonrpc.ts"

/** Longest stdout line accepted (an app-server message); a longer one ends the child. */
export const STDIO_MAX_LINE = 16 * 1024 * 1024
const KILL_GRACE_MS = 2000
const LOG_LINE_MAX = 2000

export interface StdioOptions {
  readonly command: string
  readonly args: readonly string[]
  /** The child's whole environment (nothing is inherited implicitly). */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
  readonly log?: (line: string) => void
}

export interface StdioChild {
  readonly channel: Channel
  /** 0 when the child could not start. */
  readonly pid: number
  readonly exited: Promise<{ code: number | null; signal: string | null }>
}

export function spawnStdioChannel(options: StdioOptions): StdioChild {
  const listeners: ((text: string) => void)[] = []
  const closers: ((reason: string) => void)[] = []
  let closed = false
  const finish = (reason: string) => {
    if (closed) return
    closed = true
    for (const cb of closers) cb(reason)
  }
  const env = Object.fromEntries(Object.entries(options.env).filter(([, v]) => v !== undefined)) as Record<string, string>
  const child = spawn(options.command, [...options.args], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  let exitDone!: (v: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => (exitDone = resolve))
  child.on("error", (error) => {
    finish(`cannot run ${options.command}: ${error.message}`)
    exitDone({ code: null, signal: null })
  })
  child.on("exit", (code, signal) => {
    finish(`${options.command} exited (code ${code ?? "none"}${signal ? `, signal ${signal}` : ""})`)
    exitDone({ code, signal })
  })
  child.stdin.on("error", () => {})

  let out = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    out += chunk
    let end: number
    while ((end = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, end).replace(/\r$/, "")
      out = out.slice(end + 1)
      if (line.trim()) for (const cb of listeners) cb(line)
    }
    if (out.length > STDIO_MAX_LINE) child.kill("SIGKILL")
  })
  let err = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    err += chunk
    let end: number
    while ((end = err.indexOf("\n")) >= 0) {
      const line = err.slice(0, end)
      err = err.slice(end + 1)
      if (line.trim()) options.log?.(line.slice(0, LOG_LINE_MAX))
    }
    if (err.length > LOG_LINE_MAX) err = ""
  })

  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
    timer.unref?.()
    void exited.then(() => clearTimeout(timer))
  }

  return {
    pid: child.pid ?? 0,
    exited,
    channel: {
      send(text) {
        if (closed) throw new Error("the app-server process has exited")
        child.stdin.write(`${text}\n`)
      },
      close() {
        child.stdin.end()
        stop()
        finish("closed")
      },
      onMessage: (cb) => void listeners.push(cb),
      onClose: (cb) => void closers.push(cb),
    },
  }
}
