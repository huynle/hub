// Hub: HTTP routes (web UI, JSON API, SSE, enrollment) and the spoke WebSocket.
// Phones authenticate with the `voice_device` cookie (or, in native apps, the same secret as a bearer device
// token; see ./agent/actor.ts); spokes with machine bearer tokens. Source IPs
// (including loopback) are never trusted.
import type { Server } from "bun"
import { diskAssets, type WebAssets } from "./assets"
import path from "node:path"
import { promisify } from "node:util"
import { brotliCompress, constants as zlib, gzip } from "node:zlib"
import { formAnswerProblem, PROMPT_IMAGE_MIMES, promptImagesProblem, type AvailableModel, type EnrollStart, type FormAnswer, type ModelSelection, type PermissionDecision, type PromptImage } from "../protocol"
import { isLoopbackAddress, isLoopbackHost, isLoopbackURL, loopbackOrigins } from "../loopback"
import { speakable } from "../speakable"
import { Auth, RateLimitError, ValidationError } from "./auth"
import { emailAllowed, type CentralConfig } from "./config"
import { authPage, cookieValue, deviceName, OIDC_COOKIE, OidcClient, OidcError } from "./oidc"
import { isNotificationKind, Push, type PushSender } from "./push"
import { pushEndpointProblem, resolveHost as systemResolveHost, type ResolveHost } from "./push-target"
import { Webhooks } from "./agent/webhooks"
import { WEBHOOK_SCOPE } from "./agent/webhook-routes"
import { fileBackends, type Backends } from "./backend"
import { createResolver, type AgentActor, type BearerVerifier, type CredentialMode } from "./agent/actor"
import { ActingSwitch } from "./agent/acting-switch"
import { AgentAudit } from "./agent/audit"
import { Grants } from "./agent/grants"
import { Decisions, type Decision } from "./agent/decisions"
import type { Escalate } from "./agent/acting"
import { Escalations } from "./agent/escalation"
import { GrantRequests } from "./agent/grant-requests"
import { partyFromActor } from "./agent/envelope"
import { Delivery } from "./agent/delivery"
import { AgentError } from "./agent/errors"
import { decisionStateQuery, MessageFeed } from "./agent/message-routes"
import { hubDirectory } from "./agent/directory-routes"
import { agentApi, agentRoutes, agentVerifiers, isAgentPath, wellKnown, type AgentRoute } from "./agent/routes"
import { SessionTokens } from "./agent/session-tokens"
import { SessionTokenPush } from "./session-token-push"
import { TokenKeys } from "./token-keys"
import { EventLog } from "./events-log"
import { BusyError, Registry } from "./registry"
import { createActions } from "./actions"
import { audioFormat, SpeechError } from "./speech/provider"
import { SpeechService } from "./speech/service"
import { NodeRegistry } from "./nodes"
import { randomBytes } from "node:crypto"
import { LaunchEngine } from "./agent/launch-engine"
import { LaunchTokens } from "./agent/launch-tokens"
import { LaunchFeed, launchInfo } from "./agent/launch-routes"
import { RequestTimeoutError, RequestTooLargeError, SpokeError, SpokeHub, type Notifier, type SpokeHubOptions, type SpokeSocketData } from "./spoke-ws"
import { ACTIVITY_INTERVAL_MAX, ACTIVITY_INTERVAL_MIN, LOCAL_USER, PUSH_PREF_KEYS, quietHoursInput, Store, VIEW_PREF_KEYS, type DeviceRecord, type LegacyPushPrefs, type PushPrefs, type UserRecord, type ViewPrefs } from "./store"

export interface Speech {
  transcribe(audio: Uint8Array, format: string): Promise<string>
  speak(text: string): Promise<Uint8Array<ArrayBuffer>>
  /** Streams the audio as it is synthesized (the built-in providers do; an override may only buffer). */
  speakStream?(text: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>
}

export interface CentralOptions {
  readonly config: CentralConfig
  /** The built web app (web/dist, see web/vite.config.ts) on disk; or pass `web` (e.g. files embedded in a compiled binary). */
  readonly webDir?: string
  readonly web?: WebAssets
  readonly version?: string
  /** Overrides speech (default: the provider configured in the speech settings). */
  readonly speech?: Speech
  /** fetch for upstream speech providers and model lists (tests). */
  readonly fetch?: typeof globalThis.fetch
  /** Overrides the notifier (default: web push via `push`). */
  readonly notifier?: Notifier
  /** Overrides web-push delivery (tests; web-push itself needs https push services). */
  readonly pushSender?: PushSender
  /** Resolves push endpoint and webhook hosts (SSRF checks); the system resolver by default. */
  readonly resolveHost?: ResolveHost
  /** Clock for sign-in expiry, the store, the registry and the backends (tests). */
  readonly now?: () => number
  /** Shared state for new code (default: in memory, see ./backend). */
  readonly backends?: Backends
  /** More bearer verifiers and /api/agent routes, after the built-in ones (tests). */
  readonly agent?: { readonly verifiers?: readonly BearerVerifier[]; readonly routes?: readonly AgentRoute[] }
  readonly timing?: {
    readonly helloTimeoutMs?: number
    readonly requestTimeoutMs?: number
    readonly turnGraceMs?: number
    /** `Prefer: respond-async` turns: how long the hub waits for a quick result before answering 202. */
    readonly turnAcceptMs?: number
    readonly heartbeatMs?: number
    readonly staleMs?: number
    /** Per node op request timeouts (see NODE_TIMEOUTS_MS). */
    readonly nodeTimeoutsMs?: SpokeHubOptions["nodeTimeoutsMs"]
  }
}

export interface Central {
  readonly url: string
  readonly publicURL: string
  readonly store: Store
  readonly auth: Auth
  readonly registry: Registry
  /** Connected `hub node` daemons (never in the registry). */
  readonly nodes: NodeRegistry
  readonly spokes: SpokeHub
  readonly push: Push
  readonly speechSettings: SpeechService
  /** Backends for new code (state, bus, event log, counters, locks, catalog). */
  readonly backends: Backends
  /** Agent messages: store and delivery to sessions (the message routes use it). */
  readonly delivery: Delivery
  /** Decisions (ask @me): answered by the user on /api/decisions. */
  readonly decisions: Decisions
  /** Kill switches (per user and hub-wide) and hub.json agents.never, for the acting verbs. */
  readonly acting: ActingSwitch
  /** Launches (design §6): accept, list, stop; placement onto nodes and each launch's run to its end. */
  readonly launches: LaunchEngine
  /** Every launch change, per user (SSE 'launch' events and the agent watch subscribe; webhooks hang off it). */
  readonly launchFeed: LaunchFeed
  /** Launch-bound (hlt1) tokens: what a sandboxed harness connects back to /spoke/ws with (phase 5). */
  readonly launchTokens: LaunchTokens
  /** Webhooks (P4-T10): registrations and the outbox sender; launch changes are published to it. */
  readonly webhooks: Webhooks
  /** The JSON API's route table (method, path, access), for audits and tests. */
  readonly routes: readonly RouteInfo[]
  stop(): Promise<void>
}

type Message = { type: string; [key: string]: unknown }

interface Listener {
  readonly userID: string
  readonly deviceID: string
  /** Leaves out streamed text and reasoning (except of `session`'s tree). */
  readonly lite: boolean
  /** The session the page shows: its tree's text and reasoning stream even when lite. */
  readonly session?: string
  /** Sends a message; `id` is its event id (EventSource's lastEventId). */
  send(message: Message, id?: string): void
  close(): void
}

/** Messages a lite stream leaves out (unless they are of the listener's session tree). */
const STREAMED = new Set(["delta", "reasoning"])

/**
 * Who may call a route: anyone, any signed-in user, admins, or the owner of the :session / :machine in the path;
 * "agent": an /api/agent route (src/central/agent), checked per credential kind there.
 */
export type Access = "public" | "user" | "admin" | "session" | "machine" | "agent"

export interface RouteInfo {
  readonly method: string
  /** Express-style path, e.g. /api/sessions/:session/turn. */
  readonly path: string
  readonly access: Access
}

interface Context {
  readonly request: Request
  readonly server: Server<SpokeSocketData>
  readonly url: URL
  readonly params: Record<string, string>
  readonly device: DeviceRecord
  readonly user: UserRecord
}

type Handler = (context: Context) => Response | Promise<Response>

interface Route extends RouteInfo {
  readonly handle: Handler
  readonly pattern: RegExp
  readonly keys: string[]
  /** Speech routes refused (403 not_exposed) while Voice is off for the session; inspection and control are not. */
  readonly exposed: boolean
}

const NO_STORE = { "cache-control": "no-store" }

export const COOKIE = "voice_device"
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60
const SSE_HEARTBEAT_MS = 20_000
/**
 * `POST …/turn` with `Prefer: respond-async`: a turn that has not settled after this long is answered 202 and
 * finishes in the background (result as an SSE `turn` event). Long enough for the quick refusals (busy, unknown
 * session, spoke error), short enough that no proxy cuts the request (Traefik's default readTimeout is 60 s).
 */
export const TURN_ACCEPT_MS = 1500
const NO_OWNER = "No OpenCode process for this session is connected"
const AUTO_NAME_OUTDATED = "Update the Hub plugin to use Auto-name"
const NOT_EXPOSED = "Voice is not enabled for this session"
/** A permission or question that is not pending any more: someone answered it elsewhere, or it expired. */
const PERMISSION_GONE = "This request was already answered or expired"
/** Longest directory and title accepted for a new session (as in the spoke protocol). */
const MAX_DIRECTORY_CHARS = 4096
const MAX_TITLE_CHARS = 200
/** Longest Herdr workspace ID accepted (as in the spoke protocol). */
const MAX_HERDR_WORKSPACE_CHARS = 100
/** View preferences: entries per list and characters per entry. */
const VIEW_PREF_MAX_ENTRIES = 500
/** hiddenSessions holds archived sessions (Archive in the console), which add up over time. */
const VIEW_PREF_MAX_ARCHIVED = 5000
const VIEW_PREF_MAX_CHARS = 4096
const DECISIONS = new Set<PermissionDecision>(["once", "always", "reject"])
/** Longest utterance accepted for conversation mode (characters, after trimming). */
export const MAX_UTTERANCE_CHARS = 4000
/** Longest typed prompt or steer accepted (characters, after trimming); a bigger one would not fit in a frame. */
export const MAX_PROMPT_CHARS = 100_000
/** The shell's answer when the hub has no built web app (e.g. the plugin installed from GitHub). */
const WEB_NOT_BUILT = [
  "This hub has no built web app (web/dist).",
  "",
  "To run a hub, install it from npm (`opencode plugin add @huynle/hub`, or `bunx --package @huynle/hub hub-server`)",
  "or use a release binary (https://github.com/huynle/hub/releases), which ship the web app.",
  "In a source checkout, run `npm install && npm run build:web` first.",
].join("\n")
/** Preview text for POST /api/settings/speech/test. */
const SPEECH_TEST_TEXT = "Hi! This is how I will sound when I read replies to you."
const SPEECH_TEST_MAX_CHARS = 300
const APP_ROUTES = /^\/(?:|pair|approve|new|settings|s\/[^/]+)$/
const STATIC_PATH = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/
/** Where a one-time sign-in link may land: home, or a session (with Voice mode starting: `?voice=1`). */
const LOGIN_NEXT = /^\/(?:s\/[A-Za-z0-9_-]+(?:\?voice=1)?)?$/
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  // Voice mode's on-device speech detection (Silero VAD through onnxruntime-web)
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
}
/** Vite's content-hashed build output: a changed file gets a new name, so it can be cached for good. */
const HASHED_ASSET = /^assets\//
const IMMUTABLE = "public, max-age=31536000, immutable"
/** Hashed assets sent compressed when the browser accepts it (onnxruntime's wasm: 12 MB → 2.3 MB with Brotli). */
const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".wasm", ".json", ".svg"])
const MIN_COMPRESS_BYTES = 1024
const brotli = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/** "br" or "gzip" when the Accept-Encoding header allows it (q=0 refuses), else undefined. */
function pickEncoding(header: string | null): "br" | "gzip" | undefined {
  const accepted = new Map<string, number>()
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";")
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean)
    if (name) accepted.set(name.trim(), q === undefined ? 1 : Number(q))
  }
  for (const encoding of ["br", "gzip"] as const) if ((accepted.get(encoding) ?? 0) > 0) return encoding
  return undefined
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable reason, e.g. not_exposed. */
    readonly code?: string,
  ) {
    super(message)
  }
}

const error = (status: number, message: string, code?: string) =>
  Response.json({ error: message, ...(code ? { code } : {}) }, { status })

export function startCentral(options: CentralOptions): Central {
  const { config } = options
  const heartbeatMs = options.timing?.heartbeatMs ?? SSE_HEARTBEAT_MS
  const web: WebAssets = options.web ?? diskAssets(options.webDir ?? path.join(import.meta.dir, "..", "..", "web", "dist"))
  const now = options.now ?? Date.now
  const store = Store.open(config.stateDir, now, { mode: config.auth.mode })
  /** Used only by new code; existing state stays in the store, registry and event log. */
  const backends = options.backends ?? fileBackends({ stateDir: config.stateDir, now })
  // A machine's tenant is its owner (read live: ownership moves on migration).
  const registry = new Registry(now, undefined, (machineID) => store.machines().find((m) => m.id === machineID)?.ownerID)
  const nodes = new NodeRegistry((machineID) => store.machines().find((m) => m.id === machineID)?.ownerID, now)
  const push = new Push({ store, subject: config.vapidSubject, sender: options.pushSender })
  const notifier = options.notifier ?? push
  /** SSE subscribers, one user each. */
  const listeners = new Set<Listener>()
  /** Recent messages per user, replayed to a stream that reconnects with Last-Event-ID. */
  const eventLog = new EventLog()
  /** Whether a listener wants a message (lite streams skip other sessions' streamed text). */
  const wants = (listener: Listener, message: Message): boolean => {
    if (!listener.lite || !STREAMED.has(message.type)) return true
    if (!listener.session) return false
    const root = registry.status(listener.session)?.[0]?.id ?? listener.session
    return message.sessionID === listener.session || message.rootID === root || message.sessionID === root
  }
  /** Logs a message for one user and sends it to their streams (except `exceptDevice`'s). */
  const toUser = (userID: string, message: Message, exceptDevice?: string) => {
    // A catalog is logged as a marker: a replay sends one fresh catalog for any number of them.
    const id = eventLog.append(userID, message.type === "catalog" ? { type: "catalog" } : message, exceptDevice)
    for (const listener of [...listeners]) {
      if (listener.userID !== userID || listener.deviceID === exceptDevice) continue
      if (message.type === "catalog") listener.send({ type: "catalog", machines: machines(userID) }, id)
      else if (wants(listener, message)) listener.send(message, id)
    }
  }
  /**
   * Sends to SSE subscribers: catalog to everyone (each gets their own machines), `admins` messages to
   * admins only, anything else only to `tenant` (the session's owner). Streams of users who were
   * disabled are closed.
   */
  const broadcast = (message: Message, audience: { tenant?: string; admins?: true } = {}) => {
    for (const listener of [...listeners]) {
      const user = store.user(listener.userID)
      if (!user || user.disabled) listener.close()
    }
    const users = new Set([...eventLog.users(), ...[...listeners].map((l) => l.userID)])
    for (const userID of users) {
      const user = store.user(userID)
      if (!user || user.disabled) continue
      if (message.type === "catalog") toUser(userID, message)
      else if (audience.admins) {
        if (user.role === "admin") toUser(userID, message)
      } else if (audience.tenant !== undefined && audience.tenant === userID) toUser(userID, message)
    }
  }
  const speechSettings = new SpeechService({
    store,
    defaults: {
      apiKey: config.apiKey,
      sttModel: config.sttModel,
      ttsModel: config.ttsModel,
      voice: config.voice,
      ...(config.speech ? { file: config.speech } : {}),
    },
    fetch: options.fetch,
  })

  // Assigned right after the server starts listening; no request can arrive before that.
  let publicURL = config.publicURL
  let auth!: Auth
  let spokes!: SpokeHub
  /** At most one machine per hub process is approved without confirmation (see localAutoApprove). */
  let autoApproved = false

  const server = Bun.serve<SpokeSocketData>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255,
    maxRequestBodySize: Math.max(config.maxAudioBytes + 1024, 1 << 20),
    fetch: (request, server) => handle(request, server),
    websocket: {
      open: (ws) => spokes.websocket.open?.(ws),
      message: (ws, raw) => spokes.websocket.message(ws, raw),
      close: (ws, code, reason) => spokes.websocket.close?.(ws, code, reason),
      pong: (ws, data) => spokes.websocket.pong?.(ws, data),
      idleTimeout: 0,
    },
  })
  const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${server.port}`
  if (config.port === 0 && publicURL.endsWith(":0")) publicURL = url
  // A loopback public URL is the same site under localhost, 127.0.0.1 and [::1] (same scheme and port).
  const origins = loopbackOrigins(publicURL)
  const secure = publicURL.startsWith("https:")

  auth = new Auth({ store, publicURL, now, mode: config.auth.mode })
  // options.fetch is for speech providers only; sign-in always talks to the real issuer.
  const oidc = config.auth.mode === "oidc" ? new OidcClient({ config: config.auth, publicURL, now }) : undefined
  /** Speech settings scope of a user: "local" (pairing mode) uses the server default directly. */
  const speechScope = (userID: string) => (userID === LOCAL_USER ? undefined : userID)
  const speechFor = (userID: string): Speech => options.speech ?? speechSettings.forUser(speechScope(userID))
  const tokenKeys = TokenKeys.open(config.stateDir)
  // Launch-bound tokens (phase 5): checked against the launch engine's store (created below; read only at use).
  const launchTokens: LaunchTokens = new LaunchTokens({ keys: tokenKeys, store, launches: { launch: (userID, launchID) => launches.store.get(userID, launchID) }, publicURL, now })
  spokes = new SpokeHub({
    store,
    auth,
    registry,
    nodes,
    publicURL,
    notifier,
    broadcast: (message, tenant) => broadcast(message, { tenant }),
    turnTimeoutMs: config.turnTimeoutMs,
    launchTokens,
    ...options.timing,
  })
  // Session tokens (design §1.3): minted for the sessions spokes report, pushed on their sessions frames.
  const sessionTokens = new SessionTokens({ keys: tokenKeys, store, sessions: registry, publicURL, now })
  const tokenPush = new SessionTokenPush({
    registry,
    tokens: sessionTokens,
    send: (connID, req) => spokes.request(connID, req),
    hubURL: publicURL,
    now,
    log: (message) => console.error(message),
  })
  registry.onSessions((connID) => void tokenPush.sessions(connID))
  tokenPush.start()

  /** The user's machines with their live processes and sessions. */
  const machines = (userID: string) => {
    const online = new Map(registry.catalog().map((m) => [m.id, m]))
    return store
      .machines()
      .filter((m) => !m.revoked && m.ownerID === userID)
      .map((m) => ({
        id: m.id,
        name: m.name,
        created: m.created,
        lastSeen: m.lastSeen,
        online: online.has(m.id),
        processes: online.get(m.id)?.processes ?? [],
        ...(online.get(m.id)?.terminals ? { terminals: online.get(m.id)!.terminals } : {}),
      }))
  }

  registry.subscribe((message, tenant) => broadcast({ ...message }, tenant !== undefined ? { tenant } : {}))
  registry.subscribeAlerts((alert) => {
    // Push goes to the session owner's devices only; an alert without an owner goes nowhere.
    if (!alert.owner) return
    // Activity updates are collected and throttled per device by the push layer.
    if (alert.kind === "activity") return push.activity(alert)
    const extra = {
      ...(alert.requestID ? { requestID: alert.requestID } : {}),
      ...(alert.subject ? { subject: alert.subject } : {}),
      ...(alert.key ? { key: alert.key } : {}),
    }
    notifier.notify(alert.kind, alert.sessionID, alert.title, alert.text, alert.owner, extra).catch((cause) => {
      console.error("[hub] push notification failed:", cause instanceof Error ? cause.message : cause)
    })
  })

  /** GET /api/push/prefs: the device's toggles and quiet hours, the user's muted sessions, and the subscriptions held. */
  const pushPrefsView = (deviceID: string, userID: string, endpoint?: string | null) => {
    const mine = store.pushSubscriptions().filter((s) => s.deviceID === deviceID)
    return Response.json(
      {
        prefs: store.pushPrefs(deviceID),
        quietHours: store.quietHours(deviceID) ?? null,
        activityMinutes: store.activityMinutes(deviceID),
        muted: store.mutedSessions(userID),
        subscriptions: mine.length,
        ...(endpoint ? { subscribed: mine.some((s) => s.endpoint === endpoint) } : {}),
      },
      { headers: NO_STORE },
    )
  }

  const cookie = (token: string, maxAge = COOKIE_MAX_AGE) =>
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`

  /** The device of the voice_device cookie and its user; undefined when unknown or the user is disabled. */
  const deviceFor = (request: Request): { device: DeviceRecord; user: UserRecord } | undefined => {
    const header = request.headers.get("cookie") ?? ""
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=")
      if (name !== COOKIE) continue
      const device = store.findDevice(rest.join("="))
      if (!device) continue
      const user = store.user(device.ownerID)
      return user && !user.disabled ? { device, user } : undefined
    }
    return undefined
  }

  const oidcCookie = (state: string, maxAge: number) =>
    `${OIDC_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${maxAge}${secure ? "; Secure" : ""}`

  async function authLogin(url: URL): Promise<Response> {
    const { location, state } = await oidc!.login(url.searchParams.get("next"))
    const headers = new Headers({ location, "cache-control": "no-store" })
    headers.append("set-cookie", oidcCookie(state, 600))
    return new Response(null, { status: 302, headers })
  }

  async function authCallback(request: Request, url: URL): Promise<Response> {
    if (config.auth.mode !== "oidc") throw new Error("oidc is not configured")
    const settings = config.auth
    const cleared = { "set-cookie": oidcCookie("", 0) }
    const deny = (status: number, title: string, message: string) => authPage(status, title, message, cleared)
    let result: Awaited<ReturnType<OidcClient["callback"]>>
    try {
      result = await oidc!.callback(url.searchParams, cookieValue(request.headers.get("cookie"), OIDC_COOKIE))
    } catch (cause) {
      if (!(cause instanceof OidcError)) throw cause
      if (cause.audited) store.audit({ actor: "system", action: "signin.denied", detail: cause.reason })
      else console.warn(`[hub] sign-in refused: ${cause.reason}`)
      return deny(cause.status, "Sign-in failed", cause.message)
    }
    const { identity, next } = result
    if (!emailAllowed(settings, identity.email)) {
      store.audit({ actor: "system", action: "signin.denied", target: identity.email, detail: "not allowed" })
      return deny(403, "Not allowed", `${identity.email} is not allowed to use this hub. Ask its admin to add you.`)
    }
    const role = settings.admins.includes(identity.email) ? "admin" : "user"
    const existing = store.userByEmail(identity.email)
    if (existing?.disabled) {
      store.audit({ actor: "system", action: "signin.denied", target: identity.email, detail: "disabled" })
      return deny(403, "Account disabled", "Your account on this hub is disabled. Ask its admin.")
    }
    const user = store.upsertUser({ email: identity.email, ...(identity.name ? { name: identity.name } : {}), role })
    if (user.role === "admin" && store.migrateLocal(user.id)) broadcast({ type: "catalog" })
    const headers = new Headers({ "cache-control": "no-store" })
    headers.append("set-cookie", cleared["set-cookie"])
    const current = deviceFor(request)
    let deviceID: string
    if (current && current.user.id === user.id) deviceID = current.device.id
    else {
      const { device, token } = store.addDevice(deviceName(request.headers.get("user-agent")), user.id)
      deviceID = device.id
      headers.append("set-cookie", cookie(token))
    }
    store.audit({ actor: user.id, action: "signin", target: deviceID })
    // Speech not usable yet (e.g. no key): land on the page's speech setup (the console opens Settings → Speech for #speech).
    const setup = !next.includes("#") && speechSettings.view(speechScope(user.id)).ready.reason ? "#speech" : ""
    headers.set("location", `${next}${setup}`)
    return new Response(null, { status: 302, headers })
  }

  /** CSRF guard for state-changing requests: Origin (or Referer) must be the public origin (any loopback name for a local hub). */
  const sameOrigin = (request: Request): boolean => {
    const origin = request.headers.get("origin")
    if (origin) return origins.has(origin)
    const referer = request.headers.get("referer")
    if (!referer) return false
    try {
      return origins.has(new URL(referer).origin)
    } catch {
      return false
    }
  }

  /** A push to the user about one session (titled by it; "" opens the console), whatever device shows it. */
  const pushUser = (kind: "decision" | "message", userID: string, sessionID: string, key: string, decisionID?: string) => {
    const title = (sessionID && registry.status(sessionID)?.find((s) => s.id === sessionID)?.title) || "Hub"
    notifier.notify(kind, sessionID, title, undefined, userID, { key, ...(decisionID ? { decisionID } : {}) }).catch((cause) => {
      console.error("[hub] push notification failed:", cause instanceof Error ? cause.message : cause)
    })
  }

  const directory = hubDirectory({ registry, store, now })
  // Agent messages (design §3): delivered through spokes that announce "deliver"; pending ones flush on every
  // sessions frame; human turns (console turn/utterance, prompts typed in the harness) reset hop chains.
  const delivery = new Delivery({
    state: backends.state,
    counters: backends.counters,
    registry,
    directory,
    send: (connID, req) => spokes.request(connID, req),
    now,
    describe: (userID, sessionID) => {
      try {
        const entry = directory.resolve(userID, sessionID).sessions[0]
        const machine = entry?.machineID ? store.machines().find((m) => m.id === entry.machineID)?.name : undefined
        return { ...(entry?.name ? { name: entry.name } : {}), ...(machine ? { machine } : {}) }
      } catch {
        return {}
      }
    },
    // Push kind "message": a msg to @me, an ask left unanswered, a message loop (sent even while watched).
    alert: (userID, alert) => pushUser("message", userID, alert.sessionID, `${alert.kind}:${alert.messageID}`),
  })
  /** Message events (watch, waiters), shared by the agent routes and the console's Decision answers. */
  const feed = new MessageFeed()
  // Decisions (design §12.1): asks to @me; deadlines run over every user's Decisions (survive restarts).
  const decisions = new Decisions({
    state: backends.state,
    delivery,
    now,
    users: () => store.users().map((u) => u.id),
    notify: (userID, decision, reason) => pushUser("decision", userID, decision.sessionID ?? "", `${decision.id}:${reason}`, decision.id),
    // The console's live Decision cards: opened, answered (here, by timeout), escalated, expired.
    changed: (userID, decision) => broadcast({ type: "decision", decision }, { tenant: userID }),
    // Escalations' Decisions reply to the permission as the user; grant requests' create the grant as the user
    // (both are set up below).
    act: (userID, decision, choice, by) => (decision.action?.kind === "grant" ? grantRequests.act(userID, decision, choice, by) : escalations.act(userID, decision, choice, by)),
  })
  decisions.start()
  /** The user prompted the session: its message hop chain starts over (never fails the prompt). */
  const humanTurn = async (sessionID: string): Promise<void> => {
    const tenant = registry.sessionTenant(sessionID)
    if (tenant === undefined) return
    await delivery.humanTurn(tenant, sessionID).catch((cause) => console.error(`[hub] hop reset failed: ${(cause as Error).message}`))
  }
  registry.onSessions((connID) => void delivery.onSessions(connID).catch((cause) => console.error(`[hub] message flush failed: ${(cause as Error).message}`)))
  registry.onHumanTurn((sessionID) => void humanTurn(sessionID))
  /** Permission, form, prompt and stop execution, shared by the console routes and the agent act verbs. */
  const actions = createActions({ registry, spokes, humanTurn })
  delivery.start()
  // Launches (design §6): placement onto the user's nodes, prepare on the node, the session through the machine's
  // service spoke, then its end; restart recovery runs on start. Every change goes to launchFeed: the owner's
  // console streams get it as a 'launch' event.
  const launchFeed = new LaunchFeed()
  launchFeed.subscribe((userID, launch) => broadcast({ type: "launch", launch: launchInfo(launch) }, { tenant: userID }))
  const launches = new LaunchEngine({
    state: backends.state,
    counters: backends.counters,
    locks: backends.locks,
    owner: `hub-${process.pid}-${randomBytes(4).toString("hex")}`,
    ...(config.launchCaps ? { caps: config.launchCaps } : {}),
    nodes,
    nodeOps: spokes,
    registry,
    spokes,
    directory,
    delivery,
    decisions,
    actions,
    // openshell launches: the node starts the sandbox's harness with an hlt1 token and the hub's public URL.
    launchTokens,
    hubURL: publicURL,
    users: () => store.users().map((u) => u.id),
    now,
    onLaunchChanged: (launch) => launchFeed.publish(launch.owner, launch),
  })
  // A launch-bound connection lives only while its launch is provisioning or running: it is closed (and refused from
  // then on) when the launch ends. Not on queued: that would refuse the sandbox's spoke before it ever connects.
  launchFeed.subscribe((_userID, launch) => {
    if (launch.state === "ended") spokes.closeLaunch(launch.id)
  })
  void launches.start().catch((cause) => console.error(`[hub] launches did not start: ${(cause as Error).message}`))
  // Webhooks (P4-T10): launch changes go to the owner's matching registrations through the durable outbox; URLs
  // are checked again at every send; private targets only with hub.json agents.webhooks.allowPrivate.
  const webhooks = new Webhooks({
    state: backends.state,
    locks: backends.locks,
    now,
    source: publicURL,
    users: () => store.users().map((u) => u.id),
    resolve: options.resolveHost ?? systemResolveHost,
    ...(config.webhooksAllowPrivate ? { allowPrivate: true } : {}),
    appAlive: (userID, tokenID) => store.agentData(userID).appTokens?.some((t) => t.id === tokenID && Array.isArray(t.scopes) && t.scopes.includes(WEBHOOK_SCOPE)) === true,
    userAgent: `hub/${options.version ?? "0.0.0"}`,
  })
  launchFeed.subscribe((userID, launch) => {
    void webhooks.onLaunch(userID, launch, launchInfo(launch)).catch((cause) => console.error(`[hub] webhook queue failed: ${(cause as Error).message}`))
  })
  webhooks.start()

  // One credential resolver for every /api request: device cookie, device token, session and app tokens.
  // Every stored agent message also goes to the user's console streams (live transcript rows).
  feed.subscribe((userID, message) => broadcast({ type: "message", message }, { tenant: userID }))
  const audit = new AgentAudit({ state: backends.state, now, admin: store, recorded: (userID, entry) => broadcast({ type: "agent", entry }, { tenant: userID }) })
  const grants = new Grants({ state: backends.state, counters: backends.counters, directory, store, admin: store, now })
  const acting = new ActingSwitch({ store, never: config.agentsNever, audit })
  /** An agent as envelopes name it (a session by its directory name). */
  const describeActor = (userID: string, actor: AgentActor) => {
    if (actor.kind !== "session") return partyFromActor(actor)
    try {
      const name = directory.resolve(userID, actor.sessionID).sessions[0]?.name
      return partyFromActor(actor, name ? { name } : {})
    } catch {
      return partyFromActor(actor)
    }
  }
  // needs_user escalations (P3-T8): one Decision per (holder, request); answered as the user; closed when the
  // request goes elsewhere.
  const escalations: Escalations = new Escalations({
    state: backends.state,
    counters: backends.counters,
    decisions,
    registry,
    actions,
    audit,
    now,
    describe: describeActor,
    published: (userID, message) => feed.publish(userID, message),
  })
  // Grant requests (P3-T9): an agent asks; the user's tap creates the grant as the user.
  const grantRequests: GrantRequests = new GrantRequests({
    state: backends.state,
    counters: backends.counters,
    decisions,
    grants,
    directory,
    audit,
    now,
    describe: describeActor,
    published: (userID, message) => feed.publish(userID, message),
  })
  registry.onPermissionClosed((requestID, _sessionID, tenant) => {
    void escalations.closed(tenant, requestID).catch((cause) => console.error(`[hub] escalation close failed: ${(cause as Error).message}`))
  })
  const escalate: Escalate = (escalation) => escalations.escalate(escalation)
  const agentDeps = { store, sessionTokens, directory, registry, spokes, delivery, decisions, feed, heartbeatMs, now, audit, grants, grantRequests, acting, actions, escalate, launches, launchFeed, webhooks, maxPromptChars: MAX_PROMPT_CHARS }
  const resolveActor = createResolver({
    cookieName: COOKIE,
    findDevice: (token) => store.findDevice(token),
    user: (id) => store.user(id),
    verifiers: [...agentVerifiers(agentDeps), ...(options.agent?.verifiers ?? [])],
  })
  const agent = agentApi({
    resolve: resolveActor,
    cookieName: COOKIE,
    sameOrigin,
    touch: (user, device) => {
      if (device) store.touchDevice(device.id)
      store.touchUser(user.id)
    },
    routes: [...agentRoutes(agentDeps), ...(options.agent?.routes ?? [])],
  })

  async function handle(request: Request, server: Server<SpokeSocketData>): Promise<Response | undefined> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method
    try {
      if (pathname === "/spoke/ws") return spokes.upgrade(request, server)
      if (method === "GET" && pathname === "/healthz") {
        return Response.json({ ok: true, version: options.version ?? "0.0.0", spokes: registry.connections(), nodes: nodes.count() })
      }
      if (method === "POST" && pathname === "/spoke/enroll") {
        const start = auth.startEnrollment((await body(request)).machineName)
        const auto = config.auth.mode === "pairing" && localAutoApprove({
          host: config.host,
          publicURL,
          peer: server.requestIP(request)?.address,
          forwarded: FORWARD_HEADERS.some((h) => request.headers.has(h)),
          machines: store.machines().length,
          devices: store.devices().length,
          used: autoApproved,
        })
        if (auto && auth.approveEnrollment(start.userCode)) {
          autoApproved = true
          console.log(`[hub] local hub: approved the first machine (code ${start.userCode}) without confirmation; later machines need approval`)
          return Response.json({ ...start, autoApproved: true } satisfies EnrollStart)
        }
        broadcast({ type: "enrollment" }, { admins: true })
        return Response.json(start)
      }
      if (method === "POST" && pathname === "/spoke/enroll/poll") {
        const poll = auth.pollEnrollment((await body(request)).deviceCode)
        if (poll.status === "approved") broadcast({ type: "catalog" })
        return Response.json(poll)
      }
      if (method === "GET" && pathname === "/.well-known/hub") {
        return wellKnown({ publicURL, version: options.version ?? "0.0.0", auth: config.auth.mode === "oidc" ? { mode: "oidc", issuer: config.auth.issuer } : { mode: "pairing" } })
      }
      if (method === "GET" && pathname === "/login") return login(request, url)
      if (oidc && method === "GET" && pathname === "/auth/login") return await authLogin(url)
      if (oidc && method === "GET" && pathname === "/auth/callback") return await authCallback(request, url)
      if (isAgentPath(pathname)) return await agent.handle(request, url)
      if (pathname.startsWith("/api/")) return await api(request, server, url)
      if (method === "GET") return await staticFile(pathname, request.headers.get("accept-encoding"))
      return error(404, "Not found")
    } catch (cause) {
      return failure(cause)
    }
  }

  function login(request: Request, url: URL): Response {
    const next = url.searchParams.get("next") ?? "/"
    if (!LOGIN_NEXT.test(next)) return error(400, "Invalid next path")
    const ownerID = auth.redeemLogin(url.searchParams.get("code"))
    if (!ownerID) {
      return new Response("This sign-in link has expired or was already used. Run /hub again.", {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    // Speech not usable yet (e.g. no key): land on the page's speech setup (the console opens Settings → Speech for #speech).
    const setup = speechSettings.view(speechScope(ownerID)).ready.reason ? "#speech" : ""
    const headers = new Headers({ location: `${next}${setup}`, "cache-control": "no-store" })
    // A link signs in as the machine's owner: a browser signed in as someone else gets a new device.
    if (deviceFor(request)?.user.id !== ownerID) {
      const { device, token } = store.addDevice("Browser (sign-in link)", ownerID)
      store.audit({ actor: ownerID, action: "device.pair", target: device.id, detail: "login link" })
      headers.set("set-cookie", cookie(token))
    }
    return new Response(null, { status: 302, headers })
  }

  // ---------- JSON API: a route table with declared access, enforced here before any handler runs ----------

  const ownMachine = (userID: string, machineID: string) =>
    store.machines().find((m) => m.id === machineID && !m.revoked && m.ownerID === userID)

  /** Session routes that also answer for the user's offline sessions the directory knows (hub-side data only). */
  const OFFLINE_SESSION_ROUTES = new Set(["/api/sessions/:session/messages"])
  /** No spoke reports the session (for anyone) and the user's directory has a record of it (not deleted). */
  const knownOffline = (userID: string, sessionID: string) =>
    registry.sessionTenant(sessionID) === undefined && (store.agentData(userID).sessions ?? []).some((s) => s.sessionID === sessionID && s.deletedAt === undefined)
  const route = (method: string, path: string, access: Access, handle: Handler, exposed = false): Route => {
    const keys: string[] = []
    const pattern = new RegExp(`^${path.replace(/:([a-z]+)/g, (_, key: string) => (keys.push(key), "([^/]+)"))}$`)
    return { method, path, access, handle, pattern, keys, exposed }
  }

  const routes: Route[] = [
    // public
    route("GET", "/api/auth", "public", () =>
      Response.json({ mode: config.auth.mode, signIn: oidc ? "/auth/login" : null }, { headers: { "cache-control": "no-store" } }),
    ),
    route("POST", "/api/pair", "public", async ({ request }) => {
      const input = await body(request)
      const paired = auth.pair(input.code, input.deviceName)
      if (!paired) return error(401, "Invalid or expired pairing code")
      store.audit({ actor: paired.device.ownerID, action: "device.pair", target: paired.device.id })
      return Response.json({ device: deviceView(paired.device) }, { headers: { "set-cookie": cookie(paired.token) } })
    }),
    // A native app trades a link code for a device token (kept by the app, sent as Authorization: Bearer): no cookie.
    route("POST", "/api/devices/redeem", "public", async ({ request }) => {
      const input = await body(request)
      const linked = auth.redeemLink(input.code, input.deviceName, input.publicKey)
      if (!linked) return error(401, "Invalid or expired link code")
      store.audit({ actor: linked.device.ownerID, action: "device.pair", target: linked.device.id, detail: "app link" })
      return Response.json({ device: deviceView(linked.device), token: linked.token }, { headers: NO_STORE })
    }),

    // any signed-in user, own data only
    route("GET", "/api/me", "user", ({ device, user }) =>
      Response.json({
        device: deviceView(device),
        user: userView(user),
        auth: config.auth.mode,
        publicURL,
        version: options.version ?? "0.0.0",
      }),
    ),
    route("GET", "/api/machines", "user", ({ user }) => Response.json({ machines: machines(user.id) })),
    route("GET", "/api/events", "user", ({ request, server, user, device, url }) => {
      server.timeout(request, 0)
      const session = url.searchParams.get("session")
      return events(request.signal, user.id, device.id, {
        lastID: request.headers.get("last-event-id") ?? url.searchParams.get("last") ?? undefined,
        lite: url.searchParams.get("lite") === "1",
        ...(session && session.length <= 300 && registry.owns(user.id, session) ? { session } : {}),
      })
    }),
    // The phone's session view (hidden/pinned sessions and workspaces), per user, synced to their other devices.
    route("GET", "/api/prefs/view", "user", ({ user }) => Response.json({ prefs: store.viewPrefs(user.id) }, { headers: NO_STORE })),
    route("PUT", "/api/prefs/view", "user", async ({ request, user, device }) => {
      const prefs = store.setViewPrefs(user.id, viewPrefsInput(await request.json()))
      // The user's other devices only: never another user, and not the device that made the change.
      toUser(user.id, { type: "prefs", prefs }, device.id)
      return Response.json({ prefs }, { headers: NO_STORE })
    }),
    route("GET", "/api/reads", "user", ({ user }) => Response.json({ reads: store.reads(user.id) }, { headers: NO_STORE })),
    route("POST", "/api/enrollments/:code/approve", "user", ({ params, user }) => decideEnrollment(params.code!, "approved", user)),
    route("POST", "/api/enrollments/:code/deny", "user", ({ params, user }) => decideEnrollment(params.code!, "denied", user)),
    route("GET", "/api/devices", "user", ({ device, user }) =>
      Response.json({
        devices: store
          .devices()
          .filter((d) => d.ownerID === user.id)
          .map((d) => ({ ...deviceView(d), current: d.id === device.id })),
      }),
    ),
    // A link code for a native app, shown as a QR code / deep link in Settings → Devices → Add app.
    route("POST", "/api/devices/link", "user", ({ user }) => {
      const { code, expiresAt } = auth.issueLinkCode(user.id)
      store.audit({ actor: user.id, action: "device.link" })
      const url = `${APP_SCHEME}://link?hub=${encodeURIComponent(publicURL)}&code=${code}`
      return Response.json({ code, expiresAt, hub: publicURL, url }, { headers: NO_STORE })
    }),
    route("DELETE", "/api/devices/:id", "user", ({ params, user }) => {
      const target = store.devices().find((d) => d.id === params.id && d.ownerID === user.id)
      if (!target || !store.removeDevice(target.id)) return error(404, "No such device")
      store.audit({ actor: user.id, action: "device.revoke", target: target.id })
      return new Response(null, { status: 204 })
    }),
    route("POST", "/api/logout", "user", ({ device }) => {
      store.removeDevice(device.id)
      return new Response(null, { status: 204, headers: { "set-cookie": cookie("", 0) } })
    }),
    route("POST", "/api/transcribe", "user", ({ request, user }) => transcribe(request, speechFor(user.id))),
    route("POST", "/api/speak", "user", async ({ request, user }) => {
      const text = speakable(String((await body(request)).text ?? ""), config.maxSpeechChars)
      if (!text) return error(400, "Nothing to speak")
      const speech = speechFor(user.id)
      // Passed through as the provider sends it, so the phone can start playing before synthesis ends.
      const audio = speech.speakStream ? await speech.speakStream(text, request.signal) : await speech.speak(text)
      return new Response(audio, { headers: { "content-type": "audio/mpeg" } })
    }),
    route("GET", "/api/push/key", "user", () => Response.json({ publicKey: push.publicKey() })),
    route("POST", "/api/push/subscribe", "user", async ({ request, device }) => {
      const input = await body(request)
      const target = pushTarget(input.subscription)
      if (!target) return error(400, "Invalid push subscription")
      const problem = await pushEndpointProblem(target.endpoint, options.resolveHost ?? systemResolveHost)
      if (problem) return error(400, `Invalid push subscription: ${problem}`)
      // pushsubscriptionchange: the service worker sends the endpoint it replaces.
      if (typeof input.oldEndpoint === "string" && input.oldEndpoint !== target.endpoint) store.removePushSubscription(device.id, input.oldEndpoint)
      store.addPushSubscription(device.id, target)
      const prefs = prefsInput(input.prefs)
      return Response.json({ prefs: prefs ? store.setPushPrefs(device.id, prefs) : store.pushPrefs(device.id) })
    }),
    route("POST", "/api/push/unsubscribe", "user", async ({ request, device }) => {
      const endpoint = (await body(request)).endpoint
      if (typeof endpoint !== "string" || !store.removePushSubscription(device.id, endpoint)) {
        return error(404, "No such subscription on this device")
      }
      return new Response(null, { status: 204 })
    }),
    route("GET", "/api/push/prefs", "user", ({ device, user, url }) => pushPrefsView(device.id, user.id, url.searchParams.get("endpoint"))),
    route("PUT", "/api/push/prefs", "user", async ({ request, device, user }) => {
      const input = await body(request)
      if ("quietHours" in input) {
        const quiet = input.quietHours === null ? null : quietHoursInput(input.quietHours)
        if (quiet === undefined) return error(400, "quietHours must be {start: \"HH:MM\", end: \"HH:MM\", timeZone} or null")
        store.setQuietHours(device.id, quiet)
      }
      if ("activityMinutes" in input) {
        const minutes = input.activityMinutes
        if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < ACTIVITY_INTERVAL_MIN || minutes > ACTIVITY_INTERVAL_MAX) {
          return error(400, `activityMinutes must be a whole number of minutes from ${ACTIVITY_INTERVAL_MIN} to ${ACTIVITY_INTERVAL_MAX}`)
        }
        store.setActivityMinutes(device.id, minutes)
      }
      const prefs = prefsInput(input)
      if (prefs) store.setPushPrefs(device.id, prefs)
      return pushPrefsView(device.id, user.id)
    }),
    route("PUT", "/api/push/mute", "user", async ({ request, user }) => {
      const input = await body(request)
      const sessionID = input.sessionID
      if (typeof sessionID !== "string" || !sessionID || sessionID.length > 200 || typeof input.muted !== "boolean") {
        return error(400, "Expected {sessionID, muted}")
      }
      return Response.json({ muted: store.setSessionMuted(user.id, sessionID, input.muted) })
    }),
    route("POST", "/api/push/test", "user", async ({ request, device }) => {
      // The body is optional (older clients send none): {kind?} picks what the test looks like.
      const kind = (await body(request).catch(() => ({}) as Record<string, unknown>)).kind
      if (kind !== undefined && !isNotificationKind(kind)) return error(400, `kind must be one of ${PUSH_PREF_KEYS.join(", ")}`)
      const subscriptions = store.pushSubscriptions().filter((s) => s.deviceID === device.id).length
      if (subscriptions === 0) return Response.json({ sent: 0, failed: [], subscriptions })
      const result = await push.test(device.id, kind)
      if ("limited" in result) {
        return Response.json({ error: "Wait a few seconds before sending another test" }, { status: 429, headers: { "retry-after": String(result.retryAfter) } })
      }
      return Response.json({ ...result, subscriptions: store.pushSubscriptions().filter((s) => s.deviceID === device.id).length })
    }),
    // The caller's own settings (pairing mode: the single owner's are the server default).
    route("GET", "/api/settings/speech", "user", ({ user }) => Response.json(speechSettings.view(speechScope(user.id)), { headers: NO_STORE })),
    // Raw JSON: anything but an object is refused by the validator.
    route("PUT", "/api/settings/speech", "user", async ({ request, user }) =>
      Response.json(speechSettings.update(await request.json(), speechScope(user.id)), { headers: NO_STORE }),
    ),
    route("GET", "/api/settings/speech/models", "user", async ({ url, user }) => {
      const kind = url.searchParams.get("kind")
      if (kind !== "stt" && kind !== "tts") return error(400, "Expected kind=stt or kind=tts")
      return Response.json(await speechSettings.models(kind, speechScope(user.id)))
    }),
    route("POST", "/api/settings/speech/test", "user", async ({ request, user }) => {
      const input = await body(request)
      if (input.kind === "stt") return error(501, "Testing speech-to-text is not supported; record something instead")
      if (input.kind !== "tts") return error(400, "Expected kind tts or stt")
      const text = speakable(typeof input.text === "string" ? input.text : "", SPEECH_TEST_MAX_CHARS - 1) || SPEECH_TEST_TEXT
      return new Response(await speechFor(user.id).speak(text), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } })
    }),

    // sessions: the caller must own the session (else 404, like an unknown one)
    route("GET", "/api/sessions/:session", "session", ({ params }) => {
      const view = registry.session(params.session!)
      return view ? Response.json(view) : error(404, "Not found")
    }),
    route("POST", "/api/sessions/:session/expose", "session", ({ request, params }) => expose(request, params.session!)),
    route("POST", "/api/sessions/:session/presence", "session", async ({ request, params, device }) => {
      const visible = (await body(request)).visible
      if (typeof visible !== "boolean") return error(400, "Expected {visible: boolean}")
      registry.setPresence(device.id, params.session!, visible)
      return new Response(null, { status: 204 })
    }),
    route("POST", "/api/sessions/:session/turn", "session", ({ request, server, params }) => turn(request, server, params.session!)),
    route("POST", "/api/sessions/:session/utterance", "session", ({ request, params }) => utterance(request, params.session!), true),
    route(
      "POST",
      "/api/sessions/:session/interrupt",
      "session",
      async ({ params }) => {
        await spokes.request(ownerOf(params.session!), { op: "interrupt", sessionID: params.session! })
        registry.cancelTurns(params.session!)
        return new Response(null, { status: 204 })
      },
    ),
    route("POST", "/api/sessions/:session/stop", "session", async ({ params }) => {
      const stopped = await actions.stop(params.session!)
      if (stopped.outcome === "offline") throw new HttpError(409, NO_OWNER)
      return Response.json(stopped.result, { headers: NO_STORE })
    }),
    route("POST", "/api/sessions/:session/rename", "session", ({ request, params }) => rename(request, params.session!)),
    route("POST", "/api/sessions/:session/conversation", "session", ({ request, params }) => conversation(request, params.session!), true),
    route("GET", "/api/sessions/:session/models", "session", async ({ params }) =>
      Response.json(await spokes.request(ownerOf(params.session!), { op: "models", sessionID: params.session! }), { headers: NO_STORE })),
    route("GET", "/api/sessions/:session/model-prefs", "session", async ({ params, user }) => {
      const prefs = store.modelPrefs(user.id, params.session!)
      const defaults = await spokes.request(ownerOf(params.session!), {
        op: "setModelPrefs",
        sessionID: params.session!,
        voice: prefs.voice ?? null,
        worker: prefs.worker ?? null,
      })
      return Response.json({ prefs, defaults: defaults.defaults }, { headers: NO_STORE })
    }),
    route("PUT", "/api/sessions/:session/model-prefs", "session", async ({ request, params, user }) => {
      const change = modelPrefsInput(await request.json())
      await checkModelSelections(ownerOf(params.session!), params.session!, change)
      const reply = await spokes.request(ownerOf(params.session!), { op: "setModelPrefs", sessionID: params.session!, ...change })
      const prefs = store.setModelPrefs(user.id, params.session!, change)
      return Response.json({ prefs, defaults: reply.defaults }, { headers: NO_STORE })
    }),
    route("GET", "/api/sessions/:session/timeline", "session", async ({ params, url }) => {
      const limitRaw = url.searchParams.get("limit")
      const limit = limitRaw === null ? undefined : Number(limitRaw)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return error(400, "limit must be 1–200")
      const cursor = url.searchParams.get("cursor") ?? undefined
      if (cursor && cursor.length > 4096) return error(400, "cursor is too long")
      // Newest-first mode: order=desc for the newest page, before=<older cursor> for the page before it.
      const order = url.searchParams.get("order") ?? undefined
      if (order !== undefined && order !== "asc" && order !== "desc") return error(400, "order must be asc or desc")
      const before = url.searchParams.get("before") || undefined
      if (before && before.length > 4096) return error(400, "before is too long")
      if (cursor && (before || order === "desc")) return error(400, "cursor cannot be combined with before or order=desc")
      try {
        const page = await spokes.request(ownerOf(params.session!), {
          op: "timeline",
          sessionID: params.session!,
          ...(limit ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(order ? { order } : {}),
          ...(before ? { before } : {}),
        })
        return Response.json(page, { headers: NO_STORE })
      } catch (cause) {
        // The row the cursor names is gone (history reverted or compacted): the console starts over.
        if (cause instanceof SpokeError && cause.message.includes("Invalid timeline cursor")) return error(400, "Invalid timeline cursor")
        throw cause
      }
    }),
    // Agent messages the session sent or received (newest first), merged into the timeline by `at` (+ watch events).
    route("GET", "/api/sessions/:session/messages", "session", async ({ params, url, user }) => {
      const raw = url.searchParams.get("limit")
      const limit = raw === null ? undefined : Number(raw)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return error(400, "limit must be 1–200")
      const messages = await delivery.messages.list(user.id, { kind: "session", sessionID: params.session! }, limit === undefined ? {} : { limit })
      return Response.json({ messages }, { headers: NO_STORE })
    }),
    route("GET", "/api/sessions/:session/timeline/messages/:message/parts/:part", "session", async ({ params }) =>
      Response.json(await spokes.request(ownerOf(params.session!), { op: "timelinePart", sessionID: params.session!, messageID: params.message!, partID: params.part! }), { headers: NO_STORE })),
    route("GET", "/api/sessions/:session/timeline/messages/:message/files/:index", "session", ({ params }) => timelineFile(params.session!, params.message!, params.index!)),
    route(
      "GET",
      "/api/sessions/:session/context",
      "session",
      async ({ params }) => Response.json(await spokes.request(ownerOf(params.session!), { op: "context", sessionID: params.session! })),
    ),
    route("POST", "/api/sessions/:session/permission", "session", ({ request, params }) => permission(request, params.session!)),
    route("POST", "/api/sessions/:session/form", "session", ({ request, params }) => form(request, params.session!)),
    route("GET", "/api/sessions/:session/summary", "session", async ({ params }) =>
      Response.json(await spokes.request(ownerOf(params.session!), { op: "summary", sessionID: params.session! }), { headers: NO_STORE })),
    route("GET", "/api/sessions/:session/diff", "session", async ({ params, url }) => {
      const file = url.searchParams.get("file")
      if (!file || file.length > 4096) return error(400, "Expected ?file=<path>")
      const { patch } = await spokes.request(ownerOf(params.session!), { op: "diff", sessionID: params.session!, file })
      return patch ? Response.json(patch, { headers: NO_STORE }) : error(404, "No changes for that file")
    }),
    route("POST", "/api/sessions/:session/read", "session", ({ params, user, device }) => {
      const reads = store.markRead(user.id, params.session!, Date.now())
      toUser(user.id, { type: "reads", reads }, device.id)
      return Response.json({ reads }, { headers: NO_STORE })
    }),

    // machines: the caller must own the machine
    route("POST", "/api/machines/:machine/sessions", "machine", ({ request, params }) => createSession(request, params.machine!)),
    route("DELETE", "/api/machines/:machine", "machine", ({ params, user }) => revokeMachine(params.machine!, user)),

    // admins: users, machines, devices, audit, enrollments, the server speech default
    route("GET", "/api/enrollments", "admin", () => Response.json({ enrollments: auth.pendingEnrollments() })),
    route("GET", "/api/admin/users", "admin", () => Response.json(store.users().map(userRow))),
    route("PUT", "/api/admin/users/:id", "admin", async ({ request, params, user }) => updateUser(params.id!, await body(request), user)),
    route("GET", "/api/admin/machines", "admin", () => {
      const online = new Set(registry.catalog().map((m) => m.id))
      const emails = new Map(store.users().map((u) => [u.id, u.email]))
      return Response.json(
        store
          .machines()
          .filter((m) => !m.revoked)
          .map((m) => ({
            id: m.id,
            name: m.name,
            created: m.created,
            lastSeen: m.lastSeen,
            online: online.has(m.id),
            ownerID: m.ownerID,
            ...(emails.get(m.ownerID) ? { ownerEmail: emails.get(m.ownerID) } : {}),
          })),
      )
    }),
    route("DELETE", "/api/admin/machines/:id", "admin", ({ params, user }) => revokeMachine(params.id!, user)),
    route("DELETE", "/api/admin/devices/:id", "admin", ({ params, user }) => {
      if (!store.removeDevice(params.id!)) return error(404, "No such device")
      store.audit({ actor: user.id, action: "device.revoke", target: params.id! })
      return new Response(null, { status: 204 })
    }),
    route("GET", "/api/admin/audit", "admin", () => Response.json(store.auditLog())),
    // The hub-wide agent kill switch: pauses every agent action for every user (reading and messaging still work).
    route("GET", "/api/admin/agents/acting", "admin", () => Response.json({ enabled: !store.actingPaused() }, { headers: NO_STORE })),
    route("PUT", "/api/admin/agents/acting", "admin", async ({ request, user }) => {
      const enabled = (await body(request)).enabled
      if (typeof enabled !== "boolean") return error(400, "enabled must be true or false")
      store.setActingPaused(!enabled)
      store.audit({ actor: user.id, action: enabled ? "agents.acting.resume" : "agents.acting.pause" })
      return Response.json({ enabled }, { headers: NO_STORE })
    }),
    // Decisions (asks to @me): the user's own; answered only here (tap: the console cookie, not a device token).
    route("GET", "/api/decisions", "user", async ({ url, user }) => {
      try {
        return Response.json({ decisions: await decisions.list(user.id, { ...optionalState(url) }) }, { headers: NO_STORE })
      } catch (cause) {
        return decisionFailure(cause)
      }
    }),
    route("GET", "/api/decisions/:id", "user", async ({ params, user }) => {
      const decision = await decisions.get(user.id, params.id!)
      return decision ? Response.json({ decision }, { headers: NO_STORE }) : error(404, "No such decision", "not_found")
    }),
    route("POST", "/api/decisions/:id/answer", "user", async ({ request, params, user, device }) => {
      const input = await body(request)
      const via = (await resolveActor.mode(request)) === "bearer" ? "device-token" : "cookie"
      try {
        const answered = await decisions.answer(user.id, params.id!, decisionAnswer(input), { kind: "user", userID: user.id, deviceID: device.id, via })
        if (answered.reply) feed.publish(user.id, answered.reply)
        store.audit({ actor: user.id, action: "decision.answer", target: params.id!, detail: answered.decision.answer?.option ?? "text" })
        return Response.json(answered, { headers: NO_STORE })
      } catch (cause) {
        return decisionFailure(cause)
      }
    }),
    route("GET", "/api/settings/speech/default", "admin", () => Response.json(speechSettings.view(), { headers: NO_STORE })),
    route("PUT", "/api/settings/speech/default", "admin", async ({ request, user }) => {
      const view = speechSettings.update(await request.json())
      store.audit({ actor: user.id, action: "speech.default" })
      return Response.json(view, { headers: NO_STORE })
    }),
  ]

  function findRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    for (const candidate of routes) {
      if (candidate.method !== method) continue
      const match = candidate.pattern.exec(pathname)
      if (!match) continue
      const params: Record<string, string> = {}
      candidate.keys.forEach((key, i) => (params[key] = param(match[i + 1]!)))
      return { route: candidate, params }
    }
    return undefined
  }

  async function api(request: Request, server: Server<SpokeSocketData>, url: URL): Promise<Response> {
    const method = request.method
    const mode = await resolveActor.mode(request)
    if (mode === "mixed") return error(400, "Send the device cookie or a bearer token, not both", "invalid")
    // Bearer requests (device tokens of native apps) are not CSRF-prone; cookie writes must be same-origin (a
    // foreign bearer next to the cookie, e.g. from an auth proxy, is ignored: still a cookie request).
    if (mode !== "bearer" && method !== "GET" && method !== "HEAD" && !sameOrigin(request) && !credentialFree(request, mode, url)) {
      return error(403, "Cross-origin request refused")
    }
    const found = findRoute(method, url.pathname)
    if (found?.route.access === "public") {
      // Public handlers never read device or user.
      return await found.route.handle({ request, server, url, params: found.params } as Context)
    }

    const resolved = await resolveActor(request)
    if (!resolved.ok) {
      if (resolved.reason === "expired") return error(401, "Token expired", "token_expired")
      return resolved.bearer ? error(401, "Invalid or revoked token", "unauthorized") : error(401, "This device is not paired")
    }
    // Console routes are for the user's devices (cookie or device token) only, never session or app tokens.
    if (resolved.actor.kind !== "user" || !resolved.device) return error(403, "This token cannot be used here", "forbidden")
    const { device, user } = resolved
    store.touchDevice(device.id)
    store.touchUser(user.id)
    if (!found) return error(404, "Not found")

    const { route: matched, params } = found
    switch (matched.access) {
      case "admin":
        if (user.role !== "admin") return error(403, "Admins only")
        break
      case "session":
        // Foreign and unknown sessions answer alike, so IDs don't leak.
        if (!registry.owns(user.id, params.session!) && !(OFFLINE_SESSION_ROUTES.has(matched.path) && knownOffline(user.id, params.session!))) return error(404, "Not found")
        // Sessions listed for discovery only: nothing but enabling voice (and presence) reaches them.
        if (matched.exposed && registry.exposed(params.session!) === false) return error(403, NOT_EXPOSED, "not_exposed")
        break
      case "machine":
        if (!ownMachine(user.id, params.machine!)) return error(404, "No such machine")
        break
    }
    return await matched.handle({ request, server, url, params, device, user })
  }

  function decideEnrollment(code: string, status: "approved" | "denied", user: UserRecord): Response {
    const machineName = auth.decide(code, status, user.id)
    if (machineName === undefined) return error(404, "No pending enrollment with that code")
    store.audit({ actor: user.id, action: status === "approved" ? "machine.approve" : "machine.deny", detail: machineName })
    broadcast({ type: "enrollment" }, { admins: true })
    return new Response(null, { status: 204 })
  }

  function revokeMachine(id: string, user: UserRecord): Response {
    if (!store.revokeMachine(id)) return error(404, "No such machine")
    store.bumpMachineEpoch(id)
    store.audit({ actor: user.id, action: "machine.revoke", target: id })
    spokes.closeMachine(id, "revoked")
    broadcast({ type: "catalog" })
    return new Response(null, { status: 204 })
  }

  function userRow(u: UserRecord) {
    return {
      id: u.id,
      ...(u.email ? { email: u.email } : {}),
      ...(u.name ? { name: u.name } : {}),
      role: u.role,
      disabled: u.disabled === true,
      created: u.created,
      lastSeen: u.lastSeen,
      machines: store.machines().filter((m) => m.ownerID === u.id && !m.revoked).length,
      devices: store.devices().filter((d) => d.ownerID === u.id).length,
    }
  }

  /** PUT /api/admin/users/:id {role?, disabled?}: the last active admin can be neither demoted nor disabled. */
  function updateUser(id: string, input: Record<string, unknown>, actor: UserRecord): Response {
    const target = store.user(id)
    if (!target) return error(404, "No such user")
    const { role, disabled } = input
    if (role !== undefined && role !== "admin" && role !== "user") return error(400, 'role must be "admin" or "user"')
    if (disabled !== undefined && typeof disabled !== "boolean") return error(400, "disabled must be true or false")
    if (role === undefined && disabled === undefined) return error(400, "Expected {role?, disabled?}")
    const activeAdmin = (u: UserRecord) => u.role === "admin" && !u.disabled
    const after: UserRecord = { ...target, ...(role ? { role: role as UserRecord["role"] } : {}), ...(disabled !== undefined ? { disabled } : {}) }
    if (activeAdmin(target) && !activeAdmin(after) && store.users().filter(activeAdmin).length <= 1) {
      return error(409, "Cannot demote or disable the last active admin. Make someone else an admin first.")
    }
    if (role && role !== target.role) store.audit({ actor: actor.id, action: "user.role", target: id, detail: role })
    if (disabled !== undefined && disabled !== (target.disabled === true)) {
      store.audit({ actor: actor.id, action: disabled ? "user.disable" : "user.enable", target: id })
    }
    store.setUser(id, { ...(role ? { role: role as "admin" | "user" } : {}), ...(disabled !== undefined ? { disabled } : {}) })
    if (disabled === true) {
      store.bumpUserEpoch(id)
      // Their machines go offline at once; their browsers get 401 from now on and lose their event streams.
      for (const machine of store.machines()) if (machine.ownerID === id) spokes.closeMachine(machine.id, "revoked")
      broadcast({ type: "catalog" })
    }
    return Response.json(userRow(store.user(id)!))
  }

  async function turn(request: Request, server: Server<SpokeSocketData>, sessionID: string): Promise<Response> {
    const input = await body(request)
    const raw = input.text
    const text = typeof raw === "string" ? raw.trim() : ""
    if (input.images !== undefined) {
      const problem = promptImagesProblem(input.images)
      if (problem) return error(400, problem)
    }
    // Only the validated fields go on; an empty list is the same as none.
    const images = Array.isArray(input.images) && input.images.length
      ? (input.images as PromptImage[]).map(({ mime, data, name }) => ({ mime, data, ...(name ? { name } : {}) }))
      : undefined
    if (!text && !images) return error(400, "Empty prompt")
    if (text.length > MAX_PROMPT_CHARS) return error(400, `Prompt longer than ${MAX_PROMPT_CHARS} characters`)
    // A turn may run for minutes: this request never times out (a stop or interrupt still answers it at once).
    server.timeout(request, 0)
    const started = await actions.prompt({ sessionID, text, ...(images ? { images } : {}), resetHops: true })
    if (started.outcome === "offline") throw new HttpError(409, NO_OWNER)
    if (started.mode === "steer") return Response.json({ mode: "steer", inboxID: started.inboxID }, { status: 202 })
    const result = started.result
    if (!/(^|[\s,])respond-async\b/i.test(request.headers.get("prefer") ?? "")) return Response.json(await result)
    // Asynchronous: answer quick results (and refusals) as usual; a turn still running is accepted (202) and its
    // result goes to the owner's consoles as an SSE `turn` event (the reply itself streams as deltas meanwhile).
    const early = await Promise.race([result.then((value) => ({ value }), (cause: unknown) => ({ cause })), sleep(options.timing?.turnAcceptMs ?? TURN_ACCEPT_MS)])
    if (early) {
      if ("cause" in early) throw early.cause
      return Response.json(early.value)
    }
    const tenant = registry.sessionTenant(sessionID)
    void result.then(
      (value) => broadcast({ type: "turn", sessionID, ...value }, { tenant }),
      (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        broadcast({ type: "turn", sessionID, ...(cause instanceof RequestTimeoutError ? { outcome: "timeout" } : { outcome: "failed", message }), reply: "" }, { tenant })
      },
    )
    return Response.json({ mode: "turn" }, { status: 202, headers: { "preference-applied": "respond-async" } })
  }

  /** GET …/timeline/messages/:message/files/:index: one image of a user message, as bytes. */
  async function timelineFile(sessionID: string, messageID: string, rawIndex: string): Promise<Response> {
    const index = /^\d{1,3}$/.test(rawIndex) ? Number(rawIndex) : NaN
    if (!Number.isInteger(index) || messageID.length > 300) return error(400, "Expected an attachment index 0–999")
    const { file, tooLarge } = await spokes.request(ownerOf(sessionID), { op: "timelineFile", sessionID, messageID, index })
    if (tooLarge) return error(413, "This image is too large to show here")
    // Only image types that are safe to render inline are served (never SVG or HTML).
    if (!file || typeof file.data !== "string" || !PROMPT_IMAGE_MIMES.includes(file.mime)) return error(404, "No such image")
    const bytes = Buffer.from(file.data, "base64")
    return new Response(bytes, {
      headers: { "content-type": file.mime, "content-length": String(bytes.length), "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    })
  }

  /**
   * Every selection must be in the session's catalog (provider, model and variant), so a typo cannot leave
   * the session failing every turn. A catalog that cannot be fetched is a 502, never an accepted selection.
   */
  async function checkModelSelections(connID: string, sessionID: string, change: { voice?: ModelSelection | null; worker?: ModelSelection | null }): Promise<void> {
    const selections = [change.voice, change.worker].filter((m): m is ModelSelection => !!m)
    if (selections.length === 0) return
    let models: readonly AvailableModel[]
    try {
      models = (await spokes.request(connID, { op: "models", sessionID })).models
    } catch (cause) {
      if (cause instanceof HttpError) throw cause
      throw new HttpError(502, `Could not fetch the session's model catalog: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    for (const m of selections) {
      const known = models.find((model) => model.providerID === m.providerID && model.modelID === m.modelID)
      if (!known || (m.variant !== undefined && m.variant !== "default" && !known.variants.includes(m.variant))) {
        throw new HttpError(400, `Unknown model ${m.providerID}/${m.modelID}${m.variant ? `#${m.variant}` : ""} for this session`)
      }
    }
  }

  /** Connection that owns the session, or a 409. */
  function ownerOf(sessionID: string): string {
    const connID = registry.owner(sessionID)
    if (!connID) throw new HttpError(409, NO_OWNER)
    return connID
  }

  /** Conversation mode: steer the utterance into the session (allowed while it is busy) and return at once. */
  async function utterance(request: Request, sessionID: string): Promise<Response> {
    const raw = (await body(request)).text
    const text = typeof raw === "string" ? raw.trim() : ""
    if (!text) return error(400, "Empty utterance")
    if (text.length > MAX_UTTERANCE_CHARS) return error(400, `Utterance longer than ${MAX_UTTERANCE_CHARS} characters`)
    const connID = ownerOf(sessionID)
    await humanTurn(sessionID)
    const { inboxID } = await spokes.request(connID, { op: "steer", sessionID, text })
    registry.trackUtterance(sessionID, inboxID)
    return Response.json({ inboxID }, { status: 202 })
  }

  /** Renames a session in OpenCode through its owner process, falling back to other processes that report it. */
  async function rename(request: Request, sessionID: string): Promise<Response> {
    const json = await body(request)
    if (json.auto !== undefined) {
      if (json.auto !== true) return error(400, "Expected {auto: true} or {title}")
      return autoName(sessionID)
    }
    const raw = json.title
    const title = typeof raw === "string" ? raw.trim() : ""
    if (!title) return error(400, "Expected {title}: a non-empty title")
    if (title.length > MAX_TITLE_CHARS) return error(400, `Title must be at most ${MAX_TITLE_CHARS} characters`)
    const targets = registry.sessionTargets(sessionID)
    if (!targets.length) throw new HttpError(409, NO_OWNER)
    let failure: unknown
    for (const connID of targets) {
      try {
        const result = await spokes.request(connID, { op: "rename", sessionID, title })
        return Response.json({ title: typeof result?.title === "string" ? result.title : title }, { headers: NO_STORE })
      } catch (cause) {
        failure ??= cause
      }
    }
    throw failure
  }

  /**
   * Has OpenCode regenerate the title with its title agent, through the processes reporting the session that
   * support it (older spokes drop the op): 200 {title} or {title, unchanged}, 202 {pending} while generating.
   */
  async function autoName(sessionID: string): Promise<Response> {
    const reporters = registry.sessionTargets(sessionID)
    if (!reporters.length) throw new HttpError(409, NO_OWNER)
    const targets = reporters.filter((connID) => registry.supports(connID, "autoName"))
    if (!targets.length) throw new HttpError(409, AUTO_NAME_OUTDATED, "plugin_outdated")
    let failure: unknown
    for (const connID of targets) {
      try {
        const result = await spokes.request(connID, { op: "autoName", sessionID })
        if (result?.pending) return Response.json({ pending: true }, { status: 202, headers: NO_STORE })
        if (typeof result?.title !== "string") throw new SpokeError("OpenCode did not report a title")
        return Response.json({ title: result.title, ...(result.unchanged ? { unchanged: true } : {}) }, { headers: NO_STORE })
      } catch (cause) {
        failure ??= cause
      }
    }
    throw failure
  }

  async function conversation(request: Request, sessionID: string): Promise<Response> {
    const on = (await body(request)).on
    if (typeof on !== "boolean") return error(400, "Expected {on: boolean}")
    // Turning off always clears the hub's state, so a later reconnect does not switch it back on.
    if (!on) registry.setConversation(sessionID, false)
    const connID = ownerOf(sessionID)
    const { agent } = await spokes.request(connID, { op: "conversation", sessionID, on })
    if (on) registry.setConversation(sessionID, true, connID)
    return Response.json({ on, agent })
  }

  /** Enables or disables voice for a session, through a process that reported it (service first). */
  async function expose(request: Request, sessionID: string): Promise<Response> {
    const on = (await body(request)).on
    if (typeof on !== "boolean") return error(400, "Expected {on: boolean}")
    const connID = registry.exposeTarget(sessionID)
    if (!connID) return error(404, "Not found")
    const { exposed } = await spokes.request(connID, { op: "expose", sessionID, on })
    return Response.json({ exposed })
  }

  /**
   * Creates a session in a workspace the machine's background service reported (or a Herdr pane folder);
   * with herdrWorkspace, the spoke also opens it in a new tab of that Herdr workspace.
   */
  async function createSession(request: Request, machineID: string): Promise<Response> {
    const input = await body(request)
    const { directory, title, herdrWorkspace } = input
    if (typeof directory !== "string" || !directory.startsWith("/") || directory.length > MAX_DIRECTORY_CHARS) {
      return error(400, "Expected {directory: absolute path, title?: string}")
    }
    if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_CHARS)) {
      return error(400, `Title must be a string of at most ${MAX_TITLE_CHARS} characters`)
    }
    if (herdrWorkspace !== undefined && (typeof herdrWorkspace !== "string" || !herdrWorkspace || herdrWorkspace.length > MAX_HERDR_WORKSPACE_CHARS)) {
      return error(400, `herdrWorkspace must be a Herdr workspace ID of at most ${MAX_HERDR_WORKSPACE_CHARS} characters`)
    }
    if (!store.machines().some((m) => m.id === machineID && !m.revoked)) return error(404, "No such machine")
    const connID = registry.serviceFor(machineID)
    if (!connID) return error(409, "The background service of this machine is not connected")
    if (!registry.reportsWorkspace(connID, directory)) return error(400, "unknown workspace")
    const trimmed = typeof title === "string" ? title.trim() : ""
    const result = (await spokes.request(connID, {
      op: "create",
      directory: path.posix.resolve(directory),
      ...(trimmed ? { title: trimmed } : {}),
      ...(typeof herdrWorkspace === "string" ? { herdrWorkspace } : {}),
    })) as { sessionID: string; openedIn?: unknown; warning?: unknown }
    const openedIn = herdrWorkspace !== undefined && result.openedIn === "herdr" ? ("herdr" as const) : undefined
    // Herdr failed (or an older spoke ignored it): the session exists anyway.
    const warning =
      herdrWorkspace === undefined || openedIn
        ? undefined
        : typeof result.warning === "string" && result.warning
          ? result.warning.slice(0, 500)
          : "The session was created but could not be opened in Herdr"
    return Response.json({ sessionID: result.sessionID, ...(openedIn ? { openedIn } : {}), ...(warning ? { warning } : {}) }, { status: 201 })
  }

  async function permission(request: Request, rootID: string): Promise<Response> {
    const input = await body(request)
    const decision = input.decision as PermissionDecision
    if (typeof input.requestID !== "string" || !DECISIONS.has(decision)) return error(400, "Invalid decision")
    const answered = await actions.answerPermission({ rootID, requestID: input.requestID, decision })
    return answered.outcome === "done" ? new Response(null, { status: 204 }) : error(409, PERMISSION_GONE, "gone")
  }

  /** Answers or cancels a pending form (question) in the session's tree, through a process that holds it. */
  async function form(request: Request, rootID: string): Promise<Response> {
    const input = await body(request)
    if (typeof input.formID !== "string" || !input.formID || input.formID.length > 300) return error(400, "Expected {formID, answer} or {formID, cancel: true}")
    const cancel = input.cancel === true
    if (cancel ? input.answer !== undefined : input.cancel !== undefined) return error(400, "Send either an answer or cancel: true")
    if (!cancel) {
      const problem = formAnswerProblem(input.answer)
      if (problem) return error(400, problem)
    }
    const answered = await actions.answerForm(
      cancel ? { rootID, formID: input.formID, cancel: true } : { rootID, formID: input.formID, answer: input.answer as FormAnswer },
    )
    return answered.outcome === "done" ? new Response(null, { status: 204 }) : error(409, PERMISSION_GONE, "gone")
  }

  async function transcribe(request: Request, speech: Speech): Promise<Response> {
    const format = audioFormat(request.headers.get("content-type"))
    if (!format) return error(415, `Unsupported audio type: ${request.headers.get("content-type")}`)
    if (Number(request.headers.get("content-length") ?? 0) > config.maxAudioBytes) {
      return error(413, "Recording too large")
    }
    const audio = new Uint8Array(await request.arrayBuffer())
    if (audio.length > config.maxAudioBytes) return error(413, "Recording too large")
    if (audio.length === 0) return error(400, "Empty recording")
    return Response.json({ text: await speech.transcribe(audio, format) })
  }

  /**
   * The live stream. Every message has an id; with `lastID` (Last-Event-ID or ?last=) the hub replays what came
   * after it when its log still covers the gap (one fresh catalog if catalogs changed meanwhile), else it starts
   * over: the catalog, then a `resync` marker so the page refetches what it shows. Heartbeats are `ping` events.
   */
  function events(signal: AbortSignal, userID: string, deviceID: string, options: { lastID?: string; lite: boolean; session?: string }): Response {
    const encoder = new TextEncoder()
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            cleanup()
          }
        }
        const listener: Listener = {
          userID,
          deviceID,
          lite: options.lite,
          ...(options.session ? { session: options.session } : {}),
          send: (message, id) => write(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(message)}\n\n`),
          close: () => {
            cleanup()
            try {
              controller.close()
            } catch {}
          },
        }
        eventLog.open(userID)
        const missed = options.lastID ? eventLog.since(userID, options.lastID) : undefined
        if (missed) {
          let catalog = false
          for (const { id, message, exceptDevice } of missed) {
            if (exceptDevice === deviceID) continue
            if (message.type === "catalog") catalog = true
            else if (wants(listener, message)) listener.send(message, id)
          }
          if (catalog) listener.send({ type: "catalog", machines: machines(userID) }, eventLog.latest(userID))
        } else {
          listener.send({ type: "catalog", machines: machines(userID) }, eventLog.latest(userID))
          if (options.lastID) listener.send({ type: "resync" }, eventLog.latest(userID))
        }
        listeners.add(listener)
        // A named event (not a comment) so the page sees it and can tell a live stream from a dead one.
        const heartbeat = setInterval(() => write("event: ping\ndata: 0\n\n"), heartbeatMs)
        cleanup = () => {
          clearInterval(heartbeat)
          listeners.delete(listener)
        }
        signal.addEventListener("abort", () => cleanup(), { once: true })
      },
      cancel() {
        cleanup()
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    })
  }

  /** Compressed copies of hashed assets, made once per file and encoding (they never change). */
  const compressed = new Map<string, Promise<Uint8Array>>()
  function compress(name: string, bytes: Uint8Array, encoding: "br" | "gzip"): Promise<Uint8Array> {
    const key = `${encoding} ${name}`
    let done = compressed.get(key)
    if (!done) {
      done =
        encoding === "br"
          ? brotli(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 6, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length } })
          : gzipAsync(bytes, { level: 9 })
      done.catch(() => compressed.delete(key))
      compressed.set(key, done)
    }
    return done
  }

  async function staticFile(pathname: string, acceptEncoding: string | null): Promise<Response> {
    const name = APP_ROUTES.test(pathname) ? "index.html" : STATIC_PATH.test(pathname) ? pathname.slice(1) : undefined
    const type = name && CONTENT_TYPES[path.extname(name).toLowerCase()]
    const bytes = name && type ? web.read(name) : undefined
    if (name === "index.html" && !bytes) {
      return new Response(WEB_NOT_BUILT, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } })
    }
    if (!type || !bytes) return error(404, "Not found")
    const headers = new Headers({ "content-type": type })
    if (pathname === "/sw.js") {
      headers.set("cache-control", "no-cache")
      headers.set("service-worker-allowed", "/")
    } else if (type.startsWith("text/html")) {
      headers.set("cache-control", "no-cache")
    } else if (HASHED_ASSET.test(name)) {
      headers.set("cache-control", IMMUTABLE)
      if (COMPRESSIBLE.has(path.extname(name).toLowerCase()) && bytes.length >= MIN_COMPRESS_BYTES) {
        headers.set("vary", "Accept-Encoding")
        const encoding = pickEncoding(acceptEncoding)
        if (encoding) {
          headers.set("content-encoding", encoding)
          return new Response(new Uint8Array(await compress(name, bytes, encoding)), { headers })
        }
      }
    }
    return new Response(bytes, { headers })
  }

  return {
    url,
    publicURL,
    store,
    auth,
    registry,
    nodes,
    spokes,
    push,
    speechSettings,
    backends,
    delivery,
    decisions,
    acting,
    launches,
    launchFeed,
    launchTokens,
    webhooks,
    routes: [...routes.map(({ method, path, access }) => ({ method, path, access })), ...agent.routes.map(({ method, path }) => ({ method, path, access: "agent" as const }))],
    async stop() {
      launches.shutdown()
      webhooks.stop()
      tokenPush.stop()
      delivery.stop()
      decisions.stop()
      spokes.stop()
      for (const listener of [...listeners]) listeners.delete(listener)
      // Bun 1.3.5 quirk: once the server has closed a WebSocket itself, stop(true)'s promise never
      // resolves even though the listener is closed. Don't wait on it forever.
      await Promise.race([server.stop(true), Bun.sleep(250)])
      await backends.state.flush?.().catch((cause) => console.error(`[hub] agent state not saved: ${(cause as Error).message}`))
    },
  }
}

/** The state filter of GET /api/decisions (throws invalid). */
const optionalState = (url: URL): { state?: Decision["state"] } => {
  const state = decisionStateQuery(url.searchParams.get("state"))
  return state ? { state } : {}
}

/** {option?, text?} of a Decision answer (types only; Decisions validates). */
function decisionAnswer(input: Record<string, unknown>): { option?: string; text?: string } {
  for (const key of ["option", "text"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") throw new AgentError("invalid", `${key} must be a string`)
  }
  return { ...(typeof input.option === "string" ? { option: input.option } : {}), ...(typeof input.text === "string" ? { text: input.text } : {}) }
}

/** Console envelope for a Decision failure: gone → 409 (the web app's toast), the rest by code. */
function decisionFailure(cause: unknown): Response {
  if (!(cause instanceof AgentError)) throw cause
  const status: Partial<Record<string, number>> = { gone: 409, not_found: 404, forbidden: 403, invalid: 400, rate_limited: 429, paused: 423 }
  return Response.json({ error: cause.message, code: cause.code, ...(cause.options.hint ? { hint: cause.options.hint } : {}) }, { status: status[cause.code] ?? 500 })
}

/** Deep-link scheme of the native apps: `hubapp://link?hub=<public URL>&code=<link code>`. */
export const APP_SCHEME = "hubapp"

/**
 * Public writes a native app makes with no ambient credential at all (no cookie, no bearer, no Origin or
 * Referer): not CSRF-prone, the single-use code in the body is the credential. Every other write keeps the
 * same-origin check, and so does any request carrying a cookie or a browser Origin.
 */
const CREDENTIAL_FREE = new Set(["POST /api/devices/redeem"])

function credentialFree(request: Request, mode: CredentialMode, url: URL): boolean {
  return (
    mode === "none" &&
    !request.headers.has("origin") &&
    !request.headers.has("referer") &&
    CREDENTIAL_FREE.has(`${request.method} ${url.pathname}`)
  )
}

function userView(user: UserRecord) {
  return { id: user.id, ...(user.email ? { email: user.email } : {}), ...(user.name ? { name: user.name } : {}), role: user.role }
}

function deviceView(device: DeviceRecord) {
  return { id: device.id, name: device.name, created: device.created, lastSeen: device.lastSeen }
}

const PUSH_KEY = /^[A-Za-z0-9_-]{1,256}={0,2}$/

/** A browser PushSubscription (toJSON shape) with an https endpoint, or undefined. */
function pushTarget(value: unknown): { endpoint: string; keys: { p256dh: string; auth: string } } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (typeof endpoint !== "string" || endpoint.length > 2048 || !endpoint.startsWith("https://")) return undefined
  try {
    new URL(endpoint)
  } catch {
    return undefined
  }
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (typeof p256dh !== "string" || typeof auth !== "string" || !PUSH_KEY.test(p256dh) || !PUSH_KEY.test(auth)) {
    return undefined
  }
  return { endpoint, keys: { p256dh, auth } }
}

/** Boolean pref fields (and the legacy `blocked` and `finished`) from untrusted input; undefined when nothing applies. */
function prefsInput(value: unknown): (Partial<PushPrefs> & LegacyPushPrefs) | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const prefs: Partial<PushPrefs> & LegacyPushPrefs = {}
  for (const key of [...PUSH_PREF_KEYS, "blocked", "finished"] as const) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === "boolean") prefs[key] = v
  }
  return Object.keys(prefs).length ? prefs : undefined
}

/** PUT /api/prefs/view body: any of the four lists, each replacing the stored one. */
function viewPrefsInput(value: unknown): Partial<ViewPrefs> {
  const invalid = () =>
    new HttpError(
      400,
      `Expected {${VIEW_PREF_KEYS.join("?, ")}?}: lists of at most ${VIEW_PREF_MAX_ENTRIES} (hiddenSessions: ${VIEW_PREF_MAX_ARCHIVED}) strings of at most ${VIEW_PREF_MAX_CHARS} characters`,
    )
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !(VIEW_PREF_KEYS as readonly string[]).includes(key))) throw invalid()
  const out: Partial<ViewPrefs> = {}
  for (const key of VIEW_PREF_KEYS) {
    const list = record[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.length > (key === "hiddenSessions" ? VIEW_PREF_MAX_ARCHIVED : VIEW_PREF_MAX_ENTRIES)) throw invalid()
    if (!list.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= VIEW_PREF_MAX_CHARS)) throw invalid()
    out[key] = [...new Set(list as string[])]
  }
  if (Object.keys(out).length === 0) throw invalid()
  return out
}

const MODEL_ID = /^[A-Za-z0-9_.:@/+~-]{1,300}$/
function modelPrefsInput(value: unknown): { voice?: ModelSelection | null; worker?: ModelSelection | null } {
  const invalid = () => new HttpError(400, "Expected Voice/Worker model selections")
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== "voice" && key !== "worker")) throw invalid()
  const out: { voice?: ModelSelection | null; worker?: ModelSelection | null } = {}
  for (const key of ["voice", "worker"] as const) {
    const item = record[key]
    if (item === undefined) continue
    if (item === null) { out[key] = null; continue }
    if (typeof item !== "object" || Array.isArray(item)) throw invalid()
    const m = item as Record<string, unknown>
    if (typeof m.providerID !== "string" || !MODEL_ID.test(m.providerID) || typeof m.modelID !== "string" || !MODEL_ID.test(m.modelID) || (m.variant !== undefined && (typeof m.variant !== "string" || !MODEL_ID.test(m.variant)))) throw invalid()
    out[key] = { providerID: m.providerID, modelID: m.modelID, ...(typeof m.variant === "string" ? { variant: m.variant } : {}) }
  }
  if (!("voice" in out) && !("worker" in out)) throw invalid()
  return out
}

function param(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, "Bad path")
  }
}

const sleep = (ms: number) => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))

async function body(request: Request): Promise<Record<string, unknown>> {
  const value = (await request.json()) as unknown
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function failure(cause: unknown): Response {
  if (cause instanceof HttpError) return error(cause.status, cause.message, cause.code)
  if (cause instanceof BusyError) return error(409, cause.message)
  if (cause instanceof RateLimitError) return error(429, cause.message)
  if (cause instanceof ValidationError) return error(400, cause.message)
  if (cause instanceof SyntaxError) return error(400, "Invalid JSON")
  if (cause instanceof SpeechError) return error(502, cause.message)
  if (cause instanceof SpokeError) return error(502, cause.message)
  if (cause instanceof RequestTooLargeError) return error(413, cause.message)
  if (cause instanceof OidcError) return authPage(cause.status, "Sign-in failed", cause.message)
  if (cause instanceof RequestTimeoutError) return error(504, cause.message)
  console.error("[hub] request failed:", cause)
  return error(500, cause instanceof Error ? cause.message : String(cause))
}

export interface LocalAutoApproveInput {
  /** Listen address of the hub. */
  readonly host: string
  readonly publicURL: string
  /** Peer address of the request (server.requestIP). */
  readonly peer: string | undefined
  /** The request carries proxy forwarding headers. */
  readonly forwarded: boolean
  /** Machines ever enrolled (revoked ones included) and devices paired. */
  readonly machines: number
  readonly devices: number
  /** This hub process already auto-approved one enrollment. */
  readonly used: boolean
}

/**
 * The very first machine may enroll without approval on a purely local hub: it listens on loopback
 * only, its public URL is loopback, the request comes straight from loopback (no proxy headers), and
 * nothing was ever enrolled or paired. Loopback is never trusted for anything else.
 */
export function localAutoApprove(input: LocalAutoApproveInput): boolean {
  return (
    isLoopbackHost(input.host) &&
    isLoopbackURL(input.publicURL) &&
    isLoopbackAddress(input.peer) &&
    !input.forwarded &&
    input.machines === 0 &&
    input.devices === 0 &&
    !input.used
  )
}

const FORWARD_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"]
