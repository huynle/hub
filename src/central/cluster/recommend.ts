// Recommendations on permissions held by another pod (design §5, §9; decision vkxkqiuf §5). An escalation shows the
// agent's recommendation on the request's blocker (Registry.recommend), and only the pod holding the request (its
// spoke) can change that blocker: the other pods see it through the cluster view. recommend() applies it here when
// this pod holds the request, else publishes it on RECOMMEND_TOPIC, where every pod tries it on its own registry (only
// the holder has it). Closing escalations needs no routing: the holder's permission-closed listener closes their
// Decisions in the shared state.
import type { Bus, Unsubscribe } from "../backend/types"
import type { BlockerRecommendation } from "../../status"

export const RECOMMEND_TOPIC = "cluster.recommend"

interface RecommendMessage {
  readonly from: string
  readonly requestID: string
  readonly recommendation: BlockerRecommendation
}

export interface ClusterRecommendationsOptions {
  readonly bus: Bus
  /** This pod (HUB_POD_ID). */
  readonly podID: string
  readonly registry: { recommend(requestID: string, recommendation: BlockerRecommendation): boolean }
  readonly onError?: (error: unknown) => void
}

export class ClusterRecommendations {
  private readonly options: ClusterRecommendationsOptions
  private readonly onError: (error: unknown) => void
  private unsubscribe: Unsubscribe | undefined

  constructor(options: ClusterRecommendationsOptions) {
    this.options = options
    this.onError = options.onError ?? ((error) => console.error(`[hub] cluster recommendation: ${error instanceof Error ? error.message : String(error)}`))
  }

  /** Applies other pods' recommendations for requests this pod holds. */
  async start(): Promise<void> {
    if (this.unsubscribe) return
    this.unsubscribe = await this.options.bus.subscribe(RECOMMEND_TOPIC, (message) => {
      const m = message as Partial<RecommendMessage> | undefined
      if (m?.from === this.options.podID || typeof m?.requestID !== "string" || typeof m.recommendation !== "object" || m.recommendation === null) return
      this.options.registry.recommend(m.requestID, m.recommendation)
    })
  }

  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    await unsubscribe?.()
  }

  /** Shows the recommendation on the request's blocker: here, or (true: sent) on the pod holding it. */
  recommend(requestID: string, recommendation: BlockerRecommendation): boolean {
    if (this.options.registry.recommend(requestID, recommendation)) return true
    const message: RecommendMessage = { from: this.options.podID, requestID, recommendation }
    void this.options.bus.publish(RECOMMEND_TOPIC, message).catch((error) => this.onError(error))
    return true
  }
}
