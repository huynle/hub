// Recommendations on permissions held by another pod (design §5, §9): an escalation shows the agent's
// recommendation on the request's blocker (Registry.recommend), which only the pod holding the request can change;
// ClusterRecommendations sends it there over the Bus (cluster.recommend) when this pod does not hold it.
import { describe, expect, test } from "bun:test"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { ClusterRecommendations, RECOMMEND_TOPIC } from "../src/central/cluster/recommend"
import type { BlockerRecommendation } from "../src/status"

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** A registry holding the given pending requests; records what it was told. */
function registry(held: string[]) {
  const calls: Array<{ requestID: string; recommendation: BlockerRecommendation }> = []
  return {
    calls,
    recommend(requestID: string, recommendation: BlockerRecommendation): boolean {
      if (!held.includes(requestID)) return false
      calls.push({ requestID, recommendation })
      return true
    },
  }
}

const rec: BlockerRecommendation = { by: "@reviewer", recommends: "approve", why: "read-only" }

describe("ClusterRecommendations", () => {
  test("a request held here is recommended here; one held on another pod reaches that pod", async () => {
    const bus = new MemoryBus()
    const ra = registry(["per_a"])
    const rb = registry(["per_b"])
    const a = new ClusterRecommendations({ bus, podID: "pod-a", registry: ra })
    const b = new ClusterRecommendations({ bus, podID: "pod-b", registry: rb })
    await a.start()
    await b.start()
    expect(a.recommend("per_a", rec)).toBe(true)
    expect(ra.calls).toEqual([{ requestID: "per_a", recommendation: rec }])
    // Held on B: sent there (true: it went out; the holder applies it).
    expect(a.recommend("per_b", rec)).toBe(true)
    await settle()
    expect(rb.calls).toEqual([{ requestID: "per_b", recommendation: rec }])
    expect(ra.calls).toHaveLength(1)
    await a.stop()
    await b.stop()
  })

  test("after stop the pod no longer applies others' recommendations; malformed messages are ignored", async () => {
    const bus = new MemoryBus()
    const ra = registry(["per_a"])
    const a = new ClusterRecommendations({ bus, podID: "pod-a", registry: ra })
    await a.start()
    await bus.publish(RECOMMEND_TOPIC, { from: "pod-x", requestID: 42 })
    await bus.publish(RECOMMEND_TOPIC, { from: "pod-x", requestID: "per_a" })
    expect(ra.calls).toEqual([])
    await a.stop()
    await bus.publish(RECOMMEND_TOPIC, { from: "pod-x", requestID: "per_a", recommendation: rec })
    expect(ra.calls).toEqual([])
  })
})
