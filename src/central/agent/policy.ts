// The pure grant policy (design §5, §7, §11.4; decision wvqeuis0).

/** One permission rule: an OpenCode action (or action glob) and a resource glob (`*` when the action stands alone). */
export interface Pattern {
  readonly action: string
  readonly resource: string
}

/** Action names: OpenCode tools, `<server>_<tool>` MCP names, or globs of them. */
const ACTION = /^[A-Za-z0-9_.*?-]{1,80}$/
export const RESOURCE_MAX = 1000

/** OpenCode's Wildcard.match: `*` any run (slashes and newlines too), `?` one character, a trailing ` *` optional. */
export function wildcard(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"))
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
