// Hub profiles for OpenShell sandboxes (decision lk6gn3u7 §2, §4, §9): node.json `openshell.profiles`, a map of
// profile name to { image?, providers?, endpoints?, allowGitRemote? }. Phase 5 keeps them on the node; a hub-side
// profile store comes later. They are not OpenShell's own (credential) profiles: `providers` names OpenShell
// providers the node operator created, and the sandbox only ever sees their placeholders.
//
// Normalized field by field like the rest of node.json: a bad field is dropped with one problem line. A profile
// that asks for what the vm backend cannot honour (host mounts, cpu, memory) is never used in a weaker form: it is
// listed as unsupported and a launch naming it fails `unsupported`.
//
// node.json: { "openshell": { "profiles": { "untrusted-code": { "image": "hub-sandbox:0.1",
//   "providers": ["anthropic"], "endpoints": ["registry.npmjs.org:443"], "allowGitRemote": false } } } }
import { token } from "../../protocol/src/wire.ts"
import { RuntimeError } from "../../runtime-sdk/src/index.ts"

/** The profile a launch without `runtime.profile` gets; built in (deny all but the hub) unless node.json sets it. */
export const DEFAULT_PROFILE = "default"
export const PROFILES_MAX = 32
export const ENDPOINTS_MAX = 64
const NAME_MAX = 64
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const KNOWN_FIELDS = new Set(["image", "providers", "endpoints", "allowGitRemote"])
/** Fields the vm backend cannot honour (decision 9), in the order the reason lists them. */
const UNSUPPORTED_FIELDS = ["mounts", "cpu", "memoryMB", "memory"] as const

/** An egress destination a profile adds to the policy. */
export interface EgressEndpoint {
  readonly host: string
  readonly port: number
}

export interface OpenShellProfile {
  readonly name: string
  /** The sandbox image; unset: the runtime's default image. */
  readonly image?: string
  /** OpenShell provider names attached to the sandbox (model keys, injected by OpenShell's proxy). */
  readonly providers: readonly string[]
  /** Extra egress beyond the hub (and the providers' own endpoints). */
  readonly endpoints: readonly EgressEndpoint[]
  /** Allow egress to the launch's git remote (pushing from inside is a later opt-in; off by default). */
  readonly allowGitRemote: boolean
}

export interface OpenShellProfiles {
  readonly profiles: Readonly<Record<string, OpenShellProfile>>
  /** Profile name → why it cannot be used on this node. */
  readonly unsupported: Readonly<Record<string, string>>
  readonly problems: readonly string[]
}

/** A launch named a profile this node does not have (`not_found`) or cannot honour (`unsupported`). */
export class ProfileError extends RuntimeError {
  constructor(
    readonly code: "unsupported" | "not_found",
    message: string,
  ) {
    super(message)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 80) ?? String(v)
const builtinDefault = (): OpenShellProfile => ({ name: DEFAULT_PROFILE, providers: [], endpoints: [], allowGitRemote: false })

/** A hostname (lowercase), or a wildcard host OpenShell accepts: `*` or `**` as the first of at least three labels. */
export function egressHost(v: string): string | undefined {
  const host = v.toLowerCase()
  if (host.length > 253) return undefined
  const labels = host.split(".")
  const [first, ...rest] = labels
  const wildcard = first === "*" || first === "**"
  if (wildcard && labels.length < 3) return undefined
  return (wildcard ? rest : labels).every((label) => LABEL.test(label)) ? host : undefined
}

const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535

/** "host:port" or { host, port }. */
function egressEndpoint(v: unknown): EgressEndpoint | undefined {
  let host: unknown
  let port: unknown
  if (typeof v === "string") {
    const colon = v.lastIndexOf(":")
    if (colon < 0 || !/^\d{1,5}$/.test(v.slice(colon + 1))) return undefined
    host = v.slice(0, colon)
    port = Number(v.slice(colon + 1))
  } else if (isObject(v)) {
    host = v.host
    port = v.port
  }
  if (typeof host !== "string" || !isPort(port)) return undefined
  const clean = egressHost(host)
  return clean ? { host: clean, port } : undefined
}

function normalizeProfile(name: string, r: Record<string, unknown>, problems: string[]): OpenShellProfile {
  const at = `openshell.profiles.${name}`
  for (const key of Object.keys(r)) if (!KNOWN_FIELDS.has(key)) problems.push(`${at}: unknown field ${show(key)} ignored`)

  let image: string | undefined
  if (r.image !== undefined) {
    if (typeof r.image === "string" && IMAGE.test(r.image)) image = r.image
    else problems.push(`${at}.image: ${show(r.image)} is not an image reference`)
  }

  const providers: string[] = []
  if (r.providers !== undefined && !Array.isArray(r.providers)) problems.push(`${at}.providers must be a list of provider names`)
  for (const provider of Array.isArray(r.providers) ? r.providers : []) {
    if (!token(provider, NAME_MAX)) problems.push(`${at}.providers: ${show(provider)} is not a provider name`)
    else if (!providers.includes(provider)) providers.push(provider)
  }

  const endpoints: EgressEndpoint[] = []
  if (r.endpoints !== undefined && !Array.isArray(r.endpoints)) problems.push(`${at}.endpoints must be a list of host:port`)
  for (const raw of Array.isArray(r.endpoints) ? r.endpoints : []) {
    const endpoint = egressEndpoint(raw)
    if (!endpoint) problems.push(`${at}.endpoints: ${show(raw)} is not host:port`)
    else if (!endpoints.some((e) => e.host === endpoint.host && e.port === endpoint.port)) endpoints.push(endpoint)
  }
  if (endpoints.length > ENDPOINTS_MAX) {
    problems.push(`${at}.endpoints: at most ${ENDPOINTS_MAX} endpoints; the rest are ignored`)
    endpoints.length = ENDPOINTS_MAX
  }

  let allowGitRemote = false
  if (r.allowGitRemote !== undefined) {
    if (typeof r.allowGitRemote === "boolean") allowGitRemote = r.allowGitRemote
    else problems.push(`${at}.allowGitRemote must be true or false`)
  }

  return { name, ...(image !== undefined ? { image } : {}), providers, endpoints, allowGitRemote }
}

/** Normalizes untrusted node.json `openshell.profiles`; the default profile is always there unless unsupported. */
export function normalizeOpenShellProfiles(raw: unknown): OpenShellProfiles {
  const problems: string[] = []
  const profiles: Record<string, OpenShellProfile> = { [DEFAULT_PROFILE]: builtinDefault() }
  const unsupported: Record<string, string> = {}
  if (raw !== undefined && !isObject(raw)) problems.push("openshell.profiles must be an object of profile name to profile")

  let entries = Object.entries(isObject(raw) ? raw : {})
  if (entries.length > PROFILES_MAX) {
    problems.push(`openshell.profiles: at most ${PROFILES_MAX} profiles; the rest are ignored`)
    entries = entries.slice(0, PROFILES_MAX)
  }
  for (const [name, value] of entries) {
    if (!token(name, NAME_MAX)) {
      problems.push(`openshell.profiles: ${show(name)} is not a profile name (lowercase letters, digits, . _ -; at most ${NAME_MAX})`)
      continue
    }
    if (!isObject(value)) {
      problems.push(`openshell.profiles.${name} must be an object`)
      continue
    }
    const asked = UNSUPPORTED_FIELDS.filter((field) => value[field] !== undefined)
    if (asked.length > 0) {
      const reason = `profile ${name} sets ${asked.join(", ")}, which the OpenShell vm backend does not support`
      unsupported[name] = reason
      delete profiles[name]
      problems.push(`openshell.profiles.${name}: unsupported (${reason})`)
      continue
    }
    profiles[name] = normalizeProfile(name, value, problems)
  }
  return { profiles, unsupported, problems }
}

/** The profile a launch asked for (or the default); ProfileError when it is unknown or unsupported here. */
export function selectProfile(set: OpenShellProfiles, name: string | undefined): OpenShellProfile {
  const wanted = name ?? DEFAULT_PROFILE
  const reason = set.unsupported[wanted]
  if (reason !== undefined) throw new ProfileError("unsupported", reason)
  const profile = set.profiles[wanted]
  if (!profile) throw new ProfileError("not_found", `this node has no OpenShell profile ${wanted}`)
  return profile
}

/** Usable profile names, sorted: what the node's hello reports for the openshell runtime. */
export function profileNames(set: OpenShellProfiles): string[] {
  return Object.keys(set.profiles).sort()
}
