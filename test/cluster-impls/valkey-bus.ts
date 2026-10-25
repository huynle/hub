// ValkeyBus in the shared Bus contract (test/central-backend-bus.test.ts) with HUB_IT_CLUSTER=1, twice:
// - "ValkeyBus": one instance does everything;
// - "ValkeyBus (two pods)": publish and request go through one instance (its own clients), subscribe and serve
//   through another, so every message crosses Valkey between two sets of connections.
// The contract checks what subscribers got right after publish resolves (the memory bus delivers before it
// resolves); a networked publish resolves on send, so the adapter awaits the receiving instance's sync() after
// publishing. Nothing else is adapted.
import { ValkeyBus } from "../../src/central/backend/valkey-bus"
import type { Bus } from "../../src/central/backend/types"
import type { ImplRegistry } from "../backend-impls"
import type { ItCluster } from "../cluster-it"

type ContractBus = Bus & { readonly close: () => void }

/** A Bus whose publish/request go through `sender` and subscribe/serve through `receiver`. */
function pair(sender: ValkeyBus, receiver: ValkeyBus): ContractBus {
  return {
    publish: async (topic, message) => {
      const count = await sender.publish(topic, message)
      await receiver.sync()
      return count
    },
    subscribe: (topic, handler) => receiver.subscribe(topic, handler),
    serve: (topic, responder) => receiver.serve(topic, responder),
    request: (topic, message, options) => sender.request(topic, message, options),
    close: () => {
      sender.close()
      receiver.close()
    },
  }
}

export default function register(registry: ImplRegistry, cluster: ItCluster): void {
  registry.add("bus", {
    name: "ValkeyBus",
    backend: "valkey",
    supports: ["timers", "options"],
    make: async (options) => {
      const bus = new ValkeyBus(await cluster.freshValkey(), options)
      return pair(bus, bus)
    },
    dispose: (bus) => (bus as ContractBus).close(),
  })
  registry.add("bus", {
    name: "ValkeyBus (two pods)",
    backend: "valkey",
    supports: ["timers", "options"],
    make: async (options) => {
      const url = await cluster.freshValkey()
      return pair(new ValkeyBus(url, { ...options, instanceID: "pod-a" }), new ValkeyBus(url, { ...options, instanceID: "pod-b" }))
    },
    dispose: (bus) => (bus as ContractBus).close(),
  })
}
