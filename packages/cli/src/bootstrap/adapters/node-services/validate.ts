// What a persistent launch node may be configured with, and where its services may run.
//
// Node settings (node.json): workspace roots must be narrow project directories, never /, a top-level directory,
// the home itself, a parent of it, another user's home, or hub's own config/state/unit directories; roots are
// distinct and never nested; slots are bounded; labels are plain and never a credential or the node's own os/arch.
//
// Same runtime context: a service runs where the service manager that loads it runs. It must be the same runtime
// and filesystem context as the harness it serves and the paths in its unit. So the adapter refuses
//   - a harness reached through a container shim (the harness and its repositories live in a container, while this
//     host has none: a host service would find no harness and the wrong paths);
//   - inside a container, a unit directory that is a host directory mounted in (the host's manager would run the
//     unit with the container's paths);
//   - any program, harness or workspace path that is the other side's view of a mounted root.
import { labelsProblem, NODE_ROOTS_MAX } from "../../../../../protocol/src/index.ts"
import {
  Checker,
  checkTarget,
  executionContextOf,
  fail,
  findSecrets,
  isAbsolutePath,
  isRecord,
  pointer,
  rootPathIn,
  sha256Hex,
  shape,
  type DiscoverySnapshot,
  type ExecutionContext,
  type HarnessID,
  type ProgramLayout,
  type Result,
  type RootMapping,
  type ServiceManagerID,
} from "../../contracts/index.ts"
import { UNIT_ROOT } from "./render.ts"

/** Concurrent launches when the settings name none (the node's own default, packages/node DEFAULT_SLOTS). */
export const DEFAULT_SLOTS = 4
/** The bootstrap configures at most this many slots; a larger node is configured by hand. */
export const BOOTSTRAP_SLOTS_MAX = 64
/** Labels the node sets itself. */
export const RESERVED_LABELS = ["os", "arch"] as const

export interface NodeSettings {
  readonly workspaceRoots: readonly string[]
  readonly slots: number
  readonly labels: Readonly<Record<string, string>>
}

export interface NodePlaces {
  /** The discovery the plan is made from: its roots and execution context. */
  readonly snapshot: Pick<DiscoverySnapshot, "roots" | "topology">
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`)
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/"

/** Mount prefixes as the *other* context sees them (a path under one is not valid where the service runs). */
function otherViews(roots: readonly RootMapping[], context: ExecutionContext): string[] {
  return roots.flatMap((r) => (r.containerPath !== undefined && r.containerPath !== r.path ? [context === "container" ? r.path : r.containerPath] : []))
}

function thisViews(roots: readonly RootMapping[], context: ExecutionContext): string[] {
  return roots.map((r) => rootPathIn(r, context))
}

/** Whether `path` is the other context's view of a mounted root (and not also valid in this context). */
const foreignPath = (path: string, roots: readonly RootMapping[], context: ExecutionContext) =>
  otherViews(roots, context).some((v) => inside(path, v)) && !thisViews(roots, context).some((v) => inside(path, v))

function rootProblem(root: unknown, roots: readonly RootMapping[], context: ExecutionContext): { code: "invalid_path" | "inconsistent"; message: string } | undefined {
  if (!isAbsolutePath(root)) return { code: "invalid_path", message: "a workspace root is an absolute, normalized, single-line path" }
  if (foreignPath(root, roots, context)) return { code: "inconsistent", message: `${root} is how the other side of the container mount sees it; give the path the service sees` }
  if (root === "/" || root.split("/").length < 3) return { code: "invalid_path", message: `${root} is too broad for a workspace root` }
  const home = roots.find((r) => r.id === "home")
  const homePath = home ? rootPathIn(home, context) : undefined
  if (homePath && inside(homePath, root)) return { code: "invalid_path", message: `${root} is the whole home or a parent of it; name a project directory inside it` }
  if (homePath && parentOf(root) === parentOf(homePath)) return { code: "invalid_path", message: `${root} is another user's home` }
  for (const r of roots) {
    if (r.id === "home") continue
    const dir = rootPathIn(r, context)
    if (inside(root, dir) || inside(dir, root)) return { code: "invalid_path", message: `${root} holds hub's own ${r.id} directory` }
  }
  return undefined
}

/** Validates and normalizes the launch node's settings for this host. */
export function checkNodeSettings(value: unknown, places: NodePlaces): Result<NodeSettings> {
  const c = new Checker()
  const r = shape(c, "", value, ["workspaceRoots"], ["slots", "labels"])
  if (!r) return c.result(undefined)
  const context = executionContextOf(places.snapshot)
  const roots = places.snapshot.roots
  const workspaceRoots: string[] = []
  if (r.workspaceRoots !== undefined) {
    if (!Array.isArray(r.workspaceRoots) || r.workspaceRoots.length === 0) c.add("/workspaceRoots", "invalid_value", "a launch node needs at least one workspace root")
    else if (r.workspaceRoots.length > NODE_ROOTS_MAX) c.add("/workspaceRoots", "invalid_value", `at most ${NODE_ROOTS_MAX} workspace roots`)
    else
      r.workspaceRoots.forEach((root: unknown, i: number) => {
        const at = pointer("/workspaceRoots", i)
        const problem = rootProblem(root, roots, context)
        if (problem) return c.add(at, problem.code, problem.message)
        const path = root as string
        if (workspaceRoots.some((w) => inside(path, w) || inside(w, path))) return c.add(at, "duplicate", `${path} repeats or nests another workspace root`)
        workspaceRoots.push(path)
      })
  }
  let slots = DEFAULT_SLOTS
  if (r.slots !== undefined) {
    if (Number.isInteger(r.slots) && (r.slots as number) >= 1 && (r.slots as number) <= BOOTSTRAP_SLOTS_MAX) slots = r.slots as number
    else c.add("/slots", "invalid_value", `slots must be a whole number from 1 to ${BOOTSTRAP_SLOTS_MAX}`)
  }
  let labels: Record<string, string> = {}
  if (r.labels !== undefined) {
    const problem = labelsProblem(r.labels)
    if (findSecrets(r.labels).length > 0) c.add("/labels", "secret", "labels never carry credentials")
    else if (problem) c.add("/labels", "invalid_value", problem)
    else if (isRecord(r.labels) && RESERVED_LABELS.some((k) => k in (r.labels as object))) c.add("/labels", "invalid_value", `the node sets ${RESERVED_LABELS.join(" and ")} itself`)
    else labels = Object.fromEntries(Object.entries(r.labels as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
  return c.result<NodeSettings>({ workspaceRoots, slots, labels })
}

export interface RenderedConfig {
  readonly text: string
  readonly bytes: Uint8Array
  readonly sha256: string
}

/** node.json for validated settings: the same settings always give the same bytes. */
export function renderNodeConfig(settings: NodeSettings): RenderedConfig {
  const labels = Object.fromEntries(Object.entries(settings.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const text = `${JSON.stringify({ workspaceRoots: settings.workspaceRoots, slots: settings.slots, labels }, null, 2)}\n`
  const bytes = new TextEncoder().encode(text)
  return { text, bytes, sha256: `sha256:${sha256Hex(bytes)}` }
}

export interface ServiceContextInput {
  readonly snapshot: DiscoverySnapshot
  /** The harnesses the services serve (the node: every chosen harness; a spoke: its own). */
  readonly harnesses: readonly HarnessID[]
  /** The hubctl the services start. */
  readonly layout: ProgramLayout
}

export interface ServiceContext {
  readonly context: ExecutionContext
  readonly manager: ServiceManagerID
  /** Home as the service sees it. */
  readonly home: string
  /** Each installed harness's real binary in this context (a wrapper resolved), carried into the unit. */
  readonly harnessBins: Partial<Record<HarnessID, string>>
}

/** Where this host's services run, refusing any mismatch with the harness's runtime and filesystem context. */
export function serviceContextOf(input: ServiceContextInput): Result<ServiceContext> {
  const { snapshot } = input
  const context = executionContextOf(snapshot)
  const manager = snapshot.managers.service
  if (manager === "none") return fail("/managers/service", "no_service_manager", "this host has no user service manager (launchd or systemd --user)")
  const target = checkTarget(snapshot.host.target)
  if (!target.ok) return target as Result<never>
  if (target.value.serviceManager !== manager) return fail("/managers/service", "inconsistent", `${snapshot.host.target} services run under ${target.value.serviceManager}, not ${manager}`)

  const c = new Checker()
  const unitRoot = snapshot.roots.find((r) => r.id === UNIT_ROOT[manager])
  const home = snapshot.roots.find((r) => r.id === "home")
  if (!unitRoot) c.add("/roots", "unmapped_root", `this host has no ${UNIT_ROOT[manager]} root`)
  if (!home) c.add("/roots", "unmapped_root", "this host has no home root")
  if (unitRoot && context === "container" && unitRoot.containerPath !== undefined)
    c.add("/roots", "inconsistent", `the ${unitRoot.id} directory is the host's ${unitRoot.path}, mounted into this container: the host's ${manager} would run the unit outside the container`)

  const program = input.layout.kind === "standalone" ? [input.layout.executable] : [input.layout.runtime, input.layout.entry]
  for (const word of program)
    if (isAbsolutePath(word) && foreignPath(word, snapshot.roots, context)) c.add("/layout", "inconsistent", `${word} is the other side's view of a container mount; the service could not start it`)

  const harnessBins: Partial<Record<HarnessID, string>> = {}
  for (const id of input.harnesses) {
    const presence = snapshot.harnesses.find((h) => h.id === id)
    if (!presence?.installed || !presence.path) continue
    const shim = snapshot.topology.shims.find((s) => s.path === presence.path)
    if (shim?.kind === "container-shim") {
      c.add(
        `/harnesses/${id}`,
        "inconsistent",
        `${id} at ${presence.path} is a shim into a container${shim.resolvesTo ? ` (${shim.resolvesTo})` : ""}: the harness and its repositories live there, so set up the service inside that container`,
      )
      continue
    }
    const bin = shim?.kind === "wrapper" && shim.resolvesTo ? shim.resolvesTo : presence.path
    if (foreignPath(bin, snapshot.roots, context)) c.add(`/harnesses/${id}`, "inconsistent", `${id} at ${bin} is the other side's view of a container mount`)
    else harnessBins[id] = bin
  }
  if (c.issues.length > 0) return c.result(undefined)
  return c.result<ServiceContext>({ context, manager, home: rootPathIn(home!, context), harnessBins })
}
