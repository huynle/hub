// Upgrade and downgrade planning, under the contract's downgrade policy.
//
// Profiles. planProfileChange compares two profiles as sets of capabilities (harnesses, runtimes, services,
// launching, escalation). Adding is an upgrade. Removing anything is a downgrade and needs explicit consent
// (downgrade_rejected otherwise, like --allow-downgrade for artifacts). The v1 action union has no uninstall or
// deactivate action, so removed capabilities are reported as retained: left in place until a rollback (history.ts)
// or the user removes them.
//
// Catalog revisions. rebaseProfile moves a profile from the defaults it was made from (base) to a newer catalog's
// (next), field by field: a field still equal to the old default follows the new one; a field the user changed is
// kept and reported. New defaults never raise escalation or opt in to a runtime (OpenShell is opt-in): such changes
// are refused and reported. A rebase that would produce an invalid profile fails instead of guessing.
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
  fail,
  HARNESS_ORDER,
  ok,
  validateProfile,
  type HarnessID,
  type InstallHarness,
  type InstallKind,
  type Profile,
  type Result,
  type VerifiedManifest,
} from "../contracts/index.ts"
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
  /** Removed capabilities hub leaves in place (no typed uninstall in v1): undo them with a rollback. */
  readonly retained: readonly Capability[]
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

export function planProfileChange(fromDoc: unknown, toDoc: unknown, options: { readonly allowDowngrade?: boolean } = {}): Result<ProfileChange> {
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
  return ok({ from: from.value.id, to: to.value.id, direction, adds, removes, retained: removes })
}

const REBASED_FIELDS = ["harnesses", "runtimes", "services", "launch", "escalation"] as const
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

const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b)

export function rebaseProfile(input: { readonly current: unknown; readonly base: unknown; readonly next: unknown }): Result<RebasedProfile> {
  const c = new Checker()
  const current = validateProfile(input.current)
  const base = validateProfile(input.base)
  const next = validateProfile(input.next)
  c.merge("/current", current)
  c.merge("/base", base)
  c.merge("/next", next)
  if (!current.ok || !base.ok || !next.ok) return c.result(undefined)
  const [cur, old, neu] = [current.value, base.value, next.value]
  if (cur.id !== old.id || cur.id !== neu.id) return fail("/next/id", "invalid_value", "a rebase keeps the profile; change profiles with planProfileChange")

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
