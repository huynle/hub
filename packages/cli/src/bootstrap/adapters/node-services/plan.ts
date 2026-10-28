// Plans a persistent launch node: the typed actions that configure `hub node` (a lossless merge of node.json), write
// its service unit and the chosen harness spokes' units (install-service, from the embedded templates, pinned by the
// rendered unit's digest), load them only when the user explicitly asked to (activate-service, confirm: "explicit";
// apply also needs --confirm-activation), and optionally prove the setup with one bounded launch inside a configured
// workspace root (launch-session). Linger is never planned: it is an opt-in note, since keeping a user's services
// running after logout is a login setting hubctl does not change.
//
// Pure and deterministic: the same snapshot, profile and options always plan the same actions and units, so a
// re-plan at apply gives the same digest. No action carries a command, and no unit carries a credential.
import {
  HARNESS_SERVICE,
  resolvePathRef,
  validateAction,
  type Action,
  type ConfigSet,
  type HarnessID,
  type InstallService,
  type Issue,
  type PathRef,
  type PlanInput,
  type ProgramLayout,
  type Result,
  type ServiceID,
} from "../../contracts/index.ts"
import type { PlanContributor } from "../../preview/plan.ts"
import { renderServiceUnit, SERVICE_ENVIRONMENT, type RenderedUnit } from "./render.ts"
import { checkNodeSettings, inside, serviceContextOf, type NodeSettings, type ServiceContext } from "./validate.ts"

export interface NodeServicesOptions {
  /** The hubctl the services start (programLayout of this process). */
  readonly layout: ProgramLayout
  /** node.json settings ({workspaceRoots, slots?, labels?}); required when the profile has the node service. */
  readonly node?: unknown
  /** Explicit consent, given at preview: plan loading the services. Never a default. */
  readonly activate?: boolean
  /** Opt-in: the user wants the services kept running while logged out (a note; hubctl changes no login setting). */
  readonly linger?: boolean
  /** The user's environment; only each service's own settings (SERVICE_ENVIRONMENT) are carried, others ignored. */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** One bounded verification launch, inside a workspace root (needs `activate` and a launch-enabled profile). */
  readonly launch?: { readonly harness: HarnessID; readonly workspace: PathRef }
}

export interface NodeServicesPlan {
  readonly actions: readonly Action[]
  /** The rendered units, in the order of their install-service actions. */
  readonly units: readonly RenderedUnit[]
  readonly settings?: NodeSettings
  readonly context?: ServiceContext
  /** Secret-free guidance for the preview (activation not requested, linger). */
  readonly notes: readonly string[]
}

export const NODE_CONFIG_REF: PathRef = { root: "config", rel: "hub/node.json" }
const CONFIG_DIR: PathRef = { root: "config", rel: "hub" }

const LABEL: Readonly<Record<ServiceID, string>> = { node: "hub node", "claude-code": "Claude Code spoke", "codex-spoke": "Codex spoke" }
const SERVICE_HARNESS: Readonly<Partial<Record<ServiceID, HarnessID>>> = Object.fromEntries(Object.entries(HARNESS_SERVICE).map(([h, s]) => [s, h]))
const BIN_SETTING: Readonly<Partial<Record<HarnessID, string>>> = { "claude-code": "HUB_CLAUDE_BIN", codex: "HUB_CODEX_BIN" }

const failed = <T>(issues: readonly Issue[]): Result<T> => ({ ok: false, issues: [...issues] })
const prefixed = (prefix: string, r: Result<unknown>): Issue[] => (r.ok ? [] : r.issues.map((i) => ({ ...i, path: `${prefix}${i.path}` })))

/** The harnesses a service serves: the node all chosen ones, a spoke its own. */
const servedBy = (service: ServiceID, harnesses: readonly HarnessID[]): HarnessID[] => (service === "node" ? [...harnesses] : [SERVICE_HARNESS[service]!])

function environmentFor(service: ServiceID, served: readonly HarnessID[], ctx: ServiceContext, environment: NodeServicesOptions["environment"]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SERVICE_ENVIRONMENT[service]) {
    const v = environment?.[key]
    if (v) env[key] = v
  }
  // The harness binary the service starts is the one discovery found in this context, not whatever its PATH holds.
  for (const harness of served) {
    const key = BIN_SETTING[harness]
    const bin = ctx.harnessBins[harness]
    if (key && bin && SERVICE_ENVIRONMENT[service].includes(key)) env[key] = bin
  }
  return env
}

function nodeConfigAction(raw: Record<string, unknown>, settings: NodeSettings, input: PlanInput, ctx: ServiceContext): Action[] {
  const set: ConfigSet[] = [{ pointer: "/workspaceRoots", value: [...settings.workspaceRoots] }]
  if (raw.slots !== undefined) set.push({ pointer: "/slots", value: settings.slots })
  if (raw.labels !== undefined) set.push({ pointer: "/labels", value: { ...settings.labels } })
  const where = resolvePathRef(NODE_CONFIG_REF, input.snapshot.roots, ctx.context)
  const hostWhere = resolvePathRef(NODE_CONFIG_REF, input.snapshot.roots, "host")
  const known = input.snapshot.configs.find((f) => (where.ok && f.path === where.value) || (hostWhere.ok && f.path === hostWhere.value))
  const precondition = known?.sha256 ? { exists: true, sha256: known.sha256 } : { exists: false }
  return [
    { id: "hub-config-dir", kind: "ensure-directory", escalation: "user", summary: "Create the hub config directory", path: CONFIG_DIR, mode: 0o700 },
    {
      id: "node-config",
      kind: "merge-config",
      escalation: "user",
      summary: `Set the launch node's workspace roots (${settings.workspaceRoots.join(", ")}) in node.json`,
      path: NODE_CONFIG_REF,
      format: "json",
      owner: "hub",
      precondition,
      set,
      preserveUnknown: true,
    },
  ]
}

/** The node-services actions for (snapshot, profile); refuses settings or contexts it cannot serve. */
export function planNodeServices(input: PlanInput, options: NodeServicesOptions): Result<NodeServicesPlan> {
  const { profile } = input
  if (profile.services.length === 0) {
    if (options.launch) return failed([{ path: "/launch", code: "inconsistent", message: `the ${profile.id} profile runs no node to launch on` }])
    return { ok: true, value: { actions: [], units: [], notes: [] } }
  }
  const harnesses = [...new Set(profile.services.flatMap((s) => servedBy(s, profile.harnesses)))]
  const context = serviceContextOf({ snapshot: input.snapshot, harnesses, layout: options.layout })
  if (!context.ok) return context as Result<never>
  const ctx = context.value

  const actions: Action[] = []
  const issues: Issue[] = []
  let settings: NodeSettings | undefined
  if (profile.services.includes("node")) {
    if (options.node === undefined) issues.push({ path: "/node", code: "missing_field", message: "a launch node needs its workspace roots (node.json workspaceRoots)" })
    else {
      const checked = checkNodeSettings(options.node, { snapshot: input.snapshot })
      if (!checked.ok) issues.push(...prefixed("/node", checked))
      else {
        settings = checked.value
        actions.push(...nodeConfigAction(options.node as Record<string, unknown>, settings, input, ctx))
      }
    }
  }

  const units: RenderedUnit[] = []
  for (const service of profile.services) {
    const environment = environmentFor(service, servedBy(service, profile.harnesses), ctx, options.environment)
    const unit = renderServiceUnit({ service, manager: ctx.manager, layout: options.layout, home: ctx.home, environment })
    if (!unit.ok) {
      issues.push(...prefixed(`/services/${service}`, unit))
      continue
    }
    units.push(unit.value)
    actions.push({
      id: `install-${service}-service`,
      kind: "install-service",
      escalation: "user",
      summary: `Write the ${LABEL[service]} ${ctx.manager === "launchd" ? "launchd agent" : "systemd --user unit"} (${unit.value.name})`,
      service,
      manager: ctx.manager,
      path: unit.value.path,
      asset: unit.value.asset,
      sha256: unit.value.sha256,
    })
  }

  if (options.activate)
    for (const service of profile.services)
      actions.push({ id: `activate-${service}-service`, kind: "activate-service", escalation: "user", summary: `Load the ${LABEL[service]} service (explicitly confirmed)`, service, manager: ctx.manager, confirm: "explicit" })

  if (options.launch) issues.push(...checkLaunch(input, options, ctx, settings))
  if (issues.length > 0) return failed(issues)
  if (options.launch)
    actions.push({
      id: `verify-launch-${options.launch.harness}`,
      kind: "launch-session",
      escalation: "user",
      summary: `Launch one bounded ${options.launch.harness} session (at most ${profile.launch.maxDurationS} s) to prove the node end to end`,
      harness: options.launch.harness,
      workspace: options.launch.workspace,
      maxDurationS: profile.launch.maxDurationS!,
    })

  for (const action of actions) {
    const valid = validateAction(action)
    if (!valid.ok) issues.push(...prefixed(`/actions/${action.id}`, valid))
  }
  if (issues.length > 0) return failed(issues)
  return { ok: true, value: { actions, units, ...(settings ? { settings } : {}), context: ctx, notes: notesFor(options, ctx) } }
}

function checkLaunch(input: PlanInput, options: NodeServicesOptions, ctx: ServiceContext, settings: NodeSettings | undefined): Issue[] {
  const launch = options.launch!
  const { profile } = input
  if (!profile.launch.enabled || profile.launch.maxDurationS === undefined) return [{ path: "/launch", code: "inconsistent", message: `the ${profile.id} profile does not launch sessions` }]
  if (!options.activate) return [{ path: "/launch", code: "inconsistent", message: "a verification launch needs the node running: confirm activation too" }]
  if (!profile.harnesses.includes(launch.harness)) return [{ path: "/launch/harness", code: "inconsistent", message: `the ${profile.id} profile does not set up ${launch.harness}` }]
  const where = resolvePathRef(launch.workspace, input.snapshot.roots, ctx.context)
  if (!where.ok) return prefixed("/launch/workspace", where)
  if (settings && !settings.workspaceRoots.some((root) => inside(where.value, root)))
    return [{ path: "/launch/workspace", code: "invalid_path", message: `${where.value} is outside the node's workspace roots` }]
  return []
}

function notesFor(options: NodeServicesOptions, ctx: ServiceContext): string[] {
  const notes: string[] = []
  if (!options.activate) notes.push("The services are installed but not loaded: pass --confirm-activation to load them (hubctl never loads a service without it).")
  if (ctx.manager === "systemd-user")
    notes.push(
      options.linger
        ? "To keep the services running while you are logged out, run `loginctl enable-linger` yourself; hubctl does not change login settings."
        : "systemd --user services stop when you log out; keeping them running (linger) is opt-in.",
    )
  else notes.push("launchd user agents run while you are logged in.")
  return notes
}

/** A planner contributor (preview/plan.ts). Validate with planNodeServices first: a contributor cannot refuse. */
export function nodeServicesContributor(options: NodeServicesOptions): PlanContributor {
  return (input) => {
    const planned = planNodeServices(input, options)
    if (!planned.ok) throw new Error(`node services cannot be planned: ${planned.issues.map((i) => `${i.code} ${i.path}: ${i.message}`).join("; ")}`)
    return planned.value.actions
  }
}

/** The applier's renderService (BuiltinDeps): exactly the planned units, nothing else. */
export function serviceAssets(planned: NodeServicesPlan): { readonly renderService: (action: InstallService) => Uint8Array | undefined } {
  return {
    renderService: (action) =>
      planned.units.find((u) => u.asset === action.asset && u.service === action.service && u.manager === action.manager && u.path.root === action.path.root && u.path.rel === action.path.rel)?.bytes,
  }
}
