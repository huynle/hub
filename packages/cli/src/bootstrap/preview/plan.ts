// planSetup: a pure function of (snapshot, profile, link facts, planners), with no clock and no randomness, so
// the same host and choices always give the same plan and planDigest. Harness adapters and other contributors
// propose typed actions; planSetup adds the steps every plan needs (the state directory, real verification of
// every chosen harness, opt-in runtime checks), drops exact duplicates, refuses conflicting ones, never implies
// escalation, puts the actions in dependency order, and replaces any config write behind a symlink with a
// ManualEdit blocker (decision Q8). Writes that cannot become a manual edit are refused.
import {
  actionPaths,
  canonicalJSON,
  checkTarget,
  digestOf,
  fail,
  HARNESS_ORDER,
  manualEditFor,
  ok,
  REQUIRED_PROBES,
  validateAction,
  validateDiscoverySnapshot,
  validateProfile,
  validateSetupPlan,
  type Action,
  type ActionKind,
  type AdapterRegistry,
  type DiscoverySnapshot,
  type HarnessID,
  type Issue,
  type ManualEdit,
  type PathRef,
  type PlanInput,
  type PreviewEvidence,
  type Profile,
  type Result,
  type SetupPlan,
} from "../contracts/index.ts"

/** Proposes actions for a plan; must be deterministic in its input (like HarnessAdapter.plan). */
export type PlanContributor = (input: PlanInput) => readonly Action[]

/** A symlink found between a root and a path the plan would write. */
export interface LinkFact {
  readonly linkPath: string
  /** Where the target really is (the file the edit belongs in). */
  readonly resolvedPath: string
}

/** The first symlink under the root on the way to `ref`, if any. */
export type LinkInspector = (ref: PathRef) => LinkFact | undefined

export interface PlanSources {
  /** Harness adapters; each chosen harness's adapter plans for it, in HARNESS_ORDER. */
  readonly adapters?: AdapterRegistry
  /** Further planners (services, enrollment, launches), after the adapters. */
  readonly contributors?: readonly PlanContributor[]
}

export interface PlannedSetup {
  readonly plan: SetupPlan
  readonly blockers: readonly ManualEdit[]
  readonly evidence: readonly PreviewEvidence[]
}

/**
 * The digest a plan and its preview token pin for the snapshot: the canonical snapshot without its capture time,
 * so rediscovering an unchanged host gives the same digest.
 */
export const snapshotDigest = (snapshot: DiscoverySnapshot): string => digestOf({ ...snapshot, capturedAt: undefined })

/** Execution phases: each action kind runs after everything it depends on. */
const PHASE: Readonly<Record<ActionKind, number>> = {
  "ensure-directory": 0,
  "install-artifact": 1,
  "link-executable": 2,
  "install-harness": 3,
  // v1.1: a freshly installed version is made current right after it is installed (and before it is verified).
  "select-harness-version": 3.5,
  "write-file": 4,
  "merge-config": 4,
  "register-mcp-server": 4,
  // v1.1: a removed component's service is unloaded, then its unit removed, before new services are installed.
  "deactivate-service": 4.8,
  "remove-service": 4.9,
  "install-service": 5,
  "enroll-machine": 6,
  "verify-harness": 7,
  "verify-runtime": 8,
  "activate-service": 9,
  "launch-session": 10,
}

const HARNESS_LABEL: Readonly<Record<HarnessID, string>> = { opencode: "OpenCode", "claude-code": "Claude Code", codex: "Codex" }

const STATE_DIR: Action = { id: "state-dir", kind: "ensure-directory", escalation: "user", summary: "Create the hub state directory", path: { root: "state", rel: "hub" }, mode: 0o700 }

const verifyHarness = (harness: HarnessID): Action => ({
  id: `verify-${harness}`,
  kind: "verify-harness",
  escalation: "user",
  summary: `Verify ${HARNESS_LABEL[harness]} really runs, reaches its provider and connects to the hub`,
  harness,
  probes: REQUIRED_PROBES[harness].filter((p): p is Exclude<typeof p, "presence"> => p !== "presence"),
})

export const issuesAt = (prefix: string, r: Result<unknown>): Issue[] => (r.ok ? [] : r.issues.map((i) => ({ ...i, path: `${prefix}${i.path}` })))
const failed = <T>(issues: readonly Issue[]): Result<T> => ({ ok: false, issues: [...issues] })

/** Plans a setup. Pure: the same inputs always give the same plan. */
export function planSetup(input: { readonly snapshot: DiscoverySnapshot; readonly profile: Profile; readonly links: LinkInspector } & PlanSources): Result<PlannedSetup> {
  const snap = validateDiscoverySnapshot(input.snapshot)
  const prof = validateProfile(input.profile)
  if (!snap.ok || !prof.ok) return failed([...issuesAt("/snapshot", snap), ...issuesAt("/profile", prof)])
  const snapshot = snap.value
  const profile = prof.value
  const target = checkTarget(snapshot.host.target)
  if (!target.ok || !snapshot.host.supported) return failed(issuesAt("/snapshot/host/target", target.ok ? fail("", "unsupported_platform", "unsupported host") : target))
  if (profile.services.length > 0 && snapshot.managers.service === "none")
    return fail("/profile/services", "inconsistent", `the ${profile.id} profile installs services, but this host has no user service manager (launchd or systemd --user)`)

  // Collect: the state dir, then each chosen harness's adapter actions, then the other contributors.
  const planInput: PlanInput = { snapshot, profile }
  const groups: Action[][] = [[STATE_DIR]]
  const harnessGroup = new Map<HarnessID, Action[]>()
  for (const id of HARNESS_ORDER) {
    if (!profile.harnesses.includes(id)) continue
    const group = [...(input.adapters?.get(id)?.plan(planInput) ?? [])]
    harnessGroup.set(id, group)
    groups.push(group)
  }
  for (const contribute of input.contributors ?? []) groups.push([...contribute(planInput)])
  // Every chosen harness is verified by real probes (presence is never readiness); runtimes are checked, never installed.
  const all = () => groups.flat()
  for (const [id, group] of harnessGroup) if (!all().some((a) => a.kind === "verify-harness" && a.harness === id)) group.push(verifyHarness(id))
  groups.push(profile.runtimes.map((runtime) => ({ id: `verify-${runtime}`, kind: "verify-runtime", escalation: "user", summary: `Check ${runtime} (opt-in)`, runtime }) as Action))

  // Validate every proposed action; drop exact duplicates, refuse conflicting ones.
  const issues: Issue[] = []
  const byID = new Map<string, Action>()
  const actions: Action[] = []
  all().forEach((action, i) => {
    const checked = validateAction(action)
    if (!checked.ok) return void issues.push(...issuesAt(`/actions/${i}`, checked))
    const seen = byID.get(action.id)
    if (seen) {
      if (canonicalJSON(seen) !== canonicalJSON(action)) issues.push({ path: `/actions/${i}/id`, code: "duplicate", message: `two different actions are both named ${action.id}` })
      return
    }
    byID.set(action.id, action)
    actions.push(action)
  })
  if (issues.length > 0) return failed(issues)

  // Escalation is never implied; services must have their manager's root; writes never go through a symlink.
  const blockers: ManualEdit[] = []
  const kept: Action[] = []
  for (const action of actions) {
    if (action.escalation === "elevated" && profile.escalation !== "explicit") {
      issues.push({ path: `/actions/${action.id}`, code: "inconsistent", message: `${action.id} needs escalation, which the ${profile.id} profile never allows` })
      continue
    }
    const unmapped = actionPaths(action).find((ref) => !snapshot.roots.some((r) => r.id === ref.root))
    if (unmapped) {
      issues.push({ path: `/actions/${action.id}`, code: "unmapped_root", message: `this host has no ${unmapped.root} root` })
      continue
    }
    const link = "path" in action ? input.links(action.path) : undefined
    if (!link) {
      kept.push(action)
      continue
    }
    const edit = manualEditFor(action, link)
    if (edit) blockers.push(edit)
    else issues.push({ path: `/actions/${action.id}`, code: "symlink", message: `${link.linkPath} is a symbolic link; refusing to write through it` })
  }
  if (issues.length > 0) return failed(issues)

  const ordered = kept.map((a, i) => ({ a, i })).sort((x, y) => PHASE[x.a.kind] - PHASE[y.a.kind] || x.i - y.i).map((x) => x.a)
  const plan: SetupPlan = {
    schema: "hub.setup-plan",
    version: 1,
    hostFingerprint: snapshot.host.fingerprint,
    snapshotDigest: snapshotDigest(snapshot),
    target: snapshot.host.target,
    profile: { id: profile.id, version: profile.version },
    requiresEscalation: ordered.some((a) => a.escalation === "elevated"),
    activatesServices: ordered.some((a) => a.kind === "activate-service"),
    actions: ordered,
  }
  const valid = validateSetupPlan(plan)
  if (!valid.ok) return failed(issuesAt("/plan", valid))
  // Upstream evidence for a pinned harness download is checked on the downloaded bytes, at apply.
  const evidence: PreviewEvidence[] = ordered.flatMap((a) => (a.kind === "install-harness" ? a.evidence.map((kind) => ({ actionID: a.id, kind, status: "deferred" as const })) : []))
  return ok({ plan, blockers, evidence })
}
