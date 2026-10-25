// Registers the Postgres StateStore with the backend contract suites (test/backend-impls.ts, HUB_IT_CLUSTER=1).
// Each instance gets a fresh database and migrates it on first use. State has no expiry, so the injected clock
// stamps claims and time travel is trivially supported; there are no timers or memory-specific options. The
// container starts at registration (the suite's import), so test timeouts never include a cold start.
import { PostgresStateStore } from "../../src/central/backend/postgres-state"
import type { RegisterClusterImpls } from "../backend-impls"

const register: RegisterClusterImpls = async (registry, cluster) => {
  // Started here, while the suite loads, not inside the first test: a cold start can exceed a test's timeout.
  await cluster.postgres()
  registry.add("state", {
    name: "PostgresStateStore",
    backend: "postgres",
    supports: ["clock", "timeTravel"],
    make: async (options = {}) => new PostgresStateStore({ url: await cluster.freshDatabase(), migrate: true, ...options }),
    dispose: (store) => (store as PostgresStateStore).close(),
  })
}

export default register
