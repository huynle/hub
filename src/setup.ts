// First-run setup for /voice: whether to show it, which options in which order, the server URL the user
// types, and whether that server answers like a voice hub. Pure decisions; src/tui.ts renders them.
import { DEFAULT_SERVER, type Mode } from "./config"
import { isLoopbackURL } from "./loopback"

export type { Mode }

/** The parts of voice.status that setup depends on. */
export interface SetupStatus {
  readonly server: string
  readonly enrolled: boolean
  readonly connection: "off" | "connecting" | "connected" | "revoked" | "error"
  readonly mode: Mode
}

/**
 * configured: connect to the (remote) server already in the config · local / local-session: a hub on this
 * computer, sharing every session / only sessions switched on · remote: type a server URL · later: close.
 */
export type SetupChoice = "configured" | "local" | "local-session" | "remote" | "later"

export interface SetupOption {
  readonly value: SetupChoice
  readonly title: string
  readonly description: string
}

export type Parsed = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly error: string }
export type Health = { readonly ok: true; readonly version?: string } | { readonly ok: false; readonly error: string }

/** Setup instead of the regular menu: this machine has no token for its server, or the server revoked it. */
export function needsSetup(status: SetupStatus): boolean {
  return !status.enrolled || status.connection === "revoked"
}

const hostOf = (server: string) => server.replace(/^https?:\/\//, "")

export function setupOptions(status: SetupStatus): SetupOption[] {
  const remote = !isLoopbackURL(status.server)
  const revoked = status.enrolled && status.connection === "revoked"
  const options: SetupOption[] = []
  if (remote) {
    options.push({
      value: "configured",
      title: `Connect to ${hostOf(status.server)}`,
      description: revoked
        ? "This machine was revoked there; ask to be approved again"
        : "Your voice server: approve this machine in its web page, then talk from any device",
    })
  }
  options.push(
    {
      value: "local",
      title: "On this computer (local — nothing to install)",
      description: "Starts a voice hub here (nothing to install), shares every session, and opens the voice page in your browser",
    },
    {
      value: "local-session",
      title: "On this computer, only sessions I choose",
      description: "Same local hub; share a session with /voice → This session",
    },
    {
      value: "remote",
      title: remote ? "Connect to a different voice server…" : "Connect to a voice server…",
      description: "A hub you or your team host, e.g. https://voice.example.com (needed for phones away from this computer)",
    },
    { value: "later", title: "Not now", description: "Run /voice again any time" },
  )
  return options
}

/** The local hub's URL: a loopback http server already configured (custom port), else the default. */
export function localServerFor(server: string): string {
  return isLoopbackURL(server) && server.startsWith("http:") ? server : DEFAULT_SERVER
}

/** Every session by default; only chosen sessions for the secondary local choice. */
export function modeFor(choice: SetupChoice): Mode {
  return choice === "local-session" ? "session" : "always"
}

/** A server URL as typed: http(s) only, a bare host means https; no credentials, query or fragment. */
export function parseServerInput(raw: string): Parsed {
  const text = raw.trim()
  if (!text) return { ok: false, error: "Enter the voice server's address, e.g. https://voice.example.com" }
  if (/\s/.test(text)) return { ok: false, error: "The address cannot contain spaces" }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: `Not a valid address: ${text}` }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Use an http:// or https:// address" }
  if (!url.hostname) return { ok: false, error: `Not a valid address: ${text}` }
  if (url.username || url.password) return { ok: false, error: "Leave user names and passwords out of the address" }
  if (url.search || url.hash || withScheme.includes("#") || withScheme.includes("?")) {
    return { ok: false, error: "Use the server's base address, without ? or #" }
  }
  return { ok: true, url: `${url.origin}${url.pathname}`.replace(/\/+$/, "") }
}

/** GET <server>/healthz: reachable and answering like an OpenCode Hub ({ok: true}). */
export async function checkServer(
  server: string,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<Health> {
  const doFetch = options.fetch ?? globalThis.fetch
  let res: Response
  try {
    res = await doFetch(`${server}/healthz`, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 8000) })
  } catch (cause) {
    return { ok: false, error: `Could not reach ${server}: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `${server}/healthz answered HTTP ${res.status}. If a login proxy protects the server, leave /healthz and /spoke/* reachable.`,
    }
  }
  const body = (await res.json().catch(() => undefined)) as { ok?: unknown; version?: unknown } | undefined
  if (body?.ok !== true) return { ok: false, error: `${server} answered, but it is not an OpenCode Hub` }
  return { ok: true, ...(typeof body.version === "string" ? { version: body.version } : {}) }
}
