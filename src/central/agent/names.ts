// Pure helpers for @name / @@role addressing (design §2.1): OpenCode's placeholder titles, slugs, derived names,
// conflict suffixes, the reserved name and reserved roles. Name syntax and address parsing live in the SDK (packages/sdk/src/address.ts)
// and are re-exported here.

import { NAME_MAX, validName } from "../../../packages/sdk/src/address.ts"

export { NAME_MAX, parseAddress, validName, type Address } from "../../../packages/sdk/src/address.ts"

/**
 * OpenCode's fallback titles: "New session" / "Child session" (display labels) and the historical
 * timestamped "New session - <ISO>" (see @opencode/util session-title-fallback). Spokes list an untitled
 * session with an empty title.
 */
const FALLBACK = /^(New session|Child session)( - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/

/** A title the hub must not derive a name from (missing, blank or an OpenCode fallback). */
export const isPlaceholderTitle = (title: string | undefined): boolean => title === undefined || title.trim() === "" || FALLBACK.test(title.trim())

/** The slug of a title for a derived name: undefined when fewer than 2 usable characters remain. */
export function slugify(title: string): string | undefined {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/, "")
  return validName(slug) ? slug : undefined
}

/** `base` when free, else `base-2`, `base-3`, … (the base cut so the result stays a valid name). */
export function withSuffix(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const name = `${base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, "")}${suffix}`
    if (!taken(name)) return name
  }
}

/** `me` always addresses the user (@me), so no session may hold it, explicitly or derived. Only the exact name. */
export const isReservedName = (name: string): boolean => name === "me"

/** Roles only the user may claim in phase 1 (grants including `roles` come in phase 3). */
const RESERVED_ROLES = ["orchestrator", "concierge"]

export const isReservedRole = (role: string): boolean => RESERVED_ROLES.some((prefix) => role.startsWith(prefix))

/** The longest derived name: a few words, short enough to type and read in an address (@send-hello-to-session). */
export const DERIVED_NAME_MAX = 24
/** At most this many words of the title make a derived name. */
const DERIVED_WORDS_MAX = 4

/** Tokens that identify rather than describe (dropped from derived names): ses_…/msg_… IDs, UUIDs, hashes, long letter+digit runs. */
const ID_LIKE = [
  /^[a-z]{2,5}_[a-z0-9]{6,}$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=[a-f]*\d)[0-9a-f]{8,}$/i,
  /^(?=.*\d)(?=.*[a-z])[a-z0-9]{10,}$/i,
]
const isIDLike = (token: string): boolean => ID_LIKE.some((re) => re.test(token))

/**
 * The name derived from a session title: its first few meaningful words (ID-like tokens dropped), at most
 * DERIVED_WORDS_MAX words and DERIVED_NAME_MAX characters, cut at a word boundary (a single longer word is cut).
 * Undefined when fewer than 2 usable characters remain. Derived once per session (see directory.ts), so later
 * title changes never rename it.
 */
export function deriveName(title: string): string | undefined {
  const words = title
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => token && !isIDLike(token))
    .flatMap((token) => slugify(token)?.split("-") ?? (/^[a-z0-9]$/i.test(token) ? [token.toLowerCase()] : []))
  let name = ""
  for (const word of words.slice(0, DERIVED_WORDS_MAX)) {
    const next = name ? `${name}-${word}` : word
    if (next.length > DERIVED_NAME_MAX) {
      if (!name) name = word.slice(0, DERIVED_NAME_MAX)
      break
    }
    name = next
  }
  return validName(name) ? name : undefined
}
