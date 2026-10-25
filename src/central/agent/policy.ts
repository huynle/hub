// The pure grant policy (design §5, §7, §11.4; decision wvqeuis0). No state, no I/O: grants.ts stores grants and
// checks tenancy, acting.ts runs the check order; this module answers "does this rule cover this request?".
// - Patterns `action[:glob]` (`bash` is OpenCode's `shell`; the action alone means every resource), matched with
//   OpenCode's Wildcard semantics (`*` any run, `?` one character, a trailing ` *` optional).
// - A request is allowed only if every resource is; never (hub `agents.never`, then the grant's) beats allow, and
//   for an `always` reply also covers the save patterns, which must lie inside the allow rules.
// - Shell allow rules: `$(`, backticks and `<`/`>` in a resource must be written literally, never matched by a wildcard.
// - Escalation tiers are the hub's: tap for shell, external_directory, MCP/unknown tools and near-never requests.
// - Grant schema: verbs (launch included, phase 4), permissions, expires (1 minute–30 days), maxActionsPerHour,
//   allowAlways; children stays deferred. Project scopes are canonical paths matched on path boundaries.

import type { Tier } from "./decisions"
import { AgentError } from "./errors"
import { isReservedName, isReservedRole, parseAddress } from "./names"

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

/** OpenCode's built-in tools a console confirm may answer; everything else (shell, external_directory, MCP, unknown) is tap. */
const CONFIRM_ACTIONS: ReadonlySet<string> = new Set(["read", "edit", "write", "glob", "grep", "list", "lsp", "webfetch", "websearch", "codesearch", "task", "skill", "todowrite", "todoread", "question"])

/** The literal text of a glob before its first wildcard; at least 3 characters to count. */
const NEAR_MIN = 3
const literalPrefix = (glob: string): string => glob.replaceAll("\\", "/").split(/[*?]/, 1)[0]!.trim()

/** A never rule hits, or nearly hits, the request: a resource matches or contains its literal text, a save pattern overlaps it. */
function nearNever(action: string, request: PermissionRequest, never: readonly Pattern[]): boolean {
  return never.some((pattern) => {
    if (!wildcard(action, pattern.action)) return false
    const literal = literalPrefix(pattern.resource)
    const near = (r: string) => wildcard(r, pattern.resource) || (literal.length >= NEAR_MIN && r.replaceAll("\\", "/").includes(literal))
    return request.resources.some(near) || (request.save ?? []).some((s) => globsOverlap(pattern.resource, s))
  })
}

/**
 * The tier of an escalation (decision wvqeuis0 §7): `tap` for shell, external_directory, MCP (and unknown)
 * tools and anything near a never rule (hub and grant); `confirm` otherwise. The hub sets it, never the agent.
 */
export function riskTier(request: PermissionRequest, never: readonly Pattern[]): Tier {
  const action = normaliseAction(request.action)
  if (!CONFIRM_ACTIONS.has(action)) return "tap"
  return nearNever(action, request, never) ? "tap" : "confirm"
}

export const PROJECT_PATH_MAX = 1024
const DRIVE = /^[A-Za-z]:\//

/**
 * A project directory as a grant scope compares it: absolute (POSIX or a Windows drive), `/` separators,
 * `.`/`..`/repeated slashes resolved, no trailing slash; undefined for relative, `~`, root or malformed paths.
 * Pure text: symlinks are not resolved (the directories live on the spokes' machines).
 */
export function canonicalProject(path: string): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.length > PROJECT_PATH_MAX || path.includes("\0")) return undefined
  const slashed = path.replaceAll("\\", "/")
  const drive = DRIVE.test(slashed) ? slashed.slice(0, 2) : ""
  const rest = drive ? slashed.slice(2) : slashed
  if (!rest.startsWith("/")) return undefined
  const segments: string[] = []
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return undefined
      segments.pop()
    } else segments.push(segment)
  }
  return segments.length === 0 ? undefined : `${drive}/${segments.join("/")}`
}

/** Whether a session directory is one of the projects or inside one (on a path boundary, after canonicalising). */
export function inProjects(dir: string, projects: readonly string[]): boolean {
  const canonical = canonicalProject(dir)
  if (canonical === undefined) return false
  return projects.some((project) => {
    const root = canonicalProject(project)
    return root !== undefined && (canonical === root || canonical.startsWith(`${root}/`))
  })
}

/** A Pattern as text: the action alone when it covers every resource, else `action:glob`. */
export const formatPattern = (pattern: Pattern): string => (pattern.resource === "*" ? pattern.action : `${pattern.action}:${pattern.resource}`)

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** A duration in ms: a number of seconds (as elsewhere in the agent API) or `<n>s|m|h|d`; undefined when malformed. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : undefined
  if (typeof value !== "string") return undefined
  const match = /^(\d{1,9})([smhd])$/.exec(value)
  return match ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] : undefined
}

// ---------- grants ----------

/** What a grant may let its holder do (`launch`, phase 4, starts sessions in the grant's projects). */
export const GRANT_VERBS = ["approve", "deny", "answer", "prompt", "stop", "roles", "launch"] as const
export type GrantVerb = (typeof GRANT_VERBS)[number]

export const GRANT_DEFAULT_EXPIRES_MS = 8 * 3_600_000
export const GRANT_EXPIRES_MIN_MS = 60_000
export const GRANT_EXPIRES_MAX_MS = 30 * 86_400_000
export const GRANT_DEFAULT_MAX_ACTIONS_PER_HOUR = 60
export const GRANT_MAX_ACTIONS_PER_HOUR = 1000
export const GRANT_PROJECTS_MAX = 20
export const GRANT_PATTERNS_MAX = 100

/** A validated grant as the user wrote it (holder, scope and tenancy are checked against the user's world by grants.ts). */
export interface GrantSpec {
  /** `@@role` (a reserved role), `@name`, `ses_…` or `app:<token id>`. */
  readonly holder: string
  readonly scope: { readonly projects: readonly string[] }
  readonly allow: readonly GrantVerb[]
  /** Canonical pattern texts (formatPattern). */
  readonly permissions: { readonly allow: readonly string[]; readonly never: readonly string[] }
  /** The holder may reply `always` (still only when every save pattern passes the policy). */
  readonly allowAlways: boolean
  readonly expiresInMs: number
  readonly maxActionsPerHour: number
}

const GRANT_FIELDS = ["holder", "scope", "allow", "permissions", "expires", "maxActionsPerHour", "allowAlways"]
const APP_HOLDER = /^app:[0-9a-f]{16}$/
const DEFERRED = ["children"]

const invalid = (message: string) => new AgentError("invalid", message)
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function onlyFields(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (DEFERRED.includes(key)) throw invalid(`${what}.${key} is not available yet (phase 4)`)
    if (!allowed.includes(key)) throw invalid(`Unknown ${what} field ${key}`)
  }
}

function validHolder(value: unknown): string {
  if (typeof value === "string" && APP_HOLDER.test(value)) return value
  const address = typeof value === "string" ? parseAddress(value) : undefined
  if (!address || (address.kind === "name" && isReservedName(address.name))) throw invalid("holder is @@role, @name, ses_… or app:<token id>")
  if (address.kind === "role" && !isReservedRole(address.role)) throw invalid("A role holder must be a reserved role (such as @@orchestrator)")
  return value as string
}

function validProjects(value: unknown): string[] {
  if (!isObject(value)) throw invalid("scope is an object {projects: [...]}")
  onlyFields(value, ["projects"], "scope")
  const raw = value.projects
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > GRANT_PROJECTS_MAX) throw invalid(`scope.projects lists 1–${GRANT_PROJECTS_MAX} project directories`)
  const projects: string[] = []
  for (const item of raw) {
    const canonical = canonicalProject(item as string)
    if (canonical === undefined) throw invalid(`scope.projects: ${String(item)} is not an absolute project directory`)
    if (!projects.includes(canonical)) projects.push(canonical)
  }
  return projects
}

function validVerbs(value: unknown): GrantVerb[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid(`allow lists the verbs: ${GRANT_VERBS.join(", ")}`)
  const verbs: GrantVerb[] = []
  for (const verb of value) {
    if (!GRANT_VERBS.includes(verb)) throw invalid(`allow: unknown verb ${String(verb)}`)
    if (!verbs.includes(verb)) verbs.push(verb)
  }
  return verbs
}

function validPatterns(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > GRANT_PATTERNS_MAX) throw invalid(`${what} lists at most ${GRANT_PATTERNS_MAX} patterns`)
  const out: string[] = []
  for (const item of value) {
    const pattern = parsePattern(item)
    if (!pattern) throw invalid(`${what}: ${String(item)} is not an action[:glob] pattern`)
    const text = formatPattern(pattern)
    if (!out.includes(text)) out.push(text)
  }
  return out
}

/** Validates a grant the user creates or edits; throws AgentError invalid. Holder and scope tenancy are the caller's. */
export function validateGrant(input: unknown): GrantSpec {
  if (!isObject(input)) throw invalid("A grant is an object")
  onlyFields(input, GRANT_FIELDS, "grant")
  const holder = validHolder(input.holder)
  const projects = validProjects(input.scope)
  const allow = validVerbs(input.allow)
  let permissions: GrantSpec["permissions"] = { allow: [], never: [] }
  if (input.permissions !== undefined) {
    if (!isObject(input.permissions)) throw invalid("permissions is an object {allow?, never?}")
    onlyFields(input.permissions, ["allow", "never"], "permissions")
    permissions = { allow: validPatterns(input.permissions.allow, "permissions.allow"), never: validPatterns(input.permissions.never, "permissions.never") }
  }
  const expiresInMs = input.expires === undefined ? GRANT_DEFAULT_EXPIRES_MS : parseDuration(input.expires)
  if (expiresInMs === undefined || expiresInMs < GRANT_EXPIRES_MIN_MS || expiresInMs > GRANT_EXPIRES_MAX_MS) {
    throw invalid("expires is 1 minute to 30 days (seconds, or 30m, 8h, 2d)")
  }
  const cap = input.maxActionsPerHour ?? GRANT_DEFAULT_MAX_ACTIONS_PER_HOUR
  if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > GRANT_MAX_ACTIONS_PER_HOUR) {
    throw invalid(`maxActionsPerHour is a whole number 1–${GRANT_MAX_ACTIONS_PER_HOUR}`)
  }
  if (input.allowAlways !== undefined && typeof input.allowAlways !== "boolean") throw invalid("allowAlways is true or false")
  return { holder, scope: { projects }, allow, permissions, allowAlways: input.allowAlways === true, expiresInMs, maxActionsPerHour: cap as number }
}
