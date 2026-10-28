// Previews (`hubctl setup preview`) and their revalidation at apply time. previewSetup discovers the host, plans
// (planSetup) and issues a preview token bound to the host fingerprint, the snapshot digest and the plan digest,
// valid for at most 15 minutes, with a single-use nonce. revalidateApply never trusts that token: it rediscovers,
// re-plans and compares (revalidatePreview), then refuses while a manual edit or failed evidence remains. Both only
// read, through the probe.
import {
  fail,
  ok,
  planDigest,
  PREVIEW_MAX_TTL_MS,
  previewApplicable,
  revalidatePreview,
  validatePreviewToken,
  validateSetupPreview,
  type DiscoverySnapshot,
  type PreviewToken,
  type Profile,
  type Result,
  type SetupPreview,
} from "../contracts/index.ts"
import { discover } from "../discovery/discover.ts"
import type { DiscoveryProbe } from "../discovery/probe.ts"
import { inspectLinks } from "./links.ts"
import { planSetup, type PlannedSetup, type PlanSources } from "./plan.ts"

const randomNonce = (): string => {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

export interface PreviewRequest extends PlanSources {
  readonly probe: DiscoveryProbe
  readonly profile: Profile
  readonly now: number
  /** Injected for tests; otherwise 18 random bytes, base64url. */
  readonly nonce?: string
  /** Token lifetime, at most (and by default) 15 minutes. */
  readonly ttlMs?: number
}

function discoverAndPlan(probe: DiscoveryProbe, profile: Profile, now: number, sources: PlanSources): Result<{ snapshot: DiscoverySnapshot } & PlannedSetup> {
  const snap = discover(probe, { now })
  if (!snap.ok) return snap
  const planned = planSetup({ snapshot: snap.value, profile, links: inspectLinks(probe, snap.value), adapters: sources.adapters, contributors: sources.contributors, enrollment: sources.enrollment })
  return planned.ok ? ok({ snapshot: snap.value, ...planned.value }) : planned
}

/** Discovers, plans and issues a preview. Writes nothing. */
export function previewSetup(request: PreviewRequest): Result<SetupPreview> {
  const ttl = request.ttlMs ?? PREVIEW_MAX_TTL_MS
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > PREVIEW_MAX_TTL_MS) return fail("/ttlMs", "invalid_value", `a preview lives 1 ms..${PREVIEW_MAX_TTL_MS / 60_000} minutes`)
  const planned = discoverAndPlan(request.probe, request.profile, request.now, request)
  if (!planned.ok) return planned
  const { plan, blockers, evidence } = planned.value
  const digest = planDigest(plan)
  const token: PreviewToken = {
    schema: "hub.preview-token",
    version: 1,
    planDigest: digest,
    hostFingerprint: plan.hostFingerprint,
    snapshotDigest: plan.snapshotDigest,
    issuedAt: request.now,
    expiresAt: request.now + ttl,
    nonce: request.nonce ?? randomNonce(),
  }
  return validateSetupPreview({ schema: "hub.setup-preview", version: 1, plan, planDigest: digest, token, blockers, evidence })
}

export interface ApplyCheck extends PlanSources {
  readonly token: unknown
  readonly probe: DiscoveryProbe
  readonly profile: Profile
  readonly now: number
  /** Nonces consumed by earlier applies (from the journals). */
  readonly usedNonces: ReadonlySet<string>
}

/**
 * Whether apply may run the previewed plan: rediscovers and re-plans now, then checks the token against the fresh
 * host fingerprint, snapshot and plan (revalidatePreview), and refuses while a manual edit or failed evidence
 * remains. On success, returns the freshly made plan (never one read back from the preview).
 */
export function revalidateApply(check: ApplyCheck): Result<{ readonly token: PreviewToken; readonly snapshot: DiscoverySnapshot } & PlannedSetup> {
  const token = validatePreviewToken(check.token)
  if (!token.ok) return token
  const fresh = discoverAndPlan(check.probe, check.profile, check.now, check)
  if (!fresh.ok) return fresh
  const valid = revalidatePreview(token.value, { now: check.now, hostFingerprint: fresh.value.snapshot.host.fingerprint, plan: fresh.value.plan, usedNonces: check.usedNonces })
  if (!valid.ok) return valid
  const gate = previewApplicable({ schema: "hub.setup-preview", version: 1, plan: fresh.value.plan, planDigest: planDigest(fresh.value.plan), token: valid.value, blockers: fresh.value.blockers, evidence: fresh.value.evidence })
  if (!gate.ok) return gate
  return ok({ token: valid.value, ...fresh.value })
}

/** A preview document read back from disk or another process: validated, never cast. */
export const parsePreview = (raw: unknown): Result<SetupPreview> => validateSetupPreview(raw)
