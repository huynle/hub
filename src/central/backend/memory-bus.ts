// Bus in process memory (a cluster uses Valkey/Redis pub/sub). Messages are copied, like a network hop, so
// publisher and subscribers never share objects. publish resolves once every subscriber has handled the message
// here; callers must not rely on that (a networked bus resolves on send).
import { BusNoResponderError, BusRemoteError, BusTimeoutError, type Bus, type BusHandler, type BusResponder, type Data, type RequestOptions, type Timers, type Unsubscribe } from "./types"

const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface MemoryBusOptions {
  /** Request timeouts (injectable for tests). */
  readonly timers?: Timers
  /** Called with a subscriber's error (default: logged). */
  readonly onError?: (error: unknown, topic: string) => void
}

export class MemoryBus implements Bus {
  private readonly timers: Timers
  private readonly onError: (error: unknown, topic: string) => void
  private readonly subscribers = new Map<string, Set<BusHandler>>()
  private readonly responders = new Map<string, BusResponder>()

  constructor(options: MemoryBusOptions = {}) {
    this.timers = options.timers ?? realTimers
    this.onError = options.onError ?? ((error, topic) => console.error(`hub: bus subscriber on ${topic} failed:`, error))
  }

  async publish(topic: string, message: Data): Promise<number> {
    const handlers = [...(this.subscribers.get(topic) ?? [])]
    await Promise.all(
      handlers.map(async (handler) => {
        try {
          await handler(structuredClone(message), topic)
        } catch (error) {
          this.onError(error, topic)
        }
      }),
    )
    return handlers.length
  }

  async subscribe(topic: string, handler: BusHandler): Promise<Unsubscribe> {
    let handlers = this.subscribers.get(topic)
    if (!handlers) this.subscribers.set(topic, (handlers = new Set()))
    // Wrapped so subscribing one function twice gives two independent subscriptions.
    const subscription: BusHandler = (message, t) => handler(message, t)
    handlers.add(subscription)
    return async () => {
      const current = this.subscribers.get(topic)
      current?.delete(subscription)
      if (current?.size === 0) this.subscribers.delete(topic)
    }
  }

  async serve(topic: string, responder: BusResponder): Promise<Unsubscribe> {
    if (this.responders.has(topic)) throw new Error(`already serving ${topic}`)
    this.responders.set(topic, responder)
    return async () => {
      if (this.responders.get(topic) === responder) this.responders.delete(topic)
    }
  }

  request<T = Data>(topic: string, message: Data, options: RequestOptions): Promise<T> {
    const responder = this.responders.get(topic)
    if (!responder) return Promise.reject(new BusNoResponderError(topic))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = this.timers.set(() => {
        if (settled) return
        settled = true
        reject(new BusTimeoutError(topic, options.timeoutMs))
      }, options.timeoutMs)
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        this.timers.clear(timer)
        fn()
      }
      Promise.resolve()
        .then(() => responder(structuredClone(message), topic))
        .then(
          (reply) => settle(() => resolve(structuredClone(reply) as T)),
          (error) => settle(() => reject(new BusRemoteError(topic, error instanceof Error ? error.message : String(error)))),
        )
    })
  }
}
