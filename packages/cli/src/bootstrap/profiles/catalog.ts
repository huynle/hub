// The built-in profiles hubctl offers, as contract Profile documents. The catalog has a revision: a later hubctl may
// ship different defaults under a new revision (profile upgrades then keep every field the user chose; see
// upgrade.ts). Defaults are always the safe ones: no escalation, OpenShell only when asked for, launches bounded.
// v1.1: every catalog profile records the revision it comes from (Profile.revision), so a rebase knows its base.
import { fail, HARNESS_ORDER, HARNESS_SERVICE, PROFILE_IDS, validateProfile, type HarnessID, type Profile, type ProfileID, type Result, type ServiceID } from "../contracts/index.ts"

export interface ProfileCatalog {
  readonly revision: number
  readonly profiles: Readonly<Record<ProfileID, Profile>>
}

/** The bound on a launch when the user chose none. */
export const DEFAULT_LAUNCH_S = 3600

const base = { schema: "hub.bootstrap-profile", version: 2, revision: 1, runtimes: [], escalation: "never" } as const

export const PROFILE_CATALOG: ProfileCatalog = Object.freeze({
  revision: 1,
  profiles: Object.freeze({
    "session-only": { ...base, id: "session-only", harnesses: ["opencode"], services: [], launch: { enabled: false } },
    "launch-node": { ...base, id: "launch-node", harnesses: ["opencode"], services: ["node"], launch: { enabled: true, maxDurationS: DEFAULT_LAUNCH_S } },
    "full-harness": {
      ...base,
      id: "full-harness",
      harnesses: [...HARNESS_ORDER],
      services: ["node", "claude-code", "codex-spoke"],
      launch: { enabled: true, maxDurationS: DEFAULT_LAUNCH_S },
    },
  } satisfies Record<ProfileID, Profile>),
})

export interface ProfileChoices {
  /** The harnesses to set up (any order; they are put in HARNESS_ORDER). Default: the profile's. */
  readonly harnesses?: readonly HarnessID[]
  /** Opt in to OpenShell discovery and verification (never installed or configured). */
  readonly openshell?: boolean
}

/** Every spoke service the chosen harnesses run (full-harness only), after the node service. */
const spokeServices = (harnesses: readonly HarnessID[]): ServiceID[] => harnesses.flatMap((h) => HARNESS_SERVICE[h] ?? [])

/** A built-in profile with the user's choices applied, validated against the contract. */
export function defaultProfile(id: ProfileID, choices: ProfileChoices = {}, catalog: ProfileCatalog = PROFILE_CATALOG): Result<Profile> {
  if (!(PROFILE_IDS as readonly string[]).includes(id) || !catalog.profiles[id]) return fail("/id", "invalid_value", `expected one of ${PROFILE_IDS.join(", ")}`)
  const preset = catalog.profiles[id]
  const harnesses = choices.harnesses ? [...choices.harnesses].sort((a, b) => HARNESS_ORDER.indexOf(a) - HARNESS_ORDER.indexOf(b)) : preset.harnesses
  const services = choices.harnesses && id === "full-harness" ? (["node", ...spokeServices(harnesses)] as ServiceID[]) : preset.services
  return validateProfile({ ...preset, harnesses, services, runtimes: choices.openshell ? ["openshell"] : preset.runtimes })
}
