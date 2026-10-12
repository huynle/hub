// Central voice server: HTTP routes (web UI, JSON API, SSE, enrollment) and the spoke WebSocket.
// Phones authenticate with the `voice_device` cookie; spokes with machine bearer tokens. Source IPs
// (including loopback) are never trusted.
import type { Server } from "bun"
import { diskAssets, type WebAssets } from "./assets"
import path from "node:path"
import type { EnrollStart, PermissionDecision } from "../protocol"
import { isLoopbackAddress, isLoopbackHost, isLoopbackURL, loopbackOrigins } from "../loopback"
import { speakable } from "../speakable"
import { Auth, RateLimitError, ValidationError } from "./auth"
import { emailAllowed, type CentralConfig } from "./config"
import { authPage, cookieValue, deviceName, OIDC_COOKIE, OidcClient, OidcError } from "./oidc"
import { Push, type PushSender } from "./push"
import { BusyError, Registry } from "./registry"
import { audioFormat, SpeechError } from "./speech/provider"
import { SpeechService } from "./speech/service"
import { RequestTimeoutError, SpokeError, SpokeHub, type Notifier, type SpokeSocketData } from "./spoke-ws"
import { DEFAULT_PUSH_PREFS, LOCAL_USER, Store, type DeviceRecord, type PushPrefs, type UserRecord } from "./store"

export interface Speech {
  transcribe(audio: Uint8Array, format: string): Promise<string>
  speak(text: string): Promise<Uint8Array<ArrayBuffer>>
}

export interface CentralOptions {
  readonly config: CentralConfig
  /** Directory with index.html and other static PWA files. */
  /** web/ on disk; or pass `web` (e.g. files embedded in a compiled binary). */
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
  /** Clock for sign-in expiry and the store (tests). */
  readonly now?: () => number
  readonly timing?: {
    readonly helloTimeoutMs?: number
    readonly requestTimeoutMs?: number
    readonly turnGraceMs?: number
    readonly heartbeatMs?: number
    readonly staleMs?: number
  }
}

export interface Central {
  readonly url: string
  readonly publicURL: string
  readonly store: Store
  readonly auth: Auth
  readonly registry: Registry
  readonly spokes: SpokeHub
  readonly push: Push
  readonly speechSettings: SpeechService
  /** The JSON API's route table (method, path, access), for audits and tests. */
  readonly routes: readonly RouteInfo[]
  stop(): Promise<void>
}

type Message = { type: string; [key: string]: unknown }

interface Listener {
  readonly userID: string
  send(message: Message): void
  close(): void
}

/** Who may call a route: anyone, any signed-in user, admins, or the owner of the :session / :machine in the path. */
export type Access = "public" | "user" | "admin" | "session" | "machine"

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
  /** Session routes refused (403 not_exposed) while voice is off for the session. */
  readonly exposed: boolean
}

const NO_STORE = { "cache-control": "no-store" }

export const COOKIE = "voice_device"
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60
const SSE_HEARTBEAT_MS = 20_000
const NO_OWNER = "No OpenCode process for this session is connected"
const NOT_EXPOSED = "Voice is not enabled for this session"
/** Longest directory and title accepted for a new session (as in the spoke protocol). */
const MAX_DIRECTORY_CHARS = 4096
const MAX_TITLE_CHARS = 200
const DECISIONS = new Set<PermissionDecision>(["once", "always", "reject"])
/** Longest utterance accepted for conversation mode (characters, after trimming). */
export const MAX_UTTERANCE_CHARS = 4000
/** Preview text for POST /api/settings/speech/test. */
const SPEECH_TEST_TEXT = "Hi! This is how I will sound when I read replies to you."
const SPEECH_TEST_MAX_CHARS = 300
const APP_ROUTES = /^\/(?:|pair|approve|s\/[^/]+)$/
const STATIC_PATH = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/
const LOGIN_NEXT = /^\/(?:s\/[A-Za-z0-9_-]+)?$/
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
  const web: WebAssets = options.web ?? diskAssets(options.webDir ?? path.join(import.meta.dir, "..", "..", "web"))
  const now = options.now ?? Date.now
  const store = Store.open(config.stateDir, now, { mode: config.auth.mode })
  // A machine's tenant is its owner (read live: ownership moves on migration).
  const registry = new Registry(Date.now, undefined, (machineID) => store.machines().find((m) => m.id === machineID)?.ownerID)
  const push = new Push({ store, subject: config.vapidSubject, sender: options.pushSender })
  const notifier = options.notifier ?? push
  /** SSE subscribers, one user each. */
  const listeners = new Set<Listener>()
  /**
   * Sends to SSE subscribers: catalog to everyone (each gets their own machines), `admins` messages to
   * admins only, anything else only to `tenant` (the session's owner). Streams of users who were
   * disabled are closed.
   */
  const broadcast = (message: Message, audience: { tenant?: string; admins?: true } = {}) => {
    for (const listener of [...listeners]) {
      const user = store.user(listener.userID)
      if (!user || user.disabled) {
        listener.close()
        continue
      }
      if (message.type === "catalog") listener.send({ type: "catalog", machines: machines(user.id) })
      else if (audience.admins) {
        if (user.role === "admin") listener.send(message)
      } else if (audience.tenant !== undefined && audience.tenant === user.id) listener.send(message)
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
  spokes = new SpokeHub({
    store,
    auth,
    registry,
    publicURL,
    notifier,
    broadcast: (message, tenant) => broadcast(message, { tenant }),
    turnTimeoutMs: config.turnTimeoutMs,
    ...options.timing,
  })

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
      }))
  }

  registry.subscribe((message, tenant) => broadcast({ ...message }, tenant !== undefined ? { tenant } : {}))
  registry.subscribeAlerts((alert) => {
    // Push goes to the session owner's devices only; an alert without an owner goes nowhere.
    if (!alert.owner) return
    notifier.notify(alert.kind, alert.sessionID, alert.title, alert.detail, alert.text, alert.owner).catch((cause) => {
      console.error("[voice] push notification failed:", cause instanceof Error ? cause.message : cause)
    })
  })

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
      else console.warn(`[voice] sign-in refused: ${cause.reason}`)
      return deny(cause.status, "Sign-in failed", cause.message)
    }
    const { identity, next } = result
    if (!emailAllowed(settings, identity.email)) {
      store.audit({ actor: "system", action: "signin.denied", target: identity.email, detail: "not allowed" })
      return deny(403, "Not allowed", `${identity.email} is not allowed to use this voice hub. Ask its admin to add you.`)
    }
    const role = settings.admins.includes(identity.email) ? "admin" : "user"
    const existing = store.userByEmail(identity.email)
    if (existing?.disabled) {
      store.audit({ actor: "system", action: "signin.denied", target: identity.email, detail: "disabled" })
      return deny(403, "Account disabled", "Your account on this voice hub is disabled. Ask its admin.")
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
    // Speech not usable yet (e.g. no key): land on the page's speech setup (web/app.js opens it for #speech).
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

  async function handle(request: Request, server: Server<SpokeSocketData>): Promise<Response | undefined> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method
    try {
      if (pathname === "/spoke/ws") return spokes.upgrade(request, server)
      if (method === "GET" && pathname === "/healthz") {
        return Response.json({ ok: true, version: options.version ?? "0.0.0", spokes: registry.connections() })
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
          console.log(`[voice] local hub: approved the first machine (code ${start.userCode}) without confirmation; later machines need approval`)
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
      if (method === "GET" && pathname === "/login") return login(request, url)
      if (oidc && method === "GET" && pathname === "/auth/login") return await authLogin(url)
      if (oidc && method === "GET" && pathname === "/auth/callback") return await authCallback(request, url)
      if (pathname.startsWith("/api/")) return await api(request, server, url)
      if (method === "GET") return staticFile(pathname)
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
      return new Response("This sign-in link has expired or was already used. Run /voice again.", {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    // Speech not usable yet (e.g. no key): land on the page's speech setup (web/app.js opens it for #speech).
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
    route("GET", "/api/events", "user", ({ request, server, user }) => {
      server.timeout(request, 0)
      return events(request.signal, user.id)
    }),
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
      return new Response(await speechFor(user.id).speak(text), { headers: { "content-type": "audio/mpeg" } })
    }),
    route("GET", "/api/push/key", "user", () => Response.json({ publicKey: push.publicKey() })),
    route("POST", "/api/push/subscribe", "user", async ({ request, device }) => {
      const input = await body(request)
      const target = pushTarget(input.subscription)
      if (!target) return error(400, "Invalid push subscription")
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
    route("GET", "/api/push/prefs", "user", ({ device }) =>
      Response.json({
        prefs: store.pushPrefs(device.id),
        subscriptions: store.pushSubscriptions().filter((s) => s.deviceID === device.id).length,
      }),
    ),
    route("PUT", "/api/push/prefs", "user", async ({ request, device }) =>
      Response.json({ prefs: store.setPushPrefs(device.id, prefsInput(await body(request)) ?? {}) }),
    ),
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
    route("POST", "/api/sessions/:session/turn", "session", ({ request, server, params }) => turn(request, server, params.session!), true),
    route("POST", "/api/sessions/:session/utterance", "session", ({ request, params }) => utterance(request, params.session!), true),
    route(
      "POST",
      "/api/sessions/:session/interrupt",
      "session",
      async ({ params }) => {
        await spokes.request(ownerOf(params.session!), { op: "interrupt", sessionID: params.session! })
        return new Response(null, { status: 204 })
      },
      true,
    ),
    route("POST", "/api/sessions/:session/conversation", "session", ({ request, params }) => conversation(request, params.session!), true),
    route(
      "GET",
      "/api/sessions/:session/context",
      "session",
      async ({ params }) => Response.json(await spokes.request(ownerOf(params.session!), { op: "context", sessionID: params.session! })),
      true,
    ),
    route("POST", "/api/sessions/:session/permission", "session", ({ request, params }) => permission(request, params.session!), true),

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
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(request)) {
      return error(403, "Cross-origin request refused")
    }
    const found = findRoute(method, url.pathname)
    if (found?.route.access === "public") {
      // Public handlers never read device or user.
      return await found.route.handle({ request, server, url, params: found.params } as Context)
    }

    const resolved = deviceFor(request)
    if (!resolved) return error(401, "This device is not paired")
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
        if (!registry.owns(user.id, params.session!)) return error(404, "Not found")
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
      // Their machines go offline at once; their browsers get 401 from now on and lose their event streams.
      for (const machine of store.machines()) if (machine.ownerID === id) spokes.closeMachine(machine.id, "revoked")
      broadcast({ type: "catalog" })
    }
    return Response.json(userRow(store.user(id)!))
  }

  async function turn(request: Request, server: Server<SpokeSocketData>, sessionID: string): Promise<Response> {
    const raw = (await body(request)).text
    const text = typeof raw === "string" ? raw.trim() : ""
    if (!text) return error(400, "Empty prompt")
    const connID = ownerOf(sessionID)
    const release = registry.beginTurn(sessionID)
    server.timeout(request, 0)
    try {
      return Response.json(await spokes.request(connID, { op: "turn", sessionID, text, voiceStyle: true }))
    } finally {
      release()
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
    const { inboxID } = await spokes.request(ownerOf(sessionID), { op: "steer", sessionID, text })
    registry.trackUtterance(sessionID, inboxID)
    return Response.json({ inboxID }, { status: 202 })
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

  /** Creates a session in a workspace the machine's background service reported. */
  async function createSession(request: Request, machineID: string): Promise<Response> {
    const input = await body(request)
    const { directory, title } = input
    if (typeof directory !== "string" || !directory.startsWith("/") || directory.length > MAX_DIRECTORY_CHARS) {
      return error(400, "Expected {directory: absolute path, title?: string}")
    }
    if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_CHARS)) {
      return error(400, `Title must be a string of at most ${MAX_TITLE_CHARS} characters`)
    }
    if (!store.machines().some((m) => m.id === machineID && !m.revoked)) return error(404, "No such machine")
    const connID = registry.serviceFor(machineID)
    if (!connID) return error(409, "The background service of this machine is not connected")
    if (!registry.reportsWorkspace(connID, directory)) return error(400, "unknown workspace")
    const trimmed = typeof title === "string" ? title.trim() : ""
    const { sessionID } = await spokes.request(connID, {
      op: "create",
      directory: path.posix.resolve(directory),
      ...(trimmed ? { title: trimmed } : {}),
    })
    return Response.json({ sessionID }, { status: 201 })
  }

  async function permission(request: Request, rootID: string): Promise<Response> {
    const input = await body(request)
    const decision = input.decision as PermissionDecision
    if (typeof input.requestID !== "string" || !DECISIONS.has(decision)) return error(400, "Invalid decision")
    const target = registry.permissionTarget(rootID, input.requestID)
    if (!target) return error(409, `Permission request ${input.requestID} is not pending in this session`)
    await spokes.request(target.connID, {
      op: "permission",
      sessionID: target.sessionID,
      requestID: input.requestID,
      decision,
    })
    return new Response(null, { status: 204 })
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

  function events(signal: AbortSignal, userID: string): Response {
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
          send: (message) => write(`data: ${JSON.stringify(message)}\n\n`),
          close: () => {
            cleanup()
            try {
              controller.close()
            } catch {}
          },
        }
        listener.send({ type: "catalog", machines: machines(userID) })
        listeners.add(listener)
        const heartbeat = setInterval(() => write(": ping\n\n"), SSE_HEARTBEAT_MS)
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

  function staticFile(pathname: string): Response {
    const name = APP_ROUTES.test(pathname) ? "index.html" : STATIC_PATH.test(pathname) ? pathname.slice(1) : undefined
    const type = name && CONTENT_TYPES[path.extname(name).toLowerCase()]
    const bytes = name && type ? web.read(name) : undefined
    if (!type || !bytes) return error(404, "Not found")
    const headers = new Headers({ "content-type": type })
    if (pathname === "/sw.js") {
      headers.set("cache-control", "no-cache")
      headers.set("service-worker-allowed", "/")
    } else if (type.startsWith("text/html")) {
      headers.set("cache-control", "no-cache")
    }
    return new Response(bytes, { headers })
  }

  return {
    url,
    publicURL,
    store,
    auth,
    registry,
    spokes,
    push,
    speechSettings,
    routes: routes.map(({ method, path, access }) => ({ method, path, access })),
    async stop() {
      spokes.stop()
      for (const listener of [...listeners]) listeners.delete(listener)
      // Bun 1.3.5 quirk: once the server has closed a WebSocket itself, stop(true)'s promise never
      // resolves even though the listener is closed. Don't wait on it forever.
      await Promise.race([server.stop(true), Bun.sleep(250)])
    },
  }
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

/** Boolean pref fields from untrusted input; undefined when nothing applies. */
function prefsInput(value: unknown): Partial<PushPrefs> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const prefs: Partial<PushPrefs> = {}
  for (const key of Object.keys(DEFAULT_PUSH_PREFS) as Array<keyof PushPrefs>) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === "boolean") prefs[key] = v
  }
  return Object.keys(prefs).length ? prefs : undefined
}

function param(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, "Bad path")
  }
}

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
  if (cause instanceof OidcError) return authPage(cause.status, "Sign-in failed", cause.message)
  if (cause instanceof RequestTimeoutError) return error(504, cause.message)
  console.error("[voice] request failed:", cause)
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
