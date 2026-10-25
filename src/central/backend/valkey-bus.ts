// Bus over Valkey/Redis pub/sub (decision vkxkqiuf §1, §5): the cluster's implementation of ./types Bus.
//
// Connections (Bun.RedisClient, opened lazily on first use, never in the constructor):
// - one command connection for PUBLISH;
// - subscriber connections made with duplicate() (a subscribed connection takes no other commands). A topic's
//   k-th local subscription goes on the k-th subscriber connection, so each connection listens to a topic at most
//   once and PUBLISH's count (subscribed connections) is exactly the number of subscriptions in the cluster.
//   Usually that is one subscriber connection per instance; connection 0 also carries rpc and reply channels.
//
// Channels, under `prefix` (default "hub:bus:"): t:<topic> for publish/subscribe, rpc:<topic> for requests,
// reply:<instanceID> for this instance's replies, sync:<instanceID>:<n> for sync() markers. Payloads are JSON
// envelopes, so every subscriber decodes its own copy.
//
// Request/reply: request() publishes {id, replyTo, m} on rpc:<topic>; 0 receivers is BusNoResponderError at once.
// The responder publishes {id, ok, v | e} to replyTo; ok:false becomes BusRemoteError. The timeout starts before
// anything is sent. One responder per topic per instance (not enforced across instances: the first reply wins;
// pod-scoped topics such as pod.<id>.rpc have one server by construction).
//
// Delivery is at most once and publish resolves on send, before subscribers ran. sync() waits until everything
// published before it has reached this instance's subscribers and their handlers settled (a marker through each
// subscriber connection: Redis keeps per-connection order). Do not await sync() inside a handler.
//
// Reconnects: Bun reconnects a dropped connection by itself, but the server has forgotten its subscriptions while
// the client keeps its listeners and leaves subscriber mode (Bun 1.3.5). On a subscriber connection's onconnect the
// bus closes it and subscribes its channels on a fresh duplicate. Messages sent while it was down are lost.
import { randomUUID } from "node:crypto"
import { realTimers } from "./memory-bus"
import { BusNoResponderError, BusRemoteError, BusTimeoutError, type Bus, type BusHandler, type BusResponder, type Data, type RequestOptions, type Timers, type Unsubscribe } from "./types"

type Listener = (message: string, channel: string) => void

/** The part of Bun.RedisClient the bus uses (a fake in unit tests). */
export interface BusRedis {
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string, listener: Listener): Promise<number>
  unsubscribe(channel: string, listener?: Listener): Promise<void>
  duplicate(): Promise<BusRedis>
  close(): void
  /** Runs when the client (re)connects. */
  onconnect: (() => void) | null
}

export interface ValkeyBusOptions {
  /** Opens the command connection (default: new Bun.RedisClient(url)); subscriber connections are its duplicates. */
  readonly client?: () => BusRedis
  /** Names this instance's reply and sync channels (default: a random UUID; unique per process). */
  readonly instanceID?: string
  /** Request timeouts (injectable for tests). */
  readonly timers?: Timers
  /** Called with a subscriber's or responder's error (default: logged). */
  readonly onError?: (error: unknown, topic: string) => void
  /** Channel name prefix (default "hub:bus:"). */
  readonly prefix?: string
  /** How long sync() waits for a marker to come back (default 5000 ms). */
  readonly syncTimeoutMs?: number
}

/** A subscriber connection slot; its connection is replaced after a reconnect. */
interface SubscriberConnection {
  /** The current connection, once it listens on every channel the slot had when it opened. */
  client: Promise<BusRedis>
  /** The current connection once it is open (close() closes it at once). */
  open?: BusRedis
  /** The topics subscribed on this slot (each at most once). */
  readonly topics: Set<string>
  /** Every channel the slot listens on, with its one listener (what a replacement connection subscribes). */
  readonly channels: Map<string, Listener>
  readonly syncChannel: string
}

interface PendingRequest {
  readonly topic: string
  readonly resolve: (reply: Data) => void
  readonly reject: (error: unknown) => void
  readonly timer: unknown
}

/** On an rpc channel. */
interface RequestEnvelope {
  readonly id: string
  readonly replyTo: string
  readonly m?: Data
}

/** On a reply channel: the reply (`v`) or the responder's error message (`e`). */
interface ReplyEnvelope {
  readonly id: string
  readonly ok: boolean
  readonly v?: Data
  readonly e?: string
}

export class ValkeyBus implements Bus {
  private readonly makeClient: () => BusRedis
  private readonly instanceID: string
  private readonly prefix: string
  private readonly onError: (error: unknown, topic: string) => void
  private readonly syncTimeoutMs: number
  private readonly timers: Timers
  private readonly replyChannel: string
  private readonly responders = new Map<string, BusResponder>()
  private readonly pending = new Map<string, PendingRequest>()
  private nextRequest = 0
  private replies?: Promise<void>
  private main?: BusRedis
  private readonly subscribers = new Map<number, SubscriberConnection>()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly syncWaiters = new Map<string, () => void>()
  /** The SUBSCRIBE sent per connection and channel (so a channel is never subscribed twice on one connection). */
  private readonly subscribed = new WeakMap<BusRedis, Map<string, Promise<unknown>>>()
  private closed = false

  constructor(url: string, options: ValkeyBusOptions = {}) {
    this.makeClient = options.client ?? (() => new Bun.RedisClient(url))
    this.instanceID = options.instanceID ?? randomUUID()
    this.prefix = options.prefix ?? "hub:bus:"
    this.onError = options.onError ?? ((error, topic) => console.error(`hub: bus subscriber on ${topic} failed:`, error))
    this.syncTimeoutMs = options.syncTimeoutMs ?? 5000
    this.timers = options.timers ?? realTimers
    this.replyChannel = `${this.prefix}reply:${this.instanceID}`
  }

  async publish(topic: string, message: Data): Promise<number> {
    return this.connection().publish(this.topicChannel(topic), JSON.stringify({ m: message }))
  }

  async subscribe(topic: string, handler: BusHandler): Promise<Unsubscribe> {
    this.assertOpen()
    let index = 0
    while (this.subscribers.get(index)?.topics.has(topic)) index++
    const subscriber = this.subscriber(index)
    subscriber.topics.add(topic)
    const channel = this.topicChannel(topic)
    let done = false
    // The guard covers a channel given up while its connection was being replaced.
    const listener: Listener = (raw) => {
      if (!done) this.dispatch(topic, raw, handler)
    }
    try {
      await this.listen(subscriber, channel, listener)
    } catch (error) {
      subscriber.topics.delete(topic)
      throw error
    }
    return async () => {
      if (done) return
      done = true
      subscriber.topics.delete(topic)
      await this.unlisten(subscriber, channel, listener)
    }
  }

  async serve(topic: string, responder: BusResponder): Promise<Unsubscribe> {
    this.assertOpen()
    if (this.responders.has(topic)) throw new Error(`already serving ${topic}`)
    this.responders.set(topic, responder)
    const channel = this.rpcChannel(topic)
    const listener: Listener = (raw) => this.answer(topic, raw, responder)
    const subscriber = this.subscriber(0)
    try {
      await this.listen(subscriber, channel, listener)
    } catch (error) {
      if (this.responders.get(topic) === responder) this.responders.delete(topic)
      throw error
    }
    let done = false
    return async () => {
      if (done) return
      done = true
      if (this.responders.get(topic) === responder) this.responders.delete(topic)
      await this.unlisten(subscriber, channel, listener)
    }
  }

  request<T = Data>(topic: string, message: Data, options: RequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error("bus closed"))
      const id = String(++this.nextRequest)
      // Set before anything is sent, so the timeout covers connecting too.
      const timer = this.timers.set(() => this.settle(id, (p) => p.reject(new BusTimeoutError(topic, options.timeoutMs))), options.timeoutMs)
      this.pending.set(id, { topic, resolve: resolve as (reply: Data) => void, reject, timer })
      const envelope: RequestEnvelope = { id, replyTo: this.replyChannel, m: message }
      void (async () => {
        await this.listenForReplies()
        const receivers = await this.connection().publish(this.rpcChannel(topic), JSON.stringify(envelope))
        if (receivers === 0) this.settle(id, (p) => p.reject(new BusNoResponderError(topic)))
      })().catch((error) => this.settle(id, (p) => p.reject(error)))
    })
  }

  /** Resolves once every message published before the call reached this instance's handlers and they settled. */
  async sync(): Promise<void> {
    await Promise.all([...this.subscribers.values()].map((subscriber) => this.syncSubscriber(subscriber)))
    await Promise.allSettled([...this.inFlight])
  }

  private async syncSubscriber(subscriber: SubscriberConnection): Promise<void> {
    await subscriber.client
    const token = randomUUID()
    let timer: unknown
    try {
      const seen = new Promise<void>((resolve, reject) => {
        this.syncWaiters.set(token, resolve)
        timer = realTimers.set(() => reject(new Error(`bus sync: no echo within ${this.syncTimeoutMs} ms`)), this.syncTimeoutMs)
      })
      if ((await this.connection().publish(subscriber.syncChannel, token)) === 0) throw new Error("bus sync: subscriber connection lost")
      await seen
    } finally {
      this.syncWaiters.delete(token)
      realTimers.clear(timer)
    }
  }

  private dispatch(topic: string, raw: string, handler: BusHandler): void {
    let message: Data
    try {
      message = (JSON.parse(raw) as { m?: Data }).m
    } catch (error) {
      this.onError(error, topic)
      return
    }
    const run = (async () => {
      try {
        await handler(message, topic)
      } catch (error) {
        this.onError(error, topic)
      }
    })()
    this.track(run)
  }

  /** Closes every connection and rejects pending requests; later calls reject. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const id of [...this.pending.keys()]) this.settle(id, (p) => p.reject(new Error("bus closed")))
    this.main?.close()
    // A connection still opening closes itself when it arrives (see subscriber()).
    for (const subscriber of this.subscribers.values()) subscriber.open?.close()
    this.subscribers.clear()
  }

  /** Answers one request on a served topic: the responder's reply or error goes to the asker's reply channel. */
  private answer(topic: string, raw: string, responder: BusResponder): void {
    let request: RequestEnvelope
    try {
      request = JSON.parse(raw) as RequestEnvelope
      if (typeof request?.id !== "string" || typeof request.replyTo !== "string") throw new Error("malformed request")
    } catch (error) {
      this.onError(error, topic)
      return
    }
    const run = (async () => {
      let reply: string
      try {
        reply = JSON.stringify({ id: request.id, ok: true, v: await responder(request.m, topic) } satisfies ReplyEnvelope)
      } catch (error) {
        reply = JSON.stringify({ id: request.id, ok: false, e: error instanceof Error ? error.message : String(error) } satisfies ReplyEnvelope)
      }
      if (this.closed) return
      try {
        await this.connection().publish(request.replyTo, reply)
      } catch (error) {
        // Closing this instance cancels replies on the way; that is not a responder failure.
        if (!this.closed) this.onError(error, topic)
      }
    })()
    this.track(run)
  }

  /** Subscribes this instance's reply channel (once). */
  private listenForReplies(): Promise<void> {
    this.replies ??= (async () => {
      await this.listen(this.subscriber(0), this.replyChannel, (raw) => this.receiveReply(raw))
    })().catch((error) => {
      this.replies = undefined
      throw error
    })
    return this.replies
  }

  private receiveReply(raw: string): void {
    let reply: ReplyEnvelope
    try {
      reply = JSON.parse(raw) as ReplyEnvelope
    } catch (error) {
      this.onError(error, this.replyChannel)
      return
    }
    this.settle(String(reply?.id), (p) => (reply.ok ? p.resolve(reply.v) : p.reject(new BusRemoteError(p.topic, String(reply.e)))))
  }

  /** Ends a pending request once (later replies, timeouts and errors are ignored). */
  private settle(id: string, fn: (pending: PendingRequest) => void): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    this.timers.clear(pending.timer)
    fn(pending)
  }

  private track(run: Promise<void>): void {
    this.inFlight.add(run)
    void run.finally(() => this.inFlight.delete(run))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("bus closed")
  }

  private connection(): BusRedis {
    this.assertOpen()
    return (this.main ??= this.makeClient())
  }

  /** Listens on a channel through a subscriber slot (one listener per channel and slot). */
  private async listen(subscriber: SubscriberConnection, channel: string, listener: Listener): Promise<void> {
    subscriber.channels.set(channel, listener)
    for (;;) {
      const current = subscriber.client
      try {
        const client = await current
        if (current !== subscriber.client) continue
        await this.subscribeOnce(client, channel, listener)
        return
      } catch (error) {
        // Replaced meanwhile: the new connection subscribes what the slot has; make sure of it on that one.
        if (current !== subscriber.client) continue
        if (subscriber.channels.get(channel) === listener) subscriber.channels.delete(channel)
        throw error
      }
    }
  }

  private subscribeOnce(client: BusRedis, channel: string, listener: Listener): Promise<unknown> {
    let sent = this.subscribed.get(client)
    if (!sent) this.subscribed.set(client, (sent = new Map()))
    const existing = sent.get(channel)
    if (existing) return existing
    const subscribing = client.subscribe(channel, listener).catch((error) => {
      sent.delete(channel)
      throw error
    })
    sent.set(channel, subscribing)
    return subscribing
  }

  /**
   * Stops listening on a channel. An UNSUBSCRIBE that fails (the connection is down or being replaced) is not an
   * error: the replacement connection subscribes only what the slot still has.
   */
  private async unlisten(subscriber: SubscriberConnection, channel: string, listener: Listener): Promise<void> {
    if (subscriber.channels.get(channel) !== listener) return
    subscriber.channels.delete(channel)
    const client = subscriber.open
    if (!client || this.closed) return
    this.subscribed.get(client)?.delete(channel)
    await client.unsubscribe(channel, listener).catch(() => {})
  }

  private subscriber(index: number): SubscriberConnection {
    const existing = this.subscribers.get(index)
    if (existing) return existing
    const syncChannel = `${this.prefix}sync:${this.instanceID}:${index}`
    const sync: Listener = (token) => this.syncWaiters.get(token)?.()
    const subscriber: SubscriberConnection = { client: Promise.resolve(undefined!), topics: new Set(), channels: new Map([[syncChannel, sync]]), syncChannel }
    this.subscribers.set(index, subscriber)
    this.openSubscriber(subscriber, index)
    return subscriber
  }

  /** Opens the slot's connection (a duplicate of the command connection) and subscribes the slot's channels. */
  private openSubscriber(subscriber: SubscriberConnection, index: number): void {
    const replacing = subscriber.open !== undefined
    subscriber.open = undefined
    subscriber.client = (async () => {
      const client = await this.connection().duplicate()
      if (this.closed) {
        client.close()
        throw new Error("bus closed")
      }
      subscriber.open = client
      client.onconnect = () => void this.checkSubscriber(subscriber, client, index)
      await Promise.all([...subscriber.channels].map(([channel, listener]) => this.subscribeOnce(client, channel, listener)))
      return client
    })()
    subscriber.client.catch((error) => {
      if (this.closed || this.subscribers.get(index) !== subscriber) return
      // Later calls open a new slot; what this one carried is gone.
      this.subscribers.delete(index)
      subscriber.open?.close()
      if (replacing) this.onError(error, `subscriber connection ${index}`)
    })
  }

  /**
   * On a subscriber connection's onconnect (Bun runs it for the first connection too, and after reconnecting a
   * dropped one): once the slot has opened, a PUBLISH on its sync channel reaching nobody means the server forgot
   * the subscriptions (a reconnect). The client is then in no state to redo them cleanly (it keeps its listeners
   * but left subscriber mode): close it and subscribe the slot's channels on a fresh connection.
   */
  private async checkSubscriber(subscriber: SubscriberConnection, client: BusRedis, index: number): Promise<void> {
    try {
      await subscriber.client
      if (this.closed || subscriber.open !== client) return
      if ((await this.connection().publish(subscriber.syncChannel, "probe")) > 0) return
    } catch (error) {
      if (this.closed || subscriber.open !== client) return
      this.onError(error, `subscriber connection ${index}`)
      return
    }
    if (this.closed || subscriber.open !== client) return
    client.onconnect = null
    client.close()
    this.openSubscriber(subscriber, index)
  }

  private topicChannel(topic: string): string {
    return `${this.prefix}t:${topic}`
  }

  private rpcChannel(topic: string): string {
    return `${this.prefix}rpc:${topic}`
  }
}
