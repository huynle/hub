// A fake `openshell` CLI for tests (no gateway, no VMs). createFakeOpenShell() makes a temp directory with the fake's
// state (state.json), a log of every call (calls.jsonl: argv, the command, the global flags, the OPENSHELL_* env) and
// an executable `openshell` wrapper that runs this file. It speaks the subset of OpenShell 0.1.2 the hub uses, with
// the same JSON shapes (`sandbox get/create -o json`, `sandbox list -o json` pages, `status -o json`) and the same
// failure style (miette "Error: × status: NotFound, message: …" on stderr, exit 1).
//
// A sandbox's filesystem is a directory (sandboxRoot(name)); its working directory is /sandbox. `sandbox exec` runs
// the command LOCALLY in the mapped working directory (env SANDBOX_ROOT points at the root) and exits with its code.
// Failures are injectable per command (and optionally per sandbox name), with an exit code, stderr, stdout and a
// delay (to test time limits).
import { spawn } from "node:child_process"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export type FakePhase = "Provisioning" | "Ready" | "Error" | "Deleting" | "Stopping" | "Stopped" | "Starting" | "Completed"

export interface FakeSandbox {
  id: string
  name: string
  workspace: string
  labels: Record<string, string>
  phase: FakePhase
  /** `sandbox get` calls left before a Provisioning sandbox turns Ready (or a Deleting one disappears). */
  pendingGets: number
  createdAt: string
  from?: string
  template?: string
  policy?: string
  providers: string[]
  env: Record<string, string>
  command: string[]
  exitCode: number | null
}

export interface FakeFailure {
  /** The command words, e.g. "sandbox create", "sandbox exec", "policy set", "status", "--version". */
  command: string
  /** Only for this sandbox name. */
  name?: string
  exitCode?: number
  stderr?: string
  stdout?: string
  /** Sleep before answering (time limit tests). */
  delayMs?: number
  /** How many calls fail (default 1; 0 = every call). */
  times?: number
}

export interface FakeState {
  version: string
  /** `sandbox get` calls a new sandbox stays Provisioning for (default 0: Ready at once). */
  readyAfterGets: number
  /** `sandbox get` calls a deleted sandbox stays Deleting for (default 0: gone at once). */
  deleteAfterGets: number
  sandboxes: Record<string, FakeSandbox>
  failures: FakeFailure[]
  nextID: number
  /** What `gateway info` lists as compute drivers (default ["vm"]). */
  computeDrivers?: string[]
}

export interface FakeCall {
  argv: string[]
  /** The command words ("sandbox exec"). */
  command: string
  gateway?: string
  workspace: string
  /** OPENSHELL_* variables the fake saw. */
  env: Record<string, string>
  /** Bytes read on stdin (exec only). */
  stdinBytes?: number
}

export interface FakeOpenShellOptions {
  version?: string
  readyAfterGets?: number
  deleteAfterGets?: number
  failures?: FakeFailure[]
}

export interface FakeOpenShell {
  /** The executable to give the client (`binary`). */
  readonly binary: string
  readonly dir: string
  calls(): FakeCall[]
  state(): FakeState
  update(change: (state: FakeState) => void): void
  fail(failure: FakeFailure): void
  sandbox(name: string, workspace?: string): FakeSandbox | undefined
  /** The directory standing for the sandbox's "/" (its working directory is <root>/sandbox). */
  sandboxRoot(name: string, workspace?: string): string
  cleanup(): void
}

const STATE = "state.json"
const CALLS = "calls.jsonl"
const key = (workspace: string, name: string) => `${workspace}/${name}`

function readState(dir: string): FakeState {
  return JSON.parse(readFileSync(path.join(dir, STATE), "utf8"))
}

function writeState(dir: string, state: FakeState): void {
  writeFileSync(path.join(dir, STATE), JSON.stringify(state, null, 2))
}

function rootOf(dir: string, workspace: string, name: string): string {
  return path.join(dir, "sandboxes", workspace, name)
}

export function createFakeOpenShell(options: FakeOpenShellOptions = {}): FakeOpenShell {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-fake-openshell-"))
  const state: FakeState = {
    version: options.version ?? "0.1.2",
    readyAfterGets: options.readyAfterGets ?? 0,
    deleteAfterGets: options.deleteAfterGets ?? 0,
    sandboxes: {},
    failures: options.failures ?? [],
    nextID: 1,
  }
  writeState(dir, state)
  writeFileSync(path.join(dir, CALLS), "")
  const binary = path.join(dir, "openshell")
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  writeFileSync(binary, `#!/bin/sh\nFAKE_OPENSHELL_DIR=${quote(dir)} exec ${quote(process.execPath)} ${quote(import.meta.path)} "$@"\n`)
  chmodSync(binary, 0o755)
  return {
    binary,
    dir,
    calls: () =>
      readFileSync(path.join(dir, CALLS), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCall),
    state: () => readState(dir),
    update(change) {
      const s = readState(dir)
      change(s)
      writeState(dir, s)
    },
    fail(failure) {
      this.update((s) => s.failures.push(failure))
    },
    sandbox: (name, workspace = "hub") => readState(dir).sandboxes[key(workspace, name)],
    sandboxRoot: (name, workspace = "hub") => rootOf(dir, workspace, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// ---- the fake CLI itself (runs when this file is executed through the wrapper) ----

class Exit extends Error {
  constructor(
    readonly code: number,
    readonly stderr = "",
  ) {
    super(stderr)
  }
}

function grpcError(code: string, message: string): Exit {
  return new Exit(1, `Error:   × status: ${code}, message: "${message}", details: [], metadata: MetadataMap { headers: {} }\n`)
}

interface Parsed {
  words: string[]
  flags: Map<string, string[]>
  bools: Set<string>
  positionals: string[]
  rest: string[]
}

const VALUE_FLAGS = new Set([
  "-g", "--gateway", "--gateway-endpoint", "--workspace", "--color", "-o", "--output", "--name", "-n", "--from", "--template",
  "--policy", "--provider", "--label", "--env", "--workdir", "--timeout", "--selector", "--page-size", "--page-token", "--cpu",
  "--memory", "--approval-mode",
])

function parse(argv: string[]): Parsed {
  const parsed: Parsed = { words: [], flags: new Map(), bools: new Set(), positionals: [], rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      parsed.rest = argv.slice(i + 1)
      break
    }
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=")
      const name = eq > 0 && arg.startsWith("--") ? arg.slice(0, eq) : arg
      if (VALUE_FLAGS.has(name)) {
        const value = eq > 0 && arg.startsWith("--") ? arg.slice(eq + 1) : argv[++i]
        if (value === undefined) throw new Exit(2, `error: a value is required for '${name}'\n`)
        parsed.flags.set(name, [...(parsed.flags.get(name) ?? []), value])
      } else parsed.bools.add(name)
      continue
    }
    const commandDone = parsed.words[0] === "status" || parsed.words.length === 2
    if (!commandDone) parsed.words.push(arg)
    else parsed.positionals.push(arg)
  }
  return parsed
}

const one = (p: Parsed, ...names: string[]) => {
  for (const n of names) {
    const v = p.flags.get(n)
    if (v?.length) return v[v.length - 1]
  }
  return undefined
}
const many = (p: Parsed, name: string) => p.flags.get(name) ?? []

function sandboxJSON(s: FakeSandbox): unknown {
  return {
    id: s.id,
    name: s.name,
    workspace: s.workspace,
    labels: s.labels,
    annotations: {},
    resource_version: 1,
    created_at: s.createdAt,
    phase: s.phase,
    current_policy_version: s.policy ? 1 : 0,
    exit_code: s.exitCode,
    conditions: [],
    endpoint_statuses: [],
    configuration_admission: null,
    provisioning: null,
    created_from_workload_template: null,
  }
}

function pairs(values: string[], what: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const v of values) {
    const eq = v.indexOf("=")
    if (eq <= 0) throw new Exit(2, `error: invalid ${what} '${v}': expected KEY=VALUE\n`)
    out[v.slice(0, eq)] = v.slice(eq + 1)
  }
  return out
}

/** A sandbox path (absolute, or relative to /sandbox) inside the sandbox's root directory. */
function mapPath(root: string, sandboxPath: string): string {
  const abs = path.posix.resolve("/sandbox", sandboxPath)
  return path.join(root, abs)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function main(dir: string, argv: string[]): Promise<number> {
  const p = parse(argv)
  const command = p.bools.has("--version") || p.bools.has("-V") ? "--version" : p.words.join(" ")
  const workspace = one(p, "--workspace") ?? process.env.OPENSHELL_WORKSPACE ?? "default"
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("OPENSHELL_") && v !== undefined) env[k] = v
  const call: FakeCall = { argv, command, workspace, env }
  const gateway = one(p, "-g", "--gateway")
  if (gateway !== undefined) call.gateway = gateway
  let stdin: Buffer | undefined
  if (command === "sandbox exec") {
    stdin = await readStdin()
    call.stdinBytes = stdin.length
  }
  appendFileSync(path.join(dir, CALLS), JSON.stringify(call) + "\n")

  const state = readState(dir)
  const name = one(p, "--name", "-n") ?? p.positionals[0]
  const failure = state.failures.find((f) => f.command === command && (f.name === undefined || f.name === name))
  if (failure) {
    if (failure.times !== 0) {
      const left = (failure.times ?? 1) - 1
      if (left <= 0) state.failures.splice(state.failures.indexOf(failure), 1)
      else failure.times = left
      writeState(dir, state)
    }
    if (failure.delayMs) await sleep(failure.delayMs)
    if (failure.stdout) process.stdout.write(failure.stdout)
    throw new Exit(failure.exitCode ?? 1, failure.stderr ?? `Error:   × injected failure for ${command}\n`)
  }

  const json = one(p, "-o", "--output") === "json"
  const find = (n: string | undefined) => {
    if (!n) throw new Exit(2, "error: a sandbox name is required\n")
    const s = state.sandboxes[key(workspace, n)]
    if (!s) throw grpcError("NotFound", "sandbox not found")
    return s
  }
  const save = () => writeState(dir, state)
  const out = (text: string) => process.stdout.write(text)

  switch (command) {
    case "--version":
      out(`openshell ${state.version}\n`)
      return 0
    case "status": {
      const status = { authentication: { provider: "mTLS transport", status: "authenticated" }, gateway: gateway ?? "openshell", server: "https://localhost:17670", status: "connected", version: state.version }
      out(json ? JSON.stringify(status, null, 2) + "\n" : `Server Status\n\n  Gateway: ${status.gateway}\n  Status: Connected\n`)
      return 0
    }
    case "gateway info": {
      const drivers = state.computeDrivers ?? ["vm"]
      const info = { auth: null, compute_drivers: drivers.map((name) => ({ capabilities: { driver_name: `openshell-driver-${name}`, driver_version: state.version }, name })), extensions: [] }
      out(json ? JSON.stringify(info, null, 2) + "\n" : `Gateway Info\n\n  Compute drivers:\n${drivers.map((d) => `    ${d}\n`).join("")}`)
      return 0
    }
    case "sandbox create": {
      const n = one(p, "--name")
      if (!n) throw new Exit(2, "error: the fake needs --name\n")
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(n)) throw grpcError("InvalidArgument", "invalid sandbox name")
      if (state.sandboxes[key(workspace, n)]) throw grpcError("AlreadyExists", "sandbox already exists")
      const policyFile = one(p, "--policy")
      const s: FakeSandbox = {
        id: `sb-${state.nextID++}`,
        name: n,
        workspace,
        labels: pairs(many(p, "--label"), "label"),
        phase: state.readyAfterGets > 0 ? "Provisioning" : "Ready",
        pendingGets: state.readyAfterGets,
        createdAt: new Date().toISOString(),
        providers: many(p, "--provider"),
        env: pairs(many(p, "--env"), "env"),
        command: p.rest,
        exitCode: null,
      }
      const from = one(p, "--from")
      if (from) s.from = from
      const template = one(p, "--template")
      if (template) s.template = template
      if (policyFile) {
        if (!existsSync(policyFile)) throw new Exit(1, `Error:   × failed to read policy file ${policyFile}\n`)
        s.policy = readFileSync(policyFile, "utf8")
      }
      state.sandboxes[key(workspace, n)] = s
      mkdirSync(path.join(rootOf(dir, workspace, n), "sandbox"), { recursive: true })
      save()
      out(json ? JSON.stringify({ ...(sandboxJSON(s) as object), service_urls: {} }, null, 2) + "\n" : `✓ Created sandbox ${n}\n`)
      return 0
    }
    case "sandbox get": {
      const s = find(p.positionals[0])
      if (s.pendingGets > 0) s.pendingGets--
      else if (s.phase === "Provisioning") s.phase = "Ready"
      else if (s.phase === "Deleting") {
        delete state.sandboxes[key(workspace, s.name)]
        save()
        throw grpcError("NotFound", "sandbox not found")
      }
      save()
      out(json ? JSON.stringify(sandboxJSON(s), null, 2) + "\n" : `Sandbox: ${s.name}\n  Phase: ${s.phase}\n`)
      return 0
    }
    case "sandbox list": {
      const selector = one(p, "--selector")
      const wanted = selector ? pairs(selector.split(","), "selector") : {}
      const all = Object.values(state.sandboxes)
        .filter((s) => s.workspace === workspace)
        .filter((s) => Object.entries(wanted).every(([k, v]) => s.labels[k] === v))
      const size = Number(one(p, "--page-size") ?? 100)
      const start = Number(one(p, "--page-token") || 0)
      const page = all.slice(start, start + size)
      const next = start + size < all.length ? String(start + size) : ""
      out(json ? JSON.stringify({ sandboxes: page.map(sandboxJSON), next_page_token: next }, null, 2) + "\n" : page.map((s) => s.name).join("\n") + "\n")
      return 0
    }
    case "sandbox stop": {
      const s = find(p.positionals[0])
      s.phase = "Stopped"
      save()
      out(`✓ Stopped sandbox ${s.name}\n`)
      return 0
    }
    case "sandbox delete": {
      for (const n of p.positionals) {
        const s = state.sandboxes[key(workspace, n)]
        if (!s) {
          out(`✓ Sandbox ${n} already deleted\n`)
          continue
        }
        rmSync(rootOf(dir, workspace, n), { recursive: true, force: true })
        if (state.deleteAfterGets > 0) {
          s.phase = "Deleting"
          s.pendingGets = state.deleteAfterGets
          out(`✓ Sandbox ${n} deletion accepted; cleanup is pending\n`)
        } else {
          delete state.sandboxes[key(workspace, n)]
          out(`✓ Deleted sandbox ${n}\n`)
        }
      }
      save()
      return 0
    }
    case "sandbox upload": {
      const [n, local, dest] = p.positionals
      const s = find(n)
      if (!local || !existsSync(local)) throw new Exit(1, `Error:   × local path does not exist: ${local}\n`)
      const root = rootOf(dir, workspace, s.name)
      let target = mapPath(root, dest ?? ".")
      if (statSync(local).isFile() && (dest === undefined || dest.endsWith("/") || (existsSync(target) && statSync(target).isDirectory()))) target = path.join(target, path.basename(local))
      mkdirSync(path.dirname(target), { recursive: true })
      cpSync(local, target, { recursive: true })
      out(`✓ Uploaded ${local}\n`)
      return 0
    }
    case "sandbox download": {
      const [n, sandboxPath, dest] = p.positionals
      const s = find(n)
      if (!sandboxPath) throw new Exit(2, "error: SANDBOX_PATH is required\n")
      const abs = path.posix.resolve("/sandbox", sandboxPath)
      if (abs !== "/sandbox" && !abs.startsWith("/sandbox/")) throw new Exit(1, `Error:   × download path must be inside the sandbox working directory\n`)
      const source = mapPath(rootOf(dir, workspace, s.name), sandboxPath)
      if (!existsSync(source)) throw new Exit(1, `Error:   × sandbox path not found: ${sandboxPath}\n`)
      let target = dest ?? "."
      if (statSync(source).isFile() && existsSync(target) && statSync(target).isDirectory()) target = path.join(target, path.basename(source))
      cpSync(source, target, { recursive: true })
      out(`✓ Downloaded ${sandboxPath}\n`)
      return 0
    }
    case "sandbox exec": {
      const s = find(one(p, "--name", "-n"))
      if (s.phase !== "Ready") throw grpcError("FailedPrecondition", "sandbox is not ready")
      if (p.rest.length === 0) throw new Exit(2, "error: COMMAND is required\n")
      const root = rootOf(dir, workspace, s.name)
      const cwd = mapPath(root, one(p, "--workdir") ?? "/sandbox")
      mkdirSync(cwd, { recursive: true })
      const timeout = Number(one(p, "--timeout") ?? 0)
      const child = spawn(p.rest[0]!, p.rest.slice(1), {
        cwd,
        env: { ...process.env, ...s.env, ...pairs(many(p, "--env"), "env"), SANDBOX_ROOT: root },
        stdio: ["pipe", "inherit", "inherit"],
      })
      child.stdin.end(stdin)
      return await new Promise<number>((resolve) => {
        const timer = timeout > 0 ? setTimeout(() => child.kill("SIGKILL"), timeout * 1000) : undefined
        child.on("error", () => {
          process.stderr.write(`exec: ${p.rest[0]}: not found\n`)
          resolve(127)
        })
        child.on("close", (code, signal) => {
          clearTimeout(timer)
          resolve(signal ? 124 : (code ?? 1))
        })
      })
    }
    case "policy set": {
      const s = find(p.positionals[0])
      const file = one(p, "--policy")
      if (!file || !existsSync(file)) throw new Exit(1, `Error:   × failed to read policy file ${file}\n`)
      s.policy = readFileSync(file, "utf8")
      save()
      out(`✓ Policy version 2 submitted\n${p.bools.has("--wait") ? "✓ Policy version 2 loaded\n" : ""}`)
      return 0
    }
    default:
      throw new Exit(2, `error: unrecognized subcommand '${command}'\n`)
  }
}

if (import.meta.main) {
  const dir = process.env.FAKE_OPENSHELL_DIR
  if (!dir) {
    process.stderr.write("fake-openshell: FAKE_OPENSHELL_DIR is not set\n")
    process.exit(2)
  }
  main(dir, process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof Exit) {
        process.stderr.write(error.stderr)
        process.exit(error.code)
      }
      process.stderr.write(`fake-openshell: ${error instanceof Error ? error.stack : String(error)}\n`)
      process.exit(70)
    },
  )
}
