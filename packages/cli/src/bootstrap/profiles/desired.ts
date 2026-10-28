// Profile → desired state: what this host should end up with, as a pure function of (profile, discovery snapshot).
// It is a description, never a write: the planner turns it into actions, the audit mode only verifies it. Hosts it
// cannot serve fail explicitly (an unsupported target, services without a user service manager, OpenShell that is
// absent or was not discovered) instead of being half-configured. OpenShell is verify-only: hubctl never installs
// or configures it. A harness the user installed some other way stays theirs (owner "user"): hub verifies it and
// never replaces it.
import {
  Checker,
  fail,
  REQUIRED_PROBES,
  validateDiscoverySnapshot,
  validateProfile,
  type DiscoverySnapshot,
  type HarnessID,
  type Profile,
  type ProbeKind,
  type ProfileID,
  type Result,
  type RuntimeID,
  type ServiceID,
  type ServiceManagerID,
} from "../contracts/index.ts"

export interface DesiredHarness {
  readonly id: HarnessID
  readonly presence: "installed" | "missing"
  /** hub: installed (or to be installed) by hubctl from a pinned artifact. user: installed another way; never replaced. */
  readonly owner: "hub" | "user"
  /** The version discovery found, when installed. */
  readonly version?: string
  /** The real probes readiness needs. */
  readonly verify: readonly Exclude<ProbeKind, "presence">[]
}

export interface DesiredService {
  readonly id: ServiceID
  readonly manager: ServiceManagerID
  /** Services are only ever activated on explicit confirmation. */
  readonly activation: "explicit"
}

export interface DesiredRuntime {
  readonly id: RuntimeID
  readonly mode: "verify-only"
}

export interface DesiredState {
  readonly profile: { readonly id: ProfileID; readonly version: Profile["version"] }
  readonly target: string
  readonly harnesses: readonly DesiredHarness[]
  readonly services: readonly DesiredService[]
  readonly runtimes: readonly DesiredRuntime[]
  readonly launch: Profile["launch"]
  readonly escalation: Profile["escalation"]
}

export function desiredState(profileDoc: unknown, snapshotDoc: unknown): Result<DesiredState> {
  const c = new Checker()
  const checkedProfile = validateProfile(profileDoc)
  const checkedSnapshot = validateDiscoverySnapshot(snapshotDoc)
  c.merge("/profile", checkedProfile)
  c.merge("/snapshot", checkedSnapshot)
  if (!checkedProfile.ok || !checkedSnapshot.ok) return c.result(undefined)
  const profile = checkedProfile.value
  const snapshot: DiscoverySnapshot = checkedSnapshot.value

  if (!snapshot.host.supported) return fail("/snapshot/host/target", "unsupported_platform", `cannot set up ${snapshot.host.target}`)
  const manager = snapshot.managers.service
  if (profile.services.length > 0 && manager === "none")
    c.add("/profile/services", "unsupported_platform", `${profile.id} runs services, but this host has no user service manager (launchd or systemd --user)`)
  const runtimes = profile.runtimes.map((id, i): DesiredRuntime => {
    const found = snapshot.runtimes.find((r) => r.id === id)
    if (!found) c.add(`/profile/runtimes/${i}`, "unsupported_platform", `discovery did not check ${id}; it is verified only after discovery finds it`)
    else if (!found.present) c.add(`/profile/runtimes/${i}`, "unsupported_platform", `${id} is not present on this host; hubctl verifies it but never installs it`)
    return { id, mode: "verify-only" }
  })

  const harnesses = profile.harnesses.map((id): DesiredHarness => {
    const found = snapshot.harnesses.find((h) => h.id === id)
    const verify = REQUIRED_PROBES[id].filter((k): k is Exclude<ProbeKind, "presence"> => k !== "presence")
    if (!found?.installed) return { id, presence: "missing", owner: "hub", verify }
    return { id, presence: "installed", owner: found.installMethod === "hub" ? "hub" : "user", ...(found.version ? { version: found.version } : {}), verify }
  })
  const services = manager === "none" ? [] : profile.services.map((id): DesiredService => ({ id, manager, activation: "explicit" }))
  const launch = profile.launch.enabled ? { enabled: true, maxDurationS: profile.launch.maxDurationS } : { enabled: false }

  return c.result<DesiredState>({
    profile: { id: profile.id, version: profile.version },
    target: snapshot.host.target,
    harnesses,
    services,
    runtimes,
    launch,
    escalation: profile.escalation,
  })
}
