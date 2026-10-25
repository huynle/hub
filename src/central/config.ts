// Hub configuration: HUB_* environment variables (legacy VOICE_* still read, see ../env.ts) over the
// optional hub config file (~/.config/hub/hub.json or $HUB_CONFIG) over built-in defaults. The file's speech
// settings sit between the phone's saved settings and the env (see speech/settings.ts).
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir, hostname } from "node:os"
import path from "node:path"
import { hubEnv } from "../env"
import { isLoopbackHost } from "../loopback"
import { formatPattern, parsePattern } from "./agent/policy"
import { APP_DIR, configBase, legacyPaths, migrateFirst, stateBase } from "../migrate"
import { updateSpeech, type StoredSpeech } from "./speech/settings"

export const GOOGLE_ISSUER = "https://accounts.google.com"

/** How browsers get access: pairing codes only (one owner), or OpenID Connect sign-in (several users). */
export type AuthConfig =
  | { readonly mode: "pairing" }
  | {
      readonly mode: "oidc"
      /** Without a trailing slash; discovery at <issuer>/.well-known/openid-configuration. */
      readonly issuer: string
      readonly clientId: string
      /** Non-enumerable: never serialized or printed with the config. */
      readonly clientSecret: string
      /** Lowercased emails and @domain entries. */
      readonly allowed: readonly string[]
      /** Lowercased admin emails (also allowed). */
      readonly admins: readonly string[]
      /** Dev only (HUB_OIDC_INSECURE_ISSUER=1): the issuer is plain http on loopback. */
      readonly insecureIssuer?: true
    }

export type OidcConfig = Extract<AuthConfig, { mode: "oidc" }>

/** hub.json `auth`, validated (lists already split and lowercased). */
export interface HubAuth {
  readonly mode?: "pairing" | "oidc"
  readonly issuer?: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly allowed?: readonly string[]
  readonly admins?: readonly string[]
}

export interface CentralConfig {
  readonly host: string
  readonly port: number
  /** Origin used in links, cookies (Secure when https) and CSRF checks; no trailing slash. */
  readonly publicURL: string
  readonly stateDir: string
  readonly apiKey: string | undefined
  readonly sttModel: string
  readonly ttsModel: string
  readonly voice: string
  readonly maxAudioBytes: number
  readonly maxSpeechChars: number
  readonly turnTimeoutMs: number
  /** VAPID subject (mailto: or https: URL) sent to push services. */
  readonly vapidSubject: string
  /** Speech settings from hub.json (below the phone's saved settings, above the env). */
  readonly speech?: StoredSpeech
  readonly auth: AuthConfig
  /** hub.json `agents.never`: permission patterns no agent may ever approve, for every user (design §5, §7). */
  readonly agentsNever: readonly string[]
  /** hub.json `agents.launches`: per-user launch caps, only those set (placement fills in its defaults). */
  readonly launchCaps?: HubLaunches
  /** hub.json `agents.webhooks.allowPrivate`: webhooks may target http, loopback, private and local hosts (admin opt-in). */
  readonly webhooksAllowPrivate?: true
  /** Cluster mode (design §9): set only when HUB_DATABASE_URL and HUB_VALKEY_URL (or hub.json cluster) are. */
  readonly cluster?: ClusterConfig
}

/**
 * Cluster mode: shared state in Postgres, cross-pod messages and short-lived data in Valkey. The URLs hold
 * credentials: they are non-enumerable (never serialized or printed with the config) and never put in messages.
 */
export interface ClusterConfig {
  /** This pod's id (HUB_POD_ID, default the hostname): RPC topics and leases name it. */
  readonly podID: string
  /** postgres:// or postgresql:// (non-enumerable). */
  readonly databaseURL: string
  /** redis:// or rediss:// (non-enumerable). */
  readonly valkeyURL: string
}

/** hub.json `cluster` (env HUB_DATABASE_URL / HUB_VALKEY_URL win). */
export interface HubCluster {
  readonly database?: string
  readonly valkey?: string
}

/** hub.json `agents.launches`: per-user launch caps (design §6.2, §7). */
export interface HubLaunches {
  /** Launches waiting to be placed. */
  readonly maxQueued?: number
  /** Launches placed and not ended (placing, provisioning, running). */
  readonly maxActive?: number
  /** New launches per clock hour. */
  readonly perHour?: number
}

/** hub.json `agents`, validated. */
export interface HubAgents {
  /** Normalised `action[:glob]` patterns (see agent/policy.ts), duplicates dropped. */
  readonly never?: readonly string[]
  readonly launches?: HubLaunches
  readonly webhooks?: HubWebhooks
}

/** hub.json `agents.webhooks` (decision znbg8xa5 #8). */
export interface HubWebhooks {
  /** Lets webhook URLs use http and private or local targets (self-hosted receivers); off by default (SSRF). */
  readonly allowPrivate?: boolean
}

/** hub.json, validated. */
export interface HubFile {
  readonly host?: string
  readonly port?: number
  readonly publicURL?: string
  readonly stateDir?: string
  readonly speech?: StoredSpeech
  readonly auth?: HubAuth
  readonly agents?: HubAgents
  readonly cluster?: HubCluster
}

type Env = Readonly<Record<string, string | undefined>>

const HUB_KEYS = new Set(["host", "port", "publicURL", "stateDir", "speech", "auth", "agents", "cluster"])
const CLUSTER_KEYS = ["database", "valkey"] as const
const AGENTS_KEYS = new Set(["never", "launches", "webhooks"])
const WEBHOOK_KEYS = new Set(["allowPrivate"])
const LAUNCH_CAP_KEYS = ["maxQueued", "maxActive", "perHour"] as const
const LAUNCH_CAP_MAX = 100_000
const AUTH_KEYS = new Set(["mode", "issuer", "clientId", "clientSecret", "allowed", "admins"])
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/
const DOMAIN = /^@[^\s@,]+\.[^\s@,]+$/

/** Splits a comma list (or takes an array), trims and lowercases; empty entries dropped. */
function emailList(value: string | readonly string[] | undefined): string[] {
  const items = typeof value === "string" ? value.split(",") : (value ?? [])
  return items.map((item) => item.trim().toLowerCase()).filter(Boolean)
}

/** True when the (verified) email is an admin or on the allow-list: exact email or `@domain` (no subdomains). */
export function emailAllowed(auth: { readonly allowed: readonly string[]; readonly admins: readonly string[] }, email: string): boolean {
  const e = email.trim().toLowerCase()
  if (!EMAIL.test(e)) return false
  const domain = e.slice(e.lastIndexOf("@"))
  return auth.admins.includes(e) || auth.allowed.includes(e) || auth.allowed.includes(domain)
}

function int(value: string | undefined, fallback: number, min = 1): number {
  if (value === undefined || value.trim() === "") return fallback
  const n = Number(value)
  return Number.isInteger(n) && n >= min ? n : fallback
}

const expandHome = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p)

export function hubConfigPath(env: Env = process.env, home: string = homedir()): string {
  const explicit = hubEnv(env).HUB_CONFIG
  if (explicit) return explicit
  return path.join(configBase(env, home), APP_DIR, "hub.json")
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Removes apiKey from both speech sections; true when there was one. */
function stripKeys(speech: Record<string, unknown>): boolean {
  let found = false
  for (const kind of ["stt", "tts"]) {
    const section = speech[kind]
    if (isObj(section) && "apiKey" in section) {
      found = true
      const { apiKey: _drop, ...rest } = section
      speech[kind] = rest
    }
  }
  return found
}

/**
 * Reads and validates hub.json. A missing file yields no settings. Invalid JSON or values throw (with
 * the file name). API keys are refused, with a warning, when the file is readable by group or others.
 */
export function readHubFile(file: string, home: string = homedir()): { file?: HubFile; warnings: string[] } {
  if (!existsSync(file)) return { warnings: [] }
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (cause) {
    return fail(`not valid JSON (${cause instanceof Error ? cause.message : cause})`)
  }
  if (!isObj(raw)) return fail("expected a JSON object")

  const warnings: string[] = []
  for (const key of Object.keys(raw)) if (!HUB_KEYS.has(key)) warnings.push(`${file}: unknown key "${key}" ignored`)

  const hub: { -readonly [K in keyof HubFile]: HubFile[K] } = {}
  if (raw.host !== undefined) {
    if (typeof raw.host !== "string" || !raw.host.trim()) fail("host must be a non-empty string")
    hub.host = (raw.host as string).trim()
  }
  if (raw.port !== undefined) {
    const port = raw.port
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) fail("port must be an integer from 0 to 65535")
    hub.port = port as number
  }
  if (raw.publicURL !== undefined) {
    if (typeof raw.publicURL !== "string" || !raw.publicURL.trim()) fail("publicURL must be a string")
    hub.publicURL = (raw.publicURL as string).trim()
  }
  if (raw.stateDir !== undefined) {
    if (typeof raw.stateDir !== "string" || !raw.stateDir.trim()) fail("stateDir must be a non-empty string")
    hub.stateDir = expandHome((raw.stateDir as string).trim(), home)
  }
  if (raw.auth !== undefined) hub.auth = readHubAuth(raw.auth, file, warnings, fail)
  if (raw.agents !== undefined) hub.agents = readHubAgents(raw.agents, file, warnings, fail)
  if (raw.cluster !== undefined) hub.cluster = readHubCluster(raw.cluster, file, warnings, fail)
  if (raw.speech !== undefined) {
    if (!isObj(raw.speech)) fail("speech must be an object with stt and/or tts")
    const speech = { ...(raw.speech as Record<string, unknown>) }
    const shared = (statSync(file).mode & 0o044) !== 0
    if (shared && stripKeys(speech)) {
      warnings.push(`${file} is readable by other users, so its API keys are ignored. Fix it with: chmod 600 ${file}`)
    }
    try {
      hub.speech = updateSpeech({}, speech)
    } catch (cause) {
      fail(`speech: ${cause instanceof Error ? cause.message : cause}`)
    }
  }
  return { file: hub, warnings }
}

function readHubAuth(raw: unknown, file: string, warnings: string[], fail: (message: string) => never): HubAuth {
  if (!isObj(raw)) fail("auth must be an object")
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!AUTH_KEYS.has(key)) warnings.push(`${file}: unknown key "auth.${key}" ignored`)
  const auth: { -readonly [K in keyof HubAuth]: HubAuth[K] } = {}
  if (input.mode !== undefined) {
    if (input.mode !== "pairing" && input.mode !== "oidc") fail('auth.mode must be "pairing" or "oidc"')
    auth.mode = input.mode as "pairing" | "oidc"
  }
  for (const key of ["issuer", "clientId", "clientSecret"] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== "string" || !value.trim()) fail(`auth.${key} must be a non-empty string`)
    auth[key] = (value as string).trim()
  }
  for (const key of ["allowed", "admins"] as const) {
    const value = input[key]
    if (value === undefined) continue
    const ok = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"))
    if (!ok) fail(`auth.${key} must be a list of emails (array of strings or a comma list)`)
    auth[key] = emailList(value as string | string[])
  }
  if (auth.clientSecret !== undefined && (statSync(file).mode & 0o044) !== 0) {
    delete auth.clientSecret
    warnings.push(`${file} is readable by other users, so its auth.clientSecret is ignored. Fix it with: chmod 600 ${file}`)
  }
  return auth
}

/** hub.json `cluster`. Values are never echoed; URLs with a password are dropped from a file others can read. */
function readHubCluster(raw: unknown, file: string, warnings: string[], fail: (message: string) => never): HubCluster {
  if (!isObj(raw)) fail("cluster must be an object with database and valkey URLs")
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!(CLUSTER_KEYS as readonly string[]).includes(key)) warnings.push(`${file}: unknown key "cluster.${key}" ignored`)
  }
  const shared = (statSync(file).mode & 0o044) !== 0
  const cluster: { -readonly [K in keyof HubCluster]: HubCluster[K] } = {}
  for (const key of CLUSTER_KEYS) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== "string" || !value.trim()) fail(`cluster.${key} must be a non-empty URL string`)
    const url = (value as string).trim()
    if (shared && hasPassword(url)) {
      warnings.push(`${file} is readable by other users, so its cluster.${key} is ignored (it holds a password). Fix it with: chmod 600 ${file}`)
      continue
    }
    cluster[key] = url
  }
  return cluster
}

function hasPassword(url: string): boolean {
  try {
    return new URL(url).password !== ""
  } catch {
    // Unparseable: assume the worst; centralConfig rejects it anyway.
    return true
  }
}

function readHubAgents(raw: unknown, file: string, warnings: string[], fail: (message: string) => never): HubAgents {
  if (!isObj(raw)) fail("agents must be an object")
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!AGENTS_KEYS.has(key)) warnings.push(`${file}: unknown key "agents.${key}" ignored`)
  const launches = input.launches === undefined ? undefined : readHubLaunches(input.launches, file, warnings, fail)
  const never = input.never === undefined ? undefined : readNever(input.never, fail)
  const webhooks = input.webhooks === undefined ? undefined : readHubWebhooks(input.webhooks, file, warnings, fail)
  return { ...(never ? { never } : {}), ...(launches ? { launches } : {}), ...(webhooks ? { webhooks } : {}) }
}

function readHubWebhooks(raw: unknown, file: string, warnings: string[], fail: (message: string) => never): HubWebhooks {
  if (!isObj(raw)) fail("agents.webhooks must be an object")
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!WEBHOOK_KEYS.has(key)) warnings.push(`${file}: unknown key "agents.webhooks.${key}" ignored`)
  if (input.allowPrivate !== undefined && typeof input.allowPrivate !== "boolean") fail("agents.webhooks.allowPrivate must be true or false")
  return input.allowPrivate === undefined ? {} : { allowPrivate: input.allowPrivate as boolean }
}

function readHubLaunches(raw: unknown, file: string, warnings: string[], fail: (message: string) => never): HubLaunches {
  if (!isObj(raw)) fail("agents.launches must be an object")
  const input = raw as Record<string, unknown>
  const caps: Record<string, number> = {}
  for (const key of Object.keys(input)) {
    if (!(LAUNCH_CAP_KEYS as readonly string[]).includes(key)) {
      warnings.push(`${file}: unknown key "agents.launches.${key}" ignored`)
      continue
    }
    const value = input[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LAUNCH_CAP_MAX) {
      fail(`agents.launches.${key} must be a whole number from 1 to ${LAUNCH_CAP_MAX}`)
    }
    caps[key] = value as number
  }
  return caps
}

function readNever(raw: unknown, fail: (message: string) => never): string[] {
  if (!Array.isArray(raw)) fail('agents.never must be a list of patterns ("action" or "action:glob")')
  const never: string[] = []
  for (const item of raw as unknown[]) {
    const pattern = typeof item === "string" ? parsePattern(item) : undefined
    if (!pattern) fail(`agents.never: ${JSON.stringify(item)} is not a pattern ("action" or "action:glob")`)
    const text = formatPattern(pattern!)
    if (!never.includes(text)) never.push(text)
  }
  return never
}

/** Validates the OIDC issuer: https, or plain http on loopback when the dev flag is set. No trailing slash. */
function issuerURL(raw: string, insecure: boolean): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`HUB_OIDC_ISSUER (auth.issuer) must be a URL, got ${JSON.stringify(raw)}`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("HUB_OIDC_ISSUER (auth.issuer) must not contain credentials, a query or a fragment")
  }
  if (url.protocol === "http:" && insecure) {
    if (!isLoopbackHost(url.hostname)) throw new Error("HUB_OIDC_INSECURE_ISSUER only allows a plain http issuer on loopback (dev only)")
  } else if (url.protocol !== "https:") {
    throw new Error(`HUB_OIDC_ISSUER (auth.issuer) must be an https:// URL, got ${JSON.stringify(raw)}`)
  }
  return url.toString().replace(/\/+$/, "")
}

/** Auth settings from env over hub.json. Throws (without echoing secrets) when oidc is incomplete. */
function authConfig(env: Env, file: HubAuth = {}): AuthConfig {
  const mode = (env.HUB_AUTH?.trim() || file.mode || "pairing").toLowerCase()
  if (mode === "pairing") return { mode: "pairing" }
  if (mode !== "oidc") throw new Error(`HUB_AUTH must be "pairing" or "oidc", got ${JSON.stringify(env.HUB_AUTH)}`)
  const insecure = env.HUB_OIDC_INSECURE_ISSUER === "1"
  const issuer = issuerURL(env.HUB_OIDC_ISSUER?.trim() || file.issuer || GOOGLE_ISSUER, insecure)
  const required = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`${name} is required for HUB_AUTH=oidc`)
    return value
  }
  const clientId = required(env.HUB_OIDC_CLIENT_ID?.trim() || file.clientId, "HUB_OIDC_CLIENT_ID (auth.clientId)")
  const clientSecret = required(env.HUB_OIDC_CLIENT_SECRET?.trim() || file.clientSecret, "HUB_OIDC_CLIENT_SECRET (auth.clientSecret)")
  const allowed = emailList(env.HUB_OIDC_ALLOWED ?? file.allowed)
  const admins = emailList(env.HUB_ADMIN_EMAILS ?? file.admins)
  if (allowed.length === 0) throw new Error("HUB_OIDC_ALLOWED (auth.allowed) is required for HUB_AUTH=oidc: list emails and/or @domain entries")
  if (admins.length === 0) throw new Error("HUB_ADMIN_EMAILS (auth.admins) needs at least one admin email for HUB_AUTH=oidc")
  const bad = allowed.find((entry) => !EMAIL.test(entry) && !DOMAIN.test(entry))
  if (bad !== undefined) throw new Error(`HUB_OIDC_ALLOWED (auth.allowed): ${JSON.stringify(bad)} is not an email or @domain`)
  const badAdmin = admins.find((entry) => !EMAIL.test(entry))
  if (badAdmin !== undefined) throw new Error(`HUB_ADMIN_EMAILS (auth.admins): ${JSON.stringify(badAdmin)} is not an email`)
  const auth = { mode: "oidc" as const, issuer, clientId, allowed, admins, ...(insecure ? { insecureIssuer: true as const } : {}) }
  // A getter: printed as [Getter], skipped by JSON.stringify.
  Object.defineProperty(auth, "clientSecret", { get: () => clientSecret, enumerable: false })
  return auth as unknown as OidcConfig
}

const POD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DATABASE_KEY = "HUB_DATABASE_URL (cluster.database)"
const VALKEY_KEY = "HUB_VALKEY_URL (cluster.valkey)"

/** The URL when its scheme is one of `protocols`; errors name the key, never the value (it holds credentials). */
function serviceURL(raw: string, name: string, protocols: readonly string[]): string {
  let protocol: string
  try {
    protocol = new URL(raw).protocol
  } catch {
    throw new Error(`${name} is not a valid URL`)
  }
  if (!protocols.includes(protocol)) throw new Error(`${name} must be a ${protocols.map((p) => `${p}//`).join(" or ")} URL`)
  return raw
}

/**
 * Cluster settings from env over hub.json, or undefined (single process). Both URLs or neither; cluster mode
 * requires HUB_TOKEN_KEYS (keys every pod shares) and OIDC sign-in (pairing codes and the local owner are
 * single-process). Throws without echoing the URLs.
 */
function clusterConfig(env: Env, auth: AuthConfig, file: HubCluster = {}): ClusterConfig | undefined {
  const database = env.HUB_DATABASE_URL?.trim() || file.database
  const valkey = env.HUB_VALKEY_URL?.trim() || file.valkey
  if (!database && !valkey) return undefined
  if (!database || !valkey) {
    throw new Error(`${DATABASE_KEY} and ${VALKEY_KEY} must be set together for cluster mode; only ${database ? DATABASE_KEY : VALKEY_KEY} is set`)
  }
  const databaseURL = serviceURL(database, DATABASE_KEY, ["postgres:", "postgresql:"])
  const valkeyURL = serviceURL(valkey, VALKEY_KEY, ["redis:", "rediss:"])
  if (!env.HUB_TOKEN_KEYS?.trim()) {
    throw new Error("Cluster mode requires HUB_TOKEN_KEYS: token signing keys every pod shares (the token-keys.json shape)")
  }
  if (auth.mode !== "oidc") {
    throw new Error("Cluster mode requires HUB_AUTH=oidc: pairing mode (pairing codes, the local owner) works in a single process only")
  }
  const podID = env.HUB_POD_ID?.trim() || hostname()
  if (!POD_ID.test(podID)) {
    throw new Error(`HUB_POD_ID must be 1-128 letters, digits, '.', '_' or '-' (starting with a letter or digit), got ${JSON.stringify(podID)}`)
  }
  const cluster = { podID }
  // Getters: printed as nothing, skipped by JSON.stringify.
  Object.defineProperty(cluster, "databaseURL", { get: () => databaseURL, enumerable: false })
  Object.defineProperty(cluster, "valkeyURL", { get: () => valkeyURL, enumerable: false })
  return cluster as ClusterConfig
}

export function centralConfig(rawEnv: Env = process.env, home: string = homedir(), file: HubFile = {}): CentralConfig {
  const env = hubEnv(rawEnv)
  const host = env.HUB_HOST || file.host || "127.0.0.1"
  const port = int(env.HUB_PORT, file.port ?? 4097, 0)
  // A wildcard bind address is no origin a browser uses: default to the loopback one (Docker -p 127.0.0.1:…).
  const linkHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  const publicURL = (env.HUB_PUBLIC_URL || file.publicURL || `http://${linkHost.includes(":") ? `[${linkHost}]` : linkHost}:${port}`).replace(/\/+$/, "")
  if (!/^https?:\/\/[^\s/]+$/.test(publicURL)) {
    throw new Error(`HUB_PUBLIC_URL must be an http(s) origin without a path, got ${JSON.stringify(publicURL)}`)
  }
  const auth = authConfig(env, file.auth)
  const cluster = clusterConfig(env, auth, file.cluster)
  return {
    host,
    port,
    publicURL,
    stateDir: env.HUB_STATE_DIR || file.stateDir || path.join(stateBase(home), APP_DIR),
    apiKey: env.OPENROUTER_API_KEY || undefined,
    sttModel: env.HUB_STT_MODEL || "openai/gpt-4o-mini-transcribe",
    ttsModel: env.HUB_TTS_MODEL || "microsoft/mai-voice-2.1-flash",
    voice: env.HUB_VOICE || "en-US-Harper:MAI-Voice-2.1-Flash",
    maxAudioBytes: int(env.HUB_MAX_AUDIO_BYTES, 10 * 1024 * 1024),
    maxSpeechChars: int(env.HUB_MAX_SPEECH_CHARS, 800),
    turnTimeoutMs: int(env.HUB_TURN_TIMEOUT_MS, 600_000),
    // Push services want a contact: an https URL or mailto. The public URL works for hosted hubs.
    vapidSubject: env.HUB_VAPID_SUBJECT || (publicURL.startsWith("https://") ? publicURL : "mailto:hub@localhost"),
    ...(file.speech ? { speech: file.speech } : {}),
    auth,
    agentsNever: [...(file.agents?.never ?? [])],
    ...(file.agents?.launches ? { launchCaps: { ...file.agents.launches } } : {}),
    ...(file.agents?.webhooks?.allowPrivate === true ? { webhooksAllowPrivate: true as const } : {}),
    ...(cluster ? { cluster } : {}),
  }
}

export interface LoadOptions {
  /** Where one-time migration notices go (default console). */
  readonly log?: (message: string) => void
}

/**
 * Reads hub.json (if any) and the environment. Throws on an invalid file or public URL. On first start,
 * copies the legacy hub.json and state directory (opencode-hub first, else opencode-voice) to their default
 * Hub locations (never for paths set by env or hub.json; the old copies are kept).
 */
export function loadCentralConfig(
  env: Env = process.env,
  home: string = homedir(),
  options: LoadOptions = {},
): { config: CentralConfig; warnings: string[]; path: string; loaded: boolean } {
  const resolved = hubEnv(env)
  const migrate = options.log ? { log: options.log } : {}
  const file = hubConfigPath(env, home)
  if (!resolved.HUB_CONFIG) migrateFirst(legacyPaths(configBase(env, home), "hub.json"), file, migrate)
  const { file: hub, warnings } = readHubFile(file, home)
  const config = centralConfig(env, home, hub)
  if (!resolved.HUB_STATE_DIR && !hub?.stateDir) {
    // hub.pid is the spoke's auto-start lock for the legacy location, not state.
    migrateFirst(legacyPaths(stateBase(home)), config.stateDir, { ...migrate, skip: ["hub.pid"] })
  }
  return { config, warnings, path: file, loaded: hub !== undefined }
}
