// The message envelope (design §3.3): the pure renderer and sanitiser live in the SDK (packages/sdk/src/envelope.ts,
// shared with the plugin's hub tool and `hub mcp`) and are re-exported here; the hub adds the sender derived only
// from the authenticated actor (partyFromActor) and the party keys of its indexes.
import type { Party } from "../../../packages/sdk/src/types.ts"
import { sanitizeLabel } from "../../../packages/sdk/src/envelope.ts"
import type { AgentActor } from "./actor"

export { LABEL_MAX, partyLabel, renderEnvelope, renderPrimer, sanitizeLabel, sanitizeText, type EnvelopeInput, type EnvelopeKind } from "../../../packages/sdk/src/envelope.ts"
export type { Party } from "../../../packages/sdk/src/types.ts"

/** Directory facts for a session sender's label (never taken from a request body). */
export interface PartyInfo {
  readonly name?: string
  readonly harness?: string
  readonly machine?: string
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

