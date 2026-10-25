// The node's only way to drive NVIDIA OpenShell (decision lk6gn3u7 §1): the `openshell` CLI, never a shell. Each call
// is spawn(binary, argv) with the global flags first (--gateway when configured, --workspace hub, --color never),
// `-o json` where the CLI has it, a time limit (the whole process group is killed) and cancellation. The first call
// checks `openshell --version` (0.1.x only: the CLI and its JSON change between minor versions). Errors are
// OpenShellErrors with a code and a short reason taken from the CLI's stderr, with the call's env values, the
// configured secrets and URL credentials removed: fit for the hub and a launch's reason.
//
// Names and labels are checked here, before anything runs, so nothing the hub sends can become a flag.
// node:child_process (not Bun.spawn) so the node also runs bundled for node.
import { spawn } from "node:child_process"
import path from "node:path"

/** The OpenShell workspace the hub's sandboxes live in. */
export const OPENSHELL_WORKSPACE = "hub"
/** The CLI versions this client speaks (`openshell --version`). */
export const SUPPORTED_VERSIONS = "0.1.x"
export const DEFAULT_TIMEOUT_MS = 60_000
/** Creating waits for the sandbox to come up (~20 s cold on the vm driver). */
export const CREATE_TIMEOUT_MS = 300_000
/** `sandbox exec` reads at most this much stdin. */
export const MAX_EXEC_STDIN = 4 * 1024 * 1024
/** The process limit beyond an exec's or a policy wait's own --timeout. */
const GRACE_MS = 30_000
const MAX_OUTPUT = 16 * 1024 * 1024
const REASON_MAX = 300
/** Inherited settings that would change what a call does; the client's flags decide instead. */
const DROPPED_ENV = new Set(["OPENSHELL_SANDBOX_POLICY", "OPENSHELL_WORKSPACE", "OPENSHELL_GATEWAY", "OPENSHELL_GATEWAY_ENDPOINT", "OPENSHELL_GATEWAY_INSECURE", "OPENSHELL_COLOR"])

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const LABEL_KEY = /^([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/
const LABEL_VALUE = /^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

type Env = Readonly<Record<string, string | undefined>>

export type OpenShellErrorCode =
  | "not_installed"
  | "unsupported_version"
  | "invalid"
  | "not_found"
  | "already_exists"
  | "timeout"
  | "cancelled"
  | "bad_output"
  | "failed"

export class OpenShellError extends Error {
  override readonly name = "OpenShellError"
  constructor(
    message: string,
    readonly code: OpenShellErrorCode,
    readonly exitCode?: number,
  ) {
    super(message)
  }
}

export type SandboxPhase = "Provisioning" | "Ready" | "Error" | "Deleting" | "Stopping" | "Stopped" | "Starting" | "Completed" | "Unspecified" | "Unknown"

export interface SandboxCondition {
  readonly type: string
  readonly status: string
  readonly reason: string
  readonly message: string
}

/** A sandbox as `sandbox get/list/create -o json` reports it. */
export interface Sandbox {
  readonly id: string
  readonly name: string
  readonly workspace: string
  readonly phase: SandboxPhase
  readonly labels: Readonly<Record<string, string>>
  /** The main command's exit code once it ended, else null. */
  readonly exitCode: number | null
  readonly createdAt: string
  readonly conditions: readonly SandboxCondition[]
}

export interface GatewayStatus {
  readonly gateway: string
  readonly server: string
  readonly connected: boolean
  readonly authenticated: boolean
  readonly version: string
}

/** What `gateway info -o json` tells the node: the gateway's compute drivers (e.g. "vm"), its sandbox backends. */
export interface GatewayInfo {
  readonly computeDrivers: readonly string[]
}

export interface CreateSandboxOptions {
  readonly name: string
  /** A container image reference or rootfs tar (`--from`); or a template; or neither (the gateway's default image). */
  readonly from?: string
  readonly template?: string
  /** Policy YAML file (`--policy`). */
  readonly policyFile?: string
  /** Credential providers the node operator created (`--provider`). */
  readonly providers?: readonly string[]
  readonly labels?: Readonly<Record<string, string>>
  /** Non-secret environment (`--env`); secrets go through providers. */
  readonly env?: Readonly<Record<string, string>>
  /** The main command, started detached. */
  readonly command?: readonly string[]
}

export interface ExecOptions {
  readonly workdir?: string
  /** OpenShell's own limit (seconds); the process gets this plus a grace period. */
  readonly timeoutSec?: number
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string | Uint8Array
}

export interface ExecResult {
  /** The remote command's exit code (openshell exits with it; a CLI failure also shows here, usually as 1). */
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface PolicySetOptions {
  /** Wait for the sandbox to load the policy. */
  readonly wait?: boolean
  readonly timeoutSec?: number
}

/** Per-call cancellation. */
export interface CallOptions {
  readonly signal?: AbortSignal
}

/** What the openshell runtime needs from OpenShell; OpenShellCli implements it over the CLI. */
export interface OpenShellClient {
  version(options?: CallOptions): Promise<string>
  status(options?: CallOptions): Promise<GatewayStatus>
  /** Optional: clients without it report no backends. */
  gatewayInfo?(options?: CallOptions): Promise<GatewayInfo>
  create(sandbox: CreateSandboxOptions, options?: CallOptions): Promise<Sandbox>
  /** undefined when there is no such sandbox. */
  get(name: string, options?: CallOptions): Promise<Sandbox | undefined>
  list(selector?: Readonly<Record<string, string>>, options?: CallOptions): Promise<Sandbox[]>
  exec(name: string, command: readonly string[], exec?: ExecOptions & CallOptions): Promise<ExecResult>
  upload(name: string, localPath: string, sandboxPath?: string, options?: CallOptions): Promise<void>
  download(name: string, sandboxPath: string, localPath: string, options?: CallOptions): Promise<void>
  stop(name: string, options?: CallOptions): Promise<void>
  /** Asks for deletion (OpenShell deletes asynchronously: poll get until undefined); a missing sandbox is fine. */
  delete(name: string, options?: CallOptions): Promise<void>
  policySet(name: string, policyFile: string, policy?: PolicySetOptions & CallOptions): Promise<void>
}

export interface OpenShellCliOptions {
  /** The executable (default "openshell" on PATH). */
  readonly binary?: string
  /** A gateway name (`--gateway`); default: the CLI's active gateway. */
  readonly gateway?: string
  /** Default OPENSHELL_WORKSPACE ("hub"). */
  readonly workspace?: string
  /** Limit per call (default 60 s); create gets CREATE_TIMEOUT_MS unless createTimeoutMs is set. */
  readonly timeoutMs?: number
  readonly createTimeoutMs?: number
  /** `sandbox list --page-size` (default 100). */
  readonly pageSize?: number
  /** The environment to start from (default process.env); OpenShell overrides are dropped from it. */
  readonly env?: Env
  /** Strings never to show in an error (tokens the caller knows about). */
  readonly secrets?: readonly string[]
}

interface RunOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly stdin?: string | Uint8Array
  /** Extra strings to remove from errors (the call's env values). */
  readonly hide?: readonly string[]
  /** What the error names ("sandbox create"). */
  readonly what: string
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

// ---- checks ----

function invalid(message: string): OpenShellError {
  return new OpenShellError(message, "invalid")
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw invalid(`invalid sandbox name ${JSON.stringify(name)}: lowercase letters, digits and '-', at most 63`)
}

function checkLabels(labels: Readonly<Record<string, string>>): void {
  for (const [k, v] of Object.entries(labels)) {
    if (!LABEL_KEY.test(k)) throw invalid(`invalid label key ${JSON.stringify(k)}`)
    if (!LABEL_VALUE.test(v)) throw invalid(`invalid value for label ${k}: letters, digits, '.', '_' and '-', at most 63`)
  }
}

function checkResource(what: string, value: string): void {
  if (!RESOURCE.test(value)) throw invalid(`invalid ${what} ${JSON.stringify(value)}`)
}

/** A path argument that cannot be read as a flag. */
function checkPath(what: string, value: string): void {
  if (value === "" || value.startsWith("-") || value.includes("\0")) throw invalid(`invalid ${what} ${JSON.stringify(value)}`)
}

function envArgs(flag: string, env: Readonly<Record<string, string>> | undefined): string[] {
  const args: string[] = []
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_NAME.test(k)) throw invalid(`invalid environment variable name ${JSON.stringify(k)}`)
    if (v.includes("\0")) throw invalid(`invalid value for ${k}`)
    args.push(flag, `${k}=${v}`)
  }
  return args
}

// ---- output ----

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Removes the given strings, URL credentials and bearer tokens. */
export function redact(text: string, hide: readonly string[] = []): string {
  let out = text
  for (const s of [...hide].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRegExp(s), "g"), "***")
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@").replace(/(bearer\s+)[^\s"']+/gi, "$1***")
}

/** The gRPC message from a miette/tonic error, else the stderr's text, on one line. */
function reasonOf(stderr: string): string {
  const plain = stderr.replace(ANSI, "")
  const grpc = /message: "((?:[^"\\]|\\.)*)"/.exec(plain)
  const text = grpc ? grpc[1]! : plain
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(Error:)?\s*[×x]?\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
}

function cut(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text
}

function parseJSON<T>(what: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new OpenShellError(`openshell ${what}: output is not JSON`, "bad_output")
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")

function toSandbox(raw: unknown, what: string): Sandbox {
  if (!raw || typeof raw !== "object") throw new OpenShellError(`openshell ${what}: no sandbox in the output`, "bad_output")
  const o = raw as Record<string, unknown>
  if (typeof o.name !== "string" || typeof o.phase !== "string") throw new OpenShellError(`openshell ${what}: no sandbox in the output`, "bad_output")
  const labels: Record<string, string> = {}
  if (o.labels && typeof o.labels === "object") for (const [k, v] of Object.entries(o.labels)) if (typeof v === "string") labels[k] = v
  const conditions = Array.isArray(o.conditions)
    ? o.conditions.map((c: Record<string, unknown>) => ({ type: str(c?.type), status: str(c?.status), reason: str(c?.reason), message: str(c?.message) }))
    : []
  return {
    id: str(o.id),
    name: o.name,
    workspace: str(o.workspace),
    phase: o.phase as SandboxPhase,
    labels,
    exitCode: typeof o.exit_code === "number" ? o.exit_code : null,
    createdAt: str(o.created_at),
    conditions,
  }
}

// ---- the client ----

export class OpenShellCli implements OpenShellClient {
  readonly workspace: string
  private readonly binary: string
  private readonly timeoutMs: number
  private readonly createTimeoutMs: number
  private readonly pageSize: number
  private readonly env: Record<string, string>
  private readonly secrets: readonly string[]
  private readonly globals: readonly string[]
  private checked?: Promise<string>

  constructor(options: OpenShellCliOptions = {}) {
    this.binary = options.binary ?? "openshell"
    this.workspace = options.workspace ?? OPENSHELL_WORKSPACE
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.createTimeoutMs = options.createTimeoutMs ?? Math.max(CREATE_TIMEOUT_MS, this.timeoutMs)
    this.pageSize = options.pageSize ?? 100
    this.secrets = options.secrets ?? []
    if (options.gateway !== undefined) checkResource("gateway name", options.gateway)
    checkResource("workspace", this.workspace)
    this.globals = [...(options.gateway !== undefined ? ["--gateway", options.gateway] : []), "--workspace", this.workspace, "--color", "never"]
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(options.env ?? process.env)) if (v !== undefined && !DROPPED_ENV.has(k)) env[k] = v
    env.NO_COLOR = "1"
    this.env = env
  }

  /** The CLI's version; rejects with unsupported_version outside 0.1.x. Checked once (a failure is retried). */
  version(options: CallOptions = {}): Promise<string> {
    this.checked ??= this.checkVersion(options).catch((error: unknown) => {
      this.checked = undefined
      throw error
    })
    return this.checked
  }

  async status(options: CallOptions = {}): Promise<GatewayStatus> {
    const { stdout } = await this.call(["status", "-o", "json"], { what: "status", ...options })
    const o = parseJSON<Record<string, unknown>>("status", stdout)
    const auth = (o.authentication ?? {}) as Record<string, unknown>
    return { gateway: str(o.gateway), server: str(o.server), connected: o.status === "connected", authenticated: auth.status === "authenticated", version: str(o.version) }
  }

  async gatewayInfo(options: CallOptions = {}): Promise<GatewayInfo> {
    const { stdout } = await this.call(["gateway", "info", "-o", "json"], { what: "gateway info", ...options })
    const o = parseJSON<{ compute_drivers?: unknown }>("gateway info", stdout)
    if (!Array.isArray(o.compute_drivers)) throw new OpenShellError("openshell gateway info: no compute drivers in the output", "bad_output")
    const computeDrivers = o.compute_drivers.map((d) => str((d as { name?: unknown } | null)?.name)).filter(Boolean)
    return { computeDrivers }
  }

  async create(sandbox: CreateSandboxOptions, options: CallOptions = {}): Promise<Sandbox> {
    checkName(sandbox.name)
    const args = ["sandbox", "create", "--name", sandbox.name]
    if (sandbox.from !== undefined && sandbox.template !== undefined) throw invalid("give an image (from) or a template, not both")
    if (sandbox.from !== undefined) {
      checkPath("image", sandbox.from)
      args.push("--from", sandbox.from)
    }
    if (sandbox.template !== undefined) {
      checkResource("template", sandbox.template)
      args.push("--template", sandbox.template)
    }
    if (sandbox.policyFile !== undefined) {
      checkPath("policy file", sandbox.policyFile)
      args.push("--policy", sandbox.policyFile)
    }
    for (const p of sandbox.providers ?? []) {
      checkResource("provider", p)
      args.push("--provider", p)
    }
    checkLabels(sandbox.labels ?? {})
    for (const [k, v] of Object.entries(sandbox.labels ?? {})) args.push("--label", `${k}=${v}`)
    args.push(...envArgs("--env", sandbox.env), "--no-auto-providers", "--no-tty", "--detach", "-o", "json")
    if (sandbox.command?.length) args.push("--", ...sandbox.command)
    const { stdout } = await this.call(args, { what: "sandbox create", timeoutMs: this.createTimeoutMs, hide: Object.values(sandbox.env ?? {}), ...options })
    return toSandbox(parseJSON("sandbox create", stdout), "sandbox create")
  }

  async get(name: string, options: CallOptions = {}): Promise<Sandbox | undefined> {
    checkName(name)
    try {
      const { stdout } = await this.call(["sandbox", "get", name, "-o", "json"], { what: "sandbox get", ...options })
      return toSandbox(parseJSON("sandbox get", stdout), "sandbox get")
    } catch (error) {
      if (error instanceof OpenShellError && error.code === "not_found") return undefined
      throw error
    }
  }

  async list(selector: Readonly<Record<string, string>> = {}, options: CallOptions = {}): Promise<Sandbox[]> {
    checkLabels(selector)
    const select = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",")
    const sandboxes: Sandbox[] = []
    let token = ""
    for (let page = 0; page < 10_000; page++) {
      const args = ["sandbox", "list", "--page-size", String(this.pageSize)]
      if (token) args.push("--page-token", token)
      if (select) args.push("--selector", select)
      args.push("-o", "json")
      const { stdout } = await this.call(args, { what: "sandbox list", ...options })
      const o = parseJSON<{ sandboxes?: unknown; next_page_token?: unknown }>("sandbox list", stdout)
      if (!Array.isArray(o.sandboxes)) throw new OpenShellError("openshell sandbox list: no sandboxes in the output", "bad_output")
      for (const s of o.sandboxes) sandboxes.push(toSandbox(s, "sandbox list"))
      token = str(o.next_page_token)
      if (!token) return sandboxes
    }
    throw new OpenShellError("openshell sandbox list: too many pages", "bad_output")
  }

  async exec(name: string, command: readonly string[], exec: ExecOptions & CallOptions = {}): Promise<ExecResult> {
    checkName(name)
    if (command.length === 0) throw invalid("exec needs a command")
    const stdinSize = typeof exec.stdin === "string" ? Buffer.byteLength(exec.stdin) : (exec.stdin?.byteLength ?? 0)
    if (stdinSize > MAX_EXEC_STDIN) throw invalid(`exec stdin is over ${MAX_EXEC_STDIN} bytes`)
    const args = ["sandbox", "exec", "--name", name, "--no-tty", "--no-login-shell"]
    if (exec.workdir !== undefined) {
      checkPath("workdir", exec.workdir)
      args.push("--workdir", exec.workdir)
    }
    const timeoutSec = exec.timeoutSec
    if (timeoutSec !== undefined) {
      if (!Number.isInteger(timeoutSec) || timeoutSec < 0) throw invalid("exec timeoutSec must be a whole number of seconds")
      args.push("--timeout", String(timeoutSec))
    }
    args.push(...envArgs("--env", exec.env), "--", ...command)
    const run: RunOptions = {
      what: "sandbox exec",
      timeoutMs: timeoutSec ? timeoutSec * 1000 + GRACE_MS : this.timeoutMs,
      hide: Object.values(exec.env ?? {}),
      ...(exec.signal ? { signal: exec.signal } : {}),
      ...(exec.stdin !== undefined ? { stdin: exec.stdin } : {}),
    }
    await this.version(exec)
    return this.run(args, run)
  }

  async upload(name: string, localPath: string, sandboxPath?: string, options: CallOptions = {}): Promise<void> {
    checkName(name)
    const local = path.resolve(localPath)
    const args = ["sandbox", "upload", "--no-git-ignore", name, local]
    if (sandboxPath !== undefined) {
      checkPath("sandbox path", sandboxPath)
      args.push(sandboxPath)
    }
    await this.call(args, { what: "sandbox upload", ...options })
  }

  async download(name: string, sandboxPath: string, localPath: string, options: CallOptions = {}): Promise<void> {
    checkName(name)
    checkPath("sandbox path", sandboxPath)
    await this.call(["sandbox", "download", name, sandboxPath, path.resolve(localPath)], { what: "sandbox download", ...options })
  }

  async stop(name: string, options: CallOptions = {}): Promise<void> {
    checkName(name)
    await this.call(["sandbox", "stop", name], { what: "sandbox stop", ...options })
  }

  async delete(name: string, options: CallOptions = {}): Promise<void> {
    checkName(name)
    await this.call(["sandbox", "delete", name], { what: "sandbox delete", ...options })
  }

  async policySet(name: string, policyFile: string, policy: PolicySetOptions & CallOptions = {}): Promise<void> {
    checkName(name)
    checkPath("policy file", policyFile)
    const args = ["policy", "set", "--policy", policyFile]
    let timeoutMs = this.timeoutMs
    if (policy.wait) {
      args.push("--wait")
      if (policy.timeoutSec !== undefined) {
        if (!Number.isInteger(policy.timeoutSec) || policy.timeoutSec <= 0) throw invalid("policy timeoutSec must be a positive whole number")
        args.push("--timeout", String(policy.timeoutSec))
      }
      timeoutMs = Math.max(timeoutMs, (policy.timeoutSec ?? 60) * 1000 + GRACE_MS)
    }
    args.push(name)
    await this.call(args, { what: "policy set", timeoutMs, ...(policy.signal ? { signal: policy.signal } : {}) })
  }

  // ---- running ----

  private async checkVersion(options: CallOptions): Promise<string> {
    const { stdout } = await this.call(["--version"], { what: "--version", ...options }, false)
    const match = /(\d+)\.(\d+)\.(\d+)\S*/.exec(stdout)
    if (!match) throw new OpenShellError("openshell --version: no version in the output", "bad_output")
    if (match[1] !== "0" || match[2] !== "1") throw new OpenShellError(`openshell ${match[0]} is not supported (needs ${SUPPORTED_VERSIONS})`, "unsupported_version")
    return match[0]
  }

  /** Checks the version, runs, and turns a non-zero exit into an OpenShellError. */
  private async call(args: readonly string[], options: RunOptions, gate = true): Promise<RunResult> {
    if (gate) await this.version(options.signal ? { signal: options.signal } : {})
    const result = await this.run(args, options)
    if (result.exitCode !== 0) {
      const reason = reasonOf(result.stderr)
      const code: OpenShellErrorCode = /\bNotFound\b|\bnot found\b/i.test(reason + result.stderr) ? "not_found" : /\bAlreadyExists\b|already exists/i.test(reason + result.stderr) ? "already_exists" : "failed"
      const message = cut(redact(reason, [...this.secrets, ...(options.hide ?? [])])) || "no error output"
      throw new OpenShellError(`openshell ${options.what} failed (exit ${result.exitCode}): ${message}`, code, result.exitCode)
    }
    return result
  }

  private run(args: readonly string[], options: RunOptions): Promise<RunResult> {
    const what = `openshell ${options.what}`
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new OpenShellError(`${what} cancelled`, "cancelled"))
      let settled = false
      const finish = (error: OpenShellError | undefined, result?: RunResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        if (error) reject(error)
        else resolve(result!)
      }
      // Its own process group, so a timeout or cancel also kills what openshell started.
      const child = spawn(this.binary, [...this.globals, ...args], { env: this.env, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true })
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      }
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_OUTPUT) {
          kill()
          return finish(new OpenShellError(`${what}: output over ${MAX_OUTPUT} bytes`, "bad_output"))
        }
        into.push(chunk)
      }
      child.stdout.on("data", collect(out))
      child.stderr.on("data", collect(err))
      child.stdin.on("error", () => {}) // the CLI may exit before reading stdin
      child.stdin.end(options.stdin === undefined ? undefined : Buffer.from(options.stdin))
      const timeoutMs = options.timeoutMs ?? this.timeoutMs
      const timer = setTimeout(() => {
        kill()
        finish(new OpenShellError(`${what} timed out after ${Math.round(timeoutMs / 1000)} s`, "timeout"))
      }, timeoutMs)
      const onAbort = () => {
        kill()
        finish(new OpenShellError(`${what} cancelled`, "cancelled"))
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") finish(new OpenShellError(`openshell is not installed (${this.binary} not found)`, "not_installed"))
        else finish(new OpenShellError(`${what} could not start: ${error.code ?? "error"}`, "failed"))
      })
      child.on("close", (code, signal) => {
        finish(undefined, { exitCode: code ?? (signal ? 128 : 1), stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") })
      })
    })
  }
}
