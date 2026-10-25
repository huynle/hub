// An in-process stand-in for a Valkey server's pub/sub, for unit tests of the Valkey backends without docker.
//
// Like the real thing, PUBLISH counts subscribed connections (not listeners) and its reply can reach the
// publisher before the message reaches the subscribers: deliveries run on a later macrotask, in publish order.
// Each FakeRedis is one connection; duplicate() opens another on the same server.
import type { BusRedis } from "../src/central/backend/valkey-bus"

type Listener = (message: string, channel: string) => void

export class FakeRedisServer {
  readonly connections = new Set<FakeRedis>()
  /** Every connection ever opened. */
  opened = 0
  /** Commands as "<connection number> <COMMAND> <channel>", in order. */
  readonly log: string[] = []

  client(): FakeRedis {
    return new FakeRedis(this)
  }

  /** How many connections listen on a channel (PUBSUB NUMSUB). */
  numsub(channel: string): number {
    return [...this.connections].filter((c) => c.channels().includes(channel)).length
  }
}

export class FakeRedis implements BusRedis {
  readonly id: number
  private readonly listeners = new Map<string, Set<Listener>>()
  private closed = false

  constructor(private readonly server: FakeRedisServer) {
    this.id = ++server.opened
    server.connections.add(this)
  }

  channels(): string[] {
    return [...this.listeners.keys()]
  }

  get isClosed(): boolean {
    return this.closed
  }

  async publish(channel: string, message: string): Promise<number> {
    this.check("PUBLISH", channel)
    let receivers = 0
    for (const connection of this.server.connections) {
      if (!connection.listeners.has(channel)) continue
      receivers++
      setTimeout(() => connection.receive(channel, message), 0)
    }
    return receivers
  }

  async subscribe(channel: string, listener: Listener): Promise<number> {
    this.check("SUBSCRIBE", channel)
    let set = this.listeners.get(channel)
    if (!set) this.listeners.set(channel, (set = new Set()))
    set.add(listener)
    return this.listeners.size
  }

  async unsubscribe(channel: string, listener?: Listener): Promise<void> {
    this.check("UNSUBSCRIBE", channel)
    const set = this.listeners.get(channel)
    if (!set) return
    if (listener) set.delete(listener)
    else set.clear()
    if (!set.size) this.listeners.delete(channel)
  }

  async duplicate(): Promise<FakeRedis> {
    this.check("DUPLICATE", "")
    return new FakeRedis(this.server)
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
    this.server.connections.delete(this)
  }

  private receive(channel: string, message: string): void {
    if (this.closed) return
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(message, channel)
  }

  private check(command: string, channel: string): void {
    if (this.closed) throw new Error("Connection closed")
    this.server.log.push(`${this.id} ${command} ${channel}`.trim())
  }
}
