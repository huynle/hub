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

/** A glob's forms under the optional trailing ` *`: `git push *` is `git push` or `git push *`. */
const forms = (glob: string): string[] => {
  const g = glob.replaceAll("\\", "/")
  return g.endsWith(" *") ? [g.slice(0, -2), g] : [g]
}

/** Whether some string matches both globs (`*` any run, `?` one character). */
export function globsOverlap(a: string, b: string): boolean {
  return forms(a).some((x) => forms(b).some((y) => overlap([...x], [...y])))
}

function overlap(a: string[], b: string[]): boolean {
  const memo = new Map<number, boolean>()
  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j
    const known = memo.get(key)
    if (known !== undefined) return known
    let result: boolean
    if (i === a.length && j === b.length) result = true
    else if (a[i] === "*") result = go(i + 1, j) || (j < b.length && go(i, j + 1))
    else if (b[j] === "*") result = go(i, j + 1) || (i < a.length && go(i + 1, j))
    else if (i === a.length || j === b.length) result = false
    else result = (a[i] === "?" || b[j] === "?" || a[i] === b[j]) && go(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return go(0, 0)
}

/** Whether every string the save glob matches also matches the allow glob (a sound, not complete, check). */
export function globCovers(allow: string, save: string): boolean {
  return forms(save).every((s) => forms(allow).some((a) => covers([...a], [...s])))
}

function covers(allow: string[], save: string[]): boolean {
  const memo = new Map<number, boolean>()
  const go = (i: number, j: number): boolean => {
    const key = i * (save.length + 1) + j
    const known = memo.get(key)
    if (known !== undefined) return known
    let result: boolean
    if (i === allow.length && j === save.length) result = true
    else if (allow[i] === "*") result = go(i + 1, j) || (j < save.length && go(i, j + 1))
    else if (i === allow.length || j === save.length) result = false
    else if (allow[i] === "?") result = save[j] !== "*" && go(i + 1, j + 1)
    else result = save[j] !== "*" && save[j] !== "?" && allow[i] === save[j] && go(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return go(0, 0)
}

/** A permission request as OpenCode asks it (permission.asked). */
export interface PermissionRequest {
  readonly action: string
  readonly resources: readonly string[]
  /** What an `always` reply saves as rules. */
  readonly save?: readonly string[]
}

export interface PermissionRules {
  readonly allow: readonly Pattern[]
  readonly never: readonly Pattern[]
}

export interface PermissionContext {
  readonly grant: PermissionRules
  /** The hub-wide `agents.never` (hub.json), checked first. */
  readonly hubNever?: readonly Pattern[]
  /** The agent replies `always` (saving the request's save patterns). */
  readonly always?: boolean
  /** The grant lets its holder reply `always`. */
  readonly allowAlways?: boolean
}

export type PermissionVerdict =
  | { readonly verdict: "allow" }
  /** A never rule hit a resource or save pattern (subject): the agent may not answer; the user still may. */
  | { readonly verdict: "never"; readonly by: "hub" | "grant"; readonly pattern: Pattern; readonly subject: string }
  /** Not covered by the grant: needs_user. */
  | { readonly verdict: "outside"; readonly reason: string }

/** The shell metacharacters a shell allow rule must spell out (`$(`, backticks, redirections). */
const SHELL_META = /\$\(|[`<>]/

/**
 * The grant policy for one permission request: hub never, then grant never (on every resource and, for
 * `always`, every save pattern), then allow (every resource, and every save pattern for `always`).
 */
export function evaluatePermission(request: PermissionRequest, context: PermissionContext): PermissionVerdict {
  const action = normaliseAction(request.action)
  const save = context.always ? (request.save ?? []) : []
  const subjects = request.resources.length > 0 ? request.resources : [""]
  const nevers: Array<["hub" | "grant", readonly Pattern[]]> = [
    ["hub", context.hubNever ?? []],
    ["grant", context.grant.never],
  ]
  for (const [by, list] of nevers) {
    for (const pattern of list) {
      if (!wildcard(action, pattern.action)) continue
      const subject = subjects.find((r) => wildcard(r, pattern.resource)) ?? save.find((s) => globsOverlap(pattern.resource, s))
      if (subject !== undefined) return { verdict: "never", by, pattern, subject }
    }
  }
  if (request.resources.length === 0) return { verdict: "outside", reason: "The request names no resources" }
  const denied = request.resources.find((r) => !context.grant.allow.some((pattern) => allowsResource(pattern, action, r)))
  if (denied !== undefined) return { verdict: "outside", reason: `${action} ${denied} is outside the grant` }
  if (!context.always) return { verdict: "allow" }
  if (!context.allowAlways) return { verdict: "outside", reason: "The grant does not allow always" }
  if (save.length === 0) return { verdict: "outside", reason: "The request has nothing to save for always" }
  const broad = save.find((s) => !context.grant.allow.some((pattern) => savedBy(pattern, action, s)))
  if (broad !== undefined) return { verdict: "outside", reason: `Always would save ${action} ${broad}, broader than the grant` }
  return { verdict: "allow" }
}

/** An allow rule covers a save pattern (shell save patterns with metacharacters only word for word). */
function savedBy(pattern: Pattern, action: string, save: string): boolean {
  if (!wildcard(action, pattern.action)) return false
  if (action === "shell" && SHELL_META.test(save)) return pattern.resource === save
  return globCovers(pattern.resource, save)
}
