// SetupPlan and PreviewToken. A plan is a pure function of (discovery snapshot, profile): no timestamps, no
// randomness, so the same host and choices always produce the same plan and the same digest. `hubctl setup
// preview` shows the plan and issues a preview token bound to the host fingerprint, the snapshot digest and the
// plan digest, with a short expiry and a single-use nonce. `apply` never trusts the token's content: it rediscovers,
// re-plans, and applies only when the fresh plan's digest equals the previewed one (revalidatePreview), so a stale,
// foreign, expired or replayed preview applies nothing.
import { checkAction, type Action } from "./actions.ts"
import { digestOf } from "./canonical.ts"
import { PROFILE_IDS, PROFILE_VERSION, type ProfileID } from "./profile.ts"
import { checkTarget } from "./platform.ts"
import { bool, Checker, digest, fail, header, instant, isRecord, list, ok, oneOf, shape, text, type Result } from "./validate.ts"

export const PLAN_SCHEMA = "hub.setup-plan"
export const PLAN_VERSION = 1
export const PLAN_MAX_ACTIONS = 256

export interface SetupPlan {
  readonly schema: typeof PLAN_SCHEMA
  readonly version: typeof PLAN_VERSION
  readonly hostFingerprint: string
  /** digestOf the DiscoverySnapshot the plan was made from. */
  readonly snapshotDigest: string
  readonly target: string
  readonly profile: { readonly id: ProfileID; readonly version: typeof PROFILE_VERSION }
  /** True iff some action is elevated; apply then needs explicit consent (--escalate). */
  readonly requiresEscalation: boolean
  /** True iff the plan activates a service; apply then needs explicit consent. */
  readonly activatesServices: boolean
  /** In execution order. */
  readonly actions: readonly Action[]
}

export function validateSetupPlan(value: unknown): Result<SetupPlan> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "hostFingerprint", "snapshotDigest", "target", "profile", "requiresEscalation", "activatesServices", "actions"])
  if (!r) return c.result(value)
  header(c, "", r, PLAN_SCHEMA, PLAN_VERSION)
  digest(c, "/hostFingerprint", r.hostFingerprint)
  digest(c, "/snapshotDigest", r.snapshotDigest)
  if (typeof r.target !== "string" || !checkTarget(r.target).ok) c.add("/target", "unsupported_platform", `cannot plan for ${String(r.target)}`)
  const profile = shape(c, "/profile", r.profile, ["id", "version"])
  if (profile) {
    oneOf(c, "/profile/id", profile.id, PROFILE_IDS)
    if (profile.version !== PROFILE_VERSION) c.add("/profile/version", "unsupported_version", `profile version must be ${PROFILE_VERSION}`)
  }
  bool(c, "/requiresEscalation", r.requiresEscalation)
  bool(c, "/activatesServices", r.activatesServices)
  if (!list(c, "/actions", r.actions, PLAN_MAX_ACTIONS, (p, v) => checkAction(c, p, v), (v) => (isRecord(v) && typeof v.id === "string" ? v.id : undefined))) return c.result(value)

  const actions = (r.actions as unknown[]).filter(isRecord)
  const elevated = actions.some((a) => a.escalation === "elevated")
  if (r.requiresEscalation !== elevated) c.add("/requiresEscalation", "inconsistent", "requiresEscalation must say exactly whether an action is elevated")
  const activates = actions.some((a) => a.kind === "activate-service")
  if (r.activatesServices !== activates) c.add("/activatesServices", "inconsistent", "activatesServices must say exactly whether a service is activated")
  const installed = new Set<string>()
  const verified = new Set<string>()
  const unverifiedInstalls = new Map<string, number>()
  let enrollments = 0
  actions.forEach((a, i) => {
    const at = `/actions/${i}`
    if (a.kind === "install-service") installed.add(`${String(a.service)}@${String(a.manager)}`)
    if (a.kind === "install-harness") unverifiedInstalls.set(String(a.harness), i)
    if (a.kind === "verify-harness") {
      verified.add(String(a.harness))
      unverifiedInstalls.delete(String(a.harness))
    }
    if (a.kind === "activate-service" && !installed.has(`${String(a.service)}@${String(a.manager)}`)) c.add(at, "inconsistent", "a service is installed before it is activated")
    if (a.kind === "launch-session" && !verified.has(String(a.harness))) c.add(at, "inconsistent", "a harness is verified before a session is launched on it")
    if (a.kind === "enroll-machine" && ++enrollments > 1) c.add(at, "duplicate", "a plan enrolls the machine at most once")
  })
  for (const i of unverifiedInstalls.values()) c.add(`/actions/${i}`, "inconsistent", "an installed harness is verified afterwards (install is not readiness)")
  return c.result(value)
}

/** The digest previews and journals pin. */
export const planDigest = (plan: SetupPlan): string => digestOf(plan)

export const PREVIEW_SCHEMA = "hub.preview-token"
export const PREVIEW_VERSION = 1
export const PREVIEW_MAX_TTL_MS = 15 * 60_000
/** How far a preview's issue time may be ahead of this clock. */
export const PREVIEW_CLOCK_SKEW_MS = 60_000
const NONCE = /^[A-Za-z0-9_-]{16,128}$/

export interface PreviewToken {
  readonly schema: typeof PREVIEW_SCHEMA
  readonly version: typeof PREVIEW_VERSION
  readonly planDigest: string
  readonly hostFingerprint: string
  readonly snapshotDigest: string
  readonly issuedAt: number
  readonly expiresAt: number
  /** Single use: apply records it in the journal and refuses it again. */
  readonly nonce: string
}

export function validatePreviewToken(value: unknown): Result<PreviewToken> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "planDigest", "hostFingerprint", "snapshotDigest", "issuedAt", "expiresAt", "nonce"])
  if (!r) return c.result(value)
  header(c, "", r, PREVIEW_SCHEMA, PREVIEW_VERSION)
  digest(c, "/planDigest", r.planDigest)
  digest(c, "/hostFingerprint", r.hostFingerprint)
  digest(c, "/snapshotDigest", r.snapshotDigest)
  if (instant(c, "/issuedAt", r.issuedAt) && instant(c, "/expiresAt", r.expiresAt)) {
    const ttl = (r.expiresAt as number) - (r.issuedAt as number)
    if (ttl <= 0 || ttl > PREVIEW_MAX_TTL_MS) c.add("/expiresAt", "invalid_value", `a preview lives 1 ms..${PREVIEW_MAX_TTL_MS / 60_000} minutes`)
  }
  text(c, "/nonce", r.nonce, 128, NONCE)
  return c.result(value)
}

export interface RevalidationContext {
  readonly now: number
  /** This host's fingerprint, computed fresh. */
  readonly hostFingerprint: string
  /** The plan made fresh from a new discovery. */
  readonly plan: SetupPlan
  /** Nonces already consumed by earlier applies (from the journals). */
  readonly usedNonces: ReadonlySet<string>
}

/** Whether `apply` may proceed with this preview. Checked in this order; the first failure is the answer. */
export function revalidatePreview(token: unknown, context: RevalidationContext): Result<PreviewToken> {
  const checked = validatePreviewToken(token)
  if (!checked.ok) return checked
  const t = checked.value
  if (t.hostFingerprint !== context.hostFingerprint || context.plan.hostFingerprint !== context.hostFingerprint)
    return fail("/hostFingerprint", "preview_foreign", "this preview was made for another host or account")
  if (context.now >= t.expiresAt) return fail("/expiresAt", "preview_expired", "the preview expired; run the preview again")
  if (t.issuedAt > context.now + PREVIEW_CLOCK_SKEW_MS) return fail("/issuedAt", "preview_not_yet_valid", "the preview is from the future (clock skew?)")
  if (context.usedNonces.has(t.nonce)) return fail("/nonce", "preview_replayed", "this preview was already applied")
  if (t.snapshotDigest !== context.plan.snapshotDigest || t.planDigest !== planDigest(context.plan))
    return fail("/planDigest", "preview_stale", "the host or the plan changed since the preview; run the preview again")
  return ok(t)
}
