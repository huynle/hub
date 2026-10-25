// The pure grant policy (design §5, §7, §11.4; decision wvqeuis0).

/** One permission rule: an OpenCode action (or action glob) and a resource glob (`*` when the action stands alone). */
export interface Pattern {
  readonly action: string
  readonly resource: string
}

/** Action names: OpenCode tools, `<server>_<tool>` MCP names, or globs of them. */
const ACTION = /^[A-Za-z0-9_.*?-]{1,80}$/
export const RESOURCE_MAX = 1000

/** What a wildcard may consume: any character, or (for shell allow rules) anything but `$(`, backticks and redirections. */
const ANY = "."
const SHELL_SAFE = "(?:[^`<>$(]|\\$(?!\\()|(?<!\\$)\\()"

function globRegex(pattern: string, any: string): RegExp {
  const glob = pattern.replaceAll("\\", "/")
  const optionalTail = glob.endsWith(" *")
  const body = optionalTail ? glob.slice(0, -2) : glob
  const source = [...body].map((c) => (c === "*" ? `${any}*` : c === "?" ? any : c.replace(/[.+^${}()|[\]\\/]/g, "\\$&"))).join("")
  return new RegExp(`^${source}${optionalTail ? `( ${any}*)?` : ""}$`, "s")
}

/** OpenCode's Wildcard.match: `*` any run (slashes and newlines too), `?` one character, a trailing ` *` optional. */
export function wildcard(input: string, pattern: string): boolean {
  return globRegex(pattern, ANY).test(input.replaceAll("\\", "/"))
}

/** OpenCode v2 calls the shell tool `shell`; `bash` is accepted as its old name. */
const normaliseAction = (action: string): string => (action === "bash" ? "shell" : action)

/** `action[:glob]` → a Pattern; undefined when malformed. */
export function parsePattern(text: string): Pattern | undefined {
  if (typeof text !== "string" || text !== text.trim()) return undefined
  const colon = text.indexOf(":")
  const action = colon < 0 ? text : text.slice(0, colon)
  const resource = colon < 0 ? "*" : text.slice(colon + 1)
  if (!ACTION.test(action) || resource === "" || resource.length > RESOURCE_MAX) return undefined
  return { action: normaliseAction(action), resource }
}

/** True when the shell resource matches the glob with every `$(`, backtick and redirection written literally. */
const shellWildcard = (input: string, pattern: string): boolean => globRegex(pattern, SHELL_SAFE).test(input.replaceAll("\\", "/"))

/** An allow rule covers this request resource (shell metacharacters are never a wildcard's). */
export function allowsResource(pattern: Pattern, action: string, resource: string): boolean {
  const normalised = normaliseAction(action)
  if (!wildcard(normalised, pattern.action)) return false
  return normalised === "shell" ? shellWildcard(resource, pattern.resource) : wildcard(resource, pattern.resource)
}

/** A never rule hits this request resource (plain wildcards: nothing escapes a never). */
export function forbidsResource(pattern: Pattern, action: string, resource: string): boolean {
  return wildcard(normaliseAction(action), pattern.action) && wildcard(resource, pattern.resource)
}
