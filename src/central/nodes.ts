// NodeRegistry: the hub's view of connected `hub node` daemons (design §6.3), one entry per node connection.
// Kept apart from the spoke Registry on purpose: a node is never a process, never in the catalog and never makes
// its machine "online"; it only reports runtimes, labels, capacity and launch progress. Placement (P4-T5) reads
// list(ownerID); the launch engine (P4-T8) subscribes to progress and connect/disconnect events.
// Cluster mode (design §9): each pod is the single writer of its own nodes and exports them per owner (clusterSlice);
// ./cluster/view.ts applies other pods' slices (setRemote), so list/get/forMachine see every node of the cluster (a
// node on another pod is reached through SpokeHub.requestNode). Events and count() stay local; a local node of a
// machine wins over a remote one.
import type { NodeCapacity, NodeCapacityFrame, NodeHello, NodeLaunchPhase, NodeLaunchReport, NodeProgress, NodeRuntimeInfo } from "../protocol"

export interface NodeMachine {
  readonly id: string
  readonly name: string
}

/** A connected node, as seen by placement and the launch engine (a copy; changing it changes nothing). */
export interface NodeView {
  readonly connID: string
  readonly machineID: string
  readonly machineName: string
  /** The machine's current owner, read live (ownership can move). */
  readonly ownerID: string | undefined
  readonly instanceID: string
  readonly nodeVersion: string
  readonly features: readonly string[]
  readonly runtimes: readonly NodeRuntimeInfo[]
  readonly labels: Readonly<Record<string, string>>
  readonly capacity: NodeCapacity
  readonly used: NodeCapacity
  /** capacity − used, never below zero; memoryMB only when the node reports both. */
  readonly free: NodeCapacity
  readonly workspaceRoots: readonly string[]
  readonly draining: boolean
  /** Launches the node carries, with their latest phase (cleaned and cancelled ones are dropped). */
  readonly launches: readonly NodeLaunchReport[]
  readonly connectedAt: number
  readonly lastSeen: number
}

export type NodeEvent =
  | { readonly type: "connected"; readonly node: NodeView }
  | { readonly type: "capacity"; readonly node: NodeView }
  | { readonly type: "progress"; readonly node: NodeView; readonly launchID: string; readonly phase: NodeLaunchPhase; readonly message?: string }
  | { readonly type: "disconnected"; readonly node: NodeView }

export type NodeListener = (event: NodeEvent) => void

/** One owner's nodes on one pod, as other pods mirror them (JSON-compatible). */
export interface NodeSlice {
  readonly nodes: NodeView[]
}

/** Phases after which the node no longer carries the launch. */
const GONE: ReadonlySet<NodeLaunchPhase> = new Set(["cleaned", "cancelled"])

interface Entry {
  readonly connID: string
  readonly machine: NodeMachine
  readonly hello: NodeHello
  labels: Record<string, string>
  capacity: NodeCapacity
  used: NodeCapacity
  draining: boolean
  readonly launches: Map<string, NodeLaunchReport>
  readonly connectedAt: number
  lastSeen: number
}

export class NodeRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<NodeListener>()
  private readonly localChangeListeners = new Set<(owner: string | undefined) => void>()
  /** Other pods' nodes: pod → owner → slice. */
  private readonly remote = new Map<string, Map<string, NodeSlice>>()

  constructor(
    private readonly ownerOf: (machineID: string) => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  connect(connID: string, machine: NodeMachine, hello: NodeHello): NodeView {
    const at = this.now()
    const entry: Entry = {
      connID,
      machine: { id: machine.id, name: machine.name },
      hello,
      labels: { ...hello.labels },
      capacity: { ...hello.capacity },
      used: { ...hello.used },
      draining: hello.draining,
      launches: new Map(hello.launches.map((l) => [l.launchID, { ...l }])),
      connectedAt: at,
      lastSeen: at,
    }
    this.entries.set(connID, entry)
    const node = this.view(entry)
    this.emit({ type: "connected", node })
    return node
  }

  setCapacity(connID: string, frame: NodeCapacityFrame): void {
    const entry = this.entries.get(connID)
    if (!entry) return
    entry.capacity = { ...frame.capacity }
    entry.used = { ...frame.used }
    entry.draining = frame.draining
    if (frame.labels) entry.labels = { ...frame.labels }
    this.emit({ type: "capacity", node: this.view(entry) })
  }

  progress(connID: string, frame: NodeProgress): void {
    const entry = this.entries.get(connID)
    if (!entry) return
    if (GONE.has(frame.phase)) entry.launches.delete(frame.launchID)
    else {
      const previous = entry.launches.get(frame.launchID)
      entry.launches.set(frame.launchID, { ...previous, launchID: frame.launchID, phase: frame.phase })
    }
    this.emit({
      type: "progress",
      node: this.view(entry),
      launchID: frame.launchID,
      phase: frame.phase,
      ...(frame.message !== undefined ? { message: frame.message } : {}),
    })
  }

  touch(connID: string): void {
    const entry = this.entries.get(connID)
    if (entry) entry.lastSeen = this.now()
  }

  disconnect(connID: string): void {
    const entry = this.entries.get(connID)
    if (!entry) return
    this.entries.delete(connID)
    this.emit({ type: "disconnected", node: this.view(entry) })
  }

  get(connID: string): NodeView | undefined {
    const entry = this.entries.get(connID)
    return entry ? this.view(entry) : this.remoteNodes().find((node) => node.connID === connID)
  }

  /** The node connection of a machine (at most one: the hub turns away a second one); this pod's first. */
  forMachine(machineID: string): NodeView | undefined {
    return this.localForMachine(machineID) ?? this.remoteNodes().find((node) => node.machineID === machineID)
  }

  /** The node connection of a machine held by this pod. */
  localForMachine(machineID: string): NodeView | undefined {
    for (const entry of this.entries.values()) if (entry.machine.id === machineID) return this.view(entry)
    return undefined
  }

  /** Connected nodes of `ownerID` (all owned nodes when omitted); a node whose machine has no owner is never listed. */
  list(ownerID?: string): NodeView[] {
    const out: NodeView[] = []
    for (const node of [...[...this.entries.values()].map((entry) => this.view(entry)), ...this.remoteNodes()]) {
      if (node.ownerID !== undefined && (ownerID === undefined || node.ownerID === ownerID)) out.push(node)
    }
    return out
  }

  // ---------- cluster (design §9) ----------

  /** Listens for changes to this pod's nodes of an owner. */
  onLocalChange(listener: (owner: string | undefined) => void): () => void {
    this.localChangeListeners.add(listener)
    return () => this.localChangeListeners.delete(listener)
  }

  /** Owners of this pod's nodes. */
  clusterTenants(): string[] {
    const owners = new Set<string>()
    for (const entry of this.entries.values()) {
      const owner = this.ownerOf(entry.machine.id)
      if (owner !== undefined) owners.add(owner)
    }
    return [...owners]
  }

  /** This pod's nodes of an owner for other pods (undefined when none). */
  clusterSlice(owner: string): NodeSlice | undefined {
    const nodes = [...this.entries.values()].map((entry) => this.view(entry)).filter((node) => node.ownerID === owner)
    return nodes.length ? { nodes } : undefined
  }

  /** Applies another pod's nodes of an owner (undefined: it has none any more). */
  setRemote(pod: string, owner: string, slice: NodeSlice | undefined): void {
    let slices = this.remote.get(pod)
    if (slice) {
      if (!slices) this.remote.set(pod, (slices = new Map()))
      slices.set(owner, slice)
    } else if (slices?.delete(owner) && !slices.size) this.remote.delete(pod)
  }

  /** Other pods' nodes (owner read live), one per machine (the newest), none for a machine with a local node. */
  private remoteNodes(): NodeView[] {
    if (!this.remote.size) return []
    const local = new Set([...this.entries.values()].map((entry) => entry.machine.id))
    const byMachine = new Map<string, NodeView>()
    for (const slices of this.remote.values()) {
      for (const slice of slices.values()) {
        for (const node of slice.nodes ?? []) {
          if (local.has(node.machineID) || this.entries.has(node.connID)) continue
          const known = byMachine.get(node.machineID)
          if (!known || node.connectedAt > known.connectedAt) byMachine.set(node.machineID, node)
        }
      }
    }
    return [...byMachine.values()].map((node) => ({ ...structuredClone(node), ownerID: this.ownerOf(node.machineID) }))
  }

  /** Connected node connections (for /healthz). */
  count(): number {
    return this.entries.size
  }

  subscribe(listener: NodeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: NodeEvent): void {
    for (const listener of [...this.localChangeListeners]) {
      try {
        listener(event.node.ownerID)
      } catch (cause) {
        console.error("[hub] node change listener failed:", cause instanceof Error ? cause.message : cause)
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (cause) {
        console.error("[hub] node listener failed:", cause instanceof Error ? cause.message : cause)
      }
    }
  }

  private view(entry: Entry): NodeView {
    const { hello, capacity, used } = entry
    const free: NodeCapacity = {
      slots: Math.max(0, capacity.slots - used.slots),
      ...(capacity.memoryMB !== undefined && used.memoryMB !== undefined ? { memoryMB: Math.max(0, capacity.memoryMB - used.memoryMB) } : {}),
    }
    return {
      connID: entry.connID,
      machineID: entry.machine.id,
      machineName: entry.machine.name,
      ownerID: this.ownerOf(entry.machine.id),
      instanceID: hello.instanceID,
      nodeVersion: hello.nodeVersion,
      features: [...(hello.features ?? [])],
      runtimes: hello.runtimes.map((r) => structuredClone(r)),
      labels: { ...entry.labels },
      capacity: { ...capacity },
      used: { ...used },
      free,
      workspaceRoots: [...hello.workspaceRoots],
      draining: entry.draining,
      launches: [...entry.launches.values()].map((l) => ({ ...l })),
      connectedAt: entry.connectedAt,
      lastSeen: entry.lastSeen,
    }
  }
}
