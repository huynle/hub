// The launch engine (design §6, §7, §9; decision znbg8xa5): drives a launch from accept to its end.
import type { NodeListener, NodeView } from "../nodes"
import type { NodeRequest, NodeResultFor, ServerRequest } from "../../protocol"
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
import { Placement, PlacementLoop, type PlacementNode } from "./placement"

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
      onPlaced: () => {},
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
