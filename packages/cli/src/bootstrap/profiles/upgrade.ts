// Upgrade and downgrade planning, under the contract's downgrade policy.
//
// Profiles. planProfileChange compares two profiles as sets of capabilities (harnesses, runtimes, services,
// launching, escalation). Adding is an upgrade. Removing anything is a downgrade and needs explicit consent
// (downgrade_rejected otherwise, like --allow-downgrade for artifacts). v1.1: given the host's service manager and
// the units hub installed (installedServiceUnits), a removed service is planned as typed deactivate-service and
// remove-service actions (the unit only while it is exactly what hub installed). Everything else removed (harnesses,
// runtimes, launching, escalation) has no typed uninstall and is reported as retained: left in place until a
// rollback (history.ts) or the user removes it.
//
// Catalog revisions. rebaseProfile moves a profile from the defaults it was made from (base) to a newer catalog's
// (next), field by field: a field still equal to the old default follows the new one; a field the user changed is
// kept and reported. New defaults never raise escalation or opt in to a runtime (OpenShell is opt-in): such changes
// are refused and reported. A rebase that would produce an invalid profile fails instead of guessing. v1.1: the base
// is found by the profile's own `revision` in the catalogs given (or checked against it when passed explicitly), a
// rebase never goes to an older revision, and the result records the new revision.
//
// Harness versions. planHarnessVersions decides, per desired harness, against the pins of a verified manifest and
// the versions hub installed (from the history), with decideHarnessInstall: nothing below the security floor,
// older pins only with explicit consent, the same version with other bytes is tampering. A harness the user
// installed another way is never replaced. Each install, upgrade or downgrade carries its install-harness action,
// recording the version it replaces so a rollback can restore it.
import {
  checkHarnessPin,
  Checker,
  canonicalJSON,
  decideHarnessInstall,
  EMBEDDED_ASSETS,
  fail,
  HARNESS_ORDER,
  ok,
  validateProfile,
  type HarnessID,
  type Action,
  type InstallHarness,
  type InstallKind,
  type Profile,
  type Result,
  type ServiceID,
  type ServiceManagerID,
  type VerifiedManifest,
} from "../contracts/index.ts"
import { PROFILE_CATALOG, type ProfileCatalog } from "./catalog.ts"
import type { DesiredState } from "./desired.ts"
import type { InstalledHarness } from "./history.ts"

/** "harness:<id>", "runtime:<id>", "service:<id>", "launch", "escalation:explicit". */
export type Capability = string

export interface ProfileChange {
  readonly from: Profile["id"]
  readonly to: Profile["id"]
  readonly direction: "same" | "upgrade" | "downgrade"
  readonly adds: readonly Capability[]
  readonly removes: readonly Capability[]
  /** Removed capabilities hub leaves in place (no typed uninstall): undo them with a rollback. */
  readonly retained: readonly Capability[]
  /** v1.1: the typed steps that remove what can be removed (services), in execution order. */
  readonly actions: readonly Action[]
}

/** v1.1: what planProfileChange needs to plan removing services. */
export interface ServiceFacts {
  /** The host's user service manager. */
  readonly manager: ServiceManagerID
  /** The digest of each unit hub installed and still owns (installedServiceUnits). */
  readonly installed: Partial<Record<ServiceID, string>>
}

const UNIT_ROOT: Readonly<Record<ServiceManagerID, "launch-agents" | "systemd-user">> = { launchd: "launch-agents", "systemd-user": "systemd-user" }

/** Deactivates, then removes (when hub knows the unit it installed), one service of a removed component. */
function removeServiceActions(service: ServiceID, facts: ServiceFacts): Action[] {
  const actions: Action[] = [
    { id: `deactivate-${service}`, kind: "deactivate-service", escalation: "user", summary: `Unload the hub ${service} service (profile downgrade)`, service, manager: facts.manager },
  ]
  const asset = EMBEDDED_ASSETS[`service/${facts.manager}/${service}`]
  const sha256 = facts.installed[service]
  if (asset && sha256)
    actions.push({
      id: `remove-${service}`,
      kind: "remove-service",
      escalation: "user",
      summary: `Remove the hub ${service} ${facts.manager} unit (profile downgrade)`,
      service,
      manager: facts.manager,
      path: { root: UNIT_ROOT[facts.manager], rel: asset.installAs },
      sha256,
    })
  return actions
}

function capabilities(p: Profile): Capability[] {
  return [
    ...HARNESS_ORDER.filter((h) => p.harnesses.includes(h)).map((h) => `harness:${h}`),
    ...p.runtimes.map((r) => `runtime:${r}`),
    ...p.services.map((s) => `service:${s}`),
    ...(p.launch.enabled ? ["launch"] : []),
    ...(p.escalation === "explicit" ? ["escalation:explicit"] : []),
  ]
}

export function planProfileChange(fromDoc: unknown, toDoc: unknown, options: { readonly allowDowngrade?: boolean; readonly services?: ServiceFacts } = {}): Result<ProfileChange> {
  const c = new Checker()
  const from = validateProfile(fromDoc)
  const to = validateProfile(toDoc)
  c.merge("/from", from)
  c.merge("/to", to)
  if (!from.ok || !to.ok) return c.result(undefined)
  const before = capabilities(from.value)
  const after = capabilities(to.value)
  const adds = after.filter((x) => !before.includes(x))
  const removes = before.filter((x) => !after.includes(x))
  const direction = removes.length > 0 ? "downgrade" : adds.length > 0 ? "upgrade" : "same"
  if (direction === "downgrade" && !options.allowDowngrade)
    return fail("/to", "downgrade_rejected", `${to.value.id} removes ${removes.join(", ")}; pass --allow-downgrade to change to it`)
  const actions: Action[] = []
  const removed = new Set<Capability>()
  if (options.services)
    for (const capability of removes) {
      if (!capability.startsWith("service:")) continue
      const service = capability.slice("service:".length) as ServiceID
      const planned = removeServiceActions(service, options.services)
      actions.push(...planned)
      // A service is gone only once its unit is removed too; a deactivated unit hub never recorded stays.
      if (planned.some((a) => a.kind === "remove-service")) removed.add(capability)
    }
  // Deactivate everything first, then remove the units (the plan rule: a service is deactivated before it is removed).
  actions.sort((a, b) => Number(a.kind === "remove-service") - Number(b.kind === "remove-service"))
  return ok({ from: from.value.id, to: to.value.id, direction, adds, removes, retained: removes.filter((x) => !removed.has(x)), actions })
}

const REBASED_FIELDS = ["harnesses", "runtimes", "services", "launch", "escalation", "enrollment"] as const
export type RebasedField = (typeof REBASED_FIELDS)[number]

export interface RebasedProfile {
  readonly profile: Profile
  /** Fields the user had changed from the old defaults: kept. */
  readonly kept: readonly RebasedField[]
  /** Fields that followed the new defaults. */
  readonly updated: readonly RebasedField[]
  /** New defaults refused because they would raise privilege or opt in to a runtime. */
  readonly refused: readonly RebasedField[]
}

// An absent optional field (enrollment) compares as null.
const same = (a: unknown, b: unknown) => canonicalJSON(a ?? null) === canonicalJSON(b ?? null)

export interface RebaseInput {
  readonly current: unknown
  /** The defaults `current` was made from. Optional when `current.revision` names one of `catalogs`. */
  readonly base?: unknown
  readonly next: unknown
  /** v1.1: catalogs (any revisions) to find the base in by `current.revision`; default: this hubctl's catalog. */
  readonly catalogs?: readonly ProfileCatalog[]
}

export function rebaseProfile(input: RebaseInput): Result<RebasedProfile> {
  const c = new Checker()
  const current = validateProfile(input.current)
  const next = validateProfile(input.next)
  c.merge("/current", current)
  c.merge("/next", next)
  if (!current.ok || !next.ok) return c.result(undefined)
  let baseDoc = input.base
  const revision = current.value.revision
  if (baseDoc === undefined) {
    if (revision === undefined) return fail("/current/revision", "missing_field", "the profile records no catalog revision; pass the defaults it was made from as base")
    const catalog = (input.catalogs ?? [PROFILE_CATALOG]).find((k) => k.revision === revision)
    if (!catalog) return fail("/current/revision", "invalid_value", `this hubctl does not know catalog revision ${revision}`)
    baseDoc = catalog.profiles[current.value.id]
  }
  const base = validateProfile(baseDoc)
  c.merge("/base", base)
  if (!base.ok) return c.result(undefined)
  const [cur, old, neu] = [current.value, base.value, next.value]
  if (cur.id !== old.id || cur.id !== neu.id) return fail("/next/id", "invalid_value", "a rebase keeps the profile; change profiles with planProfileChange")
  if (revision !== undefined && old.revision !== undefined && old.revision !== revision)
    return fail("/base/revision", "inconsistent", `the profile was made from catalog revision ${revision}, not ${old.revision}`)
  if (revision !== undefined && neu.revision !== undefined && neu.revision < revision)
    return fail("/next/revision", "downgrade_rejected", `catalog revision ${neu.revision} is older than the profile's ${revision}`)

  const result: Record<string, unknown> = { ...cur }
  const kept: RebasedField[] = []
  const updated: RebasedField[] = []
  const refused: RebasedField[] = []
  for (const field of REBASED_FIELDS) {
    if (!same(cur[field], old[field])) {
      kept.push(field)
      continue
    }
    if (same(cur[field], neu[field])) continue
    const raises = (field === "escalation" && neu.escalation === "explicit") || (field === "runtimes" && neu.runtimes.some((r) => !cur.runtimes.includes(r)))
    if (raises) refused.push(field)
    else {
      result[field] = neu[field]
      updated.push(field)
    }
  }
  if (neu.revision !== undefined) result.revision = neu.revision
  const profile = validateProfile(result)
  if (!profile.ok) return profile
  return ok({ profile: profile.value, kept, updated, refused })
}

export type HarnessVersionDecision = "install" | "upgrade" | "downgrade" | "keep" | "keep-user-managed"

export interface HarnessVersionStep {
  readonly harness: HarnessID
  readonly decision: HarnessVersionDecision
  /** The version there now (when known). */
  readonly from?: string
  /** The pinned version. */
  readonly to?: string
  /** For install, upgrade and downgrade. */
  readonly action?: InstallHarness
}

export interface HarnessVersionInput {
  readonly desired: DesiredState
  readonly manifest: VerifiedManifest
  /** What hub installed, from the history (installedHarnesses). */
  readonly installed: Partial<Record<HarnessID, InstalledHarness>>
  /** The highest harness floors this machine has seen. */
  readonly floors?: Partial<Record<HarnessID, string>>
  readonly allowDowngrade?: boolean
}

/** Where hub installs a pinned harness version (a versioned directory under the data root). */
export const harnessInstallPath = (harness: HarnessID, version: string) => ({ root: "data", rel: `hub/harnesses/${harness}/${version}` }) as const

const VERB: Readonly<Record<Exclude<InstallKind, "reinstall">, string>> = { install: "Install", upgrade: "Upgrade", downgrade: "Downgrade" }

export function planHarnessVersions(input: HarnessVersionInput): Result<HarnessVersionStep[]> {
  const c = new Checker()
  const { desired, manifest } = input
  const steps: HarnessVersionStep[] = []
  desired.harnesses.forEach((h, i) => {
    const at = `/harnesses/${i}`
    if (h.owner === "user") return void steps.push({ harness: h.id, decision: "keep-user-managed", ...(h.version ? { from: h.version } : {}) })
    const inst = h.presence === "installed" ? input.installed[h.id] : undefined
    if (h.presence === "installed") {
      if (!inst) return c.add(at, "inconsistent", `${h.id} was installed by hub, but no committed transaction records it; recover or reinstall`)
      if (h.version !== undefined && h.version !== inst.version) return c.add(at, "inconsistent", `${h.id} is ${h.version}, not the ${inst.version} hub installed; verify it or roll back`)
    }
    const pin = manifest.harnesses.find((p) => p.harness === h.id && p.target === desired.target)
    if (!pin) {
      if (inst) return void steps.push({ harness: h.id, decision: "keep", from: inst.version })
      return c.add(at, "unpinned_artifact", `hub ${manifest.release} pins no ${h.id} for ${desired.target}`)
    }
    const decided = decideHarnessInstall(pin, { ...(inst ? { installed: { version: inst.version, sha256: inst.sha256 } } : {}), ...(input.floors?.[h.id] ? { floor: input.floors[h.id] } : {}), allowDowngrade: input.allowDowngrade })
    if (!decided.ok) return c.merge(at, decided)
    if (decided.value === "reinstall") return void steps.push({ harness: h.id, decision: "keep", from: pin.version, to: pin.version })
    const action: InstallHarness = {
      id: `install-${h.id}`,
      kind: "install-harness",
      escalation: "user",
      summary: `${VERB[decided.value]} ${h.id} ${pin.version} for ${pin.target} (pinned by hub ${manifest.release})`,
      harness: h.id,
      version: pin.version,
      target: pin.target,
      source: { manifest: manifest.release, url: pin.url, file: pin.file },
      size: pin.size,
      sha256: pin.sha256,
      evidence: [...pin.evidence],
      path: harnessInstallPath(h.id, pin.version),
      owner: "hub",
      rollback: "restore-previous",
      ...(inst ? { previous: { version: inst.version, sha256: inst.sha256 } } : {}),
    }
    const pinned = checkHarnessPin(manifest, action)
    if (!pinned.ok) return c.merge(at, pinned)
    steps.push({ harness: h.id, decision: decided.value, ...(inst ? { from: inst.version } : {}), to: pin.version, action })
  })
  return c.result(steps)
}
