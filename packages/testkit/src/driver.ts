// The harness driver protocol: how a conformance suite controls a harness (and its spoke) without knowing it. A
// harness package ships a driver executable that speaks newline-delimited JSON on stdio:
//   suite → driver  {"id":1,"method":"describe","params":{…}}
//   driver → suite  {"id":1,"result":{…}}  or  {"id":1,"error":{"code":"unsupported","message":"…"}}
//   driver → suite  {"event":"…","data":{…}}            (unsolicited, e.g. logs or harness milestones)
// Lines that are not JSON objects are ignored by the driver and kept as `noise` by the client (a harness banner).
// A method the driver has no handler for fails with code "unsupported", so suites can skip what it cannot do.
// `shutdown` is answered by serveDriver itself (after the optional handler); a stdio driver then exits.
import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import type { ModelFormat } from "./model-formats.ts"

export const DRIVER_PROTOCOL_VERSION = 1

export interface DriverInfo {
  readonly protocol: number
  readonly harness: string
  readonly harnessVersion: string
  /** The evidence level the spoke reports (EVIDENCE_LEVELS) or "unknown". */
  readonly evidence: string
  /** Core ops and optional features the spoke announces in its hello. */
  readonly features: readonly string[]
  /** Stub model formats the harness can talk to. */
  readonly models: readonly ModelFormat[]
}

export interface DriverStart {
  readonly hubURL: string
  /** The machine (or launch) token the spoke connects with. */
  readonly token: string
  /** Working directory for the harness (a throwaway project). */
  readonly directory: string
  /** Extra environment: proxy variables (denyProxy().env()), isolated HOME/config dirs. */
  readonly env: Readonly<Record<string, string>>
  /** The stub model to use: its format and base URL (StubModel.openaiBaseURL or anthropicBaseURL). */
  readonly model: { readonly format: ModelFormat; readonly baseURL: string }
}

/** Something the local user does in the harness UI, outside the hub. */
export type LocalAction = "interrupt" | "approve" | "deny" | "exit"

export interface DriverHandlers {
  describe?(): Promise<DriverInfo> | DriverInfo
  /** Starts the harness and its spoke against the hub and stub model. */
  start?(params: DriverStart): Promise<object> | object
  /** Opens a harness session (as the local user would) and returns its hub session ID. */
  createSession?(params: { directory?: string; prompt?: string }): Promise<{ sessionID: string }> | { sessionID: string }
  /** Types a prompt into a session as the local user. */
  prompt?(params: { sessionID: string; text: string }): Promise<object> | object
  local?(params: { sessionID: string; action: LocalAction }): Promise<object> | object
  /** Stops the harness and its spoke. */
  stop?(): Promise<object> | object
  shutdown?(): Promise<void> | void
  /** Other, harness-specific methods. */
  [method: string]: ((params?: any) => unknown) | undefined
}

export interface DriverEvent {
  readonly event: string
  readonly data?: unknown
}

export class DriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly method?: string,
  ) {
    super(message)
    this.name = "DriverError"
  }
}

// ---- driver side -------------------------------------------------------------------------------------------------

export interface ServedDriver {
  emit(event: string, data?: unknown): void
  /** Resolves after shutdown or when the input ends. */
  done: Promise<void>
}

/** Serves a driver: reads requests from input (default stdin), answers on output (default stdout). */
export function serveDriver(handlers: DriverHandlers, io?: { input: Readable; output: Writable }): ServedDriver {
  const input = io?.input ?? process.stdin
  const output = io?.output ?? process.stdout
  const write = (message: object) => output.write(`${JSON.stringify(message)}\n`)
  let finish!: () => void
  const done = new Promise<void>((resolve) => (finish = resolve))
  const handle = async (id: unknown, method: string, params: unknown) => {
    try {
      if (method === "shutdown") {
        await handlers.shutdown?.()
        write({ id, result: {} })
        finish()
        if (!io) setTimeout(() => process.exit(0), 10)
        return
      }
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
      if (typeof handler !== "function") throw new DriverError("unsupported", `driver does not support ${method}`)
      const result = await handler.call(handlers, params)
      write({ id, result: result ?? {} })
    } catch (e) {
      const code = e instanceof DriverError ? e.code : "failed"
      write({ id, error: { code, message: e instanceof Error ? e.message : String(e) } })
    }
  }
  onLines(input, (line) => {
    const message = parseObject(line)
    if (!message || typeof message.method !== "string" || message.id === undefined) return
    void handle(message.id, message.method, message.params)
  })
  input.on("end", () => finish())
  return { emit: (event, data) => write(data === undefined ? { event } : { event, data }), done }
}

// ---- suite side --------------------------------------------------------------------------------------------------

export interface DriverClient {
  describe(): Promise<DriverInfo>
  start(params: DriverStart): Promise<object>
  createSession(params: { directory?: string; prompt?: string }): Promise<{ sessionID: string }>
  prompt(params: { sessionID: string; text: string }): Promise<object>
  local(params: { sessionID: string; action: LocalAction }): Promise<object>
  stop(): Promise<object>
  /** Any method; rejects with a DriverError (code from the driver, or "timeout"). */
  call(method: string, params?: unknown, timeoutMs?: number): Promise<any>
  events: DriverEvent[]
  nextEvent(predicate?: (event: DriverEvent) => boolean, timeoutMs?: number): Promise<DriverEvent>
  /** Output lines that were not protocol messages. */
  noise: string[]
  /** Sends shutdown and ends the connection. */
  close(timeoutMs?: number): Promise<unknown>
}

const CALL_TIMEOUT_MS = 30_000

/** A client over a pair of streams (a driver's stdout as input, its stdin as output). */
export function connectDriver(io: { input: Readable; output: Writable }, onClose?: (timeoutMs: number) => Promise<unknown>): DriverClient {
  let nextID = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string }>()
  const waiters = new Set<() => void>()
  const events: DriverEvent[] = []
  const noise: string[] = []
  onLines(io.input, (line) => {
    const message = parseObject(line)
    if (!message) return void (line.trim() && noise.push(line))
    if (typeof message.event === "string") {
      events.push(message.data === undefined ? { event: message.event } : { event: message.event, data: message.data })
      for (const wake of [...waiters]) wake()
      waiters.clear()
      return
    }
    const call = typeof message.id === "number" ? pending.get(message.id) : undefined
    if (!call) return void noise.push(line)
    pending.delete(message.id as number)
    if (message.error && typeof message.error === "object") {
      const error = message.error as { code?: unknown; message?: unknown }
      call.reject(new DriverError(String(error.code ?? "failed"), String(error.message ?? ""), call.method))
    } else call.resolve(message.result)
  })
  const call = (method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextID
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new DriverError("timeout", `driver did not answer ${method} within ${timeoutMs} ms`, method))
      }, timeoutMs)
      const settle = <T>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(timer)
        fn(v)
      }
      pending.set(id, { resolve: settle(resolve), reject: settle(reject), method })
      io.output.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`)
    })
  let closing: Promise<unknown> | undefined
  return {
    describe: () => call("describe"),
    start: (params) => call("start", params),
    createSession: (params) => call("createSession", params),
    prompt: (params) => call("prompt", params),
    local: (params) => call("local", params),
    stop: () => call("stop"),
    call,
    events,
    noise,
    async nextEvent(predicate = () => true, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = events.find(predicate)
        if (found) return found
        const left = deadline - Date.now()
        if (left <= 0) throw new Error("timed out waiting for driver event")
        await new Promise<void>((resolve) => {
          waiters.add(resolve)
          setTimeout(resolve, left)
        })
      }
    },
    close(timeoutMs = 2000) {
      closing ??= (async () => {
        await call("shutdown", undefined, timeoutMs).catch(() => {})
        io.output.end()
        return onClose?.(timeoutMs)
      })()
      return closing
    },
  }
}

export interface SpawnedDriver extends DriverClient {
  /** Everything the driver wrote to stderr so far. */
  stderr(): string
  /** Resolves with the exit; after shutdown, a driver that has not exited within the timeout is killed. */
  close(timeoutMs?: number): Promise<{ code: number | null; signal: string | null }>
}

/** Spawns a driver executable and connects to it over its stdio. */
export function spawnDriver(command: readonly string[], options: { cwd?: string; env?: Record<string, string> } = {}): SpawnedDriver {
  const [file, ...args] = command
  if (!file) throw new Error("spawnDriver: empty command")
  const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? (process.env as Record<string, string>), stdio: ["pipe", "pipe", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
  child.stdin.on("error", () => {})
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })))
  const client = connectDriver({ input: child.stdout, output: child.stdin }, async (timeoutMs) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    const exit = await exited
    clearTimeout(timer)
    return exit
  })
  return Object.assign(client, { stderr: () => stderr }) as SpawnedDriver
}

// ---- helpers -----------------------------------------------------------------------------------------------------

function onLines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = ""
  stream.setEncoding?.("utf8")
  stream.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      onLine(line)
    }
  })
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}
