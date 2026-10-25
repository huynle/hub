// The message envelope (design §3.3) and its sanitiser. Pure functions.
//
// - The sender is derived only from the authenticated actor (partyFromActor); a request body never names it.
// - Text and every interpolated label are sanitised: ANSI escape sequences, C0 (except tab and newline), DEL,
//   C1, bidi embeddings/overrides/isolates, zero-width characters, BOM and line/paragraph separators go.
// - The body sits between two per-message boundary lines; body lines that look like a header, a boundary, a
//   reply hint (or an escaped one) are escaped with a leading backslash, so a body cannot forge any of them.
import type { AgentActor } from "./actor"

/** Interpolated labels (names, harness, machine, the address as written) are cut to this many characters. */
export const LABEL_MAX = 120

/** Who sends or receives a message: a session, the user (`@me`), or an app token. */
export type Party =
  | { readonly kind: "session"; readonly sessionID: string; readonly name?: string; readonly harness?: string; readonly machine?: string }
  | { readonly kind: "user" }
  | { readonly kind: "app"; readonly tokenID: string; readonly label?: string }

export type EnvelopeKind = "msg" | "ask" | "reply" | "decline"

export interface EnvelopeInput {
  readonly id: string
  readonly kind: EnvelopeKind
  /** The sender, from partyFromActor. */
  readonly from: Party
  /** The address as the sender wrote it (`@@reviewer`, `@x`, `ses_…`). */
  readonly to: string
  readonly at: number
  readonly text: string
  /** What a reply or decline answers. */
  readonly replyTo?: string
  /** When an ask expires. */
  readonly expiresAt?: number
}

/** Directory facts for a session sender's label (never taken from a request body). */
export interface PartyInfo {
  readonly name?: string
  readonly harness?: string
  readonly machine?: string
}

/** ANSI escape sequences: CSI, OSC (BEL or ST), DCS/PM/APC strings, other ESC sequences, 8-bit CSI. */
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[P^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]?|\u009b[0-?]*[ -/]*[@-~]/g

/**
 * C0 except tab/newline, DEL, C1, Arabic letter mark, zero-width and directional marks (U+200B-200F), line and
 * paragraph separators and bidi embeddings/overrides (U+2028-202E), word joiner, invisible operators and bidi
 * isolates (U+2060-206F), BOM.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g

/** Message text: newlines normalised, escape sequences and invisible/control characters removed. */
export function sanitizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "")
}

/** A label: sanitised, one line (whitespace runs become one space), trimmed, at most `max` characters. */
export function sanitizeLabel(text: string, max = LABEL_MAX): string {
  return Array.from(sanitizeText(text).replace(/\s+/g, " ").trim()).slice(0, max).join("").trimEnd()
}

/** The sender of a request, from its actor; session labels come from the hub's directory, sanitised. */
export function partyFromActor(actor: AgentActor, info: PartyInfo = {}): Party {
  switch (actor.kind) {
    case "user":
      return { kind: "user" }
    case "app":
      return { kind: "app", tokenID: actor.tokenID, ...labels({ label: actor.label }) }
    case "session":
      return { kind: "session", sessionID: actor.sessionID, ...labels({ name: info.name, harness: info.harness, machine: info.machine }) }
  }
}

/** The given labels, sanitised, without empty ones. */
function labels<T extends Record<string, string | undefined>>(values: T): Partial<Record<keyof T, string>> {
  const out: Partial<Record<keyof T, string>> = {}
  for (const [key, value] of Object.entries(values) as [keyof T, string | undefined][]) {
    const clean = value === undefined ? "" : sanitizeLabel(value)
    if (clean) out[key] = clean
  }
  return out
}

/** A stable key per party (index and mute keys): `ses:<id>`, `user`, `app:<tokenID>`. */
export function partyKey(party: Party): string {
  switch (party.kind) {
    case "session":
      return `ses:${party.sessionID}`
    case "user":
      return "user"
    case "app":
      return `app:${party.tokenID}`
  }
}

/** How a party reads in an envelope: `@name (harness · machine)`, `ses_…`, `the user`, `app <label>`. */
export function partyLabel(party: Party): string {
  switch (party.kind) {
    case "user":
      return "the user"
    case "app":
      return `app ${sanitizeLabel(party.label ?? "") || party.tokenID}`
    case "session": {
      const name = sanitizeLabel(party.name ?? "")
      const details = [party.harness, party.machine].map((value) => sanitizeLabel(value ?? "")).filter(Boolean)
      return `${name ? `@${name}` : party.sessionID}${details.length ? ` (${details.join(" · ")})` : ""}`
    }
  }
}

/** `MM-DD HH:MMZ` in UTC. */
function stamp(at: number): string {
  const iso = new Date(at).toISOString()
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`
}

/** Lines a body must not start with: a header, a boundary or rule, a reply hint, or an escaped one of those. */
const FORGEABLE = /^\s*\\*(?:\[hub\]|-{3,}|↩)/i

/** The sanitised body with forgeable lines escaped by a leading backslash. */
function escapeBody(text: string): string {
  return sanitizeText(text)
    .split("\n")
    .map((line) => (FORGEABLE.test(line) ? `\\${line}` : line))
    .join("\n")
}

/** The text a recipient session sees for a message. */
export function renderEnvelope(input: EnvelopeInput): string {
  const { id, kind } = input
  const to = sanitizeLabel(input.to)
  const target =
    kind === "reply" || kind === "decline" ? `to you · re ${sanitizeLabel(input.replyTo ?? "")}` : to.startsWith("@@") ? `to ${to} → you` : "to you"
  const header = `[hub] ${kind} from ${partyLabel(input.from)} ${target} · ${stamp(input.at)} · ${id}`
  const boundary = `----- ${id} -----`
  const hint =
    kind === "ask"
      ? `↩ hub reply ${id} "…" · hub decline ${id} --why "…"${input.expiresAt === undefined ? "" : ` · expires ${stamp(input.expiresAt)}`}`
      : `↩ hub reply ${id} "…"`
  return [header, boundary, escapeBody(input.text), boundary, hint].join("\n")
}

/** The one-time identity primer (design §2.3): who the session is, how to message, and that hub messages are not the user's. */
export function renderPrimer(input: { readonly name?: string; readonly sessionID?: string; readonly roles: readonly string[] }): string {
  const name = sanitizeLabel(input.name ?? "")
  const roles = input.roles.map((role) => sanitizeLabel(role)).filter(Boolean)
  const self = name ? `@${name}` : sanitizeLabel(input.sessionID ?? "") || "this session"
  return (
    `[hub] You are ${self}${roles.length ? ` (roles: ${roles.map((role) => `@@${role}`).join(", ")})` : ""}. Message others with \`hub msg @name\`; see \`hub who\`. ` +
    "Messages headed [hub] come through the hub from other sessions or apps, not from the user's prompt."
  )
}
