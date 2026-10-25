// The connection directory (design §9, decision vkxkqiuf §5): which pod holds each spoke or node connection, in the
// shared Kv so any pod can route an op to it (./rpc.ts). Each pod is the single writer of its own connections:
//   dir:<connID> → {"pod","machineID"}   written when the hello completes, removed when the socket closes
//   pod:<podID>  → "1"                   the pod's liveness
// Both expire after DIRECTORY_TTL_MS and are refreshed every DIRECTORY_HEARTBEAT_MS, so a pod that dies without
// cleaning up drops out within the TTL. A lookup that finds an entry of a pod whose liveness key is gone removes it
// on the spot (the dead-pod sweep); callers also forget an entry when its pod has no RPC responder. Connection IDs
// are never reused, so the plain DEL on close cannot remove another pod's entry.
import { realTimers } from "../backend/memory-bus"
import type { Kv, Timers } from "../backend/types"

export const DIRECTORY_HEARTBEAT_MS = 15_000
export const DIRECTORY_TTL_MS = 45_000

const ENTRY = "dir:"
const POD = "pod:"

/** Where a connection lives. */
export interface DirectoryEntry {
  readonly pod: string
  readonly machineID: string
}

export interface ConnDirectoryOptions {
  readonly kv: Kv
  /** This pod (HUB_POD_ID). */
  readonly podID: string
  readonly timers?: Timers
  readonly heartbeatMs?: number
  readonly ttlMs?: number
  /** Called when a Kv write fails (default: logged). The directory keeps going; the next heartbeat retries. */
  readonly onError?: (error: unknown) => void
}

export class ConnDirectory {
  readonly podID: string
  private readonly kv: Kv
  private readonly timers: Timers
  private readonly heartbeatMs: number
  private readonly ttlMs: number
  private readonly onError: (error: unknown) => void
  /** This pod's connections: connID → machineID. */
  private readonly own = new Map<string, string>()
  private timer: unknown
  private running = false

  constructor(options: ConnDirectoryOptions) {
    this.kv = options.kv
    this.podID = options.podID
    this.timers = options.timers ?? realTimers
    this.heartbeatMs = options.heartbeatMs ?? DIRECTORY_HEARTBEAT_MS
    this.ttlMs = options.ttlMs ?? DIRECTORY_TTL_MS
    this.onError = options.onError ?? ((error) => console.error(`[hub] directory: ${error instanceof Error ? error.message : String(error)}`))
  }

  /** Marks the pod alive and starts the heartbeat. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.kv.set(POD + this.podID, "1", { px: this.ttlMs })
    this.arm()
  }

  /** Stops the heartbeat and removes the pod's entries and liveness key (a clean shutdown). */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
    const conns = [...this.own.keys()]
    this.own.clear()
    await Promise.all([...conns.map((connID) => this.kv.del(ENTRY + connID)), this.kv.del(POD + this.podID)])
  }

  /** Records a connection this pod holds. */
  async register(connID: string, machineID: string): Promise<void> {
    this.own.set(connID, machineID)
    await this.write(connID, machineID)
  }

  /** Removes a connection this pod held (its socket closed). */
  async unregister(connID: string): Promise<void> {
    if (!this.own.delete(connID)) return
    await this.kv.del(ENTRY + connID)
  }

  /** Where a connection lives; undefined when unknown, expired, or its pod is dead (the entry is then removed). */
  async lookup(connID: string): Promise<DirectoryEntry | undefined> {
    const entry = parse(await this.kv.get(ENTRY + connID))
    if (!entry) return undefined
    if (entry.pod !== this.podID && !(await this.podAlive(entry.pod))) {
      await this.forget(connID, entry.pod)
      return undefined
    }
    return entry
  }

  /** Removes a connection's entry if it still names `pod` (that pod is gone). */
  async forget(connID: string, pod: string): Promise<void> {
    const entry = parse(await this.kv.get(ENTRY + connID))
    if (entry?.pod === pod) await this.kv.del(ENTRY + connID)
  }

  async podAlive(pod: string): Promise<boolean> {
    return (await this.kv.get(POD + pod)) !== undefined
  }

  /** This pod's registered connections. */
  local(): string[] {
    return [...this.own.keys()]
  }

  private write(connID: string, machineID: string): Promise<boolean> {
    return this.kv.set(ENTRY + connID, JSON.stringify({ pod: this.podID, machineID } satisfies DirectoryEntry), { px: this.ttlMs })
  }

  private arm(): void {
    this.timer = this.timers.set(() => void this.beat(), this.heartbeatMs)
  }

  /** Refreshes the pod's liveness and every entry it holds, then re-arms. */
  private async beat(): Promise<void> {
    if (!this.running) return
    try {
      await this.kv.set(POD + this.podID, "1", { px: this.ttlMs })
      await Promise.all([...this.own].map(([connID, machineID]) => this.write(connID, machineID)))
    } catch (error) {
      this.onError(error)
    }
    if (this.running) this.arm()
  }
}

function parse(raw: string | undefined): DirectoryEntry | undefined {
  if (raw === undefined) return undefined
  try {
    const value = JSON.parse(raw) as Partial<DirectoryEntry>
    return typeof value?.pod === "string" && typeof value.machineID === "string" ? { pod: value.pod, machineID: value.machineID } : undefined
  } catch {
    return undefined
  }
}
