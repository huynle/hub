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
//
// - The sender is only ever the authenticated actor; any from/sender in a body is ignored. A session cannot
//   message itself (invalid). Replies and declines come only from the message's recipient; anyone else, and any
//   unknown or foreign id, gets not_found. Non-session senders (the user, apps) have a stored-only inbox.
// - expiresIn and wait are seconds. wait (0–WAIT_MAX_S) long-polls an ask until it is answered, declined or
//   expired; longer waits loop on GET /messages/:id?wait=. A message reads for its sender and recipient (and the
//   user, who owns every party); others get not_found.
// - Messaging off (UserRecord.agent.messagingPaused): msg, ask, reply and decline answer paused; reading works.
// - Every stored message is published on the MessageFeed (GET /api/agent/watch 'message' events, waiters).
import type { Store } from "../store"
import type { AgentActor } from "./actor"
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

/** Stored messages of every user, as they are sent (in-process). */
export class MessageFeed {
  private readonly listeners = new Set<(userID: string, message: Message) => void>()

  subscribe(listener: (userID: string, message: Message) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  publish(userID: string, message: Message): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(userID, message)
      } catch (cause) {
        console.error("[hub] message listener failed:", cause)
      }
    }
  }
}

export interface MessageDeps {
  readonly delivery: Delivery
  readonly directory: Pick<Directory, "resolveOne">
  readonly store: Pick<Store, "agentData" | "updateAgentData" | "audit">
  readonly feed: MessageFeed
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

const sentView = ({ message, delivery }: Sent) => ({ message, ...(delivery ? { delivery } : {}) })

export function messageRoutes(deps: MessageDeps): AgentRoute[] {
  const { delivery, feed } = deps
  const pollMs = deps.pollMs ?? WAIT_POLL_MS

  const paused = (userID: string) => deps.store.agentData(userID).messagingPaused === true
  const ensureOn = (userID: string) => {
    if (paused(userID)) throw new AgentError("paused", "Messaging is off for this user", { hint: "Turn it on in the console (PUT /api/agent/messaging)" })
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
        deps.store.updateAgentData(user.id, (data) => {
          if (enabled) delete data.messagingPaused
          else data.messagingPaused = true
        })
        deps.store.audit({ actor: user.id, action: enabled ? "messaging.resume" : "messaging.pause" })
        return ok({ enabled })
      },
    },
  ]
}
