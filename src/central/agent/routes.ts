// The /api/agent framework: its own route table (access "agent" in the hub's table), credential checks and error
// envelope. http.ts registers it once (agentApi) and sends every /api/agent request here; later tasks add routes
// to agentRoutes() and verifiers to agentVerifiers() without touching http.ts.
//
// Order for each request: cookie + a hub bearer together → 400 invalid (a foreign bearer is ignored); cookie writes need the same origin (bearer
// requests skip it) → 403 forbidden; credential → 401 unauthorized / token_expired; route → 404 not_found;
// route class (agentAllows) → 403 forbidden; then the handler, whose throws become the envelope (agentFailure).
// Path parameters address sessions as `:addr` (resolved per caller), never `:session`.
import type { AgentEvents } from "./events"
import type { CursorKeys } from "./event-cursor"
import { eventsRoutes } from "./events-routes"
import type { DeviceRecord, Store, UserRecord } from "../store"
import type { Directory } from "./directory"
import { directoryRoutes } from "./directory-routes"
import { type ReadDeps, readRoutes, type ReadRegistry, type SpokeRequester } from "./read-routes"
import { agentAllows, type AgentActor, type AgentAllow, type BearerVerifier, type Credential, type Resolver } from "./actor"
import { appTokenRoutes, appTokenVerifier } from "./app-tokens"
import type { Decisions } from "./decisions"
import type { Delivery } from "./delivery"
import { MessageFeed, messageRoutes } from "./message-routes"
import type { SessionTokens } from "./session-tokens"
import { AgentError, agentFailure } from "./errors"
import { type AgentAudit, auditRoutes } from "./audit"
import { grantRoutes } from "./grant-routes"
import type { GrantRequests } from "./grant-requests"
import type { Grants } from "./grants"
import { type ActingSwitch, actingSwitchRoutes } from "./acting-switch"
import { Acting, type ActingRegistry, type Escalate } from "./acting"
import { actingRoutes } from "./acting-routes"
import type { Actions } from "../actions"
import { launchRoutes, type RouteLaunches } from "./launch-routes"
import { type RouteWebhooks, webhookRoutes } from "./webhook-routes"

export const AGENT_PREFIX = "/api/agent"

export const isAgentPath = (pathname: string): boolean => pathname === AGENT_PREFIX || pathname.startsWith(`${AGENT_PREFIX}/`)

export interface AgentContext {
  readonly request: Request
  readonly url: URL
  readonly params: Record<string, string>
  readonly actor: AgentActor
  readonly credential: Credential
  readonly user: UserRecord
  /** The caller's device (user actors only). */
  readonly device?: DeviceRecord
}

export interface AgentRoute {
  readonly method: string
  /** Express-style path under /api/agent, e.g. /api/agent/sessions/:addr. */
  readonly path: string
  /** Who besides user actors may call it (default: users only, e.g. token management). */
  readonly allow: AgentAllow
  handle(context: AgentContext): Response | Promise<Response>
}

/** What the agent API needs from the hub. */
export interface AgentDeps {
  readonly store: Store
  /** Hub-minted session tokens (P1-T5). */
  readonly sessionTokens?: SessionTokens
  /** Names, roles and address resolution (P1-T8); its routes are added when given. */
  readonly directory?: Directory
  /** The hub's catalog (P1-T9): the read routes are added when given with the directory. */
  readonly registry?: ReadRegistry & ActingRegistry
  /** Hub → spoke requests (show, log). */
  readonly spokes?: SpokeRequester
  /** Agent messages (P2-T5): the message routes are added when given with the directory. */
  readonly delivery?: Delivery
  /** Decisions (ask @me, P2-T9): with the message routes. */
  readonly decisions?: Decisions
  /** The agent audit (P3-T5): GET /api/agent/audit when given. */
  readonly audit?: AgentAudit
  /** Grants (P3-T2): the /api/agent/grants routes when given. */
  readonly grants?: Grants
  /** Grant requests (P3-T9): POST /api/agent/grants/requests with the grant routes. */
  readonly grantRequests?: GrantRequests
  /** Kill switches (P3-T4): GET/PUT /api/agent/acting when given; the acting verbs check it. */
  readonly acting?: ActingSwitch
  /**
   * The shared action executor (P3-T6): with acting, grants, audit, registry, directory and spokes, the act verbs
   * POST /api/agent/sessions/:addr/{approve,deny,answer,prompt,stop} (P3-T7).
   */
  readonly actions?: Actions
  /**
   * Launches (P4-T8): with grants, acting and audit, the launch routes /api/agent/launches (P4-T9); the read
   * routes show the labels of launched sessions.
   */
  readonly launches?: RouteLaunches
  /** Webhooks (P4-T10): the /api/agent/webhooks routes when given. */
  readonly webhooks?: RouteWebhooks
  /** The canonical agent event journal: archive changes are appended to it. */
  readonly agentEvents?: Pick<AgentEvents, "append" | "latest" | "since" | "appended">
  /** Signing keys of GET /api/agent/events cursors; the events route is served when given with agentEvents. */
  readonly eventCursorKeys?: CursorKeys
  /** needs_user escalations of the act verbs (P3-T8 opens a Decision); without it needs_user is only answered. */
  readonly escalate?: Escalate
  /** The console's prompt limit, for the user's prompts on the act route. */
  readonly maxPromptChars?: number
  /** Stored messages as they are sent (the hub also streams them to the console); a new feed when absent. */
  readonly feed?: MessageFeed
  /** Heartbeat of GET /api/agent/watch. */
  readonly heartbeatMs?: number
  /** Aborted when the hub drains: watch streams end with a `retry:` hint. */
  readonly draining?: AbortSignal
  readonly now?: () => number
}

/**
 * Session and app token verifiers (P1-T5 adds the session token verifier, P1-T7 the app token one). Tried in
 * order after the device lookup; see BearerVerifier.
 */
export function agentVerifiers(deps: AgentDeps): BearerVerifier[] {
  return [...(deps.sessionTokens ? [deps.sessionTokens.verifier] : []), appTokenVerifier(deps.store)]
}

const userView = (user: UserRecord) => ({
  id: user.id,
  ...(user.name ? { name: user.name } : {}),
  ...(user.email ? { email: user.email } : {}),
  role: user.role,
})

/** The built-in /api/agent routes. */
export function agentRoutes(deps: AgentDeps): AgentRoute[] {
  const feed = deps.feed ?? new MessageFeed()
  return [
    ...(deps.directory ? directoryRoutes({ directory: deps.directory, store: deps.store, ...(deps.agentEvents ? { events: deps.agentEvents } : {}), ...(deps.registry ? { registry: deps.registry } : {}), ...(deps.grants ? { grants: deps.grants } : {}), ...(deps.acting ? { acting: deps.acting } : {}), ...(deps.audit ? { audit: deps.audit } : {}), ...(deps.eventCursorKeys ? { previewKeys: deps.eventCursorKeys } : {}) }) : []),
    ...(deps.directory && deps.agentEvents && deps.eventCursorKeys ? eventsRoutes({ events: deps.agentEvents, keys: deps.eventCursorKeys, directory: deps.directory }) : []),
    ...(deps.directory && deps.delivery ? messageRoutes({ delivery: deps.delivery, directory: deps.directory, store: deps.store, feed, ...(deps.decisions ? { decisions: deps.decisions } : {}) }) : []),
    ...(deps.directory && deps.registry ? readRoutes({ store: deps.store, directory: deps.directory, registry: deps.registry, ...(deps.spokes ? { spokes: deps.spokes } : {}), ...launchReads(deps), ...(deps.agentEvents && deps.eventCursorKeys ? { events: { events: deps.agentEvents, keys: deps.eventCursorKeys, directory: deps.directory } } : {}), ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.draining ? { draining: deps.draining } : {}) }) : []),
    {
      method: "GET",
      path: `${AGENT_PREFIX}/whoami`,
      allow: { session: true, app: true },
      handle: ({ actor, user }) => Response.json({ actor, user: userView(user) }, { headers: { "cache-control": "no-store" } }),
    },
    ...appTokenRoutes(deps.store),
    ...(deps.audit ? auditRoutes(deps.audit) : []),
    ...(deps.grants ? grantRoutes(deps.grants, deps.now, deps.grantRequests) : []),
    ...(deps.acting ? actingSwitchRoutes(deps.acting) : []),
    ...actVerbRoutes(deps),
    ...(deps.launches && deps.grants && deps.acting && deps.audit
      ? launchRoutes({ launches: deps.launches, grants: deps.grants, acting: deps.acting, audit: deps.audit, ...(deps.directory ? { directory: deps.directory } : {}) })
      : []),
    ...(deps.webhooks ? webhookRoutes(deps.webhooks, deps.store) : []),
  ]
}

/** What the read routes show of launches: launched sessions' labels (the latest launch wins). */
function launchReads(deps: AgentDeps): Pick<ReadDeps, "labels"> {
  const { launches } = deps
  return {
    ...(launches
      ? {
          labels: async (userID: string) => {
            const out = new Map<string, Readonly<Record<string, string>>>()
            // Oldest first: a later launch of the same session overrides.
            for (const launch of await launches.list(userID)) if (launch.sessionID !== undefined) out.set(launch.sessionID, launch.spec.labels)
            return out
          },
        }
      : {}),
  }
}

/** The act verbs, when every part they need is given. */
function actVerbRoutes(deps: AgentDeps): AgentRoute[] {
  const { actions, acting, grants, audit, registry, directory, spokes } = deps
  if (!actions || !acting || !grants || !audit || !registry || !directory || !spokes) return []
  return actingRoutes(
    new Acting({
      registry,
      directory,
      actions,
      spokes,
      grants,
      acting,
      audit,
      ...(deps.escalate ? { escalate: deps.escalate } : {}),
      ...(deps.maxPromptChars !== undefined ? { maxPromptChars: deps.maxPromptChars } : {}),
    }),
  )
}

export interface AgentApiOptions {
  readonly resolve: Resolver
  readonly cookieName: string
  /** CSRF guard for cookie writes (the hub's same-origin check). */
  sameOrigin(request: Request): boolean
  /** Records activity of a resolved caller (device and user lastSeen). */
  touch?(user: UserRecord, device?: DeviceRecord): void
  readonly routes: readonly AgentRoute[]
}

export interface AgentApi {
  /** The route table (method, path) for the hub's audit table, as access "agent". */
  readonly routes: readonly { readonly method: string; readonly path: string }[]
  handle(request: Request, url: URL): Promise<Response>
}

interface Compiled {
  readonly route: AgentRoute
  readonly pattern: RegExp
  readonly keys: string[]
}

const MIXED = "Send the device cookie or a bearer token, not both"

export function agentApi(options: AgentApiOptions): AgentApi {
  const compiled: Compiled[] = options.routes.map((route) => {
    if (!isAgentPath(route.path) || route.path.includes(":session")) throw new Error(`agent route ${route.path}: must be under ${AGENT_PREFIX} and use :addr, not :session`)
    const keys: string[] = []
    const pattern = new RegExp(`^${route.path.replace(/:([a-z]+)/g, (_, key: string) => (keys.push(key), "([^/]+)"))}$`)
    return { route, pattern, keys }
  })

  const find = (method: string, pathname: string) => {
    for (const { route, pattern, keys } of compiled) {
      if (route.method !== method) continue
      const match = pattern.exec(pathname)
      if (!match) continue
      const params: Record<string, string> = {}
      keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(match[i + 1]!)
        } catch {
          throw new AgentError("invalid", "Bad path")
        }
      })
      return { route, params }
    }
    return undefined
  }

  async function handle(request: Request, url: URL): Promise<Response> {
    try {
      const mode = await options.resolve.mode(request)
      if (mode === "mixed") throw new AgentError("invalid", MIXED)
      const method = request.method
      if (mode !== "bearer" && method !== "GET" && method !== "HEAD" && !options.sameOrigin(request)) {
        throw new AgentError("forbidden", "Cross-origin request refused")
      }
      const resolved = await options.resolve(request)
      if (!resolved.ok) {
        if (resolved.reason === "expired") throw new AgentError("token_expired", "Token expired", { hint: "Get a new token" })
        throw new AgentError("unauthorized", resolved.bearer ? "Invalid or revoked token" : "Sign in or send a bearer token")
      }
      options.touch?.(resolved.user, resolved.device)
      const found = find(method, url.pathname)
      if (!found) throw new AgentError("not_found", "Not found")
      if (!agentAllows(found.route.allow, resolved.actor)) throw new AgentError("forbidden", "This credential cannot use this route")
      const { actor, credential, user, device } = resolved
      return await found.route.handle({ request, url, params: found.params, actor, credential, user, ...(device ? { device } : {}) })
    } catch (cause) {
      return agentFailure(cause)
    }
  }

  return { routes: options.routes.map(({ method, path }) => ({ method, path })), handle }
}

/** Oldest client (native app, CLI) this hub still serves; raised when the API breaks old clients. */
export const MIN_CLIENT_VERSION = "0.0.0"

export interface WellKnownInfo {
  readonly publicURL: string
  readonly version: string
  readonly auth: { readonly mode: "pairing" } | { readonly mode: "oidc"; readonly issuer: string }
}

/** GET /.well-known/hub: public discovery and version gating for apps and CLIs (design §14.5). */
export function wellKnown(info: WellKnownInfo): Response {
  // Pairing codes also work on an OIDC hub (a signed-in device issues them).
  const auth = info.auth.mode === "oidc" ? { modes: ["oidc", "pairing"], oidc: { issuer: info.auth.issuer } } : { modes: ["pairing"] }
  return Response.json(
    { publicURL: info.publicURL, version: info.version, minClientVersion: MIN_CLIENT_VERSION, auth, features: [] },
    { headers: { "cache-control": "public, max-age=60" } },
  )
}
