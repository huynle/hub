// ValkeyCounters in the shared Counters contract (HUB_IT_CLUSTER=1): windows expire server-side, so no
// fake-clock tests.
import { ValkeyCounters } from "../../src/central/backend/valkey-counters"
import type { ImplRegistry } from "../backend-impls"
import type { ItCluster } from "../cluster-it"

export default function register(registry: ImplRegistry, cluster: ItCluster): void {
  registry.add("counters", {
    name: "ValkeyCounters",
    backend: "valkey",
    supports: [],
    make: async () => new ValkeyCounters(await cluster.freshValkey()),
    dispose: (counters) => (counters as ValkeyCounters).close(),
  })
}
