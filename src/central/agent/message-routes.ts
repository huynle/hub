// Messaging on /api/agent (design §3, §8; decisions jswt9p22): thin routes over the delivery engine (./delivery).
//
// Routes (user actors always; session tokens; app tokens by scope):
//   POST /api/agent/msg      {to, text, wake?, urgent?, all?}              messages:send → 201 {message, delivery?} | {sent: [...]} (all)
//   POST /api/agent/ask      {to, text, wake?, urgent?, all?, expiresIn?, wait?}  messages:send → 201 {message, delivery?, answer?}
//   POST /api/agent/reply    {replyTo, text, wake?}                        messages:send → 201 {message, delivery?, original}
//   POST /api/agent/decline  {replyTo, why}                                messages:send → 201 {message, delivery?, original}
//   GET  /api/agent/inbox                                                  messages:read → {asks, waiting, messages, muted}
//   GET  /api/agent/messages/:id?wait=                                     messages:read → {message, answer?}
//   POST /api/agent/mute     {session}  /  POST /api/agent/unmute {session} messages:send → {muted}
//   GET  /api/agent/messaging  /  PUT /api/agent/messaging {enabled}       user actors only: the per-user switch
//   GET  /api/agent/decisions?state=  /  GET /api/agent/decisions/:id      messages:read → {decisions} / {decision}
//
// - @me (design §12.1): msg @me is stored for the user; ask @me opens a Decision (./decisions) with the extra
//   fields {options: [{id, label, safe?}], recommendation: {option, why?}, urgency, tier, deadline (seconds),
//   onTimeout, about: [addresses]} → 201 {message, decision, answer?}. Those fields on an ask to anyone else are
//   invalid. Only the user answers a Decision, on the console (/api/decisions/:id/answer): its ask cannot be
//   replied to or declined here. Decisions read for their asker (and the user); others get not_found.
//
// - The sender is only ever the authenticated actor; any from/sender in a body is ignored. A session cannot
//   message itself (invalid). Replies and declines come only from the message's recipient; anyone else, and any
//   unknown or foreign id, gets not_found. Non-session senders (the user, apps) have a stored-only inbox.
// - expiresIn and wait are seconds. wait (0–WAIT_MAX_S) long-polls an ask until it is answered, declined or
//   expired; longer waits loop on GET /messages/:id?wait=. A message reads for its sender and recipient (and the
//   user, who owns every party); others get not_found.
// - Messaging off (UserRecord.agent.messagingPaused): msg, ask, reply and decline answer paused; reading works.
// - Every stored message is published on the MessageFeed (GET /api/agent/watch 'message' events, waiters).
import { Feed } from "../cluster/feed"
import type { Store } from "../store"
import type { AgentActor } from "./actor"
import { type AskInput, DECISION_STATES, type DecisionState, type Decisions, type Tier, type Urgency } from "./decisions"
import type { Delivery, SendOptions, Sent } from "./delivery"
import type { Directory } from "./directory"
import { partyFromActor, partyKey } from "./envelope"
import { AgentError } from "./errors"
import { TEXT_MAX, WHY_MAX, type Message } from "./messages"
import { AGENT_PREFIX, type AgentRoute } from "./routes"

/** The longest wait of one request (seconds); clients loop for longer ones. */
export const WAIT_MAX_S = 60
/** How often a waiting request looks at the message besides the feed (expiry, other hub processes). */
export const WAIT_POLL_MS = 1_000

/** Message events' Bus topic (cluster mode). */
export const MESSAGES_TOPIC = "feed.messages"

/** Stored messages of every user, as they are sent (shared with the other pods once attached; see ../cluster/feed). */
export class MessageFeed extends Feed<Message> {
  constructor() {
    super(MESSAGES_TOPIC, (cause) => console.error("[hub] message listener failed:", cause))
  }
}

export interface MessageDeps {
  readonly delivery: Delivery
  readonly directory: Pick<Directory, "resolveOne">
  readonly store: Pick<Store, "agentData" | "updateAgentData" | "audit">
  readonly feed: MessageFeed
  /** Decisions (ask @me); without them an ask to @me is a plain stored ask. */
  readonly decisions?: Decisions
  /** Default WAIT_POLL_MS. */
  readonly pollMs?: number
}

const NO_STORE = { "cache-control": "no-store" }
const ok = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE })
const SEND = { session: true, scope: "messages:send" } as const
const READ = { session: true, scope: "messages:read" } as const

type Body = Record<string, unknown>

async function bodyOf(request: Request): Promise<Body> {
  const body = await request.json()
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AgentError("invalid", "Body must be a JSON object")
  return body as Body
}

function string(body: Body, key: string, max?: number): string {
  const value = body[key]
  if (typeof value !== "string" || !value.trim()) throw new AgentError("invalid", `${key} must be a non-empty string`)
  if (max !== undefined && value.length > max) throw new AgentError("invalid", `${key} is longer than ${max} characters`)
  return value
}

function flag(body: Body, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new AgentError("invalid", `${key} must be true or false`)
  return value
}

function seconds(value: unknown, key: string, max = Number.POSITIVE_INFINITY): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    const range = Number.isFinite(max) ? ` from 0 to ${max}` : ""
    throw new AgentError("invalid", `${key} must be a number of seconds${range}`, key === "wait" ? { hint: `Loop on GET ${AGENT_PREFIX}/messages/:id?wait=${WAIT_MAX_S} for longer waits` } : {})
  }
  return value
}

/** The wait query parameter (seconds), or undefined. */
function waitQuery(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined
  return seconds(/^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN, "wait", WAIT_MAX_S)
}

const sendOptions = (body: Body): SendOptions => {
  const wake = flag(body, "wake")
  const urgent = flag(body, "urgent")
  return { ...(wake === undefined ? {} : { wake }), ...(urgent === undefined ? {} : { urgent }) }
}

/** The user's address (also the malformed `@me.project`, which the delivery engine refuses). */
const isMe = (to: string) => to === "@me" || to.startsWith("@me.")

const DECISION_FIELDS = ["options", "recommendation", "urgency", "tier", "deadline", "onTimeout", "about"] as const

/** The state query parameter of a Decision listing, or undefined. */
export function decisionStateQuery(raw: string | null): DecisionState | undefined {
  if (raw === null || raw === "") return undefined
  if (!DECISION_STATES.includes(raw as DecisionState)) throw new AgentError("invalid", `state is one of ${DECISION_STATES.join(", ")}`)
  return raw as DecisionState
}

/** The Decision fields of an ask body (shapes only; ./decisions validates the rest); about stays addresses. */
function decisionFields(body: Body): Omit<AskInput, "question" | "about" | "expiresInMs"> & { about?: string[] } {
  const out: Record<string, unknown> = {}
  if (body.options !== undefined) {
    if (!Array.isArray(body.options)) throw new AgentError("invalid", "options must be a list of {id, label, safe?}")
    out.options = body.options.map((option: unknown) => {
      if (typeof option !== "object" || option === null) throw new AgentError("invalid", "options must be a list of {id, label, safe?}")
      const { id, label, safe } = option as Record<string, unknown>
      if (safe !== undefined && typeof safe !== "boolean") throw new AgentError("invalid", "safe must be true or false")
      return { id, label, ...(safe === true ? { safe } : {}) }
    })
  }
  if (body.recommendation !== undefined) {
    const r = body.recommendation as Record<string, unknown> | null
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw new AgentError("invalid", "recommendation must be {option, why?}")
    out.recommendation = { option: r.option, ...(r.why === undefined ? {} : { why: r.why }) }
  }
  for (const key of ["urgency", "tier", "onTimeout"] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== "string") throw new AgentError("invalid", `${key} must be a string`)
    out[key] = body[key]
  }
  const deadline = seconds(body.deadline, "deadline")
  if (deadline !== undefined) out.deadlineMs = Math.round(deadline * 1000)
  if (body.about !== undefined) {
    if (!Array.isArray(body.about) || body.about.some((a) => typeof a !== "string")) throw new AgentError("invalid", "about must be a list of addresses")
    out.about = body.about as string[]
  }
  return out as Omit<AskInput, "question" | "about" | "expiresInMs"> & { urgency?: Urgency; tier?: Tier; about?: string[] }
}

const sentView = ({ message, delivery }: Sent) => ({ message, ...(delivery ? { delivery } : {}) })

export function messageRoutes(deps: MessageDeps): AgentRoute[] {
  const { delivery, feed } = deps
  const pollMs = deps.pollMs ?? WAIT_POLL_MS

  const paused = (userID: string) => deps.store.agentData(userID).messagingPaused === true
  const ensureOn = (userID: string) => {
    if (paused(userID)) throw new AgentError("paused", "Messaging is off for this user", { hint: "Ask the user to turn messaging back on (it is their switch: PUT /api/agent/messaging {\"enabled\": true}; no console switch yet)" })
  }

  /** The message, when the actor may read it (its sender or recipient, or the user). */
  const readable = async (userID: string, actor: AgentActor, id: string): Promise<Message> => {
    const message = await delivery.messages.get(userID, id)
    const me = partyKey(partyFromActor(actor))
    if (!message || (actor.kind !== "user" && partyKey(message.from) !== me && partyKey(message.recipient) !== me)) {
      throw new AgentError("not_found", "No such message")
    }
    return message
  }

  /** Resolves on the feed's answer to `id`, after `ms`, or on abort. */
  const nudge = (userID: string, id: string, ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      const unsubscribe = feed.subscribe((user, message) => {
        if (user === userID && message.replyTo === id) done()
      })
      signal.addEventListener("abort", done, { once: true })
    })

  /** The message and its answer, after waiting up to `waitS` seconds for an open ask to close. */
  const settled = async (userID: string, message: Message, waitS: number | undefined, signal: AbortSignal) => {
    const deadline = Date.now() + (waitS ?? 0) * 1000
    let current = message
    while (current.state === "open" && !signal.aborted) {
      const left = deadline - Date.now()
      if (left <= 0) break
      await nudge(userID, current.id, Math.min(pollMs, left), signal)
      current = (await delivery.messages.get(userID, current.id)) ?? current
    }
    const answer = current.answer ? await delivery.messages.get(userID, current.answer.id) : undefined
    return { message: current, ...(answer ? { answer } : {}) }
  }

  /** A Decision's ask is answered only on the console (the user is its only possible replier). */
  const notADecision = async (userID: string, actor: AgentActor, replyTo: string) => {
    if (actor.kind !== "user" || !deps.decisions) return
    const decision = await deps.decisions.byMessage(userID, replyTo)
    if (decision) throw new AgentError("invalid", `${replyTo} carries decision ${decision.id}`, { hint: "Answer it on the console's Home page (its decision card)" })
  }

  /** Decisions the actor may read: the user all, others those they asked. */
  const decisionsFor = (userID: string, actor: AgentActor, state?: DecisionState) =>
    deps.decisions!.list(userID, { ...(state ? { state } : {}), ...(actor.kind === "user" ? {} : { from: partyFromActor(actor) }) })

  /** Sends to one session the address names, or (all) to every one; published on the feed. */
  async function send(userID: string, actor: AgentActor, to: string, kind: "msg" | "ask", text: string, options: SendOptions, all: boolean | undefined): Promise<Sent[]> {
    ensureOn(userID)
    const sent = all ? await delivery.sendAll(userID, actor, to, kind, text, options) : [await delivery.send(userID, actor, to, kind, text, options)]
    for (const { message } of sent) feed.publish(userID, message)
    return sent
  }

  return [
    {
      method: "POST",
      path: `${AGENT_PREFIX}/msg`,
      allow: SEND,
      async handle({ request, user, actor }) {
        const body = await bodyOf(request)
        const to = string(body, "to")
        const text = string(body, "text", TEXT_MAX)
        const all = flag(body, "all")
        const sent = await send(user.id, actor, to, "msg", text, sendOptions(body), all)
        return ok(all ? { sent: sent.map(sentView) } : sentView(sent[0]!), 201)
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/ask`,
      allow: SEND,
      async handle({ request, user, actor }) {
        const body = await bodyOf(request)
        const to = string(body, "to")
        const text = string(body, "text", TEXT_MAX)
        const all = flag(body, "all")
        const expiresIn = seconds(body.expiresIn, "expiresIn")
        const wait = seconds(body.wait, "wait", WAIT_MAX_S)
        if (all && wait !== undefined) throw new AgentError("invalid", "wait cannot be combined with all")
        const options: SendOptions = { ...sendOptions(body), ...(expiresIn === undefined ? {} : { expiresInMs: Math.round(expiresIn * 1000) }) }
        const decisionAsked = DECISION_FIELDS.some((key) => body[key] !== undefined)
        if (isMe(to) && deps.decisions) {
          if (all) throw new AgentError("invalid", "all cannot be combined with @me")
          ensureOn(user.id)
          const { about, ...fields } = decisionFields(body)
          const sessions = about?.map((addr) => deps.directory.resolveOne(user.id, addr).sessionID)
          const { message, decision } = await deps.decisions.ask(user.id, actor, {
            question: text,
            ...fields,
            ...(sessions ? { about: sessions } : {}),
            ...(options.expiresInMs === undefined ? {} : { expiresInMs: options.expiresInMs }),
          })
          feed.publish(user.id, message)
          const done = await settled(user.id, message, wait, request.signal)
          return ok({ ...done, decision: (await deps.decisions.get(user.id, decision.id)) ?? decision }, 201)
        }
        if (decisionAsked) throw new AgentError("invalid", "options, recommendation, urgency, tier, deadline, onTimeout and about are for asks to @me")
        const sent = await send(user.id, actor, to, "ask", text, options, all)
        if (all) return ok({ sent: sent.map(sentView) }, 201)
        const { message, delivery: how } = sent[0]!
        return ok({ ...sentView({ message, ...(how ? { delivery: how } : {}) }), ...(await settled(user.id, message, wait, request.signal)) }, 201)
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/reply`,
      allow: SEND,
      async handle({ request, user, actor }) {
        const body = await bodyOf(request)
        const replyTo = string(body, "replyTo")
        const text = string(body, "text", TEXT_MAX)
        const wake = flag(body, "wake")
        ensureOn(user.id)
        await notADecision(user.id, actor, replyTo)
        const replied = await delivery.reply(user.id, actor, replyTo, text, wake === undefined ? {} : { wake })
        feed.publish(user.id, replied.message)
        return ok({ ...sentView(replied), original: replied.original }, 201)
      },
    },
    {
      method: "POST",
      path: `${AGENT_PREFIX}/decline`,
      allow: SEND,
      async handle({ request, user, actor }) {
        const body = await bodyOf(request)
        const replyTo = string(body, "replyTo")
        const why = string(body, "why", WHY_MAX)
        ensureOn(user.id)
        await notADecision(user.id, actor, replyTo)
        const declined = await delivery.decline(user.id, actor, replyTo, why)
        feed.publish(user.id, declined.message)
        return ok({ ...sentView(declined), original: declined.original }, 201)
      },
    },
    {
      method: "GET",
      path: `${AGENT_PREFIX}/inbox`,
      allow: READ,
      async handle({ user, actor }) {
        const party = partyFromActor(actor)
        const inbox = await delivery.messages.inbox(user.id, party)
        return ok({ ...inbox, muted: await delivery.messages.muted(user.id, party) })
      },
    },
    {
      method: "GET",
      path: `${AGENT_PREFIX}/messages/:id`,
      allow: READ,
      async handle({ user, actor, params, url, request }) {
        const wait = waitQuery(url.searchParams.get("wait"))
        const message = await readable(user.id, actor, params.id!)
        return ok(await settled(user.id, message, wait, request.signal))
      },
    },
    ...(deps.decisions
      ? [
          {
            method: "GET",
            path: `${AGENT_PREFIX}/decisions`,
            allow: READ,
            handle: async ({ user, actor, url }) => ok({ decisions: await decisionsFor(user.id, actor, decisionStateQuery(url.searchParams.get("state"))) }),
          } satisfies AgentRoute,
          {
            method: "GET",
            path: `${AGENT_PREFIX}/decisions/:id`,
            allow: READ,
            async handle({ user, actor, params }) {
              const decision = await deps.decisions!.get(user.id, params.id!)
              if (!decision || (actor.kind !== "user" && partyKey(decision.from) !== partyKey(partyFromActor(actor)))) throw new AgentError("not_found", "No such decision")
              return ok({ decision })
            },
          } satisfies AgentRoute,
        ]
      : []),
    ...(["mute", "unmute"] as const).map(
      (verb): AgentRoute => ({
        method: "POST",
        path: `${AGENT_PREFIX}/${verb}`,
        allow: SEND,
        async handle({ request, user, actor }) {
          const body = await bodyOf(request)
          const entry = deps.directory.resolveOne(user.id, string(body, "session"))
          if (actor.kind === "session" && entry.sessionID === actor.sessionID) throw new AgentError("invalid", "A session cannot mute itself")
          const party = partyFromActor(actor)
          if (verb === "mute") await delivery.messages.mute(user.id, party, entry.sessionID)
          else await delivery.messages.unmute(user.id, party, entry.sessionID)
          return ok({ muted: await delivery.messages.muted(user.id, party) })
        },
      }),
    ),
    {
      method: "GET",
      path: `${AGENT_PREFIX}/messaging`,
      allow: {},
      handle: ({ user }) => ok({ enabled: !paused(user.id) }),
    },
    {
      method: "PUT",
      path: `${AGENT_PREFIX}/messaging`,
      allow: {},
      async handle({ request, user }) {
        const enabled = flag(await bodyOf(request), "enabled")
        if (enabled === undefined) throw new AgentError("invalid", "enabled must be true or false")
        await deps.store.updateAgentData(user.id, (data) => {
          if (enabled) delete data.messagingPaused
          else data.messagingPaused = true
        })
        await deps.store.audit({ actor: user.id, action: enabled ? "messaging.resume" : "messaging.pause" })
        return ok({ enabled })
      },
    },
  ]
}
