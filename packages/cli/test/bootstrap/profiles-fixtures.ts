// Fixtures for the profile layer (packages/cli/src/bootstrap/profiles). Plain, clock-free data built on the shared
// contract fixtures (./fixtures.ts), which this file never changes. Everything a test mutates is a copy.
import type { ProfileMigrations } from "../../src/bootstrap/contracts/index.ts"
import { PROFILE_V0 } from "./fixtures.ts"

/** Deep-freezes a value so a test can prove a pure function never writes to its inputs. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

/** A deep copy (fixtures are plain JSON). */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * The pre-v1 draft shape (PROFILE_V0: one profile name and one harness) upgraded to v1. Injected by tests only:
 * v1 is the first frozen profile version, so hubctl ships no migrations yet.
 */
export const MIGRATIONS_FROM_V0: ProfileMigrations = Object.freeze({
  0: (raw: Record<string, unknown>) => ({
    schema: raw.schema,
    version: 1,
    id: raw.profile,
    harnesses: [raw.harness],
    runtimes: [],
    services: [],
    launch: { enabled: false },
    escalation: "never",
  }),
})

export const PROFILE_V0_MIGRATED = {
  schema: "hub.bootstrap-profile",
  version: 1,
  id: "session-only",
  harnesses: ["opencode"],
  runtimes: [],
  services: [],
  launch: { enabled: false },
  escalation: "never",
} as const

export { PROFILE_V0 }
