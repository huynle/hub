// Renders a bootstrap profile, or a previewed setup plan, as the vars of the optional Ansible role
// (contrib/ansible/roles/hub_bootstrap). The role reimplements nothing: it stages the signed hubctl pinned here and
// runs the same `hubctl setup preview / apply / verify` a person would run directly, with the same canonical profile
// and the same consent flags. So the vars carry only:
//   - the profile, canonical, and its digest (the direct path's input, byte for byte);
//   - when rendered from a plan, that plan's digest, host and snapshot, so the role refuses to apply anything but
//     the plan that was previewed;
//   - the hubctl artifacts and harness pins of a *verified* manifest (VerifiedManifest: only verifyManifest makes
//     one), so the role can check the downloads before hubctl checks the signature again on the host;
//   - explicit consent flags, all off by default.
// Never a credential: inputs are validated, and the rendered vars are scanned (findSecrets) and refused, not
// redacted, if anything credential-shaped got through. Enrollment is never part of the vars or the role: a plan that
// enrolls is refused, because the device-code flow is a separate step a person approves.
import {
  canonicalJSON,
  checkHarnessPin,
  digestOf,
  findSecrets,
  migrateProfile,
  planDigest,
  selectArtifact,
  validateSetupPlan,
  type ErrorCode,
  type Issue,
  type Profile,
  type SetupPlan,
  type VerifiedManifest,
} from "../contracts/index.ts"

export const ANSIBLE_VARS_SCHEMA = "hub.ansible-vars"
export const ANSIBLE_VARS_VERSION = 1
/** The manifest file a release publishes next to its hubctl binaries (I5). */
export const MANIFEST_FILE = "hubctl-manifest.json"

/** Each consent var and the hubctl flag it becomes, in argv order. Never a default. */
export const ROLE_FLAGS = Object.freeze({
  hub_bootstrap_escalate: "--escalate",
  hub_bootstrap_confirm_activation: "--confirm-activation",
  hub_bootstrap_allow_downgrade: "--allow-downgrade",
} as const)

export interface RenderOptions {
  /** https base URL of the hub release holding hubctl-manifest.json and the hubctl-<target> files. */
  readonly releaseBaseURL: string
  readonly escalate?: boolean
  readonly confirmActivation?: boolean
  readonly allowDowngrade?: boolean
  /** Fail the play when `hubctl setup verify` finds a harness not ready (default true). */
  readonly requireReady?: boolean
}

export interface RenderInput {
  /** A bootstrap profile document (older versions are migrated). */
  readonly profile: unknown
  /** The plan `hubctl setup preview` showed for one host, to pin the role to it. */
  readonly plan?: unknown
  readonly manifest: VerifiedManifest
  readonly options: RenderOptions
}

export interface PinnedArtifact {
  readonly url: string
  readonly file: string
  readonly size: number
  readonly sha256: string
}

export interface PinnedHarness {
  readonly harness: string
  readonly version: string
  readonly target: string
  readonly sha256: string
}

export interface ExpectedPlan {
  readonly planDigest: string
  readonly hostFingerprint: string
  readonly snapshotDigest: string
  readonly target: string
}

export interface RoleVars {
  readonly hub_bootstrap_vars_schema: typeof ANSIBLE_VARS_SCHEMA
  readonly hub_bootstrap_vars_version: typeof ANSIBLE_VARS_VERSION
  readonly hub_bootstrap_release: string
  readonly hub_bootstrap_channel: string
  readonly hub_bootstrap_minimum_version: string
  readonly hub_bootstrap_manifest_url: string
  /** Per supported target: the hubctl download and its pinned size and digest. */
  readonly hub_bootstrap_artifacts: Readonly<Record<string, PinnedArtifact>>
  readonly hub_bootstrap_harness_pins: readonly PinnedHarness[]
  readonly hub_bootstrap_profile: Profile
  readonly hub_bootstrap_profile_digest: string
  readonly hub_bootstrap_expected_plan: ExpectedPlan | null
  readonly hub_bootstrap_escalate: boolean
  readonly hub_bootstrap_confirm_activation: boolean
  readonly hub_bootstrap_allow_downgrade: boolean
  readonly hub_bootstrap_require_ready: boolean
}

/** The order keys appear in the rendered YAML. */
const VAR_ORDER: readonly (keyof RoleVars)[] = [
  "hub_bootstrap_vars_schema",
  "hub_bootstrap_vars_version",
  "hub_bootstrap_release",
  "hub_bootstrap_channel",
  "hub_bootstrap_minimum_version",
  "hub_bootstrap_manifest_url",
  "hub_bootstrap_artifacts",
  "hub_bootstrap_harness_pins",
  "hub_bootstrap_profile",
  "hub_bootstrap_profile_digest",
  "hub_bootstrap_expected_plan",
  "hub_bootstrap_escalate",
  "hub_bootstrap_confirm_activation",
  "hub_bootstrap_allow_downgrade",
  "hub_bootstrap_require_ready",
]

export interface RenderError {
  readonly code: ErrorCode
  readonly message: string
  readonly path?: string
}

export type RenderResult = { readonly ok: true; readonly vars: RoleVars; readonly yaml: string } | { readonly ok: false; readonly error: RenderError }

const refuse = (code: ErrorCode, message: string, path?: string): RenderResult => ({ ok: false, error: { code, message, ...(path === undefined ? {} : { path }) } })

const describeIssues = (issues: readonly Issue[]) => issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; ")

/** A pin issue code as an envelope error code. */
const pinCode = (code: string): ErrorCode => (code === "unpinned_artifact" || code === "integrity_mismatch" ? code : "invalid")

function releaseBase(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || raw.includes("?") || raw.includes("#")) return undefined
  return url.href.replace(/\/+$/, "")
}

/** Checks a plan against the profile, the manifest and the consent given; undefined when it may be rendered. */
function checkPlan(plan: SetupPlan, profile: Profile, manifest: VerifiedManifest, options: RenderOptions): RenderResult | undefined {
  if (plan.profile.id !== profile.id) return refuse("invalid", `the plan is for profile ${plan.profile.id}, not ${profile.id}`, "/plan/profile/id")
  const artifact = selectArtifact(manifest, plan.target)
  if (!artifact.ok) return refuse("wrong_platform", describeIssues(artifact.issues), "/plan/target")
  for (const [i, action] of plan.actions.entries()) {
    const at = `/plan/actions/${i}`
    if (action.kind === "enroll-machine")
      return refuse("usage", "enrollment is a separate, explicit step: run `hubctl machine enroll` on the host, then preview again", at)
    if (action.kind === "install-artifact") {
      if (action.version !== manifest.release || action.target !== plan.target)
        return refuse("unpinned_artifact", `the plan installs hubctl ${action.version} for ${action.target}, but the manifest pins ${manifest.release} for ${plan.target}`, at)
      if (action.sha256 !== artifact.value.sha256) return refuse("integrity_mismatch", "the plan's hubctl digest differs from the manifest's", at)
    }
    if (action.kind === "install-harness") {
      const pin = checkHarnessPin(manifest, action)
      if (!pin.ok) return refuse(pinCode(pin.issues[0]!.code), describeIssues(pin.issues), at)
    }
  }
  if (plan.requiresEscalation && !options.escalate) return refuse("escalation_required", "the plan has elevated actions; pass escalate explicitly to allow them", "/plan/requiresEscalation")
  if (!plan.requiresEscalation && options.escalate) return refuse("usage", "the plan needs no escalation; do not pass escalate", "/options/escalate")
  if (plan.activatesServices && !options.confirmActivation) return refuse("needs_user", "the plan activates services; pass confirmActivation explicitly to allow it", "/plan/activatesServices")
  return undefined
}

export function renderRoleVars(input: RenderInput): RenderResult {
  const { manifest, options } = input
  const base = releaseBase(options.releaseBaseURL)
  if (!base) return refuse("usage", "the release URL must be https, without credentials, query or fragment", "/options/releaseBaseURL")
  const migrated = migrateProfile(input.profile)
  if (!migrated.ok) return refuse("invalid", `invalid profile: ${describeIssues(migrated.issues)}`, "/profile")
  const profile = JSON.parse(canonicalJSON(migrated.value)) as Profile
  if (options.escalate && profile.escalation !== "explicit") return refuse("usage", "the profile never escalates; escalate cannot be passed", "/options/escalate")

  let expected: ExpectedPlan | null = null
  if (input.plan !== undefined) {
    const checked = validateSetupPlan(input.plan)
    if (!checked.ok) return refuse("invalid", `invalid plan: ${describeIssues(checked.issues)}`, "/plan")
    const plan = checked.value
    const problem = checkPlan(plan, profile, manifest, options)
    if (problem) return problem
    expected = { planDigest: planDigest(plan), hostFingerprint: plan.hostFingerprint, snapshotDigest: plan.snapshotDigest, target: plan.target }
  }

  const artifacts: Record<string, PinnedArtifact> = {}
  for (const a of manifest.artifacts) artifacts[a.target] = { url: `${base}/${a.file}`, file: a.file, size: a.size, sha256: a.sha256 }
  const vars: RoleVars = {
    hub_bootstrap_vars_schema: ANSIBLE_VARS_SCHEMA,
    hub_bootstrap_vars_version: ANSIBLE_VARS_VERSION,
    hub_bootstrap_release: manifest.release,
    hub_bootstrap_channel: manifest.channel,
    hub_bootstrap_minimum_version: manifest.minimumVersion,
    hub_bootstrap_manifest_url: `${base}/${MANIFEST_FILE}`,
    hub_bootstrap_artifacts: artifacts,
    hub_bootstrap_harness_pins: manifest.harnesses.map((p) => ({ harness: p.harness, version: p.version, target: p.target, sha256: p.sha256 })),
    hub_bootstrap_profile: profile,
    hub_bootstrap_profile_digest: digestOf(profile),
    hub_bootstrap_expected_plan: expected,
    hub_bootstrap_escalate: options.escalate === true,
    hub_bootstrap_confirm_activation: options.confirmActivation === true,
    hub_bootstrap_allow_downgrade: options.allowDowngrade === true,
    hub_bootstrap_require_ready: options.requireReady !== false,
  }
  const secrets = findSecrets(vars)
  if (secrets.length > 0) return refuse("invalid", `refusing to render credential-shaped values at ${secrets.join(", ")}`, secrets[0])
  return { ok: true, vars, yaml: renderYAML(vars) }
}

/**
 * The vars as YAML: one `key: <canonical JSON>` line per var, in a fixed order (JSON is YAML, so any YAML loader
 * reads it back exactly, and the same vars always render the same bytes).
 */
export function renderYAML(vars: RoleVars): string {
  const lines = [
    "---",
    "# Vars for the hub_bootstrap Ansible role, rendered by hubctl. Regenerate instead of editing by hand:",
    "# the profile and the pins must stay exactly what was previewed and signed.",
    ...VAR_ORDER.map((key) => `${key}: ${canonicalJSON(vars[key])}`),
  ]
  return `${lines.join("\n")}\n`
}

export interface RolePaths {
  /** The staged, digest-checked hubctl the role runs. */
  readonly hubctl: string
  readonly profile: string
  readonly preview: string
  readonly manifest: string
}

export interface RoleCommands {
  readonly preview: readonly string[]
  readonly apply: readonly string[]
  readonly verify: readonly string[]
}

/** The exact argv the role runs; the same words a person runs on the direct path. */
export function directCommands(vars: RoleVars, paths: RolePaths): RoleCommands {
  const consent = (Object.keys(ROLE_FLAGS) as (keyof typeof ROLE_FLAGS)[]).filter((key) => vars[key] === true).map((key) => ROLE_FLAGS[key])
  return {
    preview: [paths.hubctl, "setup", "preview", "--profile", paths.profile, "--manifest", paths.manifest, "--out", paths.preview, "--json"],
    apply: [paths.hubctl, "setup", "apply", "--preview", paths.preview, "--manifest", paths.manifest, ...consent, "--json"],
    verify: [paths.hubctl, "setup", "verify", "--profile", paths.profile, "--json"],
  }
}
