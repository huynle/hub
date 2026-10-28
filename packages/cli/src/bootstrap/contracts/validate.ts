// A small, dependency-free validator kit for the bootstrap contracts. Every document crossing a trust boundary (a
// discovery snapshot, a plan read back from disk, a preview token, a manifest downloaded from a release, a journal
// left by a crashed apply) is parsed as `unknown` and checked here; nothing is cast blindly. Checks collect every
// issue (with a JSON pointer) instead of stopping at the first, so a report shows the whole problem.

/** Machine-readable reasons a check fails. Tests and callers match on `code`, never on `message`. */
export type IssueCode =
  | "invalid_value"
  | "missing_field"
  | "unknown_field"
  | "unsupported_version"
  | "inconsistent"
  | "duplicate"
  | "invalid_path"
  | "unmapped_root"
  | "symlink"
  | "exec_field"
  | "secret"
  | "unsupported_platform"
  | "wrong_platform"
  | "integrity_mismatch"
  | "signature_invalid"
  | "downgrade_rejected"
  | "below_security_floor"
  | "trust_root_rollback"
  | "unmigratable"
  | "preview_foreign"
  | "preview_expired"
  | "preview_not_yet_valid"
  | "preview_replayed"
  | "preview_stale"
  | "unpinned_artifact"
  | "evidence_failed"
  | "manual_edit_required"

export interface Issue {
  /** JSON pointer of the offending value ("" for the document itself). */
  readonly path: string
  readonly code: IssueCode
  readonly message: string
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = <T = never>(path: string, code: IssueCode, message: string): Result<T> => ({ ok: false, issues: [{ path, code, message }] })

/** Collects issues while a document is walked. */
export class Checker {
  readonly issues: Issue[] = []

  add(path: string, code: IssueCode, message: string): void {
    this.issues.push({ path, code, message })
  }

  merge(prefix: string, result: Result<unknown>): void {
    if (!result.ok) for (const issue of result.issues) this.issues.push({ ...issue, path: `${prefix}${issue.path}` })
  }

  result<T>(value: unknown): Result<T> {
    return this.issues.length === 0 ? ok(value as T) : { ok: false, issues: [...this.issues] }
  }
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** JSON pointer segment escaping (RFC 6901). */
export const pointer = (base: string, key: string | number): string => `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`

/**
 * Checks that `value` is an object whose keys are all in `allowed` (keys holding `undefined` count as absent) and
 * that every key in `required` is present. Returns the object, or undefined (with issues added) when not an object.
 */
export function shape(c: Checker, path: string, value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    c.add(path, "invalid_value", "expected an object")
    return undefined
  }
  const allowed = new Set([...required, ...optional])
  for (const [key, v] of Object.entries(value)) if (v !== undefined && !allowed.has(key)) c.add(pointer(path, key), "unknown_field", `unknown field ${key}`)
  for (const key of required) if (value[key] === undefined) c.add(pointer(path, key), "missing_field", `missing ${key}`)
  return value
}

/** schema + version header shared by every versioned document. */
export function header(c: Checker, path: string, r: Record<string, unknown>, schema: string, version: number): void {
  if (r.schema !== schema) c.add(pointer(path, "schema"), "invalid_value", `expected schema ${schema}`)
  if (!Number.isInteger(r.version)) c.add(pointer(path, "version"), "invalid_value", "version must be an integer")
  else if (r.version !== version) c.add(pointer(path, "version"), "unsupported_version", `version ${String(r.version)} is not supported (expected ${version})`)
}

export function oneOf<T extends string>(c: Checker, path: string, value: unknown, options: readonly T[]): value is T {
  if (typeof value === "string" && (options as readonly string[]).includes(value)) return true
  if (value !== undefined) c.add(path, "invalid_value", `expected one of ${options.join(", ")}`)
  return false
}

export function bool(c: Checker, path: string, value: unknown): value is boolean {
  if (typeof value === "boolean") return true
  if (value !== undefined) c.add(path, "invalid_value", "expected true or false")
  return false
}

export function int(c: Checker, path: string, value: unknown, min: number, max: number): value is number {
  if (Number.isInteger(value) && (value as number) >= min && (value as number) <= max) return true
  if (value !== undefined) c.add(path, "invalid_value", `expected an integer in ${min}..${max}`)
  return false
}

/** A timestamp: integer milliseconds since the epoch. */
export const instant = (c: Checker, path: string, value: unknown): value is number => int(c, path, value, 0, 8.64e15)

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A one-line printable string of bounded length (no control characters, so it cannot fake output lines). */
export function text(c: Checker, path: string, value: unknown, max = 200, pattern?: RegExp): value is string {
  if (typeof value === "string" && value.length >= 1 && value.length <= max && !CONTROL.test(value) && (!pattern || pattern.test(value))) return true
  if (value !== undefined) c.add(path, "invalid_value", pattern ? `expected a string matching ${pattern}` : `expected a one-line string of 1..${max} characters`)
  return false
}

export const DIGEST = /^sha256:[0-9a-f]{64}$/
export const digest = (c: Checker, path: string, value: unknown): value is string => text(c, path, value, 71, DIGEST)

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export const semver = (c: Checker, path: string, value: unknown): value is string => text(c, path, value, 64, SEMVER)

/** An absolute, normalized POSIX path: no empty, "." or ".." segments, no trailing slash, no control characters. */
export function isAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || CONTROL.test(value) || value.includes("\\")) return false
  if (value === "/") return true
  return value
    .slice(1)
    .split("/")
    .every((s) => s !== "" && s !== "." && s !== "..")
}

export function absPath(c: Checker, path: string, value: unknown): value is string {
  if (isAbsolutePath(value)) return true
  if (value !== undefined) c.add(path, "invalid_path", "expected an absolute, normalized path")
  return false
}

/** An array whose items are checked by `item`; `unique` reports repeated keys as duplicates. */
export function list(c: Checker, path: string, value: unknown, max: number, item: (p: string, v: unknown) => void, unique?: (v: unknown) => string | undefined): value is unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    if (value !== undefined) c.add(path, "invalid_value", `expected a list of at most ${max} items`)
    return false
  }
  const seen = new Set<string>()
  value.forEach((v, i) => {
    item(pointer(path, i), v)
    const key = unique?.(v)
    if (key === undefined) return
    if (seen.has(key)) c.add(pointer(path, i), "duplicate", `duplicate ${key}`)
    seen.add(key)
  })
  return true
}

/** A list of distinct strings drawn from `options`. */
export function subset<T extends string>(c: Checker, path: string, value: unknown, options: readonly T[]): value is T[] {
  return list(c, path, value, options.length, (p, v) => oneOf(c, p, v, options), (v) => (typeof v === "string" ? v : undefined))
}

/** A plain file name (no directories). */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** An https URL without credentials (download sources: never plain http, not even for loopback). */
export function httpsURL(c: Checker, path: string, value: unknown): value is string {
  if (typeof value === "string" && value.length <= 2048) {
    try {
      const url = new URL(value)
      if (url.protocol === "https:" && !url.username && !url.password) return true
    } catch {}
  }
  if (value !== undefined) c.add(path, "invalid_value", "expected an https URL without credentials")
  return false
}

/** http(s) URL; plain http only for loopback hubs (a local hub on 127.0.0.1). */
export function hubURL(c: Checker, path: string, value: unknown): value is string {
  if (typeof value === "string" && value.length <= 2048) {
    try {
      const url = new URL(value)
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
      if ((url.protocol === "https:" || (url.protocol === "http:" && loopback)) && !url.username && !url.password) return true
    } catch {}
  }
  if (value !== undefined) c.add(path, "invalid_value", "expected an https URL (http only for a loopback hub), without credentials")
  return false
}
