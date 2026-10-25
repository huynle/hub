// The hub process: command line, config, startup log and shutdown. Shared by bin/hub.ts (web/ from
// disk) and the compiled binaries (web/ embedded, see scripts/gen-web-entry.ts).
import type { WebAssets } from "./assets"
import { PAIR_TTL_MS } from "./auth"
import { isLoopbackURL } from "../loopback"
import { ClusterUnavailableError } from "./backend"
import { loadCentralConfig, type CentralConfig } from "./config"
import { startCentral } from "./http"

export type HubArgs = { readonly action: "run" | "version" | "help" } | { readonly action: "error"; readonly message: string }

export function parseHubArgs(argv: readonly string[]): HubArgs {
  if (argv.length === 0) return { action: "run" }
  const [first] = argv
  if (argv.length === 1 && (first === "--version" || first === "-v")) return { action: "version" }
  if (argv.length === 1 && (first === "--help" || first === "-h")) return { action: "help" }
  return { action: "error", message: `Unknown argument: ${argv.join(" ")}. The hub is configured with env vars and hub.json; see --help.` }
}

export function hubHelp(version: string): string {
  return `hub-server ${version}

Hub: the central hub your AI agent harnesses connect to (OpenCode first). Serves the web console,
pairs phones and browsers, enrolls machines, and does push notifications and (optional) Voice speech.

Usage: hub-server [--help | --version]   (also installed as opencode-hub and opencode-voice-hub)

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

  let loaded: ReturnType<typeof loadCentralConfig>
  try {
    loaded = loadCentralConfig()
  } catch (cause) {
    console.error(`[hub] ${cause instanceof Error ? cause.message : cause}`)
    process.exit(1)
  }
  for (const warning of loaded.warnings) console.warn(`[hub] warning: ${warning}`)
  const config = loaded.config
  let central: ReturnType<typeof startCentral>
  try {
    central = startCentral({ config, web: options.web, version: options.version })
  } catch (cause) {
    // Cluster mode in a build without it: one clear line (it never names the database or Valkey URL).
    if (!(cause instanceof ClusterUnavailableError)) throw cause
    console.error(`[hub] ${cause.message}`)
    process.exit(1)
  }

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

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    await shutdownHub(central, signal)
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
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
