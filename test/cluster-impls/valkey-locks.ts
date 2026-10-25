// ValkeyLocks in the shared Locks contract (HUB_IT_CLUSTER=1): the `now` option stamps lease expiresAt (clock),
// but leases expire server-side (no timeTravel).
import { ValkeyLocks } from "../../src/central/backend/valkey-locks"
import type { ImplRegistry } from "../backend-impls"
import type { ItCluster } from "../cluster-it"

export default function register(registry: ImplRegistry, cluster: ItCluster): void {
  registry.add("locks", {
    name: "ValkeyLocks",
    backend: "valkey",
    supports: ["clock"],
    make: async (options) => new ValkeyLocks(await cluster.freshValkey(), options),
    dispose: (locks) => (locks as ValkeyLocks).close(),
  })
}
