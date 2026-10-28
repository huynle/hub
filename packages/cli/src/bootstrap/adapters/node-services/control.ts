// The typed service-manager client for hub's own user services (the ServiceControl the transaction executors take,
// transaction/builtin.ts), and the activate-service executor.
//
// It names a service and a manager, never a command. Underneath, it makes only fixed calls:
//   systemd --user  systemctl --user daemon-reload | enable | disable | start | restart | stop <hub unit>
//                   systemctl --user is-active --quiet | is-enabled --quiet <hub unit>
//   launchd         launchctl bootstrap gui/<uid> <the hub agent's plist> | bootout gui/<uid>/<hub label>
//                   launchctl print gui/<uid>/<hub label>
// Every call is checked against that set (checkManagerCall) before it reaches the injected runner, so a bug cannot
// turn it into anything else; the real runner (spawnManagerRunner) checks again, spawns the absolute program
// without a shell and with an empty environment (only the user bus address is passed), and reports only an exit
// code. Failures name the unit and the exit, never output. Nothing elevated: only the user's own manager.
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

/** Runs one checked call; only its exit code comes back. */
export type ManagerRunner = (call: ManagerCall) => Promise<{ readonly exitCode: number }>

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
}

const UNITS = new Set(SERVICE_IDS.map((s) => serviceName(s, "systemd-user")))
const LABELS = new Set(SERVICE_IDS.map((s) => serviceName(s, "launchd")))
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const DOMAIN = /^gui\/\d{1,10}$/
const SYSTEMD_UNIT_VERBS = new Set(["enable", "disable", "start", "restart", "stop"])
const SYSTEMD_QUERIES = new Set(["is-active", "is-enabled"])

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
}

const ok = txOk(undefined)

/** The ServiceControl for hub's user services, over a (checked) fixed-call runner. */
export function createServiceControl(options: ServiceControlOptions): NodeServiceControl {
  if (!Number.isInteger(options.uid) || options.uid < 0) throw new Error("the service manager's user must be a uid")
  const call = async (program: ManagerProgram, ...words: string[]): Promise<number> => {
    const c: ManagerCall = { program, words }
    if (!checkManagerCall(c)) throw new Error(`refused a service manager call outside the fixed set (${program} ${words[0] ?? ""})`)
    return (await options.run(c)).exitCode
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
      return (await sctl("is-active", "--quiet", unit)) === 0 ? ok : txFail("internal", `${unit} did not start (systemctl --user is-active)`)
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
      return (await call("launchctl", "print", `${domain}/${label}`)) === 0 ? ok : txFail("internal", `${label} did not load (launchctl print)`)
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
  }
}

/** Spawns one process: no shell; resolves its exit code. */
export type Spawner = (file: string, words: readonly string[], options: { readonly shell: false; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number }) => Promise<number>

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
    const child = nodeSpawn(file, [...words], { shell: false, env: { ...options.env }, stdio: "ignore", timeout: options.timeoutMs, killSignal: "SIGKILL" })
    child.on("error", () => resolve(127))
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)))
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
    return { exitCode: await spawn(options.programs[call.program], [...call.words], { shell: false, env, timeoutMs }) }
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
          return control.activate(action.service, action.manager)
        },
      })
    },
    undo: async (action) => {
      if (!control) return txFail("internal", "this hubctl was built without a service manager client")
      return control.restore(action.service, action.manager, priors.get(action.id) ?? { loaded: false, enabled: false })
    },
  }
}
