// SetupPreview: what `hubctl setup preview` outputs. It contains the plan, its digest and preview token, the
// blockers that stop apply, and the upstream evidence already checked for pinned harness downloads.
//
// The only blocker in v1 is a manual edit. When a config the plan would change is a symlink (for example
// ~/.config/opencode pointing into a dotfiles repository), hubctl refuses to write through it. Instead it emits the
// exact, structured, secret-free edit for the user to make in the repository the link points to. The edit
// replaces its action: the plan itself never contains an action that writes through the link. Apply refuses while
// any blocker remains (manual_edit_required, exit 10). Once the user has made the edit, a new preview sees the
// changed config, so its digest differs and that plan no longer carries the refused action.
//
// v1.1: a second reason, unmergeable-format: a config hubctl cannot edit losslessly (TOML, or a file it cannot
// parse) gets the same exact, structured edit, for the file itself (no link involved), instead of a bare conflict.
import { checkConfigSets, checkPrecondition, CONFIG_OWNERS, findExecKeys, type Action, type ConfigFormat, type ConfigOwner, type ConfigSet, type Precondition } from "./actions.ts"
import { EVIDENCE_KINDS, HARNESS_ORDER, type EvidenceKind, type HarnessID } from "./harness.ts"
import { checkPathRef, type PathRef } from "./paths.ts"
import { planDigest, validatePreviewToken, validateSetupPlan, type PreviewToken, type SetupPlan } from "./plan.ts"
import { findSecrets } from "./secrets.ts"
import { absPath, Checker, digest, fail, header, int, isRecord, list, ok, oneOf, pointer, shape, text, type Result } from "./validate.ts"

export type ManualChange =
  | { readonly op: "merge"; readonly set: readonly ConfigSet[] }
  /** Register this hubctl's `mcp` subcommand under `name` (the command is implied, as in the action). */
  | { readonly op: "register-mcp-server"; readonly harness: HarnessID; readonly name: string }
  | { readonly op: "write-file"; readonly asset: string; readonly sha256: string; readonly mode: number }

export const MANUAL_EDIT_REASONS = ["symlinked-config", "unmergeable-format"] as const
export type ManualEditReason = (typeof MANUAL_EDIT_REASONS)[number]

export interface ManualEdit {
  readonly kind: "manual-edit"
  readonly reason: ManualEditReason
  /** The plan action it replaces. */
  readonly actionID: string
  readonly path: PathRef
  /** The symlink found between the root and the target (symlinked-config only). */
  readonly linkPath?: string
  /** Where the edit belongs (the file the link resolves to). */
  readonly resolvedPath: string
  readonly format?: ConfigFormat
  readonly owner?: ConfigOwner
  /** What the file looked like when the edit was computed. */
  readonly precondition?: Precondition
  readonly change: ManualChange
}

/** Everything that stops apply. */
export type PlanBlocker = ManualEdit

const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

function checkManualEdit(c: Checker, path: string, value: unknown): void {
  for (const p of findExecKeys(value, path)) c.add(p, "exec_field", "a manual edit never carries a command")
  const r = shape(c, path, value, ["kind", "reason", "actionID", "path", "resolvedPath", "change"], ["linkPath", "format", "owner", "precondition"])
  if (!r) return
  const at = (key: string) => pointer(path, key)
  if (r.kind !== "manual-edit") c.add(at("kind"), "invalid_value", "expected manual-edit")
  oneOf(c, at("reason"), r.reason, MANUAL_EDIT_REASONS)
  text(c, at("actionID"), r.actionID, 64, ACTION_ID)
  checkPathRef(c, at("path"), r.path)
  if (r.reason === "symlinked-config" && r.linkPath === undefined) c.add(at("linkPath"), "missing_field", "a symlinked config names its link")
  if (r.reason === "unmergeable-format" && r.linkPath !== undefined) c.add(at("linkPath"), "inconsistent", "an unmergeable config is edited in place; no link is involved")
  if (r.linkPath !== undefined) absPath(c, at("linkPath"), r.linkPath)
  absPath(c, at("resolvedPath"), r.resolvedPath)
  if (r.format !== undefined) oneOf(c, at("format"), r.format, ["json", "jsonc", "toml"] as const)
  if (r.owner !== undefined) oneOf(c, at("owner"), r.owner, CONFIG_OWNERS)
  if (r.precondition !== undefined) checkPrecondition(c, at("precondition"), r.precondition)
  const change = isRecord(r.change) ? r.change : undefined
  if (!change) return void c.add(at("change"), "invalid_value", "expected a change")
  const cp = at("change")
  if (!oneOf(c, pointer(cp, "op"), change.op, ["merge", "register-mcp-server", "write-file"] as const)) return
  if (change.op === "merge") {
    shape(c, cp, change, ["op", "set"])
    checkConfigSets(c, pointer(cp, "set"), change.set)
  } else if (change.op === "register-mcp-server") {
    shape(c, cp, change, ["op", "harness", "name"])
    oneOf(c, pointer(cp, "harness"), change.harness, HARNESS_ORDER)
    text(c, pointer(cp, "name"), change.name, 32, /^[a-z0-9][a-z0-9-]{0,31}$/)
  } else {
    shape(c, cp, change, ["op", "asset", "sha256", "mode"])
    text(c, pointer(cp, "asset"), change.asset, 128, /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/)
    digest(c, pointer(cp, "sha256"), change.sha256)
    int(c, pointer(cp, "mode"), change.mode, 0, 0o7777)
  }
  for (const p of findSecrets(value, path)) c.add(p, "secret", "a manual edit never carries credentials")
}

export function validateManualEdit(value: unknown): Result<ManualEdit> {
  const c = new Checker()
  checkManualEdit(c, "", value)
  return c.result(value)
}

/** The manual edit that replaces `action` when its target is behind a symlink; undefined if the action writes no config or file. */
export function manualEditFor(action: Action, link: { readonly linkPath: string; readonly resolvedPath: string }): ManualEdit | undefined {
  const base = { kind: "manual-edit", reason: "symlinked-config", actionID: action.id, linkPath: link.linkPath, resolvedPath: link.resolvedPath } as const
  switch (action.kind) {
    case "merge-config":
      return { ...base, path: action.path, format: action.format, owner: action.owner, precondition: action.precondition, change: { op: "merge", set: action.set } }
    case "register-mcp-server":
      return { ...base, path: action.path, precondition: action.precondition, change: { op: "register-mcp-server", harness: action.harness, name: action.name } }
    case "write-file":
      return { ...base, path: action.path, change: { op: "write-file", asset: action.asset, sha256: action.sha256, mode: action.mode } }
    default:
      return undefined
  }
}

/**
 * v1.1: the manual edit that replaces a config action hubctl cannot apply losslessly (TOML, or a file it cannot
 * parse), for the file at `resolvedPath` itself; undefined if the action edits no config.
 */
export function unmergeableEditFor(action: Action, resolvedPath: string): ManualEdit | undefined {
  const base = { kind: "manual-edit", reason: "unmergeable-format", actionID: action.id, resolvedPath } as const
  switch (action.kind) {
    case "merge-config":
      return { ...base, path: action.path, format: action.format, owner: action.owner, precondition: action.precondition, change: { op: "merge", set: action.set } }
    case "register-mcp-server":
      return { ...base, path: action.path, precondition: action.precondition, change: { op: "register-mcp-server", harness: action.harness, name: action.name } }
    default:
      return undefined
  }
}

/** An upstream evidence check reported in the preview; "deferred" checks run on the downloaded bytes at apply. */
export interface PreviewEvidence {
  readonly actionID: string
  readonly kind: EvidenceKind
  readonly status: "verified" | "unavailable" | "deferred" | "failed"
  readonly detail?: string
}

export const SETUP_PREVIEW_SCHEMA = "hub.setup-preview"

export interface SetupPreview {
  readonly schema: typeof SETUP_PREVIEW_SCHEMA
  readonly version: 1
  readonly plan: SetupPlan
  readonly planDigest: string
  readonly token: PreviewToken
  readonly blockers: readonly PlanBlocker[]
  readonly evidence: readonly PreviewEvidence[]
}

export function validateSetupPreview(value: unknown): Result<SetupPreview> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "plan", "planDigest", "token", "blockers", "evidence"])
  if (!r) return c.result(value)
  header(c, "", r, SETUP_PREVIEW_SCHEMA, 1)
  const plan = validateSetupPlan(r.plan)
  c.merge("/plan", plan)
  digest(c, "/planDigest", r.planDigest)
  const token = validatePreviewToken(r.token)
  c.merge("/token", token)
  const actions = plan.ok ? plan.value.actions : []
  if (plan.ok) {
    const d = planDigest(plan.value)
    if (r.planDigest !== d) c.add("/planDigest", "inconsistent", "planDigest is not the digest of the plan")
    if (token.ok && (token.value.planDigest !== d || token.value.hostFingerprint !== plan.value.hostFingerprint || token.value.snapshotDigest !== plan.value.snapshotDigest))
      c.add("/token", "inconsistent", "the token is not for this plan")
  }
  list(c, "/blockers", r.blockers, 256, (p, b) => {
    checkManualEdit(c, p, b)
    // A manual edit replaces its action: the plan never keeps an action that would write through the symlink.
    if (plan.ok && isRecord(b) && actions.some((a) => a.id === b.actionID)) c.add(pointer(p, "actionID"), "inconsistent", "the refused action is still in the plan")
  })
  list(c, "/evidence", r.evidence, 256, (p, e) => {
    const ev = shape(c, p, e, ["actionID", "kind", "status"], ["detail"])
    if (!ev) return
    text(c, pointer(p, "actionID"), ev.actionID, 64, ACTION_ID)
    oneOf(c, pointer(p, "kind"), ev.kind, EVIDENCE_KINDS)
    oneOf(c, pointer(p, "status"), ev.status, ["verified", "unavailable", "deferred", "failed"] as const)
    if (ev.detail !== undefined) text(c, pointer(p, "detail"), ev.detail)
    const action = actions.find((a) => a.id === ev.actionID)
    if (plan.ok && (action?.kind !== "install-harness" || !action.evidence.includes(ev.kind as EvidenceKind))) c.add(p, "inconsistent", "the evidence names no planned check")
  })
  // The preview token is not a credential (it grants nothing; apply re-plans and compares), so only its key is exempt.
  for (const p of findSecrets(value, "", new Set(["/token"]))) c.add(p, "secret", "previews never carry credentials")
  return c.result(value)
}

/** Whether apply may proceed past the preview's own findings (revalidatePreview still runs at apply). */
export function previewApplicable(preview: SetupPreview): Result<SetupPreview> {
  if (preview.blockers.length > 0) {
    const reasons = [...new Set(preview.blockers.map((b) => (b.reason === "unmergeable-format" ? "a format hubctl cannot edit losslessly" : "symlinked config")))].join(", ")
    return fail("/blockers", "manual_edit_required", `${preview.blockers.length} change(s) must be made by hand (${reasons}); make them and preview again`)
  }
  const failed = preview.evidence.find((e) => e.status === "failed")
  if (failed) return fail("/evidence", "evidence_failed", `${failed.kind} failed for ${failed.actionID}`)
  return ok(preview)
}
