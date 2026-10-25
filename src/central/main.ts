// The hub process: command line, config, startup log and shutdown. Shared by bin/hub.ts (web/ from
// disk) and the compiled binaries (web/ embedded, see scripts/gen-web-entry.ts).
import type { WebAssets } from "./assets"
import { PAIR_TTL_MS } from "./auth"
import { isLoopbackURL } from "../loopback"
import { SQL } from "bun"
import { homedir } from "node:os"
import type { StateStore } from "./backend"
import { migrate, type MigrateResult } from "./backend/postgres-migrate"
import { PostgresStateStore } from "./backend/postgres-state"
import { hubConfigPath, loadCentralConfig, readHubFile, type CentralConfig } from "./config"
import { startCentral } from "./http"
import { formatImportReport, importState, tokenKeysMaterial } from "./import"

export interface ImportArgs {
  readonly stateDir: string
  readonly dryRun: boolean
  readonly force: boolean
  readonly printTokenKeys: boolean
}

export type HubArgs =
  | { readonly action: "run" | "version" | "help" | "migrate" }
  | ({ readonly action: "import" } & ImportArgs)
  | { readonly action: "error"; readonly message: string }

export function parseHubArgs(argv: readonly string[]): HubArgs {
  if (argv.length === 0) return { action: "run" }
  const [first] = argv
  if (argv.length === 1 && (first === "--version" || first === "-v")) return { action: "version" }
  if (argv.length === 1 && (first === "--help" || first === "-h")) return { action: "help" }
  if (argv.length === 1 && first === "migrate") return { action: "migrate" }
  if (first === "import") return parseImportArgs(argv.slice(1))
  return { action: "error", message: `Unknown argument: ${argv.join(" ")}. The hub is configured with env vars and hub.json; see --help.` }
}

function parseImportArgs(argv: readonly string[]): HubArgs {
  const usage = "Usage: hub-server import --state <dir> [--dry-run] [--force] [--print-token-keys]"
  let stateDir: string | undefined
  const flags = { dryRun: false, force: false, printTokenKeys: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const inline = arg.startsWith("--state=") ? arg.slice("--state=".length) : undefined
    if (arg === "--state" || inline !== undefined) {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) return { action: "error", message: `--state needs a directory. ${usage}` }
      if (stateDir !== undefined) return { action: "error", message: `--state given twice. ${usage}` }
      stateDir = value
    } else if (arg === "--dry-run") flags.dryRun = true
    else if (arg === "--force") flags.force = true
    else if (arg === "--print-token-keys") flags.printTokenKeys = true
    else return { action: "error", message: `Unknown import argument: ${arg}. ${usage}` }
  }
  if (stateDir === undefined) return { action: "error", message: `import needs --state <dir> (the single-process hub's state directory). ${usage}` }
  return { action: "import", stateDir, ...flags }
}

export function hubHelp(version: string): string {
  return `hub-server ${version}

Hub: the central hub your AI agent harnesses connect to (OpenCode first). Serves the web console,
pairs phones and browsers, enrolls machines, and does push notifications and (optional) Voice speech.

Usage: hub-server [--help | --version]   (also installed as opencode-hub and opencode-voice-hub)
       hub-server migrate
       hub-server import --state <dir> [--dry-run] [--force] [--print-token-keys]

Configuration: environment variables over ~/.config/hub/hub.json ($HUB_CONFIG).
  HUB_HOST / HUB_PORT       listen address (default 127.0.0.1 / 4097)
  HUB_PUBLIC_URL            origin used in links and cookies (default http://<host>:<port>)
  HUB_STATE_DIR             machines, devices, keys (default ~/.local/state/hub)
  OPENROUTER_API_KEY        default speech key; or set speech providers in the web app (Settings → Speech)
  HUB_CONFIG                path of hub.json

Multi-user (sign in with Google or another OpenID Connect provider):
  HUB_AUTH=oidc             default "pairing" (one owner)
  HUB_OIDC_ISSUER           default https://accounts.google.com
  HUB_OIDC_CLIENT_ID        OAuth client ID (required)
  HUB_OIDC_CLIENT_SECRET    OAuth client secret (required; never logged)
  HUB_OIDC_ALLOWED          who may sign in: emails and/or @domain entries, comma separated (required)
  HUB_ADMIN_EMAILS          admin emails, comma separated (at least one)
  Register <public URL>/auth/callback as the redirect URI.

Cluster mode (several pods on Postgres + Valkey; docs/cluster.md):
  HUB_DATABASE_URL / HUB_VALKEY_URL   postgres:// and redis:// URLs (both, or hub.json cluster)
  migrate                   applies the Postgres schema (idempotent, under an advisory lock); run it before the pods
  import --state <dir>      copies a single-process hub's state directory (state.json, agent/) into Postgres;
                            idempotent: existing rows are kept (conflicts listed) unless --force; --dry-run writes
                            nothing; --print-token-keys prints token-keys.json as the HUB_TOKEN_KEYS value (secret)
                            on stdout. Stop the single-process hub first. Machines and devices keep their tokens.

The former VOICE_* names (opencode-voice) still work, with a deprecation warning; so do the
opencode-hub and opencode-voice config and state directories (copied once on first start).
While no device is paired, the log shows a pairing code for the first one (open <public URL>/pair).
Docs: https://github.com/huynle/hub#running-the-hub
`
}

/** Startup log lines about sign-in (never the client secret). Pairing mode has none. */
export function authStartupLines(config: CentralConfig): { info: string[]; warnings: string[] } {
  const auth = config.auth
  if (auth.mode !== "oidc") return { info: [], warnings: [] }
  const entries = auth.allowed.length
  const admins = auth.admins.length
  const info = [
    `multi-user: sign-in with ${auth.issuer} (client ${auth.clientId}); redirect URI ${config.publicURL}/auth/callback`,
    `multi-user: ${entries} allow-list ${entries === 1 ? "entry" : "entries"}, ${admins} admin${admins === 1 ? "" : "s"}`,
  ]
  const warnings: string[] = []
  if (!config.publicURL.startsWith("https://") && !isLoopbackURL(config.publicURL)) {
    warnings.push(`HUB_PUBLIC_URL ${config.publicURL} is not https: sign-in cookies travel unencrypted and most providers refuse the redirect URI`)
  }
  if (auth.insecureIssuer) warnings.push(`HUB_OIDC_INSECURE_ISSUER is set: plain-http issuer ${auth.issuer} allowed (development only)`)
  return { info, warnings }
}

export interface RunHubOptions {
  readonly web: WebAssets
  readonly version: string
  readonly argv?: readonly string[]
}

/** Runs the hub until SIGINT/SIGTERM (or answers --help / --version). */
export function runHub(options: RunHubOptions): void {
  const args = parseHubArgs(options.argv ?? process.argv.slice(2))
  if (args.action === "version") {
    console.log(options.version)
    return
  }
  if (args.action === "help") {
    console.log(hubHelp(options.version))
    return
  }
  if (args.action === "error") {
    console.error(`[hub] ${args.message}`)
    process.exit(2)
  }
  if (args.action === "migrate" || args.action === "import") {
    const io: CommandIO = { env: process.env, out: (line) => console.log(line), err: (line) => console.error(line) }
    const run = args.action === "import" ? runImport(args, io) : runMigrate(io)
    void run.then((code) => process.exit(code))
    return
  }

  let loaded: ReturnType<typeof loadCentralConfig>
  try {
    loaded = loadCentralConfig()
  } catch (cause) {
    console.error(`[hub] ${cause instanceof Error ? cause.message : cause}`)
    process.exit(1)
  }
  for (const warning of loaded.warnings) console.warn(`[hub] warning: ${warning}`)
  const config = loaded.config
  const central = startCentral({ config, web: options.web, version: options.version })

  console.log(`[hub] Hub ${options.version} listening on ${central.url} (public URL ${central.publicURL})`)
  console.log(`[hub] state: ${config.stateDir}`)
  console.log(`[hub] config: ${loaded.loaded ? loaded.path : `${loaded.path} (not found; using env and defaults)`}`)
  const authLines = authStartupLines(config)
  for (const line of authLines.info) console.log(`[hub] ${line}`)
  for (const line of authLines.warnings) console.warn(`[hub] warning: ${line}`)
  const speech = central.speechSettings.view()
  if (speech.ready.reason) {
    console.log(`[hub] speech is not set up yet: ${speech.ready.reason} (or OPENROUTER_API_KEY, or speech.stt/tts in hub.json)`)
  }

  // While no device is paired, keep a fresh bootstrap pairing code in the log.
  const bootstrap = () => {
    const code = central.auth.bootstrapCode()
    if (code) console.log(`[hub] Pair your first device at ${central.publicURL}/pair with code ${code.code}`)
    return code !== undefined
  }
  let timer: ReturnType<typeof setInterval> | undefined
  if (bootstrap()) {
    timer = setInterval(() => {
      if (!bootstrap()) clearInterval(timer)
    }, PAIR_TTL_MS - 5_000)
  }

  const onSignal = shutdownOnSignals(central, {
    log: (line) => {
      clearInterval(timer)
      console.log(line)
    },
    exit: (code) => process.exit(code),
  })
  process.on("SIGTERM", () => void onSignal("SIGTERM"))
  process.on("SIGINT", () => void onSignal("SIGINT"))
}

/**
 * The hub's signal handler: the first SIGTERM/SIGINT shuts down (shutdownHub) and exits 0; a second one while that is
 * still running (a drain waiting for requests) stops at once and exits 1; later ones are ignored.
 */
export function shutdownOnSignals(
  central: { drain(): Promise<void>; stop(): Promise<void> },
  options: { readonly log: (line: string) => void; readonly exit: (code: number) => void },
): (signal: string) => Promise<void> {
  let state: "running" | "stopping" | "forced" = "running"
  return async (signal) => {
    if (state === "forced") return
    if (state === "stopping") {
      state = "forced"
      options.log(`[hub] ${signal} again: stopping now`)
      await central.stop().catch((cause: unknown) => options.log(`[hub] stop failed: ${(cause as Error)?.message ?? cause}`))
      options.exit(1)
      return
    }
    state = "stopping"
    // Once forced, the drain ending later neither stops again nor exits.
    const once = { drain: () => central.drain(), stop: () => (state === "forced" ? Promise.resolve() : central.stop()) }
    await shutdownHub(once, signal, options.log)
    if (state === "stopping") options.exit(0)
  }
}

/**
 * Shuts the hub down on a signal. SIGTERM (Kubernetes replacing the pod, systemd, docker stop) drains first (design
 * §10: /readyz fails, spokes and nodes are sent to another pod, requests in flight finish; quick without any), then
 * stops; SIGINT (Ctrl-C) stops at once. A failed drain still stops.
 */
export async function shutdownHub(central: { drain(): Promise<void>; stop(): Promise<void> }, signal: string, log: (line: string) => void = console.log): Promise<void> {
  if (signal === "SIGTERM") {
    log(`[hub] ${signal}: draining`)
    try {
      await central.drain()
    } catch (cause) {
      log(`[hub] drain failed: ${cause instanceof Error ? cause.message : cause}`)
    }
  }
  log(`[hub] ${signal}: shutting down`)
  await central.stop()
}


/** Where the one-shot commands (migrate, import) read settings and write lines. */
export interface CommandIO {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** For the hub.json path (default the user's home). */
  readonly home?: string
}

/**
 * The Postgres URL of the one-shot commands: HUB_DATABASE_URL, else hub.json cluster.database. Errors name the
 * setting, never the value (it holds the password).
 */
function databaseURL(io: CommandIO): string {
  const name = "HUB_DATABASE_URL (cluster.database)"
  const url = io.env.HUB_DATABASE_URL?.trim() || readHubFile(hubConfigPath(io.env, io.home ?? homedir()), io.home ?? homedir()).file?.cluster?.database
  if (!url) throw new Error(`${name} is not set: the Postgres database of the cluster`)
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error(`${name} is not a valid URL`)
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") throw new Error(`${name} must be a postgres:// or postgresql:// URL`)
  return url
}

/** A message without the URL or its secret-ish parts (password, host). */
function redact(message: string, url: string | undefined): string {
  if (!url) return message
  let out = message.split(url).join("<database>")
  try {
    const parsed = new URL(url)
    for (const part of [parsed.password, decodeURIComponent(parsed.password), parsed.host, parsed.hostname]) {
      if (part && part.length >= 3) out = out.split(part).join("<redacted>")
    }
  } catch {
    // Not a URL: nothing more to hide.
  }
  return out
}

/** `hub-server migrate`: applies the Postgres schema (idempotent, under the advisory lock). Returns the exit code. */
export async function runMigrate(io: CommandIO & { readonly migrate?: (url: string) => Promise<MigrateResult> }): Promise<number> {
  let url: string | undefined
  try {
    url = databaseURL(io)
    const result = await (io.migrate ?? migrateDatabase)(url)
    io.out(
      result.applied.length
        ? `[hub] migrate: applied ${result.applied.join(", ")}; schema now at version ${result.version}`
        : `[hub] migrate: schema up to date at version ${result.version}`,
    )
    return 0
  } catch (cause) {
    io.err(`[hub] migrate failed: ${redact((cause as Error)?.message ?? String(cause), url)}`)
    return 1
  }
}

async function migrateDatabase(url: string): Promise<MigrateResult> {
  const sql = new SQL(url, { max: 1 })
  try {
    return await migrate(sql)
  } finally {
    await sql.close().catch(() => {})
  }
}

/**
 * `hub-server import`: the state directory into Postgres (see ./import). The report goes to stdout, or to stderr with
 * --print-token-keys, so stdout holds only the HUB_TOKEN_KEYS value. Returns the exit code (1 when a row failed).
 */
export async function runImport(
  args: ImportArgs,
  io: CommandIO & { readonly openState?: (url: string) => StateStore & { close?(): Promise<void> } },
): Promise<number> {
  const report = args.printTokenKeys ? io.err : io.out
  let url: string | undefined
  let state: (StateStore & { close?(): Promise<void> }) | undefined
  try {
    url = databaseURL(io)
    state = (io.openState ?? ((u: string) => new PostgresStateStore({ url: u, max: 2 })))(url)
    // Reachable and migrated (a schema error says to run migrate), before any row is read or counted.
    await state.ping?.()
    const result = await importState({ stateDir: args.stateDir, state, dryRun: args.dryRun, force: args.force })
    for (const line of formatImportReport(result)) report(redact(line, url))
    if (args.printTokenKeys) {
      const material = tokenKeysMaterial(args.stateDir)
      if (material) io.out(material)
      else io.err("[hub] no token-keys.json: nothing to print")
    }
    return result.failed ? 1 : 0
  } catch (cause) {
    io.err(`[hub] import failed: ${redact((cause as Error)?.message ?? String(cause), url)}`)
    return 1
  } finally {
    await state?.close?.().catch(() => {})
  }
}
