// Profile document versions. A persisted profile is read through the contract's migration hook (migrateProfile),
// one version at a time, and the steps taken are reported so the caller can say "migrated from v0". A document from
// a newer hubctl is refused (unsupported_version), never read as if it were current; a version no chain of
// migrations reaches is unmigratable. Negotiation picks the highest version both sides understand.
import { fail, isRecord, migrateProfile, ok, PROFILE_MIGRATIONS, PROFILE_VERSION, type Profile, type ProfileMigrations, type Result } from "../contracts/index.ts"

export interface MigrationStep {
  readonly from: number
  readonly to: number
}

export interface LoadedProfile {
  readonly profile: Profile
  /** The version the document had on disk. */
  readonly from: number
  /** The migrations applied, oldest first (empty for a current document). */
  readonly steps: readonly MigrationStep[]
}

/** Reads a profile document of any readable version; the input is never modified. */
export function loadProfile(raw: unknown, migrations: ProfileMigrations = PROFILE_MIGRATIONS): Result<LoadedProfile> {
  const steps: MigrationStep[] = []
  const recording: Record<number, (doc: Record<string, unknown>) => unknown> = {}
  for (const [key, step] of Object.entries(migrations))
    recording[Number(key)] = (doc) => {
      const next = step(structuredClone(doc))
      if (isRecord(next) && Number.isInteger(next.version)) steps.push({ from: doc.version as number, to: next.version as number })
      return next
    }
  const result = migrateProfile(raw, recording)
  if (!result.ok) return result
  return ok({ profile: result.value, from: (raw as { version: number }).version, steps })
}

/** Every profile version this hubctl can read, ascending: the current one and each older one with an unbroken chain. */
export function supportedProfileVersions(migrations: ProfileMigrations = PROFILE_MIGRATIONS): number[] {
  const versions = [PROFILE_VERSION]
  for (let v = PROFILE_VERSION - 1; typeof migrations[v] === "function"; v--) versions.unshift(v)
  return versions
}

/** The highest offered version this hubctl can read. */
export function negotiateProfileVersion(offered: readonly number[], migrations: ProfileMigrations = PROFILE_MIGRATIONS): Result<number> {
  if (offered.length === 0 || !offered.every((v) => Number.isInteger(v))) return fail("", "invalid_value", "offer at least one integer profile version")
  const supported = new Set(supportedProfileVersions(migrations))
  const common = offered.filter((v) => supported.has(v))
  if (common.length > 0) return ok(Math.max(...common))
  if (offered.some((v) => v > PROFILE_VERSION)) return fail("", "unsupported_version", `profile versions ${offered.join(", ")} are newer than this hubctl understands (${PROFILE_VERSION}); upgrade hubctl`)
  return fail("", "unmigratable", `no migration reaches profile version ${PROFILE_VERSION} from ${offered.join(", ")}`)
}
