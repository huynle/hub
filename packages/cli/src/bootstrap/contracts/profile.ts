// Setup profiles: how much of Hub a machine gets.
//   session-only   the harness integration only (follow and steer sessions); no services, no launches.
//   launch-node    plus the `hub node` service, so the hub can launch bounded sessions on this machine.
//   full-harness   plus every chosen harness's spoke service (and opt-in OpenShell checks).
// Profiles are versioned documents; an older document is upgraded by the migration hook, one version at a time,
// before it is validated. Escalation is never automatic and services are never activated without confirmation.
//
// v1.1 (profile version 2): `revision` records the catalog revision a profile was made from (profile rebases use
// it), and `enrollment` says whether the plan enrolls the machine ("inline", the default) or leaves it to a separate
// `hubctl machine enroll` ("separate", which the Ansible path always uses), so both paths plan the same digest.
import { SERVICE_IDS, type ServiceID } from "./exec.ts"
import { HARNESS_ORDER, RUNTIME_IDS, type HarnessID, type RuntimeID } from "./harness.ts"
import { bool, Checker, fail, header, int, isRecord, oneOf, shape, subset, type Result } from "./validate.ts"

export const PROFILE_SCHEMA = "hub.bootstrap-profile"
export const PROFILE_VERSION = 2
/** Profile versions a plan may record: plans made by a v1.0 hubctl (profile version 1) still validate and resume. */
export const PLAN_PROFILE_VERSIONS = [1, 2] as const
export type PlanProfileVersion = (typeof PLAN_PROFILE_VERSIONS)[number]
/** v1.1: inline: the plan enrolls the machine (enroll-machine). separate: enrollment is its own step; the plan never enrolls. */
export const ENROLLMENT_MODES = ["inline", "separate"] as const
export type EnrollmentMode = (typeof ENROLLMENT_MODES)[number]
export const PROFILE_IDS = ["session-only", "launch-node", "full-harness"] as const
export type ProfileID = (typeof PROFILE_IDS)[number]

export interface Profile {
  readonly schema: typeof PROFILE_SCHEMA
  readonly version: typeof PROFILE_VERSION
  readonly id: ProfileID
  /** In HARNESS_ORDER. */
  readonly harnesses: readonly HarnessID[]
  readonly runtimes: readonly RuntimeID[]
  readonly services: readonly ServiceID[]
  readonly launch: { readonly enabled: boolean; readonly maxDurationS?: number }
  /** "explicit": the user may approve elevated actions at apply time; "never": the plan stays unprivileged. */
  readonly escalation: "never" | "explicit"
  /** v1.1: the built-in catalog revision this profile was made from (absent: unknown, e.g. written by hand). */
  readonly revision?: number
  /** v1.1: whether the plan enrolls the machine (default "inline"). */
  readonly enrollment?: EnrollmentMode
}

/** The enrollment mode a profile plans with. */
export const enrollmentModeOf = (profile: Pick<Profile, "enrollment">): EnrollmentMode => profile.enrollment ?? "inline"

/** The service each harness's spoke runs as, when it has one (OpenCode's spoke lives in its plugin). */
export const HARNESS_SERVICE: Readonly<Partial<Record<HarnessID, ServiceID>>> = Object.freeze({ "claude-code": "claude-code", codex: "codex-spoke" })

export function validateProfile(value: unknown): Result<Profile> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "id", "harnesses", "runtimes", "services", "launch", "escalation"], ["revision", "enrollment"])
  if (!r) return c.result(value)
  header(c, "", r, PROFILE_SCHEMA, PROFILE_VERSION)
  if (r.revision !== undefined) int(c, "/revision", r.revision, 1, 1_000_000)
  if (r.enrollment !== undefined) oneOf(c, "/enrollment", r.enrollment, ENROLLMENT_MODES)
  oneOf(c, "/id", r.id, PROFILE_IDS)
  oneOf(c, "/escalation", r.escalation, ["never", "explicit"] as const)
  const harnesses = subset(c, "/harnesses", r.harnesses, HARNESS_ORDER) ? r.harnesses : []
  const services = subset(c, "/services", r.services, SERVICE_IDS) ? r.services : []
  subset(c, "/runtimes", r.runtimes, RUNTIME_IDS)
  if (Array.isArray(r.harnesses) && r.harnesses.length === 0) c.add("/harnesses", "invalid_value", "a profile sets up at least one harness")
  const order = harnesses.map((h) => HARNESS_ORDER.indexOf(h))
  if (order.some((v, i) => i > 0 && v < order[i - 1]!)) c.add("/harnesses", "inconsistent", `harnesses go in the order ${HARNESS_ORDER.join(", ")}`)
  const launch = shape(c, "/launch", r.launch, ["enabled"], ["maxDurationS"])
  if (launch) {
    bool(c, "/launch/enabled", launch.enabled)
    if (launch.maxDurationS !== undefined) int(c, "/launch/maxDurationS", launch.maxDurationS, 1, 86_400)
    if (launch.enabled === true && launch.maxDurationS === undefined) c.add("/launch/maxDurationS", "inconsistent", "launches are always bounded")
    if (launch.enabled === true && !services.includes("node")) c.add("/launch", "inconsistent", "launching needs the node service")
  }
  if (r.id === "session-only" && services.length > 0) c.add("/services", "inconsistent", "session-only installs no services")
  if (r.id === "session-only" && launch?.enabled === true) c.add("/launch", "inconsistent", "session-only never launches")
  if ((r.id === "launch-node" || r.id === "full-harness") && !services.includes("node")) c.add("/services", "inconsistent", `${String(r.id)} needs the node service`)
  for (const [harness, service] of Object.entries(HARNESS_SERVICE))
    if (services.includes(service!) && !harnesses.includes(harness as HarnessID)) c.add("/services", "inconsistent", `the ${service} service needs the ${harness} harness`)
  return c.result(value)
}

/** One step: a document of version N (the key) to version N+1. */
export type ProfileMigration = (raw: Record<string, unknown>) => unknown
export type ProfileMigrations = Readonly<Record<number, ProfileMigration>>

/**
 * Registered migrations to the current version. 1 → 2 (v1.1): the new fields are optional and mean what a version-1
 * document meant (catalog revision unknown, enrollment inline), so only the version changes.
 */
export const PROFILE_MIGRATIONS: ProfileMigrations = Object.freeze({
  1: (raw: Record<string, unknown>) => ({ ...raw, version: 2 }),
})

/** Upgrades an older profile document step by step, then validates it. */
export function migrateProfile(raw: unknown, migrations: ProfileMigrations = PROFILE_MIGRATIONS): Result<Profile> {
  let doc = raw
  for (;;) {
    if (!isRecord(doc) || !Number.isInteger(doc.version)) return fail("/version", "invalid_value", "a profile needs an integer version")
    const version = doc.version as number
    if (version > PROFILE_VERSION) return fail("/version", "unsupported_version", `profile version ${version} is newer than this hubctl understands (${PROFILE_VERSION}); upgrade hubctl`)
    if (version === PROFILE_VERSION) return validateProfile(doc)
    const step = migrations[version]
    if (!step) return fail("/version", "unmigratable", `no migration from profile version ${version}`)
    const next = step(doc)
    if (!isRecord(next) || !Number.isInteger(next.version) || (next.version as number) <= version) return fail("/version", "unmigratable", `the migration from version ${version} did not advance the version`)
    doc = next
  }
}
