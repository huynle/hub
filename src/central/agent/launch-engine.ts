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
import { type Launch, type LaunchState, LaunchStore } from "./launch-store"
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

  constructor(private readonly deps: LaunchEngineDeps) {
    this.now = deps.now ?? Date.now
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
      registry.onSessions((connID) => {
        const userID = registry.connTenant(connID)
        if (userID !== undefined) void this.loop.kick(userID)
      }),
    )
    this.loop.start()
    for (const userID of await this.deps.users()) void this.loop.kick(userID)
  }

  shutdown(): void {
    this.loop.stop()
    for (const off of this.unsubscribe.splice(0)) off()
  }

  // ---- provisioning ------------------------------------------------------------------------------------

  /** A placed launch: prepare → create → roles, name, primer → prompt → running. */
  private async provision(placed: Placed): Promise<void> {
    const { userID, launch } = placed
    this.changed(launch)
    try {
      await this.putWork(userID, launch.id, { fence: placed.fence })
      const workspace = await this.prepare(userID, launch)
      const sessionID = await this.create(userID, launch, workspace)
      await this.identify(userID, launch, sessionID)
    } catch (cause) {
      console.error(`[hub] launch ${launch.id} failed: ${errorText(cause)}`)
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
  private async identify(userID: string, launch: Launch, sessionID: string): Promise<void> {
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
    if (spec.prompt !== undefined) {
      await this.updateWork(userID, launch.id, { prompted: true })
      await actions.prompt({ sessionID, text: spec.prompt, resetHops: false })
    }
    const running = await this.store.transition(userID, launch.id, "running", {
      reason: ["Running", ...notes].join("; "),
      sessionID,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      from: ["provisioning"],
    })
    this.changed(running)
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
