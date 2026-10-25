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
// A dropped connection is not resubscribed here: Bun's autoReconnect reopens it (see open questions in P6-T5).
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

interface SubscriberConnection {
  readonly client: Promise<BusRedis>
  readonly topics: Set<string>
  readonly syncChannel: string
  /** The connection once it is open (close() closes it at once). */
  open?: BusRedis
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
    const listener: Listener = (raw) => this.dispatch(topic, raw, handler)
    let client: BusRedis
    try {
      client = await subscriber.client
      await client.subscribe(channel, listener)
    } catch (error) {
      subscriber.topics.delete(topic)
      throw error
    }
    let done = false
    return async () => {
      if (done) return
      done = true
      subscriber.topics.delete(topic)
      if (!this.closed) await client.unsubscribe(channel, listener)
    }
  }

  async serve(topic: string, responder: BusResponder): Promise<Unsubscribe> {
    this.assertOpen()
    if (this.responders.has(topic)) throw new Error(`already serving ${topic}`)
    this.responders.set(topic, responder)
    const channel = this.rpcChannel(topic)
    const listener: Listener = (raw) => this.answer(topic, raw, responder)
    let client: BusRedis
    try {
      client = await this.subscriber(0).client
      await client.subscribe(channel, listener)
    } catch (error) {
      if (this.responders.get(topic) === responder) this.responders.delete(topic)
      throw error
    }
    let done = false
    return async () => {
      if (done) return
      done = true
      if (this.responders.get(topic) === responder) this.responders.delete(topic)
      if (!this.closed) await client.unsubscribe(channel, listener)
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
      const client = await this.subscriber(0).client
      await client.subscribe(this.replyChannel, (raw) => this.receiveReply(raw))
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

  private subscriber(index: number): SubscriberConnection {
    const existing = this.subscribers.get(index)
    if (existing) return existing
    const syncChannel = `${this.prefix}sync:${this.instanceID}:${index}`
    const client = this.connection()
      .duplicate()
      .then(async (duplicate) => {
        if (this.closed) {
          duplicate.close()
          throw new Error("bus closed")
        }
        subscriber.open = duplicate
        await duplicate.subscribe(syncChannel, (token) => this.syncWaiters.get(token)?.())
        return duplicate
      })
    const subscriber: SubscriberConnection = { client, topics: new Set(), syncChannel }
    this.subscribers.set(index, subscriber)
    client.catch(() => {
      if (this.subscribers.get(index) === subscriber) this.subscribers.delete(index)
    })
    return subscriber
  }

  private topicChannel(topic: string): string {
    return `${this.prefix}t:${topic}`
  }

  private rpcChannel(topic: string): string {
    return `${this.prefix}rpc:${topic}`
  }
}
