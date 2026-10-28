// The JSON output envelope and exit codes of the bootstrap commands (`hubctl machine …`, `hubctl setup …`). With
// --json, stdout carries exactly one envelope; without it, people get text and the same exit code. Exit codes 0–9
// are the CLI's existing ones (http.ts EXIT) with unchanged meanings; the bootstrap adds 10 and up.
import { EXIT } from "../../http.ts"
import { findSecrets } from "./secrets.ts"
import { bool, Checker, header, list, oneOf, shape, text, type Result } from "./validate.ts"

export const BOOTSTRAP_EXIT = Object.freeze({
  ...EXIT,
  /** A file the plan would change was edited by someone else, is not ours, or is a symlink the user must edit themselves: nothing was overwritten. */
  conflict: 10,
  /** A hubctl or harness artifact failed authentication: unpinned, tampered, wrong platform, bad signature or evidence, or a refused downgrade. */
  artifactRejected: 11,
  /** The preview is stale, foreign, expired, replayed or malformed: preview again. */
  previewInvalid: 12,
  /** Another apply holds the lock. */
  locked: 13,
  /** An interrupted transaction must be recovered (`hubctl setup recover`) before anything else applies. */
  recoveryRequired: 14,
  /** A harness or provider failed its real probes. */
  notReady: 15,
} as const)

export const ERROR_CODES = [
  "usage",
  "invalid",
  "unsupported_platform",
  "wrong_platform",
  "integrity_mismatch",
  "signature_invalid",
  "downgrade_rejected",
  "below_security_floor",
  "trust_root_rollback",
  "unpinned_artifact",
  "evidence_failed",
  "preview_invalid",
  "preview_foreign",
  "preview_expired",
  "preview_not_yet_valid",
  "preview_replayed",
  "preview_stale",
  "locked",
  "conflict",
  "manual_edit_required",
  "recovery_required",
  "escalation_required",
  "needs_user",
  "forbidden",
  "unauthorized",
  "revoked",
  "offline",
  "not_found",
  "harness_not_ready",
  "internal",
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

const EXIT_OF: Readonly<Record<ErrorCode, number>> = {
  usage: EXIT.usage,
  invalid: EXIT.usage,
  unsupported_platform: EXIT.unavailable,
  wrong_platform: BOOTSTRAP_EXIT.artifactRejected,
  integrity_mismatch: BOOTSTRAP_EXIT.artifactRejected,
  signature_invalid: BOOTSTRAP_EXIT.artifactRejected,
  downgrade_rejected: BOOTSTRAP_EXIT.artifactRejected,
  below_security_floor: BOOTSTRAP_EXIT.artifactRejected,
  trust_root_rollback: BOOTSTRAP_EXIT.artifactRejected,
  unpinned_artifact: BOOTSTRAP_EXIT.artifactRejected,
  evidence_failed: BOOTSTRAP_EXIT.artifactRejected,
  preview_invalid: BOOTSTRAP_EXIT.previewInvalid,
  preview_foreign: BOOTSTRAP_EXIT.previewInvalid,
  preview_expired: BOOTSTRAP_EXIT.previewInvalid,
  preview_not_yet_valid: BOOTSTRAP_EXIT.previewInvalid,
  preview_replayed: BOOTSTRAP_EXIT.previewInvalid,
  preview_stale: BOOTSTRAP_EXIT.previewInvalid,
  locked: BOOTSTRAP_EXIT.locked,
  conflict: BOOTSTRAP_EXIT.conflict,
  manual_edit_required: BOOTSTRAP_EXIT.conflict,
  recovery_required: BOOTSTRAP_EXIT.recoveryRequired,
  escalation_required: EXIT.needsUser,
  needs_user: EXIT.needsUser,
  forbidden: EXIT.forbidden,
  unauthorized: EXIT.unauthorized,
  revoked: EXIT.unauthorized,
  offline: EXIT.unavailable,
  not_found: EXIT.notFound,
  harness_not_ready: BOOTSTRAP_EXIT.notReady,
  internal: EXIT.other,
}

export const exitFor = (code: ErrorCode | string): number => EXIT_OF[code as ErrorCode] ?? EXIT.other

export const ENVELOPE_SCHEMA = "hub.bootstrap.result"

export interface ResultEnvelope<T = unknown> {
  readonly schema: typeof ENVELOPE_SCHEMA
  readonly version: 1
  /** The command words ("machine status", "setup apply"). */
  readonly command: string
  readonly ok: boolean
  readonly data?: T
  readonly error?: { readonly code: ErrorCode; readonly message: string; readonly hint?: string }
  readonly warnings?: readonly string[]
}

export function validateEnvelope(value: unknown): Result<ResultEnvelope> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "command", "ok"], ["data", "error", "warnings"])
  if (!r) return c.result(value)
  header(c, "", r, ENVELOPE_SCHEMA, 1)
  text(c, "/command", r.command, 64, /^[a-z][a-z-]*(?: [a-z][a-z-]*)*$/)
  bool(c, "/ok", r.ok)
  if (r.error !== undefined) {
    const e = shape(c, "/error", r.error, ["code", "message"], ["hint"])
    if (e) {
      oneOf(c, "/error/code", e.code, ERROR_CODES)
      text(c, "/error/message", e.message, 500)
      if (e.hint !== undefined) text(c, "/error/hint", e.hint, 500)
    }
  }
  if (r.ok === true && r.error !== undefined) c.add("/error", "inconsistent", "a success has no error")
  if (r.ok === false && r.error === undefined) c.add("/error", "inconsistent", "a failure names its error")
  if (r.warnings !== undefined) list(c, "/warnings", r.warnings, 64, (p, w) => text(c, p, w, 500))
  for (const p of findSecrets(value)) c.add(p, "secret", "output never carries credentials")
  return c.result(value)
}
