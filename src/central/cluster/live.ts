// The console live stream across pods (design §9, decision vkxkqiuf §6). A user's events go to every pod over the
// Bus topic user.<id>.live, so a console connected to any pod sees what happens on the pod holding the spoke (status,
// activity, streamed text, messages, decisions, launches, agent audit). Every event except streamed text (delta,
// reasoning) is appended to the shared EventLog first and carries its id, so a console that reconnects to another
// pod resumes by Last-Event-ID; streamed text is broadcast only. Events of one user are sent in order from a pod.
// Catalog changes are not user events here: each pod rebuilds its consoles' catalog from its own (cluster-wide)
// registry; publishCatalog() only tells every pod that the stored machines changed.
import type { Bus, EventLog, EventMessage, Unsubscribe } from "../backend/types"

export const liveTopic = (userID: string): string => `user.${userID}.live`
/** Stored machines changed (approved, revoked, moved): every pod sends its consoles a fresh catalog. */
export const CATALOG_TOPIC = "live.catalog"
/** Broadcast only, never logged (high volume; a resumed console refetches the transcript). */
export const BROADCAST_ONLY: ReadonlySet<string> = new Set(["delta", "reasoning"])

/** One user event as it travels the Bus. */
export interface LiveEvent {
  /** The pod that sent it. */
  readonly pod: string
  readonly message: EventMessage
  /** Its EventLog id (absent for streamed text). */
  readonly id?: string
  /** Not for this device (the one that made the change). */
  readonly exceptDevice?: string
}

export interface LiveSubscription {
  /** Resolves once the pod listens on the user's topic. */
  readonly ready: Promise<void>
  close(): void
}

export interface LiveFanoutOptions {
  readonly bus: Bus
  readonly events: EventLog
  /** This pod (HUB_POD_ID). */
  readonly podID: string
  readonly onError?: (error: unknown) => void
}

interface UserTopic {
  readonly handlers: Set<(event: LiveEvent) => void>
  readonly subscribed: Promise<Unsubscribe | undefined>
}

const isLiveEvent = (value: unknown): value is LiveEvent => {
  const event = value as LiveEvent | null
  return typeof event === "object" && event !== null && typeof event.message === "object" && event.message !== null && typeof event.message.type === "string"
}

export class LiveFanout {
  readonly podID: string
  private readonly options: LiveFanoutOptions
  private readonly onError: (error: unknown) => void
  /** Per user: the last send in flight (sends of one user go out in order). */
  private readonly sending = new Map<string, Promise<void>>()
  /** Users this pod listens to, with their local handlers. */
  private readonly topics = new Map<string, UserTopic>()
  private readonly catalogHandlers = new Set<() => void>()
  private catalogSubscription?: Promise<Unsubscribe>

  constructor(options: LiveFanoutOptions) {
    this.options = options
    this.podID = options.podID
    this.onError = options.onError ?? ((error) => console.error(`[hub] live fan-out failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  /** Listens for catalog announcements. */
  async start(): Promise<void> {
    this.catalogSubscription ??= this.options.bus.subscribe(CATALOG_TOPIC, () => {
      for (const handler of [...this.catalogHandlers]) this.guard(handler)
    })
    await this.catalogSubscription
  }

  /** Drops this pod's subscriptions (once they are made: a Bus that never connected must not hold up a stop). */
  async stop(): Promise<void> {
    const catalog = this.catalogSubscription
    this.catalogSubscription = undefined
    const topics = [...this.topics.values()]
    this.topics.clear()
    for (const pending of [catalog, ...topics.map((topic) => topic.subscribed)]) void pending?.then((off) => off?.()).catch(this.onError)
  }

  /** Logs (unless streamed text) and publishes a user's event; resolves once it is on the Bus. */
  send(userID: string, message: EventMessage, exceptDevice?: string): Promise<void> {
    const previous = this.sending.get(userID) ?? Promise.resolve()
    const next = previous.then(async () => {
      const id = BROADCAST_ONLY.has(message.type) ? undefined : await this.options.events.append(userID, message, exceptDevice ? { exceptDevice } : {})
      const event: LiveEvent = { pod: this.podID, message, ...(id ? { id } : {}), ...(exceptDevice ? { exceptDevice } : {}) }
      await this.options.bus.publish(liveTopic(userID), event)
    })
    const tail = next.catch(this.onError)
    this.sending.set(userID, tail)
    void tail.then(() => {
      if (this.sending.get(userID) === tail) this.sending.delete(userID)
    })
    return next
  }

  /** The user's events from every pod (this one included). */
  subscribe(userID: string, handler: (event: LiveEvent) => void): LiveSubscription {
    let topic = this.topics.get(userID)
    if (!topic) {
      const handlers = new Set<(event: LiveEvent) => void>()
      const subscribed = this.options.bus
        .subscribe(liveTopic(userID), (event) => {
          if (!isLiveEvent(event)) return
          for (const h of [...handlers]) this.guard(() => h(event))
        })
        .catch((error: unknown) => {
          this.onError(error)
          return undefined
        })
      topic = { handlers, subscribed }
      this.topics.set(userID, topic)
    }
    const current = topic
    current.handlers.add(handler)
    let closed = false
    return {
      ready: current.subscribed.then(() => {}),
      close: () => {
        if (closed) return
        closed = true
        current.handlers.delete(handler)
        if (current.handlers.size || this.topics.get(userID) !== current) return
        this.topics.delete(userID)
        void current.subscribed.then((off) => off?.()).catch(this.onError)
      },
    }
  }

  /** Tells every pod (this one included) that the stored machines changed. */
  async publishCatalog(): Promise<void> {
    await this.options.bus.publish(CATALOG_TOPIC, { pod: this.podID })
  }

  onCatalog(handler: () => void): () => void {
    this.catalogHandlers.add(handler)
    return () => void this.catalogHandlers.delete(handler)
  }

  private guard(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      this.onError(error)
    }
  }
}
