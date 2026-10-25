// The agent message store (design §3.1, §3.2), over the StateStore interface with an injected clock. No routes:
// the message routes (P2-T6) and the delivery engine (P2-T5) call it.
//
// - Stored form: {id, kind, from, to, recipient, generation?, text, replyTo?, state, at, hop, expiresAt?,
//   delivery?, deliveredAt?, answer?}. `from` is the authenticated sender (partyFromActor); `to` keeps the
//   address as written (`@@reviewer`), `recipient` the party it reached; text and `to` are sanitised.
// - Caps: each party (session, the user, an app) keeps its latest SESSION_MESSAGES; a message no party keeps
//   is deleted. Per user, at most USER_MESSAGES messages / USER_BYTES; over either, the oldest go (down to
//   90%). Eviction keeps open asks while anything else can go.
// - Asks: open → answered (a reply) | declined | expired (at expiresAt, seen on read; expire() persists it).
//   The first answer wins (version-checked write); later ones get `gone`.
// - Replies and declines come only from the recipient (anyone else: not_found, like a foreign id) and go to
//   the real sender, never via a role; a reply from another role-holder generation is `gone`.
// - Mutes: a party refuses msg/ask from a session; answers to the muter's own asks still go through.
import { randomBytes } from "node:crypto"
import type { Clock, StateStore } from "../backend/types"
import { type Party, partyKey, sanitizeLabel, sanitizeText } from "./envelope"
import { AgentError } from "./errors"
import { updateVersioned } from "./versioned"

/** Messages each party keeps. */
export const SESSION_MESSAGES = 200
/** Messages per user. */
export const USER_MESSAGES = 10_000
/** Stored bytes per user. */
export const USER_BYTES = 20 * 1024 * 1024
/** Characters of message text. */
/** Body limit: the rendered envelope (escaped lines, header, boundaries, hint) must fit DELIVER_TEXT_MAX (16000). */
export const TEXT_MAX = 10_000
/** Characters of a decline reason. */
export const WHY_MAX = 1_000
/** Default and bounds of an ask's lifetime. */
export const ASK_EXPIRES_MS = 24 * 60 * 60_000
export const ASK_EXPIRES_MIN_MS = 60_000
export const ASK_EXPIRES_MAX_MS = 7 * 24 * 60 * 60_000
/** Received messages an inbox shows. */
export const INBOX_RECENT = 50

export type MessageKind = "msg" | "ask" | "reply" | "decline"
/** `sent` for msg/reply/decline; asks are open until answered, declined or expired. */
export type MessageState = "sent" | "open" | "answered" | "declined" | "expired"
/** How a message reached its recipient (design §3.3), recorded by the delivery engine. */
export type Delivery = "steer" | "turn" | "queued" | "retained" | "pending"

export interface Message {
  readonly id: string
  readonly kind: MessageKind
  readonly from: Party
  /** The address as the sender wrote it. */
  readonly to: string
  /** The party it reached. */
  readonly recipient: Party
  /** The role holder generation it reached (role addresses). */
  readonly generation?: number
  readonly text: string
  /** What a reply or decline answers. */
  readonly replyTo?: string
  readonly state: MessageState
  readonly at: number
  /** Loop protection: hops since a human turn (see HopTracker). */
  readonly hop: number
  /** Asks only. */
  readonly expiresAt?: number
  readonly delivery?: Delivery
  /** When it was first delivered (steer, turn or queued). */
  readonly deliveredAt?: number
  /** The reply or decline that closed an ask. */
  readonly answer?: { readonly id: string; readonly at: number }
}

export interface MessageLimitsConfig {
  readonly session: number
  readonly userMessages: number
  readonly userBytes: number
}

export interface SendInput {
  readonly from: Party
  readonly to: string
  readonly recipient: Party
  readonly kind: "msg" | "ask"
  readonly text: string
  readonly generation?: number
  /** From HopTracker.next (default 0). */
  readonly hop?: number
  /** Asks only; default ASK_EXPIRES_MS. */
  readonly expiresInMs?: number
}

export interface AnswerInput {
  /** The authenticated replier. */
  readonly from: Party
  readonly replyTo: string
  /** The replier's current role holder generation, when it holds the role the original reached. */
  readonly generation?: number
  readonly hop?: number
}

export interface Answered {
  /** The reply or decline. */
  readonly message: Message
  /** What it answered (an ask now closed). */
  readonly original: Message
}

export interface Inbox {
  /** Open asks to the party, newest first. */
  readonly asks: Message[]
  /** The party's own open asks, newest first. */
  readonly waiting: Message[]
  /** Recent messages to the party, newest first. */
  readonly messages: Message[]
}

export interface Usage {
  readonly count: number
  readonly bytes: number
}

const MESSAGES = "messages"
const INDEX = "message-index"
const USAGE = "message-usage"
const MUTES = "message-mutes"
const USAGE_KEY = "total"
/** Version-checked attempts to detach a contended message. */
const DETACH_ATTEMPTS = 16

interface StoredMessage {
  readonly message: Message
  /** Party keys whose index lists it. */
  readonly indexed: string[]
  readonly bytes: number
}

interface Index {
  /** Oldest first. */
  readonly ids: string[]
}

interface MuteList {
  /** Muted session id → when. */
  readonly sessions: Record<string, number>
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** `msg_` + 22 base62 characters from the CSPRNG (~131 bits, unbiased). */
export function newMessageID(): string {
  let id = ""
  while (id.length < 22) for (const byte of randomBytes(32)) if (byte < 248 && id.length < 22) id += BASE62[byte % 62]
  return `msg_${id}`
}

/** How a reply addresses a party: `@name`, `ses_…`, `@me`, `app:<tokenID>`. */
function addressOf(party: Party): string {
  switch (party.kind) {
    case "session":
      return party.name ? `@${party.name}` : party.sessionID
    case "user":
      return "@me"
    case "app":
      return `app:${party.tokenID}`
  }
}

const isOpenAsk = (message: Message) => message.kind === "ask" && message.state === "open"

const notFound = () => new AgentError("not_found", "No such message")
const gone = (message = "The ask is already answered, declined or expired") => new AgentError("gone", message)

/** Sanitised text; invalid when too long or empty. */
function cleanText(text: string, max: number, what: string): string {
  if (typeof text !== "string" || text.length > max) throw new AgentError("invalid", `${what} is longer than ${max} characters`)
  const clean = sanitizeText(text)
  if (!clean.trim()) throw new AgentError("invalid", `${what} is empty`)
  return clean
}

export class Messages {
  private readonly state: StateStore
  private readonly now: Clock
  private readonly newID: () => string
  private readonly limits: MessageLimitsConfig

  constructor(deps: { readonly state: StateStore; readonly now?: Clock; readonly newID?: () => string; readonly limits?: Partial<MessageLimitsConfig> }) {
    this.state = deps.state
    this.now = deps.now ?? Date.now
    this.newID = deps.newID ?? newMessageID
    this.limits = { session: SESSION_MESSAGES, userMessages: USER_MESSAGES, userBytes: USER_BYTES, ...deps.limits }
  }

  /** Stores a new msg or ask. Throws invalid (text, expiry) or forbidden (the recipient muted the sender). */
  async send(userID: string, input: SendInput): Promise<Message> {
    const text = cleanText(input.text, TEXT_MAX, "Message text")
    if (input.kind !== "ask" && input.expiresInMs !== undefined) throw new AgentError("invalid", "Only asks expire")
    const expiresIn = input.expiresInMs ?? ASK_EXPIRES_MS
    if (input.kind === "ask" && !(expiresIn >= ASK_EXPIRES_MIN_MS && expiresIn <= ASK_EXPIRES_MAX_MS)) {
      throw new AgentError("invalid", `An ask expires after ${ASK_EXPIRES_MIN_MS / 60_000} minute to ${ASK_EXPIRES_MAX_MS / 86_400_000} days`)
    }
    if (input.from.kind === "session" && (await this.muted(userID, input.recipient)).includes(input.from.sessionID)) {
      throw new AgentError("forbidden", "The recipient muted this session")
    }
    const at = this.now()
    const message: Message = {
      id: this.newID(),
      kind: input.kind,
      from: input.from,
      to: sanitizeLabel(input.to),
      recipient: input.recipient,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      text,
      state: input.kind === "ask" ? "open" : "sent",
      at,
      hop: input.hop ?? 0,
      ...(input.kind === "ask" ? { expiresAt: at + expiresIn } : {}),
    }
    await this.store(userID, message)
    return message
  }

  /** Replies to a message (answering an ask), from its recipient to its real sender. */
  async reply(userID: string, input: AnswerInput & { readonly text: string }): Promise<Answered> {
    const original = await this.answerable(userID, input)
    const text = cleanText(input.text, TEXT_MAX, "Reply text")
    return this.answer(userID, original, input, "reply", text)
  }

  /** Declines an ask, with a reason. */
  async decline(userID: string, input: AnswerInput & { readonly why: string }): Promise<Answered> {
    const original = await this.answerable(userID, input)
    if (original.kind !== "ask") throw new AgentError("invalid", "Only asks can be declined")
    const why = cleanText(input.why, WHY_MAX, "The reason")
    return this.answer(userID, original, input, "decline", why)
  }

  async get(userID: string, id: string): Promise<Message | undefined> {
    const stored = await this.state.get<StoredMessage>(userID, MESSAGES, id)
    return stored && this.view(stored.value.message)
  }

  /** Messages the party sent or received, newest first. */
  async list(userID: string, party: Party, options: { readonly limit?: number } = {}): Promise<Message[]> {
    const ids = (await this.state.get<Index>(userID, INDEX, partyKey(party)))?.value.ids ?? []
    const wanted = ids.slice().reverse().slice(0, options.limit ?? this.limits.session)
    const messages = await Promise.all(wanted.map((id) => this.get(userID, id)))
    return messages.filter((message): message is Message => message !== undefined)
  }

  async inbox(userID: string, party: Party): Promise<Inbox> {
    const key = partyKey(party)
    const all = await this.list(userID, party)
    const toMe = all.filter((message) => partyKey(message.recipient) === key)
    return {
      asks: toMe.filter(isOpenAsk),
      waiting: all.filter((message) => isOpenAsk(message) && partyKey(message.from) === key),
      messages: toMe.slice(0, INBOX_RECENT),
    }
  }

  async usage(userID: string): Promise<Usage> {
    return (await this.state.get<Usage>(userID, USAGE, USAGE_KEY))?.value ?? { count: 0, bytes: 0 }
  }

  /** Records how the message was delivered; undefined when there is no such message. */
  async setDelivery(userID: string, id: string, delivery: Delivery): Promise<Message | undefined> {
    const at = this.now()
    const delivered = delivery === "steer" || delivery === "turn" || delivery === "queued"
    const stored = await updateVersioned<StoredMessage>(this.state, userID, MESSAGES, id, (current) =>
      current && {
        ...current,
        message: { ...current.message, delivery, ...(current.message.deliveredAt === undefined && delivered ? { deliveredAt: at } : {}) },
      },
    )
    return stored && this.view(stored.message)
  }

  /** Closes the user's asks that are past expiresAt and returns them (to tell their senders). */
  async expire(userID: string): Promise<Message[]> {
    const expired: Message[] = []
    for (const entry of await this.state.list<StoredMessage>(userID, MESSAGES)) {
      if (!this.isDue(entry.value.message)) continue
      const stored = await updateVersioned<StoredMessage>(this.state, userID, MESSAGES, entry.key, (current) =>
        current && this.isDue(current.message) ? { ...current, message: { ...current.message, state: "expired" } } : undefined,
      )
      if (stored) expired.push(stored.message)
    }
    return expired
  }

  /** `by` refuses msg/ask from the session. */
  async mute(userID: string, by: Party, sessionID: string): Promise<void> {
    const at = this.now()
    await updateVersioned<MuteList>(this.state, userID, MUTES, partyKey(by), (current) =>
      current?.sessions[sessionID] !== undefined ? undefined : { sessions: { ...current?.sessions, [sessionID]: at } },
    )
  }

  async unmute(userID: string, by: Party, sessionID: string): Promise<void> {
    await updateVersioned<MuteList>(this.state, userID, MUTES, partyKey(by), (current) => {
      if (current?.sessions[sessionID] === undefined) return undefined
      const { [sessionID]: _, ...sessions } = current.sessions
      return { sessions }
    })
  }

  /** The sessions `by` muted, sorted. */
  async muted(userID: string, by: Party): Promise<string[]> {
    const list = (await this.state.get<MuteList>(userID, MUTES, partyKey(by)))?.value
    return Object.keys(list?.sessions ?? {}).sort()
  }

  // ---- internals ----------------------------------------------------------------------------------------

  /** The message as of now (an open ask past expiresAt reads expired). */
  private view(message: Message): Message {
    return this.isDue(message) ? { ...message, state: "expired" } : message
  }

  private isDue(message: Message): boolean {
    return isOpenAsk(message) && message.expiresAt !== undefined && this.now() >= message.expiresAt
  }

  /** The message `input` answers, when `input.from` is its recipient; otherwise not_found (or gone for another generation). */
  private async answerable(userID: string, input: AnswerInput): Promise<Message> {
    const original = await this.get(userID, input.replyTo)
    if (!original || partyKey(original.recipient) !== partyKey(input.from)) throw notFound()
    if (input.generation !== undefined && original.generation !== undefined && input.generation !== original.generation) {
      throw gone("The role changed hands since this message arrived")
    }
    return original
  }

  private async answer(userID: string, original: Message, input: AnswerInput, kind: "reply" | "decline", text: string): Promise<Answered> {
    const at = this.now()
    const message: Message = {
      id: this.newID(),
      kind,
      from: input.from,
      to: addressOf(original.from),
      recipient: original.from,
      text,
      replyTo: original.id,
      state: "sent",
      at,
      hop: input.hop ?? 0,
    }
    let closed = original
    if (original.kind === "ask") {
      if (original.state !== "open") throw gone()
      const state = kind === "reply" ? "answered" : "declined"
      const stored = await updateVersioned<StoredMessage>(this.state, userID, MESSAGES, original.id, (current) =>
        current && !this.isDue(current.message) && isOpenAsk(current.message) ? { ...current, message: { ...current.message, state, answer: { id: message.id, at } } } : undefined,
      )
      if (!stored) throw gone()
      closed = stored.message
    }
    await this.store(userID, message)
    return { message, original: closed }
  }

  /** Writes a new message, indexes it for its parties and enforces the caps. */
  private async store(userID: string, message: Message): Promise<void> {
    const indexed = [...new Set([partyKey(message.from), partyKey(message.recipient)])]
    const bytes = Buffer.byteLength(JSON.stringify(message))
    const written = await this.state.put<StoredMessage>(userID, MESSAGES, message.id, { message, indexed, bytes }, { ifVersion: 0 })
    if (!written.ok) throw new Error("message id collision")
    await this.addUsage(userID, 1, bytes)
    for (const key of indexed) {
      await updateVersioned<Index>(this.state, userID, INDEX, key, (current) => ({ ids: [...(current?.ids ?? []), message.id] }))
      await this.trimIndex(userID, key)
    }
    await this.trimUser(userID)
  }

  private async addUsage(userID: string, count: number, bytes: number): Promise<void> {
    await updateVersioned<Usage>(this.state, userID, USAGE, USAGE_KEY, (current) => ({
      count: Math.max(0, (current?.count ?? 0) + count),
      bytes: Math.max(0, (current?.bytes ?? 0) + bytes),
    }))
  }

  /** Drops a party's oldest messages over the cap (open asks last). */
  private async trimIndex(userID: string, key: string): Promise<void> {
    const ids = (await this.state.get<Index>(userID, INDEX, key))?.value.ids ?? []
    const excess = ids.length - this.limits.session
    if (excess <= 0) return
    const victims = await this.oldest(userID, ids, excess)
    const drop = new Set(victims)
    await updateVersioned<Index>(this.state, userID, INDEX, key, (current) => current && { ids: current.ids.filter((id) => !drop.has(id)) })
    for (const id of victims) await this.detach(userID, id, [key])
  }

  /** Drops the user's oldest messages (open asks last) to 90% of a cap they exceed. */
  private async trimUser(userID: string): Promise<void> {
    const usage = await this.usage(userID)
    if (usage.count <= this.limits.userMessages && usage.bytes <= this.limits.userBytes) return
    const entries = (await this.state.list<StoredMessage>(userID, MESSAGES)).sort((a, b) => rank(a.value.message) - rank(b.value.message) || a.value.message.at - b.value.message.at)
    let { count, bytes } = usage
    const countTarget = Math.floor(this.limits.userMessages * 0.9)
    const bytesTarget = Math.floor(this.limits.userBytes * 0.9)
    for (const entry of entries) {
      if (count <= countTarget && bytes <= bytesTarget) break
      count -= 1
      bytes -= entry.value.bytes
      for (const key of entry.value.indexed) {
        await updateVersioned<Index>(this.state, userID, INDEX, key, (current) => current && { ids: current.ids.filter((id) => id !== entry.key) })
      }
      await this.detach(userID, entry.key, entry.value.indexed)
    }
  }

  /** The `count` oldest of `ids` (oldest first), passing over open asks while others remain. */
  private async oldest(userID: string, ids: string[], count: number): Promise<string[]> {
    const closed: string[] = []
    const open: string[] = []
    for (const id of ids) {
      if (closed.length >= count) break
      const message = await this.get(userID, id)
      ;(message && isOpenAsk(message) ? open : closed).push(id)
    }
    return [...closed, ...open].slice(0, count)
  }

  /** Removes party keys from a message; deletes it (and its usage) when no party keeps it. */
  private async detach(userID: string, id: string, keys: string[]): Promise<void> {
    for (let attempt = 0; attempt < DETACH_ATTEMPTS; attempt++) {
      const current = await this.state.get<StoredMessage>(userID, MESSAGES, id)
      if (!current) return
      const indexed = current.value.indexed.filter((key) => !keys.includes(key))
      if (indexed.length) {
        if ((await this.state.put<StoredMessage>(userID, MESSAGES, id, { ...current.value, indexed }, { ifVersion: current.version })).ok) return
      } else if ((await this.state.delete(userID, MESSAGES, id, { ifVersion: current.version })).ok) {
        await this.addUsage(userID, -1, -current.value.bytes)
        return
      }
    }
    throw new Error(`detaching message ${id} kept conflicting`)
  }
}

/** Eviction order: closed messages before open asks. */
const rank = (message: Message) => (isOpenAsk(message) ? 1 : 0)
