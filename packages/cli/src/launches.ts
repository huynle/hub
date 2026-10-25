// `hub launch` and `hub launches list | show | stop` (design §6.1; decision znbg8xa5): the flags as a launch spec
// for POST /api/agent/launches, and the launch routes' answers as short text. The CLI checks only the flags' own
// shape (enums, key=value, what needs what); the hub validates the spec and fills in its defaults.
import path from "node:path"
import type { LaunchSpec, LaunchStep, LaunchView } from "../../sdk/src/index.ts"
import { CLEANUP_POLICIES, LAUNCH_END_WHEN, RUNTIME_KINDS, WORKSPACE_MODES } from "../../protocol/src/launch.ts"
import { str, UsageError, type FlagKind, type Parsed } from "./args"

export const LAUNCH_FLAGS: Readonly<Record<string, FlagKind>> = {
  key: "string",
  name: "string",
  role: "multi",
  harness: "string",
  agent: "string",
  model: "string",
  repo: "string",
  mode: "string",
  branch: "string",
  base: "string",
  remote: "string",
  runtime: "string",
  profile: "string",
  machine: "string",
  prefer: "bool",
  "node-label": "multi",
  label: "multi",
  prompt: "string",
  end: "string",
  timeout: "string",
  cleanup: "string",
}

/** `a, b or c` */
const choices = (options: readonly string[]) => (options.length === 2 ? options.join(" or ") : `${options.slice(0, -1).join(", ")} or ${options.at(-1)}`)

function oneOf<T extends string>(flags: Parsed["flags"], flag: string, options: readonly T[]): T | undefined {
  const value = str(flags, flag)
  if (value === undefined) return undefined
  if (!options.includes(value as T)) throw new UsageError(`--${flag} is ${choices(options)}`)
  return value as T
}

/** Repeated `--flag key=value` as an object; undefined when none is given. */
export function pairsArg(flags: Parsed["flags"], flag: string): Record<string, string> | undefined {
  const given = flags[flag] as string[] | undefined
  if (!given?.length) return undefined
  const out: Record<string, string> = {}
  for (const pair of given) {
    const at = pair.indexOf("=")
    if (at < 1) throw new UsageError(`--${flag} takes key=value (got ${JSON.stringify(pair)})`)
    out[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return out
}

/** Only the defined fields of `fields`; undefined when none is. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> | undefined {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value
  return Object.keys(out).length ? (out as Partial<T>) : undefined
}

export interface LaunchArgContext {
  /** Relative --repo paths resolve against it; the default repo. */
  readonly cwd: string
  readonly stdin?: () => Promise<string>
}

/** The launch spec the flags describe (only the given fields). */
export async function launchSpecArg(flags: Parsed["flags"], context: LaunchArgContext): Promise<LaunchSpec> {
  const mode = oneOf(flags, "mode", WORKSPACE_MODES)
  const kind = oneOf(flags, "runtime", RUNTIME_KINDS)
  const when = oneOf(flags, "end", LAUNCH_END_WHEN)
  const cleanup = oneOf(flags, "cleanup", CLEANUP_POLICIES)
  const nodeLabels = pairsArg(flags, "node-label")
  const labels = pairsArg(flags, "label")
  const profile = str(flags, "profile")
  const machine = str(flags, "machine")
  if (profile !== undefined && kind === undefined) throw new UsageError("--profile needs --runtime (e.g. --runtime openshell)")
  if (flags.prefer === true && machine === undefined && nodeLabels === undefined) throw new UsageError("--prefer needs --machine or --node-label")

  let prompt = str(flags, "prompt")
  if (prompt === "-") {
    if (!context.stdin) throw new UsageError("cannot read the prompt from stdin here")
    prompt = await context.stdin()
  }
  if (prompt !== undefined && !prompt.trim()) throw new UsageError("--prompt is empty")

  const repo = path.resolve(context.cwd, str(flags, "repo") ?? ".")
  const roles = (flags.role as string[] | undefined)?.map((r) => r.replace(/^@@/, ""))
  const name = str(flags, "name")?.replace(/^@+/, "")
  const workspace = { repo, ...defined({ mode, branch: str(flags, "branch"), base: str(flags, "base"), remote: str(flags, "remote") }) }
  const runtime = kind === undefined ? undefined : { kind, ...(profile !== undefined ? { profile } : {}) }
  const placement = defined({ labels: nodeLabels, machine, mode: flags.prefer === true ? ("prefer" as const) : undefined })
  const end = defined({ when, timeout: str(flags, "timeout"), cleanup })
  return {
    ...defined({ key: str(flags, "key"), name, roles, harness: str(flags, "harness"), agent: str(flags, "agent"), model: str(flags, "model") }),
    workspace,
    ...defined({ runtime, placement, prompt, labels, end }),
  }
}

// ---------- text ----------

const at = (name: string) => `@${name.replace(/^@+/, "")}`
const stateText = (l: Pick<LaunchView, "state" | "outcome">) => (l.outcome ? `${l.state} ${l.outcome}` : l.state)
const sessionText = (l: LaunchView) => [l.name ? at(l.name) : undefined, l.sessionID].filter(Boolean).join(" ")
const labelsText = (labels: Readonly<Record<string, string>> | undefined) =>
  Object.entries(labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")

/** `lch_1: running (session started), @api ses_1` */
const summary = (l: LaunchView) => `${l.id}: ${stateText(l)} (${l.reason})${sessionText(l) ? `, ${sessionText(l)}` : ""}`

/** What `hub launch` prints: a new launch, or the existing launch of the same key. */
export function launchedText(launch: LaunchView, created: boolean, key: string | undefined = launch.spec.key): string {
  if (created || key === undefined) return `launched ${summary(launch)}`
  return `${launch.id} was already launched with key ${key}: ${summary(launch).slice(launch.id.length + 2)}`
}

export const stoppedLaunchText = (launch: LaunchView): string => `stopped ${summary(launch)}`

/** `lch_1  running  @api ses_1  /repo (branch)  app=brain` */
export function launchLine(l: LaunchView): string {
  const where = l.directory ?? `${l.spec.workspace.repo}${l.spec.workspace.branch ? ` (${l.spec.workspace.branch})` : ""}`
  return [l.id, stateText(l), sessionText(l) || undefined, where, labelsText(l.spec.labels) || undefined].filter(Boolean).join("  ")
}

export const launchesText = (launches: readonly LaunchView[]): string => (launches.length ? launches.map(launchLine).join("\n") : "no launches")

function artifactsText(a: NonNullable<LaunchView["artifacts"]>): string {
  const parts: string[] = []
  if (a.branch) parts.push(`branch ${a.branch}${a.base ? ` from ${a.base}` : ""}`)
  if (a.head) parts.push(`head ${a.head}`)
  if (a.commits !== undefined) parts.push(`${a.commits} commit${a.commits === 1 ? "" : "s"}`)
  if (a.dirty !== undefined) parts.push(a.dirty ? "uncommitted changes" : "clean")
  return parts.join(", ")
}

const stepText = (s: LaunchStep) => `  ${new Date(s.at).toISOString()}  ${stateText(s)}: ${s.reason}`

/** `hub launches show`: the launch, its spec, its steps. */
export function launchText(l: LaunchView): string {
  const ws = l.spec.workspace
  const lines = [`${l.id}  ${stateText(l)} (${l.reason})`]
  if (sessionText(l) || l.machineID) lines.push(`session: ${[sessionText(l) || "none yet", l.machineID ? `on ${l.machineID}` : undefined].filter(Boolean).join(" ")}`)
  lines.push(`workspace: ${[ws.repo, ws.mode, ws.branch].filter(Boolean).join(" ")}${ws.base ? ` from ${ws.base}` : ""}${l.directory ? ` → ${l.directory}` : ""}`)
  const run = [l.spec.harness, l.spec.agent, l.spec.model, l.spec.runtime ? `${l.spec.runtime.kind}${l.spec.runtime.profile ? `/${l.spec.runtime.profile}` : ""}` : undefined].filter(Boolean)
  if (run.length) lines.push(`runs: ${run.join(" ")}`)
  if (l.spec.end) lines.push(`ends: ${[l.spec.end.when, l.spec.end.timeout ? `timeout ${l.spec.end.timeout}` : undefined, l.spec.end.cleanup ? `cleanup ${l.spec.end.cleanup}` : undefined].filter(Boolean).join(", ")}`)
  if (l.by) lines.push(`by: ${l.by}`)
  if (labelsText(l.spec.labels)) lines.push(`labels: ${labelsText(l.spec.labels)}`)
  if (l.artifacts && artifactsText(l.artifacts)) lines.push(`artifacts: ${artifactsText(l.artifacts)}`)
  if (l.history?.length) lines.push("steps:", ...l.history.map(stepText))
  return lines.join("\n")
}
