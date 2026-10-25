// @name / @@role addressing (design §2.1): name and role syntax and address parsing. Pure; shared by the hub
// (src/central/agent/names.ts re-exports it) and the plugin's prompt-reference hook.

/** Names and roles: lowercase letters, digits and dashes, 2–40 characters. */
export const NAME_MAX = 40
const NAME = /^[a-z0-9-]{2,40}$/

export const validName = (name: string): boolean => NAME.test(name)

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
