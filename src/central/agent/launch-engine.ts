// The launch engine (design §6, §7, §9; decision znbg8xa5): drives a launch from accept to its end. Per user
// (tenancy: every call names its user; another user's launch is not_found).
// - accept: validateLaunchSpec, then (unless it is an idempotent retry of a key) the name must be free (no session
//   holds it and no live launch asks for it: name_taken) and placement admits it (caps: rate_limited); the store
//   creates it queued, the hourly cap counts it, and placement is kicked.
// - Placement (placement.ts, under the user's fenced lease) moves it to provisioning on a node; the engine then
//   runs one pipeline per launch: prepare on the node (requestNode) → launch create on the machine's service spoke
//   (feature "launch": directory, launchID, agent, model) → roles (byUser only for the user's own launches; a refused
//   role is noted, not fatal) → the name (taken meanwhile: failed) → the primer (Delivery.prime, so roles and name
//   are in it) → the prompt (actions.prompt, resetHops false; marked prompted first, so at most once) → running.
//   A stop between steps ends it stopped; the node going away ends it lost; anything else ends it failed.
// - openshell launches (design §6.4, decision lk6gn3u7): after prepare the engine mints the launch's hlt1 token
//   (launchTokens), has the node start the harness in its sandbox (start op with the hub's public URL, which the
//   node rewrites for the sandbox, and the token; work record: started) and waits up to LAUNCH_CONNECT_MS for the
//   harness's launch-bound connection (registry.launchConn; a stop ends the wait at once); the launch create goes
//   to THAT connection, never the service spoke. Ending stops the harness on the node (graceful for idle and
//   needs_user, else kill) before collect and cleanup. A gap of the sandbox's spoke is a gap like any other: lost
//   only after SESSION_LOST_MS. Recovery reuses a still-connected harness or asks start again; a sandbox the node
//   reports for a launch the hub has no record of is the launch's own: stopped (when up) and removed.
// - End watcher (running launches): an idle end only after the prompt was seen working (registry status working,
//   a steer, or the prompt's turn finishing); then idle by real evidence (Registry.idle) with no blockers, none of
//   the session's own asks open and none of its Decisions open, unchanged for END_SETTLE_MS. end.when asked also
//   ends needs_user when a question stays open that long (blocked, or idle with an ask or Decision open); never
//   ends only by stop or timeout. end.timeout counts from running and stops the session (outcome timeout). A
//   session unreported for SESSION_LOST_MS is lost. Registry status events, a tick (END_TICK_MS) and settle/lost
//   timers drive it.
// - Ending: stop the session when asked (stop, timeout), collect artifacts (once prompted) and clean the workspace
//   up on the node (policy: needs_user keeps; never prompted removes; else spec.end.cleanup; the node never removes
//   reused, dirty or unpushed work), then the ended step with artifacts. Node away: its cleanup waits in the work
//   record and runs when the node reconnects (reconcile).
// - Work records (StateStore LAUNCH_WORK, per launch): fence, workspace, sessionID, prompted, seenWorking, pending
//   cleanup, so a restarted hub carries on: queued/placing → placement; provisioning → recover (see recover);
//   running → watched again (seen working and the timeout survive).
// - Cluster mode (design §9, decision vkxkqiuf §7): start() makes the engine the supervisor (placement, pipelines,
//   end watchers, node reconcile); the hub calls it on the leader pod only and shutdown() when the pod loses the
//   lease (its provisioning runs stop at their next step and the next leader recovers them from the work records).
//   accept() works on any pod: a pod that does not supervise kicks the leader (deps.supervisor), and a stop of a
//   provisioning or running launch goes to the leader, where its pipeline or watch lives.
// - onLaunchChanged gets every change the engine makes (queued, provisioning, running, ended); placement's own
//   intermediate steps (placing, re-queued) are not reported.
import type { NodeListener, NodeView } from "../nodes"
import type { ModelSelection, NodeLaunchPhase, NodeLaunchReport, NodeRequest, NodeResultFor, PreparedWorkspace, ServerRequest } from "../../protocol"
import type { Clock, Counters, Locks, StateStore, Timers } from "../backend/types"
import type { HubLaunches } from "../config"
import type { Registry } from "../registry"
import type { Actions } from "../actions"
import type { Decisions } from "./decisions"
import type { Delivery } from "./delivery"
import type { Directory } from "./directory"
import { AgentError } from "./errors"
import { validateLaunchSpec } from "./launch-spec"
import type { CleanupPolicy, LaunchSpec } from "./launch-spec"
import { type Launch, type LaunchFilter, type LaunchOutcome, type LaunchState, LaunchStore, LaunchTransitionError } from "./launch-store"
import { Placement, PlacementLoop, type Placed, type PlacementNode } from "./placement"

/** The NodeRegistry calls the engine needs. */
export type EngineNodes = { list(ownerID?: string): NodeView[]; forMachine(machineID: string): NodeView | undefined; subscribe(listener: NodeListener): () => void }
/** Node ops (SpokeHub.requestNode). */
export interface EngineNodeOps {
  requestNode<R extends NodeRequest>(connID: string, req: R): Promise<NodeResultFor[R["op"]]>
}
export type EngineRegistry = Pick<Registry, "serviceFor" | "supports" | "connTenant" | "hasSession" | "idle" | "session" | "subscribe" | "onSessions" | "launchConn">
/** Mints the launch-bound token (hlt1) a sandboxed harness connects back with (LaunchTokens). */
export interface EngineLaunchTokens {
  mint(machineID: string, launchID: string): Promise<{ readonly token: string; readonly exp: number } | undefined>
}
/** Spoke ops (SpokeHub.request). */
export interface EngineSpokes {
  request(connID: string, req: ServerRequest): Promise<unknown>
}
export type EngineDirectory = Pick<Directory, "sync" | "setName" | "claimRole" | "resolve">
export interface EngineDelivery {
  prime: Delivery["prime"]
  readonly messages: Pick<Delivery["messages"], "inbox">
}
export type EngineDecisions = Pick<Decisions, "list">

/**
 * Cluster mode: the supervisor (start()) runs on the leader pod only (../cluster/leader.ts); an engine that does not
 * supervise hands it work: a queued launch kicks it, a stop of a provisioning or running launch goes to it (its
 * pipeline and end watcher live there). stop resolves undefined when no supervisor answers: the pod stops it itself.
 */
export interface EngineSupervisor {
  kick(userID: string): void
  stop(userID: string, id: string, reason: string): Promise<Launch | undefined>
}
export type EngineActions = Pick<Actions, "prompt" | "stop">

export interface LaunchEngineDeps {
  readonly state: StateStore
  readonly counters: Counters
  readonly locks: Locks
  /** This process (pod), as placement lease owner. */
  readonly owner: string
  readonly caps?: HubLaunches
  readonly nodes: EngineNodes
  readonly nodeOps: EngineNodeOps
  readonly registry: EngineRegistry
  readonly spokes: EngineSpokes
  readonly directory: EngineDirectory
  readonly delivery: EngineDelivery
  readonly decisions: EngineDecisions
  readonly actions: EngineActions
  /** Launch-bound tokens for sandboxed (openshell) launches; without them (or hubURL) such launches fail. */
  readonly launchTokens?: EngineLaunchTokens
  /** The hub's public URL, handed to the node at start (the node rewrites a loopback URL for its sandbox). */
  readonly hubURL?: string
  /** Users that may have launches (restart recovery and the placement sweep). */
  readonly users: () => Promise<readonly string[]> | readonly string[]
  readonly now?: Clock
  readonly timers?: Timers
  /** Every launch change the engine makes (SSE events and webhooks hang off this). */
  readonly onLaunchChanged?: (launch: Launch) => void
  /** Cluster mode: the leader's supervisor, for an engine that does not supervise (see EngineSupervisor). */
  readonly supervisor?: EngineSupervisor
}

const LIVE: readonly LaunchState[] = ["queued", "placing", "provisioning", "running"]
/** Engine state per launch beside the store's record (StateStore collection, key: the launch ID). */
export const LAUNCH_WORK = "launch-work"

/** What the engine knows about a launch's run, kept so a restarted hub can carry on. */
export interface LaunchWork {
  /** The placement lease fence the launch was placed under. */
  readonly fence?: number
  /** The workspace the node prepared (collect and cleanup carry it back). */
  readonly workspace?: PreparedWorkspace
  readonly sessionID?: string
  /** The prompt was handed to the session (at most once). */
  readonly prompted?: boolean
  /** The session was seen working after its prompt (an idle end may start). */
  readonly seenWorking?: boolean
  /** The launch ended while its node was away: the cleanup policy to apply when it comes back. */
  readonly cleanup?: CleanupPolicy
  /** The node was asked to start the launch's harness (openshell): it must be stopped at the end. */
  readonly started?: boolean
}

/** How long a session must stay idle (or asking) with nothing changing before its launch ends. */
export const END_SETTLE_MS = 30_000
/** How often running launches are looked at again (asks and Decisions change without registry events). */
export const END_TICK_MS = 15_000
/** How long a running launch's session may go unreported before the launch is lost. */
export const SESSION_LOST_MS = 10 * 60_000

/** A provisioning run in this process; stop: a stop was asked for (its reason). */
interface Pipeline {
  done: Promise<void>
  stop?: string
  /** Ends a wait in progress (for the harness's connection) when a stop comes. */
  abort?: () => void
  /** The engine stopped supervising (shutdown): the run stops at its next checkpoint, leaving the launch as it is. */
  abandoned?: boolean
}

/** Thrown at a provisioning checkpoint after a stop. */
class StopRequested extends Error {}

/** Thrown at a provisioning checkpoint once the engine stopped supervising (the next leader recovers the launch). */
class Abandoned extends Error {}

/** The node is gone (or never came back): the launch is lost. */
class LostError extends Error {}

/** How long the engine waits for a started sandbox harness to connect back (its launch-bound connection). */
export const LAUNCH_CONNECT_MS = 120_000

/** How long a restarted hub waits for a provisioning launch's node to (re)connect or let the launch go. */
export const NODE_RETURN_MS = 5 * 60_000

/** Node phases after which the node holds nothing for the launch. */
const RELEASED: ReadonlySet<NodeLaunchPhase> = new Set(["cancelled", "failed", "cleaned"])

/** Node phases in which the node runs the launch's harness (openshell): it is stopped before cleanup. */
const HARNESS_UP: ReadonlySet<NodeLaunchPhase> = new Set(["starting", "running"])

/**
 * A workspace the node reports for a launch the hub has no record of. On the host it counts as reused, so cleanup
 * never removes it; an openshell sandbox exists only for its launch, so it is the launch's own (removable).
 */
function leftWorkspace(launch: Launch, report: Pick<NodeLaunchReport, "directory" | "sandbox">): PreparedWorkspace | undefined {
  if (report.directory === undefined) return undefined
  const { repo, mode, branch, base } = launch.spec.workspace
  const { kind, profile } = launch.spec.runtime
  const sandboxed = kind === "openshell"
  return {
    repo,
    directory: report.directory,
    mode,
    ...(branch !== undefined ? { branch } : {}),
    ...(base !== undefined ? { base } : {}),
    reused: !sandboxed,
    ...(sandboxed ? { runtime: { kind, ...(report.sandbox !== undefined ? { sandbox: report.sandbox } : {}), ...(profile !== undefined ? { profile } : {}) } } : {}),
  }
}

/** A running launch being watched for its end. */
interface Watch {
  readonly userID: string
  readonly launchID: string
  readonly sessionID: string
  readonly when: LaunchSpec["end"]["when"]
  seenWorking: boolean
  /** The end it would take and since when that has held. */
  candidate?: { readonly outcome: LaunchOutcome; readonly since: number }
  unreportedSince?: number
  settleTimer?: unknown
  lostTimer?: unknown
  timeoutTimer?: unknown
  /** An evaluation runs; again: one more after it. */
  evaluating?: boolean
  again?: boolean
}

const defaultTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** A launch as the API shows it: the stored launch plus its session's directory. */
export type LaunchView = Launch & { readonly directory?: string }

/** `provider/model#variant` as a ModelSelection. */
export function modelSelection(model: string): ModelSelection {
  const slash = model.indexOf("/")
  const rest = model.slice(slash + 1)
  const hash = rest.lastIndexOf("#")
  return hash > 0
    ? { providerID: model.slice(0, slash), modelID: rest.slice(0, hash), variant: rest.slice(hash + 1) }
    : { providerID: model.slice(0, slash), modelID: rest }
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The user's connected nodes as placement sees them. */
export function placementNodes(nodes: Pick<EngineNodes, "list">): { nodes(userID: string): PlacementNode[] } {
  return {
    nodes: (userID) =>
      nodes.list(userID).map((node) => ({
        machineID: node.machineID,
        name: node.machineName,
        owner: node.ownerID ?? "",
        runtimes: node.runtimes,
        labels: node.labels,
        capacity: node.capacity,
        used: node.used,
        workspaceRoots: node.workspaceRoots,
        draining: node.draining,
        launchIDs: node.launches.map((l) => l.launchID),
        features: node.features,
      })),
  }
}

export class LaunchEngine {
  readonly store: LaunchStore
  readonly placement: Placement
  readonly loop: PlacementLoop
  private readonly now: Clock
  private readonly unsubscribe: (() => void)[] = []
  /** Ends in progress, by launch ID. */
  private readonly ending = new Map<string, Promise<Launch | undefined>>()
  /** Provisioning runs in this process, by launch ID. */
  private readonly pipelines = new Map<string, Pipeline>()
  /** Running launches watched for their end, by launch ID. */
  private readonly watches = new Map<string, Watch>()
  /** Launches whose prompt was seen working before their watch was armed. */
  private readonly seenEarly = new Set<string>()
  private readonly timers: Timers
  private tickTimer: unknown
  /** start() ran and shutdown() did not: this engine runs placement, pipelines and end watchers. */
  private supervising = false

  constructor(private readonly deps: LaunchEngineDeps) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? defaultTimers
    this.store = new LaunchStore({ state: deps.state, now: this.now })
    const { registry } = deps
    this.placement = new Placement({
      store: this.store,
      nodes: placementNodes(deps.nodes),
      spokes: {
        launchService: (_userID, machineID) => {
          const connID = registry.serviceFor(machineID)
          return connID !== undefined && registry.supports(connID, "launch")
        },
      },
      counters: deps.counters,
      locks: deps.locks,
      owner: deps.owner,
      ...(deps.caps ? { caps: deps.caps } : {}),
      now: this.now,
    })
    this.loop = new PlacementLoop({
      placement: this.placement,
      users: async () => [...(await deps.users())],
      onPlaced: (placed) => void this.provision(placed),
      ...(deps.timers ? { timers: deps.timers } : {}),
    })
  }

  /**
   * Validates and queues a launch (or, same key and body, returns the existing one with created false). Throws
   * invalid, name_taken (the name is held by a session or another live launch) or rate_limited (caps).
   */
  async accept(userID: string, body: unknown, options: { readonly by?: string } = {}): Promise<{ launch: Launch; created: boolean }> {
    const spec = validateLaunchSpec(body)
    const launches = await this.store.list(userID)
    const retry = spec.key !== undefined && launches.some((l) => l.spec.key === spec.key)
    if (!retry) {
      if (spec.name !== undefined) this.checkName(userID, spec.name, launches)
      await this.placement.admit(userID)
    }
    const result = await this.store.create(userID, spec, options.by !== undefined ? { by: options.by } : {})
    if (result.created) {
      await this.placement.recordLaunch(userID)
      this.changed(result.launch)
      this.kick(userID)
    }
    return result
  }

  /** The launch with its directory; undefined for an unknown (or another user's) launch. */
  async view(userID: string, id: string): Promise<LaunchView | undefined> {
    const launch = await this.store.get(userID, id)
    if (!launch) return undefined
    const directory = (await this.work(userID, id))?.workspace?.directory
    return directory !== undefined ? { ...launch, directory } : launch
  }

  /** The user's launches by creation (filtered), with their directories. */
  async list(userID: string, filter: LaunchFilter = {}): Promise<LaunchView[]> {
    const launches = await this.store.list(userID, filter)
    return Promise.all(
      launches.map(async (launch) => {
        const directory = (await this.work(userID, launch.id))?.workspace?.directory
        return directory !== undefined ? { ...launch, directory } : launch
      }),
    )
  }

  /** The labels of the (latest) launch that started the session, or undefined when no launch did. */
  async labelsFor(userID: string, sessionID: string): Promise<Readonly<Record<string, string>> | undefined> {
    const launches = await this.store.list(userID)
    return launches.reverse().find((l) => l.sessionID === sessionID)?.spec.labels
  }

  /**
   * Starts the engine: re-arms running launches, recovers provisioning ones, starts placement (sweep, and kicks
   * on node and spoke changes) and reconciles nodes that connect.
   */
  async start(): Promise<void> {
    if (this.supervising) return
    this.supervising = true
    const { nodes, registry } = this.deps
    this.unsubscribe.push(
      nodes.subscribe((event) => {
        if (event.type === "disconnected" || event.node.ownerID === undefined) return
        if (event.type === "connected") void this.reconcile(event.node)
        void this.loop.kick(event.node.ownerID)
      }),
      registry.subscribe((message) => {
        if (message.type === "status") {
          const ids = new Set([message.sessionID, ...message.sessions.map((s) => s.id)])
          for (const watch of this.watches.values()) if (ids.has(watch.sessionID)) this.evaluate(watch)
        } else if (message.type === "catalog") for (const watch of this.watches.values()) this.evaluate(watch)
      }),
      registry.onSessions((connID) => {
        const userID = registry.connTenant(connID)
        if (userID !== undefined) void this.loop.kick(userID)
      }),
    )
    this.loop.start()
    this.scheduleTick()
    for (const userID of await this.deps.users()) {
      try {
        for (const launch of await this.store.list(userID, { states: ["provisioning", "running"] })) {
          if (launch.state === "running") this.arm(userID, launch, (await this.work(userID, launch.id))?.seenWorking === true)
          else void this.recover(userID, launch)
        }
      } catch (cause) {
        console.error(`[hub] launch recovery for ${userID} failed: ${errorText(cause)}`)
      }
      void this.loop.kick(userID)
    }
  }

  /** Stops supervising: placement, end watchers and listeners stop; provisioning runs stop at their next step. */
  shutdown(): void {
    this.supervising = false
    for (const pipeline of this.pipelines.values()) {
      pipeline.abandoned = true
      pipeline.abort?.()
    }
    this.loop.stop()
    if (this.tickTimer !== undefined) this.timers.clear(this.tickTimer)
    this.tickTimer = undefined
    for (const id of [...this.watches.keys()]) this.disarm(id)
    for (const off of this.unsubscribe.splice(0)) off()
  }

  // ---- provisioning ------------------------------------------------------------------------------------

  /**
   * Stops a launch (DELETE): a queued one ends at once; a provisioning one is cancelled on the node and ends before
   * its session is created or prompted; a running one has its session stopped, then artifacts and cleanup. Throws
   * not_found (unknown, or another user's) or gone (already ended).
   */
  async stop(userID: string, id: string, reason = "Stopped"): Promise<Launch> {
    for (;;) {
      const launch = await this.store.get(userID, id)
      if (!launch) throw new AgentError("not_found", `No launch ${id}`)
      if (!this.supervising && this.deps.supervisor && (launch.state === "provisioning" || launch.state === "running")) {
        const stopped = await this.deps.supervisor.stop(userID, id, reason)
        if (stopped) return stopped
      }
      switch (launch.state) {
        case "ended":
          throw new AgentError("gone", "The launch already ended")
        case "queued":
        case "placing":
          try {
            const ended = await this.store.transition(userID, id, "ended", { reason, outcome: "stopped", from: ["queued", "placing"] })
            this.changed(ended)
            return ended
          } catch (cause) {
            // Placement moved it on meanwhile: stop it where it is now.
            if (cause instanceof LaunchTransitionError && cause.code !== "gone") continue
            throw cause
          }
        case "provisioning": {
          const pipeline = this.pipelines.get(id)
          if (pipeline) {
            pipeline.stop = reason
            const node = launch.machineID !== undefined ? this.deps.nodes.forMachine(launch.machineID) : undefined
            const cancelled = node ? this.deps.nodeOps.requestNode(node.connID, { op: "cancel", launchID: id }).catch(() => undefined) : undefined
            pipeline.abort?.()
            await cancelled
            await pipeline.done
            return (await this.store.get(userID, id))!
          }
          return (await this.end(userID, id, "stopped", reason))!
        }
        case "running":
          return (await this.end(userID, id, "stopped", reason, { stopSession: true }))!
      }
    }
  }

  /** A placement pass for the user: here when this engine supervises, else on the supervisor (leader). */
  kick(userID: string): void {
    if (!this.supervising && this.deps.supervisor) this.deps.supervisor.kick(userID)
    else void this.loop.kick(userID)
  }

  /** A placed launch: prepare → create → roles, name, primer → prompt → running. */
  private provision(placed: Placed): Promise<void> {
    const { userID, launch } = placed
    return this.pipeline(userID, launch, async (checkpoint) => {
      this.changed(launch)
      await this.putWork(userID, launch.id, { fence: placed.fence })
      const workspace = await this.prepare(userID, launch)
      checkpoint()
      const connID = await this.harnessConn(userID, launch, workspace)
      checkpoint()
      const sessionID = await this.create(userID, launch, workspace, connID)
      checkpoint()
      await this.identify(userID, launch, sessionID, checkpoint)
    })
  }

  /**
   * A launch a previous run of the hub left provisioning carries on from its work record: prompted → running;
   * a session → identity and prompt; a workspace → the launch create; nothing → whatever the node still holds
   * for it is released (a running prepare cancelled, a prepared workspace kept as reused), then prepare again.
   * A node that does not come back within NODE_RETURN_MS loses the launch.
   */
  private recover(userID: string, launch: Launch): Promise<void> {
    return this.pipeline(userID, launch, async (checkpoint) => {
      const work = (await this.work(userID, launch.id)) ?? {}
      if (work.sessionID !== undefined) {
        if (work.prompted) await this.toRunning(userID, launch, work.sessionID, [], work.seenWorking === true)
        else await this.identify(userID, launch, work.sessionID, checkpoint)
        return
      }
      let workspace = work.workspace
      if (!workspace) {
        const node = await this.waitForNode(launch.machineID!)
        await this.releaseOnNode(node, launch)
        checkpoint()
        workspace = await this.prepare(userID, launch)
        checkpoint()
      }
      const connID = await this.harnessConn(userID, launch, workspace, work.workspace !== undefined && work.started === true)
      checkpoint()
      const sessionID = await this.create(userID, launch, workspace, connID)
      checkpoint()
      await this.identify(userID, launch, sessionID, checkpoint)
    })
  }

  /** Runs provisioning steps once per launch in this process; a failure ends the launch (stopped, lost or failed). */
  private pipeline(userID: string, launch: Launch, steps: (checkpoint: () => void) => Promise<void>): Promise<void> {
    const running = this.pipelines.get(launch.id)
    if (running) return running.done
    const pipeline: Pipeline = { done: Promise.resolve() }
    this.pipelines.set(launch.id, pipeline)
    const checkpoint = () => {
      if (pipeline.abandoned) throw new Abandoned()
      if (pipeline.stop !== undefined) throw new StopRequested()
    }
    pipeline.done = (async () => {
      try {
        await steps(checkpoint)
      } catch (cause) {
        if (pipeline.abandoned) return
        if (pipeline.stop !== undefined) {
          await this.end(userID, launch.id, "stopped", pipeline.stop)
          return
        }
        const gone = cause instanceof LostError || this.deps.nodes.forMachine(launch.machineID!) === undefined
        const reason = cause instanceof LostError ? cause.message : gone ? "The node went away while preparing the launch" : `Failed: ${errorText(cause)}`
        await this.end(userID, launch.id, gone ? "lost" : "failed", reason)
      }
    })()
      .catch((cause) => console.error(`[hub] launch ${launch.id}: ${errorText(cause)}`))
      .finally(() => this.pipelines.delete(launch.id))
    return pipeline.done
  }

  /** The machine's node, now or once it connects (LostError after NODE_RETURN_MS). */
  private waitForNode(machineID: string): Promise<NodeView> {
    const { nodes } = this.deps
    const now = nodes.forMachine(machineID)
    if (now) return Promise.resolve(now)
    return new Promise((resolve, reject) => {
      const off = nodes.subscribe((event) => {
        if (event.type !== "connected" || event.node.machineID !== machineID) return
        done()
        resolve(event.node)
      })
      const timer = this.timers.set(() => {
        done()
        reject(new LostError(`The node did not come back within ${NODE_RETURN_MS / 60_000} minutes`))
      }, NODE_RETURN_MS)
      const done = () => {
        off()
        this.timers.clear(timer)
      }
    })
  }

  /**
   * Releases what the node still holds for a launch the hub lost track of: cancels a prepare, keeps a host
   * workspace (as reused), stops and removes an openshell sandbox (the launch's own, nothing collected yet).
   */
  private async releaseOnNode(node: NodeView, launch: Launch): Promise<void> {
    const report = node.launches.find((l) => l.launchID === launch.id)
    if (!report) return
    const { nodeOps } = this.deps
    if (report.phase === "preparing") {
      const released = this.waitForRelease(node.machineID, launch.id)
      await nodeOps.requestNode(node.connID, { op: "cancel", launchID: launch.id })
      await released
      return
    }
    const workspace = leftWorkspace(launch, report)
    if (!workspace) return
    if (HARNESS_UP.has(report.phase)) await nodeOps.requestNode(node.connID, { op: "stop", launchID: launch.id, workspace, mode: "kill" })
    await nodeOps.requestNode(node.connID, { op: "cleanup", launchID: launch.id, workspace, policy: workspace.reused ? "keep" : "remove" })
  }

  /** Resolves when the node lets the launch go (cancelled, failed or cleaned); LostError when the node goes. */
  private waitForRelease(machineID: string, launchID: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const off = this.deps.nodes.subscribe((event) => {
        if (event.node.machineID !== machineID) return
        if (event.type === "progress" && event.launchID === launchID && RELEASED.has(event.phase)) {
          done()
          resolve()
        } else if (event.type === "disconnected") {
          done()
          reject(new LostError("The node went away"))
        }
      })
      const timer = this.timers.set(() => {
        done()
        reject(new LostError(`The node did not let the launch go within ${NODE_RETURN_MS / 60_000} minutes`))
      }, NODE_RETURN_MS)
      const done = () => {
        off()
        this.timers.clear(timer)
      }
    })
  }

  /** A node (re)connected: it cleans up what it still holds for launches that ended (or that this hub forgot). */
  private async reconcile(node: NodeView): Promise<void> {
    const userID = node.ownerID
    if (userID === undefined) return
    const { nodeOps } = this.deps
    for (const report of node.launches) {
      if (this.pipelines.has(report.launchID)) continue
      const launch = await this.store.get(userID, report.launchID)
      if (launch && launch.state !== "ended") continue
      try {
        if (report.phase === "preparing") {
          await nodeOps.requestNode(node.connID, { op: "cancel", launchID: report.launchID })
          continue
        }
        const work = await this.work(userID, report.launchID)
        const workspace = work?.workspace ?? (launch ? leftWorkspace(launch, report) : undefined)
        if (!workspace) continue
        if (HARNESS_UP.has(report.phase)) await nodeOps.requestNode(node.connID, { op: "stop", launchID: report.launchID, workspace, mode: "kill" })
        await nodeOps.requestNode(node.connID, { op: "cleanup", launchID: report.launchID, workspace, policy: work?.cleanup ?? (workspace.reused ? "keep" : "remove") })
      } catch (cause) {
        console.error(`[hub] launch ${report.launchID}: cleanup on the node failed: ${errorText(cause)}`)
      }
    }
  }

  private async prepare(userID: string, launch: Launch): Promise<PreparedWorkspace> {
    const node = this.deps.nodes.forMachine(launch.machineID!)
    if (!node) throw new Error("The node is not connected")
    const { spec } = launch
    const { workspace } = await this.deps.nodeOps.requestNode(node.connID, {
      op: "prepare",
      launchID: launch.id,
      runtime: spec.runtime,
      harness: spec.harness,
      workspace: spec.workspace,
    })
    await this.updateWork(userID, launch.id, { workspace })
    return workspace
  }

  /**
   * The connection that creates the launch's session: the machine's service spoke (host), or for openshell the
   * launch-bound connection of the harness the node starts in its sandbox.
   */
  private async harnessConn(userID: string, launch: Launch, workspace: PreparedWorkspace, started = false): Promise<string> {
    const { registry } = this.deps
    if (launch.spec.runtime.kind === "openshell") {
      // A harness started before a hub restart may still be connected; else it is (re)started (a node already
      // running it answers started false, and the harness reconnects with its own token).
      const connected = started ? registry.launchConn(launch.id) : undefined
      return connected ?? this.startHarness(userID, launch, workspace)
    }
    const connID = registry.serviceFor(launch.machineID!)
    if (connID === undefined || !registry.supports(connID, "launch")) throw new Error("The machine has no connected service spoke with launch")
    return connID
  }

  /** Mints the launch's token, has the node start the harness with it and waits for its launch-bound connection. */
  private async startHarness(userID: string, launch: Launch, workspace: PreparedWorkspace): Promise<string> {
    const { launchTokens, hubURL, nodeOps, nodes } = this.deps
    if (!launchTokens || hubURL === undefined) throw new Error("This hub cannot start sandboxed launches")
    const node = nodes.forMachine(launch.machineID!) ?? (await this.waitForNode(launch.machineID!))
    const minted = await launchTokens.mint(launch.machineID!, launch.id)
    if (!minted) throw new Error("The hub could not mint the launch token")
    await this.updateWork(userID, launch.id, { started: true })
    await nodeOps.requestNode(node.connID, { op: "start", launchID: launch.id, workspace, harness: launch.spec.harness, hub: { url: hubURL, token: minted.token } })
    return this.waitForLaunchConn(launch.id)
  }

  /**
   * The launch's launch-bound connection, now or once it connects; fails after LAUNCH_CONNECT_MS, and at once
   * (StopRequested) when the launch is stopped meanwhile.
   */
  private waitForLaunchConn(launchID: string): Promise<string> {
    const { registry } = this.deps
    const now = registry.launchConn(launchID)
    if (now !== undefined) return Promise.resolve(now)
    const pipeline = this.pipelines.get(launchID)
    if (pipeline?.stop !== undefined) return Promise.reject(new StopRequested())
    return new Promise((resolve, reject) => {
      const off = registry.subscribe((message) => {
        if (message.type !== "catalog") return
        const connID = registry.launchConn(launchID)
        if (connID === undefined) return
        done()
        resolve(connID)
      })
      const timer = this.timers.set(() => {
        done()
        reject(new Error(`The sandbox's harness did not connect within ${LAUNCH_CONNECT_MS / 1000} s`))
      }, LAUNCH_CONNECT_MS)
      if (pipeline) {
        pipeline.abort = () => {
          done()
          reject(new StopRequested())
        }
      }
      const done = () => {
        off()
        this.timers.clear(timer)
        if (pipeline) pipeline.abort = undefined
      }
    })
  }

  private async create(userID: string, launch: Launch, workspace: PreparedWorkspace, connID: string): Promise<string> {
    const { registry, spokes } = this.deps
    if (!registry.supports(connID, "launch")) throw new Error("The launch's spoke does not create launch sessions")
    const { spec } = launch
    const result = (await spokes.request(connID, {
      op: "create",
      directory: workspace.directory,
      ...(spec.name !== undefined ? { title: spec.name } : {}),
      launchID: launch.id,
      ...(spec.agent !== undefined ? { agent: spec.agent } : {}),
      ...(spec.model !== undefined ? { model: modelSelection(spec.model) } : {}),
    })) as { sessionID: string }
    await this.updateWork(userID, launch.id, { sessionID: result.sessionID })
    return result.sessionID
  }

  /** Roles, the name and the primer, then the prompt; the launch is running. */
  private async identify(userID: string, launch: Launch, sessionID: string, checkpoint: () => void = () => {}): Promise<void> {
    const { directory, delivery, actions } = this.deps
    const { spec } = launch
    await directory.sync(userID)
    const notes: string[] = []
    const byUser = launch.by === undefined || launch.by === "user"
    for (const role of spec.roles) {
      try {
        await directory.claimRole(userID, sessionID, role, byUser ? { byUser: true } : {})
      } catch (cause) {
        notes.push(`@@${role} not claimed: ${errorText(cause)}`)
      }
    }
    if (spec.name !== undefined) await directory.setName(userID, sessionID, spec.name)
    await delivery.prime(userID, sessionID)
    checkpoint()
    if (spec.prompt !== undefined) {
      await this.updateWork(userID, launch.id, { prompted: true })
      const prompted = await actions.prompt({ sessionID, text: spec.prompt, resetHops: false })
      if (prompted.outcome === "offline") throw new Error("The session went offline before its prompt")
      if (prompted.mode === "steer") this.sawWorking(userID, launch.id)
      else void prompted.result.then(
        () => this.sawWorking(userID, launch.id),
        () => this.sawWorking(userID, launch.id),
      )
    }
    await this.toRunning(userID, launch, sessionID, notes, false)
  }

  private async toRunning(userID: string, launch: Launch, sessionID: string, notes: readonly string[], seenWorking: boolean): Promise<void> {
    const { name } = launch.spec
    const running = await this.store.transition(userID, launch.id, "running", {
      reason: ["Running", ...notes].join("; "),
      sessionID,
      ...(name !== undefined ? { name } : {}),
      from: ["provisioning"],
    })
    this.changed(running)
    this.arm(userID, running, seenWorking)
  }

  // ---- the end watcher ----------------------------------------------------------------------------------

  /** Watches a running launch for its end (timeout, idle or asked, a lost session). */
  private arm(userID: string, launch: Launch, seenWorking: boolean): void {
    if (this.watches.has(launch.id) || launch.sessionID === undefined) return
    const watch: Watch = { userID, launchID: launch.id, sessionID: launch.sessionID, when: launch.spec.end.when, seenWorking: seenWorking || this.seenEarly.delete(launch.id) }
    this.watches.set(launch.id, watch)
    const { timeoutMs } = launch.spec.end
    if (timeoutMs !== undefined) {
      watch.timeoutTimer = this.timers.set(
        () => void this.end(userID, launch.id, "timeout", "Timed out", { stopSession: true }),
        Math.max(0, launch.at + timeoutMs - this.now()),
      )
    }
    this.evaluate(watch)
  }

  private disarm(id: string): void {
    const watch = this.watches.get(id)
    if (!watch) return
    this.watches.delete(id)
    for (const timer of [watch.settleTimer, watch.lostTimer, watch.timeoutTimer]) if (timer !== undefined) this.timers.clear(timer)
  }

  /** The launch's prompt was seen working: an idle end may start from now on. */
  private sawWorking(userID: string, id: string): void {
    const watch = this.watches.get(id)
    if (!watch) {
      this.seenEarly.add(id)
      return
    }
    if (!watch.seenWorking) {
      watch.seenWorking = true
      void this.updateWork(userID, id, { seenWorking: true }).catch((cause) => console.error(`[hub] launch ${id}: ${errorText(cause)}`))
    }
    this.evaluate(watch)
  }

  private scheduleTick(): void {
    this.tickTimer = this.timers.set(() => {
      for (const watch of this.watches.values()) this.evaluate(watch)
      this.scheduleTick()
    }, END_TICK_MS)
  }

  /** Looks at the watched launch now (one evaluation at a time per launch; a call during one makes one more). */
  private evaluate(watch: Watch): void {
    if (watch.evaluating) {
      watch.again = true
      return
    }
    watch.evaluating = true
    void (async () => {
      try {
        do {
          watch.again = false
          await this.evaluateNow(watch)
        } while (watch.again && this.watches.get(watch.launchID) === watch)
      } catch (cause) {
        console.error(`[hub] launch ${watch.launchID}: end check failed: ${errorText(cause)}`)
      } finally {
        watch.evaluating = false
      }
    })()
  }

  private async evaluateNow(watch: Watch): Promise<void> {
    if (this.watches.get(watch.launchID) !== watch || this.ending.has(watch.launchID)) return
    const { registry, delivery, decisions } = this.deps
    const { userID, sessionID } = watch
    const now = this.now()
    if (!registry.hasSession(sessionID)) {
      this.clearCandidate(watch)
      watch.unreportedSince ??= now
      if (now - watch.unreportedSince >= SESSION_LOST_MS) {
        await this.end(userID, watch.launchID, "lost", `The session was not reported for ${SESSION_LOST_MS / 60_000} minutes`)
      } else if (watch.lostTimer === undefined) {
        watch.lostTimer = this.timers.set(() => {
          watch.lostTimer = undefined
          this.evaluate(watch)
        }, watch.unreportedSince + SESSION_LOST_MS - now)
      }
      return
    }
    watch.unreportedSince = undefined
    if (watch.lostTimer !== undefined) this.timers.clear(watch.lostTimer)
    watch.lostTimer = undefined
    const view = registry.session(sessionID)
    if (view?.state === "working") {
      this.clearCandidate(watch)
      if (!watch.seenWorking) this.sawWorking(userID, watch.launchID)
      return
    }
    if (!watch.seenWorking || watch.when === "never") return
    const party = { kind: "session", sessionID } as const
    const asks = (await delivery.messages.inbox(userID, party)).waiting.length
    const open = (view?.blockers.length ?? 0) + asks + (await decisions.list(userID, { state: "open", from: party })).length > 0
    const idle = registry.idle(sessionID)
    const outcome: LaunchOutcome | undefined =
      idle && !open ? "idle" : watch.when === "asked" && open && (idle || view?.state === "blocked") ? "needs_user" : undefined
    if (outcome === undefined) return this.clearCandidate(watch)
    // Times are when the state was read (now), not after the awaits.
    if (watch.candidate?.outcome !== outcome) {
      this.clearCandidate(watch)
      watch.candidate = { outcome, since: now }
      watch.settleTimer = this.timers.set(() => {
        watch.settleTimer = undefined
        this.evaluate(watch)
      }, Math.max(0, now + END_SETTLE_MS - this.now()))
      return
    }
    if (now - watch.candidate.since < END_SETTLE_MS) return
    await this.end(userID, watch.launchID, outcome, outcome === "idle" ? "Idle: the session finished" : "Needs the user: the session asked a question")
  }

  private clearCandidate(watch: Watch): void {
    watch.candidate = undefined
    if (watch.settleTimer !== undefined) this.timers.clear(watch.settleTimer)
    watch.settleTimer = undefined
  }

  // ---- the end ---------------------------------------------------------------------------------------------

  /**
   * Ends a live launch once (concurrent calls share the first): stops its session when asked, collects artifacts
   * and cleans the workspace up on the node, then records the ended step. Resolves with the launch as it is then.
   */
  private end(userID: string, id: string, outcome: LaunchOutcome, reason: string, options: { readonly stopSession?: boolean } = {}): Promise<Launch | undefined> {
    const running = this.ending.get(id)
    if (running) return running
    const run = this.endNow(userID, id, outcome, reason, options).finally(() => this.ending.delete(id))
    this.ending.set(id, run)
    return run
  }

  private async endNow(userID: string, id: string, outcome: LaunchOutcome, reason: string, options: { readonly stopSession?: boolean }): Promise<Launch | undefined> {
    const launch = await this.store.get(userID, id)
    if (!launch || launch.state === "ended") return launch
    const work = await this.work(userID, id)
    if (options.stopSession && work?.sessionID) {
      await this.deps.actions.stop(work.sessionID).catch((cause) => console.error(`[hub] launch ${id}: stopping its session failed: ${errorText(cause)}`))
    }
    const notes: string[] = []
    let artifacts: Record<string, unknown> | undefined
    if (work?.workspace) {
      const policy: CleanupPolicy = outcome === "needs_user" ? "keep" : !work.prompted ? "remove" : launch.spec.end.cleanup
      const node = launch.machineID !== undefined ? this.deps.nodes.forMachine(launch.machineID) : undefined
      if (node) {
        if (work.started) {
          const mode = outcome === "idle" || outcome === "needs_user" ? "graceful" : "kill"
          try {
            await this.deps.nodeOps.requestNode(node.connID, { op: "stop", launchID: id, workspace: work.workspace, mode })
          } catch (cause) {
            notes.push(`harness not stopped: ${errorText(cause)}`)
          }
        }
        if (work.prompted) {
          try {
            artifacts = { ...(await this.deps.nodeOps.requestNode(node.connID, { op: "collect", launchID: id, workspace: work.workspace })).artifacts }
          } catch (cause) {
            notes.push(`artifacts not collected: ${errorText(cause)}`)
          }
        }
        try {
          const cleaned = await this.deps.nodeOps.requestNode(node.connID, { op: "cleanup", launchID: id, workspace: work.workspace, policy })
          notes.push(cleaned.removed ? "workspace removed" : `workspace kept${cleaned.reason ? ` (${cleaned.reason})` : ""}`)
        } catch (cause) {
          notes.push(`workspace cleanup failed: ${errorText(cause)}`)
        }
      } else {
        notes.push("workspace cleanup waits for the node")
        await this.updateWork(userID, id, { cleanup: policy })
      }
    }
    try {
      const ended = await this.store.transition(userID, id, "ended", {
        reason: [reason, ...notes].join("; "),
        outcome,
        ...(artifacts ? { artifacts } : {}),
        from: LIVE,
      })
      this.disarm(id)
      this.changed(ended)
      this.kick(userID)
      return ended
    } catch (cause) {
      if (cause instanceof LaunchTransitionError) return this.store.get(userID, id)
      throw cause
    }
  }

  // ---- work records -------------------------------------------------------------------------------------

  private async work(userID: string, id: string): Promise<LaunchWork | undefined> {
    return (await this.deps.state.get<LaunchWork>(userID, LAUNCH_WORK, id))?.value
  }

  private async putWork(userID: string, id: string, work: LaunchWork): Promise<void> {
    await this.deps.state.put(userID, LAUNCH_WORK, id, work)
  }

  private async updateWork(userID: string, id: string, change: Partial<LaunchWork>): Promise<void> {
    await this.putWork(userID, id, { ...(await this.work(userID, id)), ...change })
  }

  private checkName(userID: string, name: string, launches: readonly Launch[]): void {
    if (launches.some((l) => LIVE.includes(l.state) && l.spec.name === name)) throw new AgentError("name_taken", `@${name} is taken by another launch`)
    try {
      this.deps.directory.resolve(userID, `@${name}`)
    } catch (cause) {
      if (cause instanceof AgentError && cause.code === "not_found") return
      throw cause
    }
    throw new AgentError("name_taken", `@${name} is taken`)
  }

  private changed(launch: Launch): void {
    try {
      this.deps.onLaunchChanged?.(launch)
    } catch (cause) {
      console.error("[hub] launch listener failed:", cause instanceof Error ? cause.message : cause)
    }
  }
}
