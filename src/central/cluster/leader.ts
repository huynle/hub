// Leader loops (design §9, decision vkxkqiuf §7): a timed job (decision deadlines, message re-wakes, the webhook
// sender, the launch supervisor) runs on one pod at a time, the holder of a fenced lease `leader:<name>` in the
// shared Locks. The single-process hub runs the same code on in-memory locks: it is always the leader.
// - start(): tries to take the lease at once, then every renewMs: the leader renews it, the others try to take it.
//   Taking it calls onElected (with the lease: its fence grows with every new leader); losing it (taken, expired, or
//   a renewal failing too close to its expiry) calls onDeposed, so a leader stops before its lease can run out.
// - stop(): steps down, releases the lease and tells the other pods (LEADER topic `.released`), which try at once:
//   a graceful failover takes one bus hop; a dead leader is replaced within ttlMs (+ one renewMs tick).
// - kick(message): any pod nudges the leader (onKick runs there only), e.g. "a launch was queued".
// - request(message): any pod asks the leader (onRequest), wherever it runs (Bus RPC on leader.<name>.<owner>.rpc);
//   NoLeaderError when nobody holds the lease or the holder no longer answers.
import { realTimers } from "../backend/memory-bus"
import { BusNoResponderError, type Bus, type Clock, type Data, type Lease, type Locks, type RequestOptions, type Timers, type Unsubscribe } from "../backend/types"

/** How long a leader lease lasts without renewal (a dead leader is replaced after this). */
export const LEADER_TTL_MS = 15_000

/** The Locks key of a job's leader lease. */
export const leaderKey = (name: string) => `leader:${name}`
const kickTopic = (name: string) => `leader.${name}.kick`
const releasedTopic = (name: string) => `leader.${name}.released`
const requestTopic = (name: string, owner: string) => `leader.${name}.${owner}.rpc`

/** Nobody leads the job (or its leader went away): the request cannot be answered now. */
export class NoLeaderError extends Error {
  constructor(name: string) {
    super(`No leader runs ${name} right now`)
    this.name = "NoLeaderError"
  }
}

export interface LeaderLoopOptions {
  readonly locks: Locks
  readonly bus: Bus
  /** The job (lease key leader:<name>, topics leader.<name>.*). */
  readonly name: string
  /** This pod's process (unique per process: a restarted pod is a new owner). */
  readonly owner: string
  /** Lease time (default LEADER_TTL_MS). */
  readonly ttlMs?: number
  /** How often the leader renews and the others try (default a third of ttlMs). */
  readonly renewMs?: number
  readonly timers?: Timers
  readonly now?: Clock
  /** This pod leads now: start the job. */
  readonly onElected?: (lease: Lease) => void | Promise<void>
  /** This pod no longer leads: stop the job. */
  readonly onDeposed?: () => void | Promise<void>
  readonly onKick?: (message: Data) => void
  readonly onRequest?: (message: Data) => Data | Promise<Data>
  readonly onError?: (error: unknown) => void
}

export class LeaderLoop {
  readonly name: string
  private readonly options: LeaderLoopOptions
  private readonly ttlMs: number
  private readonly renewMs: number
  private readonly timers: Timers
  private readonly now: Clock
  private readonly onError: (error: unknown) => void
  private lease: Lease | undefined
  /** Until when (this pod's clock) the lease surely holds: the time the last successful take or renewal started + ttl. */
  private validUntil = 0
  private running = false
  private timer: unknown
  private queue: Promise<void> = Promise.resolve()
  private readonly subscriptions: Unsubscribe[] = []
  private serving: Unsubscribe | undefined

  constructor(options: LeaderLoopOptions) {
    this.options = options
    this.name = options.name
    this.ttlMs = options.ttlMs ?? LEADER_TTL_MS
    this.renewMs = options.renewMs ?? Math.max(1, Math.floor(this.ttlMs / 3))
    this.timers = options.timers ?? realTimers
    this.now = options.now ?? Date.now
    this.onError = options.onError ?? ((error) => console.error(`[hub] leader ${options.name}: ${error instanceof Error ? error.message : String(error)}`))
  }

  /** Whether this pod leads the job now. */
  isLeader(): boolean {
    return this.lease !== undefined
  }

  /** The current lease's fence (undefined when not leading). */
  fence(): number | undefined {
    return this.lease?.fence
  }

  /** Listens for kicks and releases, tries to take the lease and keeps trying (or renewing) every renewMs. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const { bus, name } = this.options
    try {
      this.subscriptions.push(
        await bus.subscribe(kickTopic(name), (message) => {
          if (this.lease) this.options.onKick?.(message)
        }),
        await bus.subscribe(releasedTopic(name), () => {
          if (this.running && !this.lease) void this.enqueue(() => this.attempt())
        }),
      )
    } catch (error) {
      this.onError(error)
    }
    await this.enqueue(() => this.attempt())
    this.schedule()
  }

  /** Steps down (releasing the lease and telling the other pods) and stops trying. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
    const subscriptions = this.subscriptions.splice(0)
    await this.enqueue(async () => {
      if (this.lease) {
        await this.depose()
        await this.options.locks.release(leaderKey(this.name), this.options.owner).catch((error) => this.onError(error))
        await this.options.bus.publish(releasedTopic(this.name), { owner: this.options.owner }).catch((error) => this.onError(error))
      }
      await Promise.allSettled(subscriptions.map((unsubscribe) => unsubscribe()))
    })
  }

  /** Nudges the leader (wherever it runs). */
  async kick(message: Data = {}): Promise<void> {
    await this.options.bus.publish(kickTopic(this.name), message)
  }

  /** Asks the leader (here or on another pod); NoLeaderError when there is none. */
  async request<T = Data>(message: Data, options: RequestOptions): Promise<T> {
    const holder = await this.options.locks.holder(leaderKey(this.name))
    if (!holder) throw new NoLeaderError(this.name)
    if (holder.owner === this.options.owner && this.lease) {
      if (!this.options.onRequest) throw new NoLeaderError(this.name)
      return (await this.options.onRequest(structuredClone(message))) as T
    }
    try {
      return await this.options.bus.request<T>(requestTopic(this.name, holder.owner), message, options)
    } catch (error) {
      if (error instanceof BusNoResponderError) throw new NoLeaderError(this.name)
      throw error
    }
  }

  // ---- internals ----------------------------------------------------------------------------------------

  private schedule(): void {
    if (!this.running) return
    this.timer = this.timers.set(() => {
      this.timer = undefined
      void this.enqueue(() => this.attempt()).finally(() => this.schedule())
    }, this.renewMs)
  }

  /** Renews the lease (leader) or tries to take it (the others). */
  private async attempt(): Promise<void> {
    if (!this.running) return
    const { locks, owner } = this.options
    const key = leaderKey(this.name)
    const started = this.now()
    if (this.lease) {
      let renewed: Lease | undefined
      try {
        renewed = await locks.renew(key, owner, this.ttlMs)
      } catch (error) {
        this.onError(error)
        // Not sure whether it still holds: step down while the lease surely lasts one more tick.
        if (this.now() + this.renewMs >= this.validUntil) await this.depose()
        return
      }
      if (!renewed) {
        await this.depose()
        return
      }
      this.lease = renewed
      this.validUntil = started + this.ttlMs
      return
    }
    let taken: Lease | undefined
    try {
      taken = await locks.acquire(key, owner, this.ttlMs)
    } catch (error) {
      this.onError(error)
      return
    }
    if (!taken) return
    this.lease = taken
    this.validUntil = started + this.ttlMs
    await this.elect(taken)
  }

  private async elect(lease: Lease): Promise<void> {
    const { bus, name, owner } = this.options
    try {
      this.serving = await bus.serve(requestTopic(name, owner), async (message) => {
        if (!this.lease || !this.options.onRequest) throw new NoLeaderError(name)
        return this.options.onRequest(message)
      })
    } catch (error) {
      this.onError(error)
    }
    try {
      await this.options.onElected?.(lease)
    } catch (error) {
      this.onError(error)
    }
  }

  private async depose(): Promise<void> {
    if (!this.lease) return
    this.lease = undefined
    const serving = this.serving
    this.serving = undefined
    await serving?.().catch((error) => this.onError(error))
    try {
      await this.options.onDeposed?.()
    } catch (error) {
      this.onError(error)
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task)
    this.queue = run.catch((error) => this.onError(error))
    return this.queue
  }
}
