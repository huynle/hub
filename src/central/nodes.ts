// NodeRegistry: the hub's view of connected `hub node` daemons (design §6.3), one entry per node connection.
// Kept apart from the spoke Registry on purpose: a node is never a process, never in the catalog and never makes
// its machine "online"; it only reports runtimes, labels, capacity and launch progress. Placement (P4-T5) reads
// list(ownerID); the launch engine (P4-T8) subscribes to progress and connect/disconnect events.
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
    return entry && this.view(entry)
  }

  /** The node connection of a machine (at most one: the hub turns away a second one). */
  forMachine(machineID: string): NodeView | undefined {
    for (const entry of this.entries.values()) if (entry.machine.id === machineID) return this.view(entry)
    return undefined
  }

  /** Connected nodes of `ownerID` (all owned nodes when omitted); a node whose machine has no owner is never listed. */
  list(ownerID?: string): NodeView[] {
    const out: NodeView[] = []
    for (const entry of this.entries.values()) {
      const node = this.view(entry)
      if (node.ownerID !== undefined && (ownerID === undefined || node.ownerID === ownerID)) out.push(node)
    }
    return out
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
