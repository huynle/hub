// The node's settings and credentials. node.json (decision 6) sits next to the spoke's config.json, in the same
// directory (~/.config/hub, or wherever HUB_SPOKE_CONFIG points): the spoke's normalize() drops fields it does not
// know, so node settings never live in config.json. The node reads config.json only for the hub URL and the
// machine token (spoke and node share one machine record) and never writes it.
//
// node.json: { "workspaceRoots": ["/Users/huy/projects"], "labels": {"gpu": "no"}, "slots": 6, "memoryMB": 49152,
//   "openshell": { "enabled": true, "gateway": "openshell", "image": "ghcr.io/huynle/hub-sandbox:0.1",
//                  "profiles": { "untrusted-code": { "providers": ["anthropic"] } } },
//   "harnesses": { "claude-code": false } }
// `harnesses` overrides what the host runtime detects (harnesses.ts): true offers a harness, false withholds it.
import { readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import path from "node:path"
import { isAbsolutePath, labelsProblem, NODE_ROOTS_MAX, NODE_SLOTS_MAX } from "../../protocol/src/index.ts"
import { normalizeOpenShellProfiles, type OpenShellProfiles } from "../../runtime-openshell/src/profiles.ts"
import { configPath, readConfig } from "../../../src/config.ts"

type Env = Readonly<Record<string, string | undefined>>

export const NODE_CONFIG_FILE = "node.json"
/** Concurrent launches when node.json sets no `slots`. */
export const DEFAULT_SLOTS = 4
const MEMORY_MB_MAX = 2 ** 31
const GATEWAY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/
/** A harness id as hellos and launch specs spell it. */
const HARNESS = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface NodeConfig {
  /** Every launch workspace must resolve (realpath) under one of these. Empty: the node prepares nothing. */
  readonly workspaceRoots: readonly string[]
  /** Labels the node adds to its own (os, arch); placement matches on them. */
  readonly labels: Readonly<Record<string, string>>
  readonly slots: number
  readonly memoryMB?: number
  /** The `openshell` runtime's settings; absent when node.json has no openshell section. */
  readonly openshell?: OpenShellNodeConfig
  /** Per-harness overrides of detection (true: offer it, false: withhold it); absent: detection alone. */
  readonly harnesses?: Readonly<Record<string, boolean>>
}

/** node.json `openshell`: whether the node offers sandboxes, through which gateway, with which image and profiles. */
export interface OpenShellNodeConfig {
  readonly enabled: boolean
  /** An OpenShell gateway name (`--gateway`); default: the CLI's active gateway. */
  readonly gateway?: string
  /** The image for profiles without their own (default: the runtime's). */
  readonly image?: string
  readonly profiles: OpenShellProfiles
}

/** A config and what was wrong with the input (each bad field is dropped, with one problem line). */
export interface NodeConfigResult {
  readonly config: NodeConfig
  readonly problems: readonly string[]
}

/** node.json in the spoke config's directory: ~/.config/hub/node.json, or next to $HUB_SPOKE_CONFIG. */
export function nodeConfigPath(env: Env = process.env, home: string = homedir()): string {
  return path.join(path.dirname(configPath(env, home)), NODE_CONFIG_FILE)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 80) ?? String(v)

/** Normalizes untrusted node.json content, field by field. */
export function normalizeNodeConfig(raw: unknown): NodeConfigResult {
  const problems: string[] = []
  let r: Record<string, unknown> = {}
  if (isObject(raw)) r = raw
  else if (raw !== undefined) problems.push("node.json must hold a JSON object")

  const workspaceRoots: string[] = []
  if (r.workspaceRoots !== undefined && !Array.isArray(r.workspaceRoots)) problems.push("workspaceRoots must be a list of absolute paths")
  for (const root of Array.isArray(r.workspaceRoots) ? r.workspaceRoots : []) {
    if (!isAbsolutePath(root) || root === "/") {
      problems.push(`workspaceRoots: ${show(root)} is not an absolute path (without . or .. segments, and not /)`)
      continue
    }
    const clean = root.replace(/\/+$/, "")
    if (!workspaceRoots.includes(clean)) workspaceRoots.push(clean)
  }
  if (workspaceRoots.length > NODE_ROOTS_MAX) {
    problems.push(`workspaceRoots: at most ${NODE_ROOTS_MAX} roots; the rest are ignored`)
    workspaceRoots.length = NODE_ROOTS_MAX
  }

  let labels: Record<string, string> = {}
  if (r.labels !== undefined) {
    const problem = labelsProblem(r.labels)
    if (problem) problems.push(`labels: ${problem}`)
    else labels = { ...(r.labels as Record<string, string>) }
  }

  let slots = DEFAULT_SLOTS
  if (r.slots !== undefined) {
    if (whole(r.slots, 1, NODE_SLOTS_MAX)) slots = r.slots
    else problems.push(`slots must be a whole number from 1 to ${NODE_SLOTS_MAX}`)
  }

  let memoryMB: number | undefined
  if (r.memoryMB !== undefined) {
    if (whole(r.memoryMB, 1, MEMORY_MB_MAX)) memoryMB = r.memoryMB
    else problems.push("memoryMB must be a positive whole number")
  }

  const openshell = r.openshell === undefined ? undefined : normalizeOpenShell(r.openshell, problems)
  const harnesses = r.harnesses === undefined ? undefined : normalizeHarnesses(r.harnesses, problems)

  return {
    config: { workspaceRoots, labels, slots, ...(memoryMB !== undefined ? { memoryMB } : {}), ...(openshell ? { openshell } : {}), ...(harnesses ? { harnesses } : {}) },
    problems,
  }
}

function normalizeHarnesses(raw: unknown, problems: string[]): Record<string, boolean> | undefined {
  if (!isObject(raw)) {
    problems.push("harnesses must be an object of harness names to true or false")
    return undefined
  }
  const out: Record<string, boolean> = {}
  for (const [name, on] of Object.entries(raw)) {
    if (!HARNESS.test(name)) problems.push(`harnesses: ${show(name)} is not a harness name`)
    else if (typeof on !== "boolean") problems.push(`harnesses.${name} must be true or false`)
    else out[name] = on
  }
  return out
}

function normalizeOpenShell(raw: unknown, problems: string[]): OpenShellNodeConfig | undefined {
  if (!isObject(raw)) {
    problems.push("openshell must be an object")
    return undefined
  }
  let enabled = false
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") enabled = raw.enabled
    else problems.push("openshell.enabled must be true or false")
  }
  let gateway: string | undefined
  if (raw.gateway !== undefined) {
    if (typeof raw.gateway === "string" && GATEWAY.test(raw.gateway)) gateway = raw.gateway
    else problems.push(`openshell.gateway: ${show(raw.gateway)} is not a gateway name`)
  }
  let image: string | undefined
  if (raw.image !== undefined) {
    if (typeof raw.image === "string" && IMAGE.test(raw.image)) image = raw.image
    else problems.push(`openshell.image: ${show(raw.image)} is not an image reference`)
  }
  const profiles = normalizeOpenShellProfiles(raw.profiles)
  problems.push(...profiles.problems)
  return { enabled, ...(gateway ? { gateway } : {}), ...(image ? { image } : {}), profiles }
}

/** Reads node.json; a missing file is the defaults, unreadable or bad JSON the defaults with a problem. */
export function readNodeConfig(file: string): NodeConfigResult {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return normalizeNodeConfig(undefined)
    return { config: normalizeNodeConfig(undefined).config, problems: [`${file}: cannot read (${(cause as Error).message})`] }
  }
  try {
    return normalizeNodeConfig(JSON.parse(text))
  } catch {
    return { config: normalizeNodeConfig(undefined).config, problems: [`${file}: not valid JSON`] }
  }
}

/** What the node connects with: the hub URL, the machine token and the machine ID, from the spoke's config.json. */
export interface SpokeCredentials {
  readonly server: string
  readonly token: string
  readonly machineID?: string
}

/** The enrolled machine's credentials from config.json (read-only), or undefined when it holds no token. */
export function readSpokeCredentials(env: Env = process.env, home: string = homedir()): SpokeCredentials | undefined {
  const config = readConfig(configPath(env, home), hostname())
  if (!config.token) return undefined
  return { server: config.server, token: config.token, ...(config.machineID ? { machineID: config.machineID } : {}) }
}
