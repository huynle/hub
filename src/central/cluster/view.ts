// The cluster view (design §9, decision vkxkqiuf §5): how every pod sees the connections other pods hold.
// Each pod's Registry and NodeRegistry are the single writers of its own connections and export a slice per tenant
// (registry: connections and what they report, status boards, pending permissions and forms, presence, running
// turns; nodes: the tenant's nodes). This pod publishes its slices
//   - to the Catalog: hash of the user, session VIEW_SESSION, one report per pod (connID = podID) with a TTL;
//   - as deltas on the Bus (VIEW_TOPIC: {pod, user, slice | null}), shortly after a change and again every
//     heartbeat (which also refreshes the Catalog TTL);
// and mirrors the other pods' slices into its Registry and NodeRegistry (setRemote), so their synchronous reads
// cover the whole cluster. The mirror is rebuilt from the Catalog at start and on resync() (e.g. after a Bus
// reconnect lost deltas). A pod that stops removes its slices; a pod that dies stops refreshing them: the other pods
// drop a slice not refreshed within the TTL, and the Catalog filters it out on read.
import { realTimers } from "../backend/memory-bus"
import type { Bus, Catalog, Clock, Timers, Unsubscribe } from "../backend/types"
import type { NodeRegistry, NodeSlice } from "../nodes"
import type { Registry, RegistrySlice } from "../registry"

export const VIEW_TOPIC = "cluster.view"
/** The Catalog session id the slices are reported under (never a real session id: those start with ses). */
export const VIEW_SESSION = "_view"
export const VIEW_HEARTBEAT_MS = 15_000
export const VIEW_TTL_MS = 45_000
/** Changes within this window go out together. */
export const VIEW_PUBLISH_DELAY_MS = 50

/** One pod's state of one tenant. */
export interface ViewSlice {
  readonly registry?: RegistrySlice
  readonly nodes?: NodeSlice
}

interface ViewMessage {
  readonly pod: string
  readonly user: string
  readonly slice: ViewSlice | null
}

type Mirrored<T extends Registry | NodeRegistry> = Pick<T, "onLocalChange" | "clusterTenants" | "clusterSlice" | "setRemote">

export interface ClusterViewOptions {
  readonly catalog: Catalog
  readonly bus: Bus
  /** This pod (HUB_POD_ID). */
  readonly podID: string
  readonly registry: Mirrored<Registry>
  readonly nodes: Mirrored<NodeRegistry>
  /** The users whose Catalog entries a rebuild reads. */
  readonly users: () => readonly string[] | Promise<readonly string[]>
  readonly now?: Clock
  readonly timers?: Timers
  readonly heartbeatMs?: number
  readonly ttlMs?: number
  readonly publishDelayMs?: number
  readonly onError?: (error: unknown) => void
}

/** Tenants that are not users (a machine without an owner) are never published. */
const publishable = (tenant: string | undefined): tenant is string => tenant !== undefined && tenant !== "" && !tenant.startsWith("?")

export class ClusterView {
  readonly podID: string
  private readonly options: ClusterViewOptions
  private readonly now: Clock
  private readonly timers: Timers
  private readonly heartbeatMs: number
  private readonly ttlMs: number
  private readonly publishDelayMs: number
  private readonly onError: (error: unknown) => void
  /** Tenants whose slice changed since the last flush; `all`: every tenant. */
  private dirty = new Set<string>()
  private dirtyAll = false
  private flushTimer: unknown
  private heartbeatTimer: unknown
  /** What this pod published last per user (JSON), to skip unchanged slices between heartbeats. */
  private readonly sent = new Map<string, string>()
  /** Other pods' slices applied here: pod → user → when last received (this pod's clock). */
  private readonly received = new Map<string, Map<string, number>>()
  /** Serialises flushes, rebuilds and stop. */
  private queue: Promise<void> = Promise.resolve()
  private readonly offs: Array<() => void> = []
  private unsubscribe?: Unsubscribe
  private running = false

  constructor(options: ClusterViewOptions) {
    this.options = options
    this.podID = options.podID
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? realTimers
    this.heartbeatMs = options.heartbeatMs ?? VIEW_HEARTBEAT_MS
    this.ttlMs = options.ttlMs ?? VIEW_TTL_MS
    this.publishDelayMs = options.publishDelayMs ?? VIEW_PUBLISH_DELAY_MS
    this.onError = options.onError ?? ((error) => console.error(`[hub] cluster view: ${error instanceof Error ? error.message : String(error)}`))
  }

  /** Listens for deltas, rebuilds the mirror from the Catalog, publishes this pod's slices and starts the heartbeat. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const mark = (tenant: string | undefined) => this.mark(tenant)
    this.offs.push(this.options.registry.onLocalChange(mark), this.options.nodes.onLocalChange(mark))
    this.unsubscribe = await this.options.bus.subscribe(VIEW_TOPIC, (message) => this.receive(message as ViewMessage))
    await this.resync()
    this.dirtyAll = true
    await this.flush()
    this.arm()
  }

  /** Stops publishing and listening, and removes this pod's slices from the Catalog and the other pods. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    for (const off of this.offs.splice(0)) off()
    for (const timer of [this.flushTimer, this.heartbeatTimer]) if (timer !== undefined) this.timers.clear(timer)
    this.flushTimer = this.heartbeatTimer = undefined
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    await this.enqueue(async () => {
      await unsubscribe?.()
      const users = [...this.sent.keys()]
      this.sent.clear()
      await Promise.allSettled(users.map((user) => this.withdraw(user)))
    })
  }

  /** How many users this pod currently publishes slices for. */
  published(): number {
    return this.sent.size
  }

  /** Reads every other pod's slices from the Catalog and replaces the mirror with them. */
  resync(): Promise<void> {
    return this.enqueue(async () => {
      const users = await this.options.users()
      const seen = new Set<string>()
      for (const user of users) {
        for (const entry of await this.options.catalog.entries(user)) {
          if (entry.sessionID !== VIEW_SESSION || entry.connID === this.podID) continue
          seen.add(`${entry.connID}\u0000${user}`)
          this.apply(entry.connID, user, entry.value as ViewSlice)
        }
      }
      for (const [pod, slices] of this.received) for (const user of slices.keys()) if (!seen.has(`${pod}\u0000${user}`)) this.apply(pod, user, null)
    })
  }

  /** A local change of `tenant` (undefined: any): published after the publish delay. */
  private mark(tenant: string | undefined): void {
    if (!this.running) return
    if (tenant === undefined) this.dirtyAll = true
    else if (publishable(tenant)) this.dirty.add(tenant)
    else return
    if (this.flushTimer !== undefined) return
    this.flushTimer = this.timers.set(() => {
      this.flushTimer = undefined
      void this.flush()
    }, this.publishDelayMs)
  }

  /** Publishes the slices of the dirty tenants (all, after a heartbeat); `force` republishes unchanged ones too. */
  private flush(force = false): Promise<void> {
    return this.enqueue(async () => {
      if (!this.running) return
      const { registry, nodes } = this.options
      const tenants = this.dirtyAll
        ? new Set([...registry.clusterTenants(), ...nodes.clusterTenants(), ...this.sent.keys()])
        : new Set(this.dirty)
      this.dirty = new Set()
      this.dirtyAll = false
      for (const user of tenants) {
        if (!publishable(user)) continue
        const r = registry.clusterSlice(user)
        const n = nodes.clusterSlice(user)
        try {
          if (!r && !n) {
            if (this.sent.delete(user)) await this.withdraw(user)
            continue
          }
          const slice: ViewSlice = { ...(r ? { registry: r } : {}), ...(n ? { nodes: n } : {}) }
          const json = JSON.stringify(slice)
          if (!force && this.sent.get(user) === json) continue
          this.sent.set(user, json)
          await this.options.catalog.set(user, VIEW_SESSION, this.podID, slice as Record<string, unknown>, { ttlMs: this.ttlMs })
          await this.options.bus.publish(VIEW_TOPIC, { pod: this.podID, user, slice } satisfies ViewMessage)
        } catch (error) {
          // The next heartbeat publishes it again.
          this.sent.delete(user)
          this.onError(error)
        }
      }
    })
  }

  private async withdraw(user: string): Promise<void> {
    await this.options.catalog.delete(user, VIEW_SESSION, this.podID)
    await this.options.bus.publish(VIEW_TOPIC, { pod: this.podID, user, slice: null } satisfies ViewMessage)
  }

  private receive(message: ViewMessage): void {
    if (!this.running || typeof message?.pod !== "string" || typeof message.user !== "string" || message.pod === this.podID) return
    this.apply(message.pod, message.user, message.slice ?? null)
  }

  /** Applies (or, null, removes) another pod's slice of a user. */
  private apply(pod: string, user: string, slice: ViewSlice | null): void {
    let users = this.received.get(pod)
    if (slice) {
      if (!users) this.received.set(pod, (users = new Map()))
      users.set(user, this.now())
    } else if (users?.delete(user) && !users.size) this.received.delete(pod)
    this.options.nodes.setRemote(pod, user, slice?.nodes)
    this.options.registry.setRemote(pod, user, slice?.registry)
  }

  /** Every heartbeat: republish this pod's slices (refreshing their TTL) and drop the ones other pods stopped refreshing. */
  private arm(): void {
    this.heartbeatTimer = this.timers.set(() => {
      this.heartbeatTimer = undefined
      if (!this.running) return
      const t = this.now()
      for (const [pod, users] of [...this.received]) for (const [user, at] of [...users]) if (t - at > this.ttlMs) this.apply(pod, user, null)
      this.dirtyAll = true
      void this.flush(true).finally(() => {
        if (this.running) this.arm()
      })
    }, this.heartbeatMs)
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task)
    this.queue = run.catch((error) => this.onError(error))
    return run
  }
}
