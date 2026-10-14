// The hub process: command line, config, startup log and shutdown. Shared by bin/hub.ts (web/ from
// disk) and the compiled binaries (web/ embedded, see scripts/gen-web-entry.ts).
import type { WebAssets } from "./assets"
import { PAIR_TTL_MS } from "./auth"
import { isLoopbackURL } from "../loopback"
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
  return `opencode-hub ${version}

OpenCode Hub: the web console for your OpenCode sessions. Serves the web app, pairs phones and
browsers, enrolls OpenCode machines, and does push notifications and (optional) Voice speech.

Usage: opencode-hub [--help | --version]

Configuration: environment variables over ~/.config/opencode-hub/hub.json ($HUB_CONFIG).
  HUB_HOST / HUB_PORT       listen address (default 127.0.0.1 / 4097)
  HUB_PUBLIC_URL            origin used in links and cookies (default http://<host>:<port>)
  HUB_STATE_DIR             machines, devices, keys (default ~/.local/state/opencode-hub)
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

The former VOICE_* names (opencode-voice) still work, with a deprecation warning.
While no device is paired, the log shows a pairing code for the first one (open <public URL>/pair).
Docs: https://github.com/huynle/opencode-hub#running-the-hub
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
    console.error(`[opencode-hub] ${args.message}`)
    process.exit(2)
  }

  let loaded: ReturnType<typeof loadCentralConfig>
  try {
    loaded = loadCentralConfig()
  } catch (cause) {
    console.error(`[opencode-hub] ${cause instanceof Error ? cause.message : cause}`)
    process.exit(1)
  }
  for (const warning of loaded.warnings) console.warn(`[opencode-hub] warning: ${warning}`)
  const config = loaded.config
  const central = startCentral({ config, web: options.web, version: options.version })

  console.log(`[opencode-hub] OpenCode Hub ${options.version} listening on ${central.url} (public URL ${central.publicURL})`)
  console.log(`[opencode-hub] state: ${config.stateDir}`)
  console.log(`[opencode-hub] config: ${loaded.loaded ? loaded.path : `${loaded.path} (not found; using env and defaults)`}`)
  const authLines = authStartupLines(config)
  for (const line of authLines.info) console.log(`[opencode-hub] ${line}`)
  for (const line of authLines.warnings) console.warn(`[opencode-hub] warning: ${line}`)
  const speech = central.speechSettings.view()
  if (speech.ready.reason) {
    console.log(`[opencode-hub] speech is not set up yet: ${speech.ready.reason} (or OPENROUTER_API_KEY, or speech.stt/tts in hub.json)`)
  }

  // While no device is paired, keep a fresh bootstrap pairing code in the log.
  const bootstrap = () => {
    const code = central.auth.bootstrapCode()
    if (code) console.log(`[opencode-hub] Pair your first device at ${central.publicURL}/pair with code ${code.code}`)
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
    console.log(`[opencode-hub] ${signal}: shutting down`)
    clearInterval(timer)
    await central.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}
