// The typed service-manager client for hub's own user services (the ServiceControl the transaction executors take,
// transaction/builtin.ts), and the activate-service executor.
//
// It names a service and a manager, never a command. Underneath, it makes only fixed calls:
//   systemd --user  systemctl --user daemon-reload | enable | disable | start | restart | stop <hub unit>
//                   systemctl --user is-active --quiet | is-enabled --quiet <hub unit>
//                   systemctl --user show --property=ActiveState,SubState,NRestarts <hub unit>
//   launchd         launchctl bootstrap gui/<uid> <the hub agent's plist> | bootout gui/<uid>/<hub label>
//                   launchctl print gui/<uid>/<hub label>
// Every call is checked against that set (checkManagerCall) before it reaches the injected runner, so a bug cannot
// turn it into anything else; the real runner (spawnManagerRunner) checks again, spawns the absolute program
// without a shell and with an empty environment (only the user bus address is passed), and reports an exit code;
// only the two state queries (show, print) also return their (bounded) output, which is parsed for a few state
// fields here and never passed on. Failures name the unit, its state and the exit, never output. Nothing elevated:
// only the user's own manager.
//
// Loading is not enough: a unit with Restart=on-failure (or KeepAlive) that crashes at once is "loaded" while it
// crash-loops. So activation then watches the service's state (HEALTH_WINDOW): it must be running, without a
// restart, for stableMs within timeoutMs. Failed, crash-looping (auto-restart, a respawn after an exit), stopped or
// never settling is service_failed, with a hint at where its log is (journalctl --user -u <unit>, or the agent's
// StandardErrorPath).
//
// Activation rolls back to the state the service had before: a service that was not loaded is unloaded (and
// disabled) again; one that was already loaded stays loaded (the engine then restores its previous unit file).
// After a crash the prior state is unknown, so recovery unloads it: no persistence remains without consent.
import { spawn as nodeSpawn } from "node:child_process"
import path from "node:path"
import { EMBEDDED_ASSETS, isAbsolutePath, isRecord, resolvePathRef, SERVICE_IDS, type ExecutionContext, type RootMapping, type ServiceID, type ServiceManagerID } from "../../contracts/index.ts"
import type { ServiceControl } from "../../transaction/builtin.ts"
import type { ActionExecutor } from "../../transaction/executor.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"
import { assetIDFor, serviceName, UNIT_ROOT } from "./render.ts"

export type ManagerProgram = "systemctl" | "launchctl"

/** One call to the user's service manager: the program and its words (never a shell string). */
export interface ManagerCall {
  readonly program: ManagerProgram
  readonly words: readonly string[]
}

/** Runs one checked call; its exit code comes back, and for the state queries (show, print) its output. */
export type ManagerRunner = (call: ManagerCall) => Promise<{ readonly exitCode: number; readonly output?: string }>

/** How long activation watches a loaded service: running without a restart for stableMs, within timeoutMs. */
export const HEALTH_WINDOW = Object.freeze({ timeoutMs: 10_000, stableMs: 3_000, pollMs: 500 })

/** What a state query says about a service. `detail` is the manager's own state words (never other output). */
export interface ServiceHealth {
  readonly state: "running" | "starting" | "crash-looping" | "failed" | "stopped"
  /** Restarts the manager counted (systemd NRestarts; launchd runs - 1). */
  readonly restarts: number
  readonly detail: string
}

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

export interface ServiceRunState {
  /** systemd: active; launchd: loaded in the user's GUI domain. */
  readonly loaded: boolean
  /** systemd only: enabled (started at login). */
  readonly enabled?: boolean
}

export interface NodeServiceControl extends ServiceControl {
  state(service: ServiceID, manager: ServiceManagerID): Promise<TxResult<ServiceRunState>>
  /** Puts a service back into `prior` (the undo of an activation). */
  restore(service: ServiceID, manager: ServiceManagerID, prior: ServiceRunState): Promise<TxResult<void>>
  /** One state query: running, starting, crash-looping, failed or stopped. */
  health(service: ServiceID, manager: ServiceManagerID): Promise<TxResult<ServiceHealth>>
}

const UNITS = new Set(SERVICE_IDS.map((s) => serviceName(s, "systemd-user")))
const LABELS = new Set(SERVICE_IDS.map((s) => serviceName(s, "launchd")))
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const DOMAIN = /^gui\/\d{1,10}$/
const SYSTEMD_UNIT_VERBS = new Set(["enable", "disable", "start", "restart", "stop"])
const SYSTEMD_QUERIES = new Set(["is-active", "is-enabled"])
const SHOW_PROPERTIES = "--property=ActiveState,SubState,NRestarts"

const labelOfTarget = (word: string | undefined) => {
  const at = word?.lastIndexOf("/") ?? -1
  return at > 0 && DOMAIN.test(word!.slice(0, at)) ? word!.slice(at + 1) : undefined
}

/** Whether `call` is one of the fixed calls this client makes. */
export function checkManagerCall(call: unknown): call is ManagerCall {
  if (!isRecord(call) || !Array.isArray(call.words) || call.words.length > 4) return false
  const w = call.words as unknown[]
  if (!w.every((x) => typeof x === "string" && x.length > 0 && x.length <= 4096 && !CONTROL.test(x))) return false
  const words = w as string[]
  if (call.program === "systemctl") {
    if (words[0] !== "--user") return false
    const verb = words[1]!
    if (verb === "daemon-reload") return words.length === 2
    if (SYSTEMD_UNIT_VERBS.has(verb)) return words.length === 3 && UNITS.has(words[2]!)
    if (SYSTEMD_QUERIES.has(verb)) return words.length === 4 && words[2] === "--quiet" && UNITS.has(words[3]!)
    if (verb === "show") return words.length === 4 && words[2] === SHOW_PROPERTIES && UNITS.has(words[3]!)
    return false
  }
  if (call.program === "launchctl") {
    const [verb, target, file] = words
    if (verb === "print" || verb === "bootout") return words.length === 2 && LABELS.has(labelOfTarget(target) ?? "")
    if (verb === "bootstrap")
      return words.length === 3 && DOMAIN.test(target!) && isAbsolutePath(file) && LABELS.has(path.basename(file!).replace(/\.plist$/, "")) && file!.endsWith(".plist")
    return false
  }
  return false
}

/** Each hub unit's absolute path in this context (the manager's root + the asset's file name), when mapped. */
export function unitPathResolver(roots: readonly RootMapping[], context: ExecutionContext): (service: ServiceID, manager: ServiceManagerID) => string | undefined {
  return (service, manager) => {
    const asset = EMBEDDED_ASSETS[assetIDFor(service, manager)]
    if (!asset) return undefined
    const where = resolvePathRef({ root: UNIT_ROOT[manager], rel: asset.installAs }, roots, context)
    return where.ok ? where.value : undefined
  }
}

export interface ServiceControlOptions {
  readonly run: ManagerRunner
  /** The user whose launchd GUI domain the agents load in (process.getuid()). */
  readonly uid: number
  readonly unitPath: (service: ServiceID, manager: ServiceManagerID) => string | undefined
  /** Time for the health window (injected in tests). */
  readonly clock?: Clock
}

const ok = txOk(undefined)

/** The fields of `systemctl show` output (KEY=value lines). */
function showFields(output: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of output.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return fields
}

const WORD = /^[A-Za-z0-9 ()_-]{1,40}$/
/** A state word from the manager, only when it looks like one (so nothing else of its output can leak). */
const word = (value: string | undefined) => (value !== undefined && WORD.test(value) ? value : "unknown")

export function systemdHealth(output: string): ServiceHealth {
  const fields = showFields(output)
  const active = word(fields.ActiveState)
  const sub = word(fields.SubState)
  const restarts = /^\d{1,9}$/.test(fields.NRestarts ?? "") ? Number(fields.NRestarts) : 0
  const detail = `${active}/${sub}`
  if (active === "active") return { state: sub === "running" ? "running" : "starting", restarts, detail }
  if (active === "activating") return { state: sub.startsWith("auto-restart") ? "crash-looping" : "starting", restarts, detail }
  if (active === "reloading") return { state: "starting", restarts, detail }
  if (active === "failed") return { state: "failed", restarts, detail }
  return { state: "stopped", restarts, detail }
}

/** The top-level `key = value` of a `launchctl print` (one tab deep), else its first occurrence. */
const printField = (output: string, key: string) => (output.match(new RegExp(`^\t${key} = (.*)$`, "m")) ?? output.match(new RegExp(`^[ \\t]*${key} = (.*)$`, "m")))?.[1]?.trim()

export function launchdHealth(output: string): ServiceHealth {
  const state = word(printField(output, "state"))
  const runs = Number(printField(output, "runs") ?? "")
  const restarts = Number.isInteger(runs) && runs > 0 ? runs - 1 : 0
  const exit = printField(output, "last exit code")
  const exited = exit !== undefined && /^-?\d{1,9}$/.test(exit)
  const detail = exited ? `${state}, last exit code ${exit}` : state
  if (state === "running") return { state: "running", restarts, detail }
  if (!exited) return { state: "starting", restarts, detail }
  return { state: state === "not running" ? "stopped" : "crash-looping", restarts, detail }
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`

/** The ServiceControl for hub's user services, over a (checked) fixed-call runner. */
export function createServiceControl(options: ServiceControlOptions): NodeServiceControl {
  if (!Number.isInteger(options.uid) || options.uid < 0) throw new Error("the service manager's user must be a uid")
  const clock = options.clock ?? realClock
  const checked = (program: ManagerProgram, ...words: string[]): ManagerCall => {
    const c: ManagerCall = { program, words }
    if (!checkManagerCall(c)) throw new Error(`refused a service manager call outside the fixed set (${program} ${words[0] ?? ""})`)
    return c
  }
  const call = async (program: ManagerProgram, ...words: string[]): Promise<number> => (await options.run(checked(program, ...words))).exitCode

  /** Watches a just-loaded service until it has run, without a restart, for the stable window (HEALTH_WINDOW). */
  const settle = async (probe: () => Promise<TxResult<ServiceHealth>>, name: string, logs: string): Promise<TxResult<void>> => {
    const failed = (what: string) => txFail("service_failed", `${name} ${what}; see ${logs}`)
    const start = clock.now()
    let since: number | undefined
    let baseline = 0
    for (;;) {
      const h = await probe()
      if (!h.ok) return h
      const { state, restarts, detail } = h.value
      const counted = restarts > 0 ? `${detail}, ${plural(restarts, "restart")}` : detail
      const now = clock.now()
      if (state === "crash-looping") return failed(`is crash-looping (${counted})`)
      if (state === "failed") return failed(`failed (${counted})`)
      if (state === "stopped") return failed(`is not running (${counted})`)
      if (state === "running") {
        if (since === undefined) [since, baseline] = [now, restarts]
        else if (restarts > baseline) return failed(`restarted ${plural(restarts - baseline, "time")} while it was watched (${detail})`)
        if (now - since >= HEALTH_WINDOW.stableMs) return ok
      } else since = undefined
      if (now - start >= HEALTH_WINDOW.timeoutMs) return failed(`did not stay running within ${HEALTH_WINDOW.timeoutMs / 1000} s (${detail})`)
      await clock.sleep(HEALTH_WINDOW.pollMs)
    }
  }
  const guarded = async <T>(f: () => Promise<TxResult<T>>): Promise<TxResult<T>> => {
    try {
      return await f()
    } catch (error) {
      return txFail("internal", (error as Error).message)
    }
  }
  const sctl = (...words: string[]) => call("systemctl", "--user", ...words)
  const step = async (code: Promise<number>, what: string): Promise<TxResult<void>> => {
    const exit = await code
    return exit === 0 ? ok : txFail("internal", `${what} failed (exit ${exit})`)
  }

  const systemd = {
    async state(service: ServiceID): Promise<TxResult<ServiceRunState>> {
      const unit = serviceName(service, "systemd-user")
      return txOk({ loaded: (await sctl("is-active", "--quiet", unit)) === 0, enabled: (await sctl("is-enabled", "--quiet", unit)) === 0 })
    },
    async activate(service: ServiceID): Promise<TxResult<void>> {
      const unit = serviceName(service, "systemd-user")
      for (const [words, what] of [
        [["daemon-reload"], "systemctl --user daemon-reload"],
        [["enable", unit], `systemctl --user enable ${unit}`],
        [["restart", unit], `systemctl --user restart ${unit}`],
      ] as const) {
        const r = await step(sctl(...words), what)
        if (!r.ok) return r
      }
      return settle(() => systemd.health(service), unit, `journalctl --user -u ${unit}`)
    },
    async health(service: ServiceID): Promise<TxResult<ServiceHealth>> {
      const unit = serviceName(service, "systemd-user")
      const r = await options.run(checked("systemctl", "--user", "show", SHOW_PROPERTIES, unit))
      return r.exitCode === 0 ? txOk(systemdHealth(r.output ?? "")) : txOk({ state: "stopped", restarts: 0, detail: `systemctl --user show exit ${r.exitCode}` })
    },
    async restore(service: ServiceID, prior: ServiceRunState): Promise<TxResult<void>> {
      const unit = serviceName(service, "systemd-user")
      const r = await step(sctl(prior.enabled ? "enable" : "disable", unit), `systemctl --user ${prior.enabled ? "enable" : "disable"} ${unit}`)
      if (!r.ok) return r
      if (!prior.loaded) {
        const stopped = await step(sctl("stop", unit), `systemctl --user stop ${unit}`)
        if (!stopped.ok) return stopped
      }
      return step(sctl("daemon-reload"), "systemctl --user daemon-reload")
    },
  }

  const domain = `gui/${options.uid}`
  const launchd = {
    async state(service: ServiceID): Promise<TxResult<ServiceRunState>> {
      return txOk({ loaded: (await call("launchctl", "print", `${domain}/${serviceName(service, "launchd")}`)) === 0 })
    },
    async activate(service: ServiceID): Promise<TxResult<void>> {
      const label = serviceName(service, "launchd")
      const file = options.unitPath(service, "launchd")
      if (!file) return txFail("invalid", `this host has no launch-agents directory for ${label}`)
      await call("launchctl", "bootout", `${domain}/${label}`) // not loaded yet is fine
      const boot = await call("launchctl", "bootstrap", domain, file)
      if (boot !== 0) return txFail("internal", `launchctl bootstrap of ${label} failed (exit ${boot})`)
      return settle(() => launchd.health(service), label, `~/.local/state/hub/${service}.log and launchctl print ${domain}/${label}`)
    },
    async health(service: ServiceID): Promise<TxResult<ServiceHealth>> {
      const r = await options.run(checked("launchctl", "print", `${domain}/${serviceName(service, "launchd")}`))
      return r.exitCode === 0 ? txOk(launchdHealth(r.output ?? "")) : txOk({ state: "stopped", restarts: 0, detail: `not loaded, launchctl print exit ${r.exitCode}` })
    },
    async deactivate(service: ServiceID): Promise<TxResult<void>> {
      const label = serviceName(service, "launchd")
      await call("launchctl", "bootout", `${domain}/${label}`) // already unloaded is fine
      return (await call("launchctl", "print", `${domain}/${label}`)) === 0 ? txFail("internal", `${label} is still loaded after launchctl bootout`) : ok
    },
  }

  const deactivate = (service: ServiceID, manager: ServiceManagerID) =>
    guarded(() => (manager === "launchd" ? launchd.deactivate(service) : systemd.restore(service, { loaded: false, enabled: false })))
  return {
    state: (service, manager) => guarded(() => (manager === "launchd" ? launchd.state(service) : systemd.state(service))),
    activate: (service, manager) => guarded(() => (manager === "launchd" ? launchd.activate(service) : systemd.activate(service))),
    deactivate,
    restore: (service, manager, prior) =>
      prior.loaded ? guarded(async () => (manager === "launchd" ? ok : systemd.restore(service, prior))) : deactivate(service, manager),
    health: (service, manager) => guarded(() => (manager === "launchd" ? launchd.health(service) : systemd.health(service))),
  }
}

/** Spawns one process: no shell; resolves its exit code, and with `capture` also its (bounded) stdout. */
export type Spawner = (
  file: string,
  words: readonly string[],
  options: { readonly shell: false; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly capture?: true },
) => Promise<number | { readonly exitCode: number; readonly output: string }>

/** At most this much of a state query's output is kept. */
const MAX_OUTPUT = 64 * 1024
/** The calls whose output is read: the state queries. */
const capturesOutput = (call: ManagerCall) => (call.program === "systemctl" ? call.words[1] === "show" : call.words[0] === "print")

export interface SpawnRunnerOptions {
  /** Absolute paths of the two programs (discovery's view of this context). */
  readonly programs: Readonly<Record<ManagerProgram, string>>
  /** The caller's environment; only the user bus address is passed on (systemctl --user needs it). */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  /** Injected in tests; the default spawns with node:child_process (never with a shell). */
  readonly spawn?: Spawner
}

const BUS_ENV = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const

const defaultSpawn: Spawner = (file, words, options) =>
  new Promise((resolve) => {
    const child = nodeSpawn(file, [...words], { shell: false, env: { ...options.env }, stdio: ["ignore", options.capture ? "pipe" : "ignore", "ignore"], timeout: options.timeoutMs, killSignal: "SIGKILL" })
    let output = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      if (output.length < MAX_OUTPUT) output = (output + chunk).slice(0, MAX_OUTPUT)
    })
    const done = (exitCode: number) => resolve(options.capture ? { exitCode, output } : exitCode)
    child.on("error", () => done(127))
    child.on("close", (code, signal) => done(code ?? (signal ? 128 : 1)))
  })

/** The real runner: checked calls only, absolute programs, no shell, no inherited environment. */
export function spawnManagerRunner(options: SpawnRunnerOptions): ManagerRunner {
  for (const program of ["systemctl", "launchctl"] as const) {
    const file = options.programs[program]
    if (!isAbsolutePath(file) || path.basename(file) !== program) throw new Error(`${program} must be given as an absolute path to ${program}`)
  }
  const env: Record<string, string> = {}
  for (const key of BUS_ENV) if (options.env?.[key]) env[key] = options.env[key]!
  const spawn = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? 30_000
  return async (call: ManagerCall) => {
    if (!checkManagerCall(call)) throw new Error(`refused a service manager call outside the fixed set (${String((call as { program?: unknown }).program)})`)
    const capture = capturesOutput(call)
    const r = await spawn(options.programs[call.program], [...call.words], { shell: false, env, timeoutMs, ...(capture ? { capture: true as const } : {}) })
    if (typeof r === "number") return { exitCode: r }
    return capture ? { exitCode: r.exitCode, output: r.output.slice(0, MAX_OUTPUT) } : { exitCode: r.exitCode }
  }
}

/**
 * activate-service: loads a hub service after the user explicitly confirmed it (the engine also requires
 * --confirm-activation). An external effect; its undo returns the service to the state it had before.
 */
export function activateServiceExecutor(control?: NodeServiceControl): ActionExecutor<"activate-service"> {
  const priors = new Map<string, ServiceRunState>()
  return {
    kind: "activate-service",
    plan: () => ({ class: "external" }),
    check: async (action) => {
      if (action.confirm !== "explicit") return txFail("needs_user", `${action.id}: a service is only loaded on explicit confirmation`)
      return control ? ok : txFail("internal", "this hubctl was built without a service manager client")
    },
    change: async (action) => {
      if (!control) return txFail("internal", "this hubctl was built without a service manager client")
      return txOk({
        type: "effect",
        perform: async () => {
          const prior = await control.state(action.service, action.manager)
          if (!prior.ok) return prior
          priors.set(action.id, prior.value)
          const activated = await control.activate(action.service, action.manager)
          if (activated.ok) return activated
          // The engine does not undo a step that failed, so a failed activation puts the service back itself.
          const restored = await control.restore(action.service, action.manager, prior.value)
          const after = !restored.ok ? `undoing it failed: ${restored.message}` : prior.value.loaded ? "it was loaded before and stays loaded" : "it was unloaded again"
          return txFail(activated.code, `${activated.message}; ${after}`)
        },
      })
    },
    undo: async (action) => {
      if (!control) return txFail("internal", "this hubctl was built without a service manager client")
      return control.restore(action.service, action.manager, priors.get(action.id) ?? { loaded: false, enabled: false })
    },
  }
}
