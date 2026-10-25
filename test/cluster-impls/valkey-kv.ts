// ValkeyKv in the shared Kv contract (HUB_IT_CLUSTER=1): expiry is server-side, so no fake-clock tests.
import { ValkeyKv } from "../../src/central/backend/valkey-kv"
import type { ImplRegistry } from "../backend-impls"
import type { ItCluster } from "../cluster-it"

export default function register(registry: ImplRegistry, cluster: ItCluster): void {
  registry.add("kv", {
    name: "ValkeyKv",
    backend: "valkey",
    supports: [],
    make: async () => new ValkeyKv(await cluster.freshValkey()),
    dispose: (kv) => (kv as ValkeyKv).close(),
  })
}
