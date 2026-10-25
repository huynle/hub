// The launch API on /api/agent (design §6.1, §7, §8; decision znbg8xa5): thin HTTP over the launch engine
// (launch-engine.ts, Central.launches).
//
//   POST   /api/agent/launches                     {launch spec}  → 201 {launch}; an idempotent repeat (same key and
//                                                                   body) → 200 {launch}; same key, other body → 400
//   GET    /api/agent/launches?state=a,b&label=k=v  → {launches} (oldest first; every label must match)
//   GET    /api/agent/launches/:id                  → {launch}
//   DELETE /api/agent/launches/:id                  → 200 {launch} (ended stopped); already ended → 410 gone
//
// Who: users always (their own launches; tenancy only). App tokens with scope sessions:launch and sessions through
// their act token (never a shell token) under a grant of their user with verb `launch` covering the repo, in the
// acting order: kill switch → grant usable → grant action consumed (hourly cap; an idempotent repeat spends none)
// → kill switch again → the engine. Apps and sessions see and stop only the launches they started (by); any other
// launch, like another user's, is 404 not_found. The engine applies the per-user launch caps (rate_limited).
// Every outcome once the body is valid is in the agent audit (verb launch, or launch.stop for DELETE).
import type { LaunchInfo, LaunchSpec as WireSpec } from "../../protocol"
import type { ActingSwitch } from "./acting-switch"
import { auditOf } from "./acting"
import type { AgentActor } from "./actor"
import type { AgentAudit, AuditDecision, AuditOutcome, AuditTarget } from "./audit"
import type { Directory } from "./directory"
import { partyFromActor, type Party } from "./envelope"
import { AgentError } from "./errors"
import type { Grant, Grants } from "./grants"
import type { LaunchEngine, LaunchView } from "./launch-engine"
import { type LaunchSpec, validateLaunchSpec } from "./launch-spec"
import { LAUNCH_STATES, type Launch, type LaunchFilter, type LaunchState, type LaunchStep } from "./launch-store"
import type { AgentRoute } from "./routes"

// A literal: routes.ts imports this module (AGENT_PREFIX is not initialised yet when it loads).
const PATH = "/api/agent/launches"
const NO_STORE = { "cache-control": "no-store" }
/** Users; sessions by their act token; apps with sessions:launch. */
const LAUNCH = { act: true, scope: "sessions:launch" } as const

export type RouteLaunches = Pick<LaunchEngine, "accept" | "view" | "list" | "stop">

export interface LaunchRoutesDeps {
  readonly launches: RouteLaunches
  readonly grants: Pick<Grants, "usable" | "consume">
  readonly acting: Pick<ActingSwitch, "ensureActing">
  readonly audit: Pick<AgentAudit, "record">
  /** Names a session caller in the audit. */
  readonly directory?: Pick<Directory, "resolveOne">
}

/** A launch change for its user (the engine's onLaunchChanged). */
export type LaunchListener = (userID: string, launch: Launch) => void

/**
 * Every launch change, per user: the hub's SSE 'launch' events, GET /api/agent/watch and webhooks (P4-T10)
 * subscribe. A throwing listener is logged and never stops the others.
 */
export class LaunchFeed {
  private readonly listeners = new Set<LaunchListener>()

  subscribe(listener: LaunchListener): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  publish(userID: string, launch: Launch): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(userID, launch)
      } catch (cause) {
        console.error(`[hub] launch listener failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
  }
}

/** A launch as the API shows it: LaunchInfo, plus who launched it and its steps. */
export type LaunchApiView = LaunchInfo & { readonly by?: string; readonly history: readonly LaunchStep[] }

const UNITS: readonly [string, number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1000],
]

/** A duration as the launch API writes it (`4h`, `90m`, `45s`). */
function duration(ms: number): string {
  for (const [unit, size] of UNITS) if (ms % size === 0) return `${ms / size}${unit}`
  return `${Math.ceil(ms / 1000)}s`
}

/** The validated spec as a request body (end.timeout as a duration). */
function wireSpec(spec: LaunchSpec): WireSpec {
  const { timeoutMs, ...end } = spec.end
  return { ...spec, end: { ...end, ...(timeoutMs !== undefined ? { timeout: duration(timeoutMs) } : {}) } }
}

/** The API view of a launch: never its owner; `updated` is when it entered its state. */
export function launchInfo(launch: LaunchView): LaunchApiView {
  return {
    id: launch.id,
    state: launch.state,
    reason: launch.reason,
    spec: wireSpec(launch.spec),
    created: launch.created,
    updated: launch.at,
    ...(launch.by !== undefined ? { by: launch.by } : {}),
    ...(launch.machineID !== undefined ? { machineID: launch.machineID } : {}),
    ...(launch.directory !== undefined ? { directory: launch.directory } : {}),
    ...(launch.sessionID !== undefined ? { sessionID: launch.sessionID } : {}),
    ...(launch.name !== undefined ? { name: launch.name } : {}),
    ...(launch.outcome !== undefined ? { outcome: launch.outcome } : {}),
    ...(launch.artifacts !== undefined ? { artifacts: launch.artifacts as LaunchInfo["artifacts"] } : {}),
    history: launch.history,
  }
}

/** Who launched, as the launch records it: `user`, `app:<token id>` or the session ID. */
export function launchedBy(actor: AgentActor): string {
  switch (actor.kind) {
    case "user":
      return "user"
    case "app":
      return `app:${actor.tokenID}`
    case "session":
      return actor.sessionID
  }
}

const invalid = (message: string) => new AgentError("invalid", message)
const notFound = (id: string) => new AgentError("not_found", `No launch ${id}`)

async function bodyOf(request: Request): Promise<unknown> {
  return JSON.parse(await request.text())
}

/** ?state=a,b and ?label=k=v (repeated). */
function filterOf(params: URLSearchParams): LaunchFilter {
  const raw = params.get("state")
  const states = raw === null ? undefined : raw.split(",").filter(Boolean)
  if (states?.some((s) => !(LAUNCH_STATES as readonly string[]).includes(s))) throw invalid(`state must be ${LAUNCH_STATES.join(", ")} (comma-separated)`)
  const labels: Record<string, string> = {}
  for (const label of params.getAll("label")) {
    const at = label.indexOf("=")
    if (at < 1) throw invalid("label must be key=value")
    labels[label.slice(0, at)] = label.slice(at + 1)
  }
  return { ...(states?.length ? { states: states as LaunchState[] } : {}), ...(Object.keys(labels).length ? { labels } : {}) }
}

export function launchRoutes(deps: LaunchRoutesDeps): AgentRoute[] {
  const { launches, grants, acting, audit } = deps

  const party = (userID: string, actor: AgentActor): Party => {
    if (actor.kind !== "session" || !deps.directory) return partyFromActor(actor)
    let name: string | undefined
    try {
      name = deps.directory.resolveOne(userID, actor.sessionID).name
    } catch {}
    return partyFromActor(actor, name ? { name } : {})
  }

  /** The caller's launch: not_found when unknown, another user's, or (apps, sessions) started by someone else. */
  const own = async (userID: string, actor: AgentActor, id: string): Promise<LaunchView> => {
    const launch = await launches.view(userID, id)
    if (!launch || (actor.kind !== "user" && launch.by !== launchedBy(actor))) throw notFound(id)
    return launch
  }

  /**
   * Runs `run` for the caller in the acting order (agents: kill switch, launch grant on the repo, its action
   * spent unless `spend` is false, kill switch again) and audits the outcome.
   */
  async function act<T>(
    userID: string,
    actor: AgentActor,
    verb: string,
    repo: string,
    plan: { readonly target: () => AuditTarget; readonly spend: () => Promise<boolean>; readonly run: () => Promise<T> },
  ): Promise<T> {
    let grant: Grant | undefined
    const record = (decision: AuditDecision, outcome: AuditOutcome, reason?: string) =>
      audit.record(userID, { actor: party(userID, actor), verb, target: plan.target(), ...(grant ? { grant: grant.id } : {}), decision, ...(reason ? { reason } : {}), outcome })
    try {
      if (actor.kind !== "user") {
        acting.ensureActing(userID)
        const usable = await grants.usable(actor, "launch", { directory: repo })
        if (!usable.length) throw new AgentError("forbidden", `No grant lets this ${actor.kind} launch in ${repo}`)
        grant = usable[0]!
        if (await plan.spend()) await grants.consume(grant)
        acting.ensureActing(userID)
      }
      const result = await plan.run()
      await record("allow", "ok")
      return result
    } catch (cause) {
      const [decision, outcome] = auditOf(cause)
      await record(decision, outcome, cause instanceof Error ? cause.message : undefined)
      throw cause
    }
  }

  return [
    {
      method: "POST",
      path: PATH,
      allow: LAUNCH,
      async handle({ request, actor, user }) {
        const raw = await bodyOf(request)
        const spec = validateLaunchSpec(raw)
        const by = launchedBy(actor)
        const held = spec.key === undefined ? undefined : (await launches.list(user.id)).find((l) => l.spec.key === spec.key)
        let launchID: string | undefined
        const result = await act(user.id, actor, "launch", spec.workspace.repo, {
          target: () => (launchID !== undefined ? { launchID } : {}),
          // An idempotent repeat spends no grant action.
          spend: async () => held === undefined,
          run: async () => {
            // An agent never gets another launcher's launch through its key.
            if (held && actor.kind !== "user" && held.by !== by) throw new AgentError("invalid", "This key was used by another launcher", { hint: "Use a key of your own" })
            const accepted = await launches.accept(user.id, raw, { by })
            launchID = accepted.launch.id
            return accepted
          },
        })
        return Response.json({ launch: launchInfo(result.launch) }, { status: result.created ? 201 : 200, headers: NO_STORE })
      },
    },
    {
      method: "GET",
      path: PATH,
      allow: LAUNCH,
      async handle({ url, actor, user }) {
        const filter = filterOf(url.searchParams)
        const by = actor.kind === "user" ? undefined : launchedBy(actor)
        const list = (await launches.list(user.id, filter)).filter((l) => by === undefined || l.by === by)
        return Response.json({ launches: list.map(launchInfo) }, { headers: NO_STORE })
      },
    },
    {
      method: "GET",
      path: `${PATH}/:id`,
      allow: LAUNCH,
      async handle({ params, actor, user }) {
        return Response.json({ launch: launchInfo(await own(user.id, actor, params.id!)) }, { headers: NO_STORE })
      },
    },
    {
      method: "DELETE",
      path: `${PATH}/:id`,
      allow: LAUNCH,
      async handle({ params, actor, user }) {
        const launch = await own(user.id, actor, params.id!)
        const stopped = await act(user.id, actor, "launch.stop", launch.spec.workspace.repo, {
          target: () => ({ launchID: launch.id, ...(launch.sessionID !== undefined ? { sessionID: launch.sessionID } : {}) }),
          spend: async () => true,
          run: () => launches.stop(user.id, launch.id),
        })
        return Response.json({ launch: launchInfo(stopped) }, { headers: NO_STORE })
      },
    },
  ]
}
