// Pure helpers for @name / @@role addressing (design §2.1): OpenCode's placeholder titles, slugs for derived names,
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
