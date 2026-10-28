// Outcomes of the transaction layer. A failure carries one contract ErrorCode (envelope.ts), so the CLI maps it to
// an exit code with exitFor, and one printable message. Messages name paths and reasons, never file contents or
// credentials.
import type { ErrorCode, Result } from "../contracts/index.ts"

export interface TxFailure {
  readonly ok: false
  readonly code: ErrorCode
  readonly message: string
}

export type TxResult<T> = { readonly ok: true; readonly value: T } | TxFailure

export const txOk = <T>(value: T): TxResult<T> => ({ ok: true, value })
export const txFail = (code: ErrorCode, message: string): TxFailure => ({ ok: false, code, message })

/** Contract issue codes that are also error codes keep their name; the rest map to the nearest error code. */
const ISSUE_TO_ERROR: Readonly<Record<string, ErrorCode>> = {
  symlink: "conflict",
  invalid_path: "invalid",
  unmapped_root: "invalid",
  invalid_value: "invalid",
  missing_field: "invalid",
  unknown_field: "invalid",
  unsupported_version: "invalid",
  inconsistent: "invalid",
  duplicate: "invalid",
  exec_field: "invalid",
  secret: "invalid",
  unmigratable: "invalid",
}

/** The first issue of a failed contract Result as a TxFailure. */
export function fromResult<T>(result: Result<T>, context?: string): TxResult<T> {
  if (result.ok) return txOk(result.value)
  const issue = result.issues[0]!
  const code = ISSUE_TO_ERROR[issue.code] ?? (issue.code as ErrorCode)
  return txFail(code, context ? `${context}: ${issue.message}` : issue.message)
}
