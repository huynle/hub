// The Valkey Catalog (a hash per user) for the contract suites. Report times and expiry follow the `now` option
// (expiresAt is filtered on read; Valkey 8 has no hash-field TTL), and it takes the memory catalog's `merge`.
import { ValkeyCatalog } from "../../src/central/backend/valkey-catalog"
import type { RegisterClusterImpls } from "../backend-impls"

const register: RegisterClusterImpls = (registry, cluster) => {
  registry.add("catalog", {
    name: "ValkeyCatalog",
    backend: "valkey",
    supports: ["clock", "timeTravel", "options"],
    make: async (options = {}) => new ValkeyCatalog(await cluster.freshValkey(), options),
    dispose: (catalog) => (catalog as ValkeyCatalog).close(),
  })
}

export default register
