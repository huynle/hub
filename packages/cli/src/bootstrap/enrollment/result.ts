// The output of `machine enroll` / `machine status`: one hub.bootstrap.result envelope (for --json) and its exit
// code, plus a text rendering for people. Every envelope is validated before it is returned: one that fails (for
// instance because a credential slipped into it) is withheld and replaced by an internal error.
import { ENVELOPE_SCHEMA, exitFor, validateEnvelope, type EnrollmentStatus, type ErrorCode, type ResultEnvelope } from "../contracts/index.ts"

export type MachineCommand = "machine enroll" | "machine status"

export interface MachineResult<T = EnrollmentStatus> {
  readonly envelope: ResultEnvelope<T>
  /** The process exit code (contracts envelope.ts exitFor; 0 on success). */
  readonly exit: number
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)
/** One line, at most `max` characters (contract text fields are single-line). */
export const line = (s: string, max = 200) => clip(s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), max)

function checked<T>(envelope: ResultEnvelope<T>): ResultEnvelope<T> {
  if (validateEnvelope(envelope).ok) return envelope
  return { schema: ENVELOPE_SCHEMA, version: 1, command: envelope.command, ok: false, error: { code: "internal", message: "The result failed validation and was withheld" } }
}

export function success<T>(command: MachineCommand, data: T, warnings: readonly string[] = []): MachineResult<T> {
  const envelope = checked<T>({ schema: ENVELOPE_SCHEMA, version: 1, command, ok: true, data, ...(warnings.length ? { warnings: warnings.map((w) => line(w, 500)) } : {}) })
  return { envelope, exit: envelope.ok ? 0 : exitFor(envelope.error!.code) }
}

export function failure<T = EnrollmentStatus>(
  command: MachineCommand,
  code: ErrorCode,
  message: string,
  extra: { hint?: string; data?: T; warnings?: readonly string[] } = {},
): MachineResult<T> {
  const envelope = checked<T>({
    schema: ENVELOPE_SCHEMA,
    version: 1,
    command,
    ok: false,
    ...(extra.data !== undefined ? { data: extra.data } : {}),
    error: { code, message: line(message, 500), ...(extra.hint ? { hint: line(extra.hint, 500) } : {}) },
    ...(extra.warnings?.length ? { warnings: extra.warnings.map((w) => line(w, 500)) } : {}),
  })
  return { envelope, exit: exitFor(envelope.error!.code) }
}

const isStatus = (v: unknown): v is EnrollmentStatus => typeof v === "object" && v !== null && (v as { schema?: unknown }).schema === "hub.enrollment-status"

/** Text for people: the machine's state, then any error, hint and warnings. */
export function renderMachineResult(envelope: ResultEnvelope): string {
  const lines: string[] = []
  if (isStatus(envelope.data)) {
    const s = envelope.data
    const who = s.machineID ? ` as ${s.machineID}${s.machineName ? ` (${s.machineName})` : ""}` : ""
    lines.push(s.server ? `machine: ${s.state}, enrolled with ${s.server}${who}` : `machine: ${s.state}`)
    if (s.detail) lines.push(`  ${s.detail}`)
  }
  if (envelope.error) {
    lines.push(`error: ${envelope.error.message}`)
    if (envelope.error.hint) lines.push(`hint: ${envelope.error.hint}`)
  }
  for (const w of envelope.warnings ?? []) lines.push(`warning: ${w}`)
  return `${lines.join("\n")}\n`
}
