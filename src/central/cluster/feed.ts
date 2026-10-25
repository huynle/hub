// A per-user feed of items (stored agent messages, launch changes) that a cluster shares over the Bus (design §9,
// decision vkxkqiuf §6). publish() runs this pod's listeners at once and, once attached, sends the item to the other
// pods, whose listeners run when it arrives (at most once). A listener subscribed with `origin: true` runs only for
// items published on its own pod: work that must happen once per item (the console broadcast, which the live
// fan-out already sends to every pod; webhooks; closing a launch's connections, which pod RPC already reaches).
// Unattached (one process), every listener runs for every item, as before.
import type { Bus, Unsubscribe } from "../backend/types"

export type FeedListener<T> = (userID: string, item: T) => void

export interface FeedSubscribeOptions {
  /** Only items published on this pod. */
  readonly origin?: boolean
}

export interface FeedAttachOptions {
  readonly bus: Bus
  /** This pod (HUB_POD_ID). */
  readonly podID: string
}

interface Envelope<T> {
  readonly pod: string
  readonly userID: string
  readonly item: T
}

export class Feed<T> {
  private readonly listeners = new Map<FeedListener<T>, boolean>()
  private attached?: { readonly bus: Bus; readonly podID: string; readonly unsubscribe: Promise<Unsubscribe> }

  constructor(
    /** The Bus topic. */
    private readonly topic: string,
    /** Logs a throwing listener (never stops the others). */
    private readonly report: (cause: unknown) => void,
  ) {}

  subscribe(listener: FeedListener<T>, options: FeedSubscribeOptions = {}): () => void {
    // Wrapped so subscribing one function twice gives two independent subscriptions.
    const own: FeedListener<T> = (userID, item) => listener(userID, item)
    this.listeners.set(own, options.origin === true)
    return () => void this.listeners.delete(own)
  }

  publish(userID: string, item: T): void {
    this.run(userID, item, true)
    const attached = this.attached
    if (attached) {
      attached.bus.publish(this.topic, { pod: attached.podID, userID, item } satisfies Envelope<T>).catch((cause: unknown) => this.report(cause))
    }
  }

  /** Shares the feed with the other pods on the Bus. */
  async attach(options: FeedAttachOptions): Promise<void> {
    if (this.attached) return
    const unsubscribe = options.bus.subscribe(this.topic, (raw) => {
      const envelope = raw as Envelope<T> | null
      if (typeof envelope !== "object" || envelope === null || typeof envelope.userID !== "string") return
      if (envelope.pod === options.podID) return
      this.run(envelope.userID, envelope.item, false)
    })
    this.attached = { ...options, unsubscribe }
    await unsubscribe
  }

  async detach(): Promise<void> {
    const attached = this.attached
    this.attached = undefined
    if (attached) await (await attached.unsubscribe)()
  }

  private run(userID: string, item: T, local: boolean): void {
    for (const [listener, origin] of [...this.listeners]) {
      if (origin && !local) continue
      try {
        listener(userID, item)
      } catch (cause) {
        this.report(cause)
      }
    }
  }
}
