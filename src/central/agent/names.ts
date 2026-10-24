// Pure helpers for @name / @@role addressing (design §2.1): name and role syntax, OpenCode's placeholder
// titles, slugs for derived names, conflict suffixes, reserved roles and address parsing.

/** Names and roles: lowercase letters, digits and dashes, 2–40 characters. */
export const NAME_MAX = 40
const NAME = /^[a-z0-9-]{2,40}$/

export const validName = (name: string): boolean => NAME.test(name)

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

/** Roles only the user may claim in phase 1 (grants including `roles` come in phase 3). */
const RESERVED_ROLES = ["orchestrator", "concierge"]

export const isReservedRole = (role: string): boolean => RESERVED_ROLES.some((prefix) => role.startsWith(prefix))

export type Address = { kind: "id"; id: string } | { kind: "name"; name: string; project?: string } | { kind: "role"; role: string; project?: string }

/** A project scope: any non-empty run of characters without dots, slashes or spaces, compared lowercased. */
const SCOPED = /^([a-z0-9-]{2,40})(?:\.([^./\s]+))?$/i

/** `ses_…` (an ID or ID prefix), `@name[.project]` or `@@role[.project]`; undefined when malformed. */
export function parseAddress(addr: string): Address | undefined {
  if (addr.startsWith("ses_")) return /^ses_[A-Za-z0-9]+$/.test(addr) ? { kind: "id", id: addr } : undefined
  const role = addr.startsWith("@@")
  if (!role && !addr.startsWith("@")) return undefined
  const match = SCOPED.exec(addr.slice(role ? 2 : 1))
  if (!match || !validName(match[1]!)) return undefined
  const project = match[2]?.toLowerCase()
  const scope = project ? { project } : {}
  return role ? { kind: "role", role: match[1]!, ...scope } : { kind: "name", name: match[1]!, ...scope }
}
