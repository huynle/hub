// The Valkey EventLog (Streams) for the contract suites. Its ids are `<epoch>.<stream id>`, not the memory log's
// `<epoch>.<n>`, and it takes no `epoch` option, so the contract tests that rely on those skip ("options");
// test/central-backend-valkey-events.test.ts covers its replay and resync instead.
import { ValkeyEventLog } from "../../src/central/backend/valkey-events"
import type { RegisterClusterImpls } from "../backend-impls"

const register: RegisterClusterImpls = (registry, cluster) => {
  registry.add("events", {
    name: "ValkeyEventLog",
    backend: "valkey",
    supports: ["clock", "timeTravel"],
    make: async (options = {}) => {
      const { now, max, maxAgeMs } = options
      return new ValkeyEventLog(await cluster.freshValkey(), {
        ...(now ? { now } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
      })
    },
    dispose: (log) => (log as ValkeyEventLog).close(),
  })
}

export default register
