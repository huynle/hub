// An in-process stand-in for a Valkey server's pub/sub as Bun.RedisClient shows it, for unit tests of the Valkey
// backends without docker.
//
// Like the real thing, PUBLISH counts subscribed connections (not listeners) and its reply can reach the
// publisher before the message reaches the subscribers: deliveries run on a later macrotask, in publish order.
// Replies also come a macrotask later, and a command still waiting for its reply when its connection closes
// rejects. Each FakeRedis is one connection; duplicate() opens another on the same server.
//
// Like Bun 1.3.5 (checked against valkey/valkey:8 with CLIENT KILL TYPE pubsub): a connection the server drops
// reconnects on its own and runs `onconnect`, but the server forgot its subscriptions while the client still
// holds its listeners; subscribing a listener again adds it twice (it then gets every message twice);
// unsubscribe(channel) drops every listener of the channel. Right after the reconnect (in `onconnect`) the client
// is not in subscriber mode and unsubscribe throws ERR_REDIS_INVALID_STATE, until something subscribes again.
// `onconnect` also runs once for the first connection, after duplicate() resolved (onclose does not run on a drop).
import type { BusRedis } from "../src/central/backend/valkey-bus"

type Listener = (message: string, channel: string) => void

export class FakeRedisServer {
  readonly connections = new Set<FakeRedis>()
  /** Every connection ever opened. */
  opened = 0

  client(): FakeRedis {
    return new FakeRedis(this)
  }

  /** How many connections the server has subscribed to a channel (PUBSUB NUMSUB). */
  numsub(channel: string): number {
    return [...this.connections].filter((c) => c.serverChannels.has(channel)).length
  }

  /** CLIENT KILL TYPE pubsub: drops every subscribed connection; each reconnects a macrotask later. */
  killSubscribers(): void {
    for (const connection of this.connections) if (connection.serverChannels.size) connection.drop()
  }
}

export class FakeRedis implements BusRedis {
  readonly id: number
  onconnect: (() => void) | null = null
  /** What the server delivers to this connection. */
  readonly serverChannels = new Set<string>()
  /** What the client dispatches (survives a reconnect). */
  private readonly listeners = new Map<string, Listener[]>()
  private closed = false
  private subscriberMode = false

  constructor(private readonly server: FakeRedisServer) {
    this.id = ++server.opened
    server.connections.add(this)
  }

  get isClosed(): boolean {
    return this.closed
  }

  async publish(channel: string, message: string): Promise<number> {
    this.check()
    let receivers = 0
    for (const connection of this.server.connections) {
      if (!connection.serverChannels.has(channel)) continue
      receivers++
      setTimeout(() => connection.receive(channel, message), 0)
    }
    return this.reply(receivers)
  }

  async subscribe(channel: string, listener: Listener): Promise<number> {
    this.check()
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener])
    this.serverChannels.add(channel)
    this.subscriberMode = true
    return this.serverChannels.size
  }

  async unsubscribe(channel: string, listener?: Listener): Promise<void> {
    this.check()
    if (!this.subscriberMode) throw new Error("RedisClient.prototype.unsubscribe can only be called while in subscriber mode.")
    const left = listener ? (this.listeners.get(channel) ?? []).filter((l) => l !== listener) : []
    if (left.length) {
      this.listeners.set(channel, left)
      return
    }
    this.listeners.delete(channel)
    this.serverChannels.delete(channel)
  }

  async duplicate(): Promise<FakeRedis> {
    this.check()
    const duplicate = new FakeRedis(this.server)
    setTimeout(() => {
      if (!duplicate.closed) duplicate.onconnect?.()
    }, 0)
    return duplicate
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
    this.serverChannels.clear()
    this.server.connections.delete(this)
  }

  /** The server drops the connection; the client reconnects a macrotask later. */
  drop(): void {
    this.serverChannels.clear()
    this.subscriberMode = false
    setTimeout(() => {
      if (!this.closed) this.onconnect?.()
    }, 0)
  }

  /** The server's reply, a macrotask later; rejects when the connection closed meanwhile. */
  private reply<T>(value: T): Promise<T> {
    return new Promise((resolve, reject) => setTimeout(() => (this.closed ? reject(new Error("Connection closed")) : resolve(value)), 0))
  }

  private receive(channel: string, message: string): void {
    if (this.closed) return
    for (const listener of this.listeners.get(channel) ?? []) listener(message, channel)
  }

  private check(): void {
    if (this.closed) throw new Error("Connection closed")
  }
}
