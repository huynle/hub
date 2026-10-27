// The hub client: bearer requests to the hub's /api/agent with JSON bodies and query strings; failures become
// HubError (the envelope) or HubTransportError (errors.ts). Typed verbs are added on top of call()/request().
import { envelopeOf, HubError, HubTransportError } from "./errors.ts"
import { sseEvents } from "./sse.ts"
import type {
  Approved,
  AppTokenView,
  Archived,
  Asked,
  CreatedAppToken,
  Decision,
  DecisionAnswered,
  DecisionOption,
  DecisionState,
  DecisionTier,
  DecisionUrgency,
  Denied,
  DirectoryEntry,
  FormAnswer,
  FormAnswered,
  Grant,
  GrantRequested,
  GrantRequestSpec,
  GrantSpec,
  Inbox,
  LaunchCreated,
  LaunchSpec,
  LaunchState,
  LaunchView,
  LogRow,
  Named,
  PromptDelivery,
  Prompted,
  Replied,
  RoleClaim,
  RoleRelease,
  Sent,
  SentAll,
  SessionDetail,
  SessionView,
  Status,
  Stopped,
  WatchEvent,
  Whoami,
} from "./types.ts"

const AGENT = "/api/agent"

/** The longest wait the hub serves in one request (seconds); longer waits loop. */
export const WAIT_POLL_MAX_S = 60

export type QueryValue = string | number | boolean | readonly string[] | undefined

export interface RequestOptions {
  /** Query parameters; undefined values are skipped, arrays repeat the key. */
  readonly query?: Readonly<Record<string, QueryValue>>
  /** Sent as JSON. */
  readonly body?: unknown
  readonly signal?: AbortSignal
}

/** The part of fetch the client uses. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export interface HubClientOptions {
  /** The hub's base URL, e.g. https://hub.example.com. */
  readonly url: string
  /** A session token (HUB_SESSION_TOKEN), an app token or a device token. */
  readonly token: string
  /** Defaults to the global fetch. */
  readonly fetch?: Fetch
}

/** `?a=1&b=2` (repeated keys for arrays); empty when nothing is set. */
export function queryString(query: Readonly<Record<string, QueryValue>> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, String(v))
  }
  const text = params.toString()
  return text ? `?${text}` : ""
}

/** A path segment (an address or ID); `@` stays readable (it is valid in a path). */
export const segment = (value: string): string => encodeURIComponent(value).replace(/%40/g, "@")

/** `@@reviewer` → `reviewer` (the role routes take the bare role). */
const bareRole = (role: string) => role.replace(/^@@/, "")

/** Only an abort signal. */
export interface CallOptions {
  readonly signal?: AbortSignal
}

export interface SessionsFilter extends CallOptions {
  readonly project?: string
  /** One state or several (sent comma-separated). */
  readonly state?: string | readonly string[]
  readonly machine?: string
  /** `key=value` labels, all of which must match. */
  readonly label?: readonly string[]
}

export interface LaunchesFilter extends CallOptions {
  /** One state or several (sent comma-separated). */
  readonly state?: LaunchState | readonly LaunchState[]
  /** `key=value` launch labels, all of which must match. */
  readonly label?: readonly string[]
}

/** hub.launches: start sessions (users; app tokens with sessions:launch and a launch grant; sessions by act token). */
export interface Launches {
  /** Starts a launch; the same key and body again answers the same launch (created false). */
  create(spec: LaunchSpec, options?: CallOptions): Promise<LaunchCreated>
  /** The caller's launches, oldest first (apps and sessions: only those they started). */
  list(filter?: LaunchesFilter): Promise<{ launches: LaunchView[] }>
  get(id: string, options?: CallOptions): Promise<{ launch: LaunchView }>
  /** Ends a launch (outcome stopped); one that already ended is gone (HubError). */
  stop(id: string, options?: CallOptions): Promise<{ launch: LaunchView }>
}

export interface TargetOptions extends CallOptions {
  /** Act on this session (address) instead of the caller's own. */
  readonly session?: string
}

export interface RoleOptions extends TargetOptions {
  readonly project?: string
}

export interface MsgOptions extends CallOptions {
  /** false: admit without starting a turn. */
  readonly wake?: boolean
  /** Steer into a running turn. */
  readonly urgent?: boolean
}

export interface AskOptions extends MsgOptions {
  /** Seconds until the ask expires (the hub's default when unset). */
  readonly expires?: number
  /** Seconds to wait for the answer; the hub serves at most WAIT_POLL_MAX_S per request, so longer waits loop. */
  readonly wait?: number
  // Asks to @me open a Decision (design §12.1) with these:
  readonly options?: readonly DecisionOption[]
  readonly recommendation?: { readonly option: string; readonly why?: string }
  readonly urgency?: DecisionUrgency
  readonly tier?: DecisionTier
  /** Seconds until the deadline. */
  readonly deadline?: number
  /** A safe option taken at the deadline. */
  readonly onTimeout?: string
  /** Addresses of the sessions it concerns. */
  readonly about?: readonly string[]
}

/** The Decision fields of AskOptions, when given. */
const decisionFields = (options: AskOptions) => {
  const out: Record<string, unknown> = {}
  for (const key of ["options", "recommendation", "urgency", "tier", "deadline", "onTimeout", "about"] as const) if (options[key] !== undefined) out[key] = options[key]
  return out
}

/** Options of the act verbs: the reason, recorded in the agent audit (deny passes it to the harness). */
export interface ActOptions extends CallOptions {
  readonly why?: string
}

export interface ApproveOptions extends ActOptions {
  /** Approve for good (OpenCode saves the rule); agents need a grant with allowAlways. */
  readonly always?: boolean
}

export interface PromptOptions extends ActOptions {
  readonly delivery?: PromptDelivery
  /** Agents' prompts always wake the session (false is refused). */
  readonly wake?: boolean
  /** Users only. */
  readonly images?: readonly { readonly mime: string; readonly data: string; readonly name?: string }[]
}

/** The why of an act verb, when given. */
const whyField = (options: ActOptions) => (options.why !== undefined ? { why: options.why } : {})

const signalOf = (options: CallOptions) => (options.signal ? { signal: options.signal } : {})
/** The wake and urgent fields of a send, when given. */
const sendFields = (options: MsgOptions) => ({ ...(options.wake !== undefined ? { wake: options.wake } : {}), ...(options.urgent !== undefined ? { urgent: options.urgent } : {}) })
/** The session and project fields of a role request, when given. */
const roleTarget = (options: RoleOptions) => ({ ...(options.session ? { session: options.session } : {}), ...(options.project !== undefined ? { project: options.project } : {}) })

export class HubClient {
  /** The URL as given (used in messages). */
  readonly url: string
  readonly #base: string
  readonly #token: string
  readonly #fetch: Fetch

  /** Launches (design §6.1): create, list, get, stop. */
  readonly launches: Launches = {
    create: async (spec, options = {}) => {
      const response = await this.request("POST", `${AGENT}/launches`, { body: spec, ...signalOf(options) })
      const body = (await this.#json(response, `${AGENT}/launches`)) as { launch: LaunchView }
      return { launch: body.launch, created: response.status === 201 }
    },
    list: (filter = {}) => {
      const state = typeof filter.state === "string" ? filter.state : filter.state?.join(",")
      return this.call("GET", `${AGENT}/launches`, { query: { state, label: filter.label }, ...signalOf(filter) })
    },
    get: (id, options = {}) => this.call("GET", `${AGENT}/launches/${segment(id)}`, signalOf(options)),
    stop: (id, options = {}) => this.call("DELETE", `${AGENT}/launches/${segment(id)}`, signalOf(options)),
  }

  constructor(options: HubClientOptions) {
    this.url = options.url
    this.#base = options.url.replace(/\/+$/, "")
    this.#token = options.token
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** Sends a request; resolves the response when OK, else throws HubError / HubTransportError. */
  async request(method: string, pathname: string, options: RequestOptions = {}): Promise<Response> {
    const target = `${pathname}${queryString(options.query)}`
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: "application/json" }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    let response: Response
    try {
      response = await this.#fetch(`${this.#base}${target}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        redirect: "manual",
      })
    } catch (cause) {
      if (options.signal?.aborted) throw cause
      throw new HubTransportError("unreachable", `cannot reach ${this.url} (${cause instanceof Error ? cause.message : String(cause)})`, { cause })
    }
    if (response.ok) return response
    const text = await response.text().catch(() => "")
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    const envelope = envelopeOf(body)
    if (envelope) throw new HubError(response.status, envelope)
    throw new HubTransportError("http", `HTTP ${response.status} from ${this.url}${target}`, { status: response.status })
  }

  /** request() answering JSON (undefined for 204). */
  async call<T = unknown>(method: string, pathname: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(method, pathname, options)
    if (response.status === 204) return undefined as T
    return (await this.#json(response, `${pathname}${queryString(options.query)}`)) as T
  }

  async #json(response: Response, target: string): Promise<unknown> {
    try {
      return await response.json()
    } catch (cause) {
      throw new HubTransportError("bad_response", `the hub at ${this.url} did not answer JSON for ${target}`, { cause })
    }
  }

  // Reading (sessions:read).

  whoami(options: CallOptions = {}): Promise<Whoami> {
    return this.call("GET", `${AGENT}/whoami`, signalOf(options))
  }

  status(options: CallOptions = {}): Promise<Status> {
    return this.call("GET", `${AGENT}/status`, signalOf(options))
  }

  sessions(filter: SessionsFilter = {}): Promise<{ sessions: SessionView[] }> {
    const state = typeof filter.state === "string" ? filter.state : filter.state?.join(",")
    return this.call("GET", `${AGENT}/sessions`, {
      query: { project: filter.project, state, machine: filter.machine, label: filter.label },
      ...signalOf(filter),
    })
  }

  /** One session by address (ses_… or a prefix, @name, @@role, @name.project). */
  show(addr: string, options: CallOptions = {}): Promise<SessionDetail> {
    return this.call("GET", `${AGENT}/sessions/${segment(addr)}`, signalOf(options))
  }

  /** The newest timeline rows (n: 1–200, the hub's default when unset). */
  log(addr: string, options: CallOptions & { readonly n?: number | string } = {}): Promise<{ rows: LogRow[] }> {
    return this.call("GET", `${AGENT}/sessions/${segment(addr)}/log`, { query: { n: options.n }, ...signalOf(options) })
  }

  /** Named and role-holding sessions. */
  who(options: CallOptions & { readonly project?: string; readonly role?: string } = {}): Promise<{ sessions: DirectoryEntry[] }> {
    return this.call("GET", `${AGENT}/who`, { query: { project: options.project, role: options.role === undefined ? undefined : bareRole(options.role) }, ...signalOf(options) })
  }

  /**
   * GET /api/agent/watch: the events (session.*, blocker.*, …) as they happen, until the hub closes the stream or
   * `signal` aborts (which ends the iteration quietly). blocked: only blocker events; session: one address.
   */
  async *watch(options: CallOptions & { readonly blocked?: boolean; readonly session?: string } = {}): AsyncGenerator<WatchEvent, void, undefined> {
    const { signal } = options
    if (signal?.aborted) return
    let response: Response
    try {
      response = await this.request("GET", `${AGENT}/watch`, { query: { blocked: options.blocked ? "1" : undefined, session: options.session }, ...signalOf(options) })
    } catch (cause) {
      if (signal?.aborted) return
      throw cause
    }
    yield* sseEvents(response, signal)
  }

  // Organization (sessions:manage).

  setArchived(addr: string, archived: boolean, options: CallOptions = {}): Promise<Archived> {
    return this.call("PUT", `${AGENT}/sessions/${segment(addr)}/archive`, { body: { archived }, ...signalOf(options) })
  }

  // Naming.

  name(name: string, options: TargetOptions = {}): Promise<Named> {
    return this.call("POST", `${AGENT}/name`, { body: { name, ...(options.session ? { session: options.session } : {}) }, ...signalOf(options) })
  }

  claimRole(role: string, options: RoleOptions & { readonly exclusive?: boolean } = {}): Promise<RoleClaim> {
    return this.call("POST", `${AGENT}/roles/claim`, { body: { role: bareRole(role), ...(options.exclusive ? { exclusive: true } : {}), ...roleTarget(options) }, ...signalOf(options) })
  }

  releaseRole(role: string, options: RoleOptions = {}): Promise<RoleRelease> {
    return this.call("POST", `${AGENT}/roles/release`, { body: { role: bareRole(role), ...roleTarget(options) }, ...signalOf(options) })
  }

  // Messaging (messages:send / messages:read).

  /** Tells a session something (fire and forget). */
  msg(to: string, text: string, options?: MsgOptions & { readonly all?: false }): Promise<Sent>
  /** To every session the address names (each holder of a role). */
  msg(to: string, text: string, options: MsgOptions & { readonly all: true }): Promise<SentAll>
  msg(to: string, text: string, options: MsgOptions & { readonly all?: boolean } = {}): Promise<Sent | SentAll> {
    return this.call("POST", `${AGENT}/msg`, { body: { to, text, ...sendFields(options), ...(options.all ? { all: true } : {}) }, ...signalOf(options) })
  }

  /** Asks a session; with wait, polls (≤WAIT_POLL_MAX_S each) until it is answered, declined or expired, or the wait is spent. */
  ask(to: string, text: string, options?: AskOptions & { readonly all?: false }): Promise<Asked>
  /** To every session the address names (no wait: TypeError). */
  ask(to: string, text: string, options: AskOptions & { readonly all: true }): Promise<SentAll>
  async ask(to: string, text: string, options: AskOptions & { readonly all?: boolean } = {}): Promise<Asked | SentAll> {
    if (options.all && options.wait !== undefined) throw new TypeError("ask: wait cannot be combined with all")
    let left = options.wait ?? 0
    const first = Math.min(left, WAIT_POLL_MAX_S)
    left -= first
    const body = {
      to,
      text,
      ...sendFields(options),
      ...(options.all ? { all: true } : {}),
      ...(options.expires !== undefined ? { expiresIn: options.expires } : {}),
      ...(options.wait !== undefined ? { wait: first } : {}),
      ...decisionFields(options),
    }
    const asked = await this.call<Asked | SentAll>("POST", `${AGENT}/ask`, { body, ...signalOf(options) })
    if ("sent" in asked) return asked
    let current: Asked = asked
    while (current.message.state === "open" && left > 0 && !options.signal?.aborted) {
      const wait = Math.min(left, WAIT_POLL_MAX_S)
      left -= wait
      current = { ...(asked.delivery ? { delivery: asked.delivery } : {}), ...(asked.decision ? { decision: asked.decision } : {}), ...(await this.message(current.message.id, { wait, ...signalOf(options) })) }
    }
    return current
  }

  /** One message the caller sent or received; wait (≤WAIT_POLL_MAX_S seconds) long-polls an open ask. */
  message(id: string, options: CallOptions & { readonly wait?: number } = {}): Promise<Asked> {
    return this.call("GET", `${AGENT}/messages/${segment(id)}`, { query: { wait: options.wait }, ...signalOf(options) })
  }

  /** Replies to a message (always to its real sender). */
  reply(id: string, text: string, options: CallOptions & { readonly wake?: boolean } = {}): Promise<Replied> {
    return this.call("POST", `${AGENT}/reply`, { body: { replyTo: id, text, ...(options.wake !== undefined ? { wake: options.wake } : {}) }, ...signalOf(options) })
  }

  /** Declines an ask, with a reason. */
  decline(id: string, why: string, options: CallOptions = {}): Promise<Replied> {
    return this.call("POST", `${AGENT}/decline`, { body: { replyTo: id, why }, ...signalOf(options) })
  }

  /** Open asks to the caller, its own waiting asks, recent messages and mutes. */
  inbox(options: CallOptions = {}): Promise<Inbox> {
    return this.call("GET", `${AGENT}/inbox`, signalOf(options))
  }

  /** Refuses messages from a session (an address). */
  mute(session: string, options: CallOptions = {}): Promise<{ muted: string[] }> {
    return this.call("POST", `${AGENT}/mute`, { body: { session }, ...signalOf(options) })
  }

  unmute(session: string, options: CallOptions = {}): Promise<{ muted: string[] }> {
    return this.call("POST", `${AGENT}/unmute`, { body: { session }, ...signalOf(options) })
  }

  // Decisions (asks to @me).

  /** Decisions the caller asked (the user: all of theirs), newest first. */
  decisions(options: CallOptions & { readonly state?: DecisionState } = {}): Promise<{ decisions: Decision[] }> {
    return this.call("GET", `${AGENT}/decisions`, { query: { state: options.state }, ...signalOf(options) })
  }

  decision(id: string, options: CallOptions = {}): Promise<{ decision: Decision }> {
    return this.call("GET", `${AGENT}/decisions/${segment(id)}`, signalOf(options))
  }

  /** Answers a Decision as the user (a device token; tap Decisions need the console): first answer wins, later ones are gone. */
  answerDecision(id: string, answer: CallOptions & { readonly option?: string; readonly text?: string }): Promise<DecisionAnswered> {
    const { signal: _signal, ...body } = answer
    return this.call("POST", `/api/decisions/${segment(id)}/answer`, { body, ...signalOf(answer) })
  }

  // Acting (users; sessions through their act token; app tokens with sessions:act). Outside the caller's grant the
  // hub answers needs_user (HubError; needsUserOf reads its evaluation).

  /** Approves a pending permission request in a session's tree. */
  approve(addr: string, requestID: string, options: ApproveOptions = {}): Promise<Approved> {
    const body = { requestID, ...(options.always ? { always: true } : {}), ...whyField(options) }
    return this.call("POST", `${AGENT}/sessions/${segment(addr)}/approve`, { body, ...signalOf(options) })
  }

  /** Rejects a pending permission request; the why reaches the harness (with who denied it). */
  deny(addr: string, requestID: string, options: ActOptions = {}): Promise<Denied> {
    return this.call("POST", `${AGENT}/sessions/${segment(addr)}/deny`, { body: { requestID, ...whyField(options) }, ...signalOf(options) })
  }

  /** Answers a pending form (question). */
  answer(addr: string, formID: string, answer: FormAnswer, options: ActOptions = {}): Promise<FormAnswered> {
    return this.call("POST", `${AGENT}/sessions/${segment(addr)}/answer`, { body: { formID, answer, ...whyField(options) }, ...signalOf(options) })
  }

  /** Dismisses a pending form without an answer. */
  cancelForm(addr: string, formID: string, options: ActOptions = {}): Promise<FormAnswered> {
    return this.call("POST", `${AGENT}/sessions/${segment(addr)}/answer`, { body: { formID, cancel: true, ...whyField(options) }, ...signalOf(options) })
  }

  /** Prompts a session (agents' prompts carry the hub's provenance). */
  prompt(addr: string, text: string, options: PromptOptions = {}): Promise<Prompted> {
    const body = {
      text,
      ...(options.images ? { images: options.images } : {}),
      ...(options.delivery ? { delivery: options.delivery } : {}),
      ...(options.wake !== undefined ? { wake: options.wake } : {}),
      ...whyField(options),
    }
    return this.call("POST", `${AGENT}/sessions/${segment(addr)}/prompt`, { body, ...signalOf(options) })
  }

  /** Stops a session's running turn. */
  stop(addr: string, options: ActOptions = {}): Promise<Stopped> {
    return this.call("POST", `${AGENT}/sessions/${segment(addr)}/stop`, { body: whyField(options), ...signalOf(options) })
  }

  // Grants (user credentials only: a session or app token is forbidden).

  /** The user's grants, newest first. */
  grants(options: CallOptions = {}): Promise<{ grants: Grant[] }> {
    return this.call("GET", `${AGENT}/grants`, signalOf(options))
  }

  grant(id: string, options: CallOptions = {}): Promise<{ grant: Grant }> {
    return this.call("GET", `${AGENT}/grants/${segment(id)}`, signalOf(options))
  }

  createGrant(spec: GrantSpec, options: CallOptions = {}): Promise<{ grant: Grant }> {
    return this.call("POST", `${AGENT}/grants`, { body: spec, ...signalOf(options) })
  }

  /** Replaces a grant (its holder stays). */
  updateGrant(id: string, spec: GrantSpec, options: CallOptions = {}): Promise<{ grant: Grant }> {
    return this.call("PUT", `${AGENT}/grants/${segment(id)}`, { body: spec, ...signalOf(options) })
  }

  /** Revokes a grant (gone when it already ended). */
  revokeGrant(id: string, options: CallOptions = {}): Promise<{ grant: Grant }> {
    return this.call("DELETE", `${AGENT}/grants/${segment(id)}`, signalOf(options))
  }

  /**
   * Asks the user for a grant (sessions; app tokens with messages:send): opens a tap Decision for the user, whose
   * approval creates the grant; the answer comes back as a reply to the ask (with the grant id when approved).
   */
  requestGrant(grant: GrantRequestSpec, why: string, options: CallOptions = {}): Promise<GrantRequested> {
    return this.call("POST", `${AGENT}/grants/requests`, { body: { grant, why }, ...signalOf(options) })
  }

  // App tokens (user credentials only).

  createAppToken(input: CallOptions & { readonly label?: string; readonly scopes?: readonly string[] } = {}): Promise<CreatedAppToken> {
    const { signal: _signal, ...body } = input
    return this.call("POST", `${AGENT}/app-tokens`, { body, ...signalOf(input) })
  }

  appTokens(options: CallOptions = {}): Promise<{ tokens: AppTokenView[] }> {
    return this.call("GET", `${AGENT}/app-tokens`, signalOf(options))
  }

  revokeAppToken(id: string, options: CallOptions = {}): Promise<void> {
    return this.call("DELETE", `${AGENT}/app-tokens/${segment(id)}`, signalOf(options))
  }
}
