import { randomUUID } from "node:crypto"
import { realTimers } from "./memory-bus"
import type { Bus, BusHandler, BusResponder, Data, RequestOptions, Timers, Unsubscribe } from "./types"

type Listener = (message: string, channel: string) => void

export interface BusRedis {
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string, listener: Listener): Promise<number>
  unsubscribe(channel: string, listener?: Listener): Promise<void>
  duplicate(): Promise<BusRedis>
  close(): void
}

export interface ValkeyBusOptions {
  readonly client?: () => BusRedis
  readonly instanceID?: string
  readonly timers?: Timers
  readonly onError?: (error: unknown, topic: string) => void
  readonly prefix?: string
  readonly syncTimeoutMs?: number
}

interface SubscriberConnection {
  readonly client: Promise<BusRedis>
  readonly topics: Set<string>
  readonly syncChannel: string
}

export class ValkeyBus implements Bus {
  private readonly makeClient: () => BusRedis
  private readonly instanceID: string
  private readonly prefix: string
  private readonly onError: (error: unknown, topic: string) => void
  private readonly syncTimeoutMs: number
  private main?: BusRedis
  private readonly subscribers = new Map<number, SubscriberConnection>()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly syncWaiters = new Map<string, () => void>()

  constructor(url: string, options: ValkeyBusOptions = {}) {
    this.makeClient = options.client ?? (() => new Bun.RedisClient(url))
    this.instanceID = options.instanceID ?? randomUUID()
    this.prefix = options.prefix ?? "hub:bus:"
    this.onError = options.onError ?? ((error, topic) => console.error(`hub: bus subscriber on ${topic} failed:`, error))
    this.syncTimeoutMs = options.syncTimeoutMs ?? 5000
  }

  async publish(topic: string, message: Data): Promise<number> {
    return this.connection().publish(this.topicChannel(topic), JSON.stringify({ m: message }))
  }

  async subscribe(topic: string, handler: BusHandler): Promise<Unsubscribe> {
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
      await client.unsubscribe(channel, listener)
    }
  }

  serve(_topic: string, _responder: BusResponder): Promise<Unsubscribe> {
    throw new Error("not implemented")
  }

  request<T = Data>(_topic: string, _message: Data, _options: RequestOptions): Promise<T> {
    throw new Error("not implemented")
  }

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
    this.inFlight.add(run)
    void run.finally(() => this.inFlight.delete(run))
  }

  private connection(): BusRedis {
    return (this.main ??= this.makeClient())
  }

  private subscriber(index: number): SubscriberConnection {
    const existing = this.subscribers.get(index)
    if (existing) return existing
    const syncChannel = `${this.prefix}sync:${this.instanceID}:${index}`
    const client = this.connection()
      .duplicate()
      .then(async (duplicate) => {
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
}
