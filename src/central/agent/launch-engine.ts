// The launch engine (design §6, §7, §9; decision znbg8xa5): drives a launch from accept to its end.
import type { NodeListener, NodeView } from "../nodes"
import type { ModelSelection, NodeRequest, NodeResultFor, PreparedWorkspace, ServerRequest } from "../../protocol"
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
import { type Launch, type LaunchOutcome, type LaunchState, LaunchStore, LaunchTransitionError } from "./launch-store"
import { Placement, PlacementLoop, type Placed, type PlacementNode } from "./placement"

/** The NodeRegistry calls the engine needs. */
export type EngineNodes = { list(ownerID?: string): NodeView[]; forMachine(machineID: string): NodeView | undefined; subscribe(listener: NodeListener): () => void }
/** Node ops (SpokeHub.requestNode). */
export interface EngineNodeOps {
  requestNode<R extends NodeRequest>(connID: string, req: R): Promise<NodeResultFor[R["op"]]>
}
export type EngineRegistry = Pick<Registry, "serviceFor" | "supports" | "connTenant" | "hasSession" | "idle" | "session" | "subscribe" | "onSessions">
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
  /** Users that may have launches (restart recovery and the placement sweep). */
  readonly users: () => Promise<readonly string[]> | readonly string[]
  readonly now?: Clock
  readonly timers?: Timers
  /** Every launch change the engine makes (SSE events and webhooks hang off this). */
  readonly onLaunchChanged?: (launch: Launch) => void
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
}

/** Thrown at a provisioning checkpoint after a stop. */
class StopRequested extends Error {}

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
      void this.loop.kick(userID)
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

  /** Starts placement (sweep and kicks on node and spoke changes). */
  async start(): Promise<void> {
    const { nodes, registry } = this.deps
    this.unsubscribe.push(
      nodes.subscribe((event) => {
        if (event.type === "disconnected" || event.node.ownerID === undefined) return
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
    for (const userID of await this.deps.users()) void this.loop.kick(userID)
  }

  shutdown(): void {
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
            if (node) await this.deps.nodeOps.requestNode(node.connID, { op: "cancel", launchID: id }).catch(() => undefined)
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

  /** A placed launch: prepare → create → roles, name, primer → prompt → running. */
  private provision(placed: Placed): Promise<void> {
    const { userID, launch } = placed
    if (this.pipelines.has(launch.id)) return this.pipelines.get(launch.id)!.done
    const pipeline: Pipeline = { done: Promise.resolve() }
    this.pipelines.set(launch.id, pipeline)
    pipeline.done = this.provisionNow(placed, pipeline).finally(() => this.pipelines.delete(launch.id))
    return pipeline.done
  }

  private async provisionNow(placed: Placed, pipeline: Pipeline): Promise<void> {
    const { userID, launch } = placed
    this.changed(launch)
    const checkpoint = () => {
      if (pipeline.stop !== undefined) throw new StopRequested()
    }
    try {
      await this.putWork(userID, launch.id, { fence: placed.fence })
      const workspace = await this.prepare(userID, launch)
      checkpoint()
      const sessionID = await this.create(userID, launch, workspace)
      checkpoint()
      await this.identify(userID, launch, sessionID, checkpoint)
    } catch (cause) {
      if (pipeline.stop !== undefined) {
        await this.end(userID, launch.id, "stopped", pipeline.stop)
        return
      }
      const gone = this.deps.nodes.forMachine(launch.machineID!) === undefined
      await this.end(userID, launch.id, gone ? "lost" : "failed", gone ? "The node went away while preparing the launch" : `Failed: ${errorText(cause)}`)
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

  private async create(userID: string, launch: Launch, workspace: PreparedWorkspace): Promise<string> {
    const { registry, spokes } = this.deps
    const connID = registry.serviceFor(launch.machineID!)
    if (connID === undefined || !registry.supports(connID, "launch")) throw new Error("The machine has no connected service spoke with launch")
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
    directory.sync(userID)
    const notes: string[] = []
    const byUser = launch.by === undefined || launch.by === "user"
    for (const role of spec.roles) {
      try {
        directory.claimRole(userID, sessionID, role, byUser ? { byUser: true } : {})
      } catch (cause) {
        notes.push(`@@${role} not claimed: ${errorText(cause)}`)
      }
    }
    if (spec.name !== undefined) directory.setName(userID, sessionID, spec.name)
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
    const running = await this.store.transition(userID, launch.id, "running", {
      reason: ["Running", ...notes].join("; "),
      sessionID,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      from: ["provisioning"],
    })
    this.changed(running)
    this.arm(userID, running, false)
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
      void this.loop.kick(userID)
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
