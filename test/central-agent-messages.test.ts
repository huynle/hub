// The agent message store (design §3.1, §3.2): stored form, per-session and per-user caps, the ask lifecycle
// (open → answered | declined | expired, first answer wins), replies only from the real recipient to the real
// sender, mutes, delivery records and tenancy, over a MemoryStateStore with a fake clock.
import { describe, expect, test } from "bun:test"
import type { Party } from "../src/central/agent/envelope"
import { AgentError } from "../src/central/agent/errors"
import {
  ASK_EXPIRES_MAX_MS,
  ASK_EXPIRES_MS,
  ASK_EXPIRES_MIN_MS,
  Messages,
  SESSION_MESSAGES,
  TEXT_MAX,
  USER_BYTES,
  USER_MESSAGES,
  WHY_MAX,
  type MessageLimitsConfig,
  type SendInput,
} from "../src/central/agent/messages"
import { MemoryStateStore } from "../src/central/backend/memory-state"

const T0 = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

const A: Party = { kind: "session", sessionID: "ses_a", name: "alpha", harness: "opencode", machine: "mbp" }
const B: Party = { kind: "session", sessionID: "ses_b", name: "beta" }
const C: Party = { kind: "session", sessionID: "ses_c" }
const ME: Party = { kind: "user" }
const APP: Party = { kind: "app", tokenID: "tok_1", label: "ci" }

function setup(limits?: Partial<MessageLimitsConfig>) {
  let t = T0
  const now = () => t
  const state = new MemoryStateStore({ now })
  let n = 0
  const messages = new Messages({ state, now, limits })
  const counted = new Messages({ state, now, limits, newID: () => `msg_${String(++n).padStart(4, "0")}` })
  return { state, messages, counted, now, advance: (ms: number) => (t += ms) }
}

const msg = (extra: Partial<SendInput> = {}): SendInput => ({ from: A, to: "@beta", recipient: B, kind: "msg", text: "hello", ...extra })

async function failure(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof AgentError) return cause
    throw cause
  }
  throw new Error("expected an AgentError")
}

describe("send", () => {
  test("stores the message in its stored form with a CSPRNG id", async () => {
    const { messages } = setup()
    const sent = await messages.send("usr_a", msg({ to: "@@reviewer", generation: 3, hop: 2 }))
    expect(sent.id).toMatch(/^msg_[A-Za-z0-9]{22}$/)
    expect(sent).toEqual({ id: sent.id, kind: "msg", from: A, to: "@@reviewer", recipient: B, generation: 3, text: "hello", state: "sent", at: T0, hop: 2 })
    expect(await messages.get("usr_a", sent.id)).toEqual(sent)
    const other = await messages.send("usr_a", msg())
    expect(other.id).not.toBe(sent.id)
  })

  test("text and the address as written are sanitised", async () => {
    const { messages } = setup()
    const sent = await messages.send("usr_a", msg({ text: "\u001b[31mred\u202e\r\nnext", to: "@be\u200bta\n" }))
    expect(sent.text).toBe("red\nnext")
    expect(sent.to).toBe("@beta")
  })

  test(`text over ${TEXT_MAX} characters, or empty after sanitising, is invalid`, async () => {
    const { messages } = setup()
    expect((await failure(messages.send("usr_a", msg({ text: "x".repeat(TEXT_MAX + 1) })))).code).toBe("invalid")
    expect((await failure(messages.send("usr_a", msg({ text: " \u200b\u001b[0m\n " })))).code).toBe("invalid")
    await messages.send("usr_a", msg({ text: "x".repeat(TEXT_MAX) }))
  })

  test("an ask is open and expires after ASK_EXPIRES_MS by default, or after expiresInMs within bounds", async () => {
    const { messages } = setup()
    const ask = await messages.send("usr_a", msg({ kind: "ask" }))
    expect(ask).toMatchObject({ kind: "ask", state: "open", expiresAt: T0 + ASK_EXPIRES_MS })
    const short = await messages.send("usr_a", msg({ kind: "ask", expiresInMs: 2 * HOUR }))
    expect(short.expiresAt).toBe(T0 + 2 * HOUR)
    expect((await failure(messages.send("usr_a", msg({ kind: "ask", expiresInMs: ASK_EXPIRES_MIN_MS - 1 })))).code).toBe("invalid")
    expect((await failure(messages.send("usr_a", msg({ kind: "ask", expiresInMs: ASK_EXPIRES_MAX_MS + 1 })))).code).toBe("invalid")
  })

  test("a plain message has no expiry; expiresInMs on it is invalid", async () => {
    const { messages } = setup()
    expect((await messages.send("usr_a", msg())).expiresAt).toBeUndefined()
    expect((await failure(messages.send("usr_a", msg({ expiresInMs: HOUR })))).code).toBe("invalid")
  })

  test("messages are per user: another user's id is not found", async () => {
    const { messages } = setup()
    const sent = await messages.send("usr_a", msg())
    expect(await messages.get("usr_b", sent.id)).toBeUndefined()
    expect(await messages.list("usr_b", B)).toEqual([])
  })
})

describe("list and inbox", () => {
  test("list: the messages a party sent or received, newest first", async () => {
    const { counted: messages, advance } = setup()
    const one = await messages.send("usr_a", msg())
    advance(1000)
    const two = await messages.send("usr_a", msg({ from: B, recipient: A, to: "@alpha" }))
    advance(1000)
    const three = await messages.send("usr_a", msg({ recipient: C, to: "ses_c" }))
    expect((await messages.list("usr_a", A)).map((m) => m.id)).toEqual([three.id, two.id, one.id])
    expect((await messages.list("usr_a", B)).map((m) => m.id)).toEqual([two.id, one.id])
    expect((await messages.list("usr_a", C)).map((m) => m.id)).toEqual([three.id])
    expect((await messages.list("usr_a", A, { limit: 2 })).map((m) => m.id)).toEqual([three.id, two.id])
  })

  test("inbox: open asks to the party, its own open asks, and recent received messages", async () => {
    const { counted: messages, advance } = setup()
    const toB = await messages.send("usr_a", msg({ kind: "ask", text: "q1" }))
    advance(1)
    const fromB = await messages.send("usr_a", msg({ from: B, recipient: A, to: "@alpha", kind: "ask", text: "q2" }))
    advance(1)
    const tell = await messages.send("usr_a", msg({ text: "fyi" }))
    const inbox = await messages.inbox("usr_a", B)
    expect(inbox.asks.map((m) => m.id)).toEqual([toB.id])
    expect(inbox.waiting.map((m) => m.id)).toEqual([fromB.id])
    expect(inbox.messages.map((m) => m.id)).toEqual([tell.id, toB.id])
  })

  test("non-session parties (the user, an app) have stored-only inboxes", async () => {
    const { messages } = setup()
    const toMe = await messages.send("usr_a", msg({ recipient: ME, to: "@me" }))
    const toApp = await messages.send("usr_a", msg({ from: B, recipient: APP, to: "app:tok_1" }))
    expect((await messages.inbox("usr_a", ME)).messages.map((m) => m.id)).toEqual([toMe.id])
    expect((await messages.inbox("usr_a", APP)).messages.map((m) => m.id)).toEqual([toApp.id])
  })
})

describe("caps", () => {
  test(`keeps the latest ${SESSION_MESSAGES} per session; older ones nobody else keeps are deleted`, async () => {
    const { counted: messages } = setup()
    const sent = []
    for (let i = 0; i < SESSION_MESSAGES + 5; i++) sent.push(await messages.send("usr_a", msg({ text: `m${i}` })))
    const listed = await messages.list("usr_a", B, { limit: 1000 })
    expect(listed).toHaveLength(SESSION_MESSAGES)
    expect(listed[0]!.id).toBe(sent.at(-1)!.id)
    expect(listed.at(-1)!.id).toBe(sent[5]!.id)
    for (let i = 0; i < 5; i++) expect(await messages.get("usr_a", sent[i]!.id)).toBeUndefined()
    expect(await messages.usage("usr_a")).toMatchObject({ count: SESSION_MESSAGES })
  })

  test("a message another party still keeps survives eviction from one session", async () => {
    const { counted: messages } = setup({ session: 3 })
    const keep = await messages.send("usr_a", msg({ from: C, recipient: B, to: "@beta" }))
    for (let i = 0; i < 3; i++) await messages.send("usr_a", msg())
    // B's index dropped `keep`, C still lists it.
    expect((await messages.list("usr_a", B)).map((m) => m.id)).not.toContain(keep.id)
    expect((await messages.list("usr_a", C)).map((m) => m.id)).toEqual([keep.id])
    expect(await messages.get("usr_a", keep.id)).toBeDefined()
  })

  test("eviction skips open asks while closed messages remain", async () => {
    const { counted: messages } = setup({ session: 3 })
    const ask = await messages.send("usr_a", msg({ kind: "ask" }))
    const tells = []
    for (let i = 0; i < 3; i++) tells.push(await messages.send("usr_a", msg()))
    const ids = (await messages.list("usr_a", B)).map((m) => m.id)
    expect(ids).toEqual([tells[2]!.id, tells[1]!.id, ask.id])
  })

  test(`per-user caps (${USER_MESSAGES} messages, ${USER_BYTES} bytes): the oldest go first`, async () => {
    const { counted: messages } = setup({ userMessages: 10 })
    const sent = []
    for (let i = 0; i < 12; i++) sent.push(await messages.send("usr_a", msg({ from: { kind: "session", sessionID: `ses_${i}` }, recipient: { kind: "session", sessionID: `ses_${i}_to` } })))
    const usage = await messages.usage("usr_a")
    expect(usage.count).toBeLessThanOrEqual(10)
    expect(await messages.get("usr_a", sent.at(-1)!.id)).toBeDefined()
    expect(await messages.get("usr_a", sent[0]!.id)).toBeUndefined()
    expect(await messages.get("usr_a", sent[1]!.id)).toBeUndefined()
  })

  test("the byte cap counts stored size", async () => {
    const { counted: messages } = setup({ userBytes: 10_000 })
    const parties = Array.from({ length: 6 }, (_, i) => `ses_${i}`)
    for (const id of parties) await messages.send("usr_a", msg({ from: { kind: "session", sessionID: id }, recipient: { kind: "session", sessionID: `${id}_to` }, text: "y".repeat(3000) }))
    const usage = await messages.usage("usr_a")
    expect(usage.bytes).toBeLessThanOrEqual(10_000)
    expect(usage.bytes).toBeGreaterThan(0)
  })
})

describe("ask lifecycle", () => {
  test("a reply from the recipient answers an open ask and goes to the real sender", async () => {
    const { messages, advance } = setup()
    const ask = await messages.send("usr_a", msg({ kind: "ask", to: "@@reviewer", generation: 2 }))
    advance(5000)
    const { message, original } = await messages.reply("usr_a", { from: B, replyTo: ask.id, text: "looks good", generation: 2 })
    expect(message).toMatchObject({ kind: "reply", from: B, recipient: A, to: "@alpha", replyTo: ask.id, text: "looks good", state: "sent", at: T0 + 5000 })
    expect(original).toMatchObject({ id: ask.id, state: "answered", answer: { id: message.id, at: T0 + 5000 } })
    expect(await messages.get("usr_a", ask.id)).toEqual(original)
  })

  test("the first answer wins: a later reply or decline is gone", async () => {
    const { messages } = setup()
    const ask = await messages.send("usr_a", msg({ kind: "ask" }))
    const [first, second] = await Promise.allSettled([
      messages.reply("usr_a", { from: B, replyTo: ask.id, text: "one" }),
      messages.reply("usr_a", { from: B, replyTo: ask.id, text: "two" }),
    ])
    expect(first.status).toBe("fulfilled")
    expect(second.status).toBe("rejected")
    expect(((second as PromiseRejectedResult).reason as AgentError).code).toBe("gone")
    expect((await failure(messages.decline("usr_a", { from: B, replyTo: ask.id, why: "late" }))).code).toBe("gone")
  })

  test("decline closes an ask with the reason as the decline's text", async () => {
    const { messages } = setup()
    const ask = await messages.send("usr_a", msg({ kind: "ask" }))
    const { message, original } = await messages.decline("usr_a", { from: B, replyTo: ask.id, why: "not my area\u202e" })
    expect(message).toMatchObject({ kind: "decline", from: B, recipient: A, replyTo: ask.id, text: "not my area" })
    expect(original.state).toBe("declined")
    expect((await failure(messages.decline("usr_a", { from: B, replyTo: ask.id, why: "again" }))).code).toBe("gone")
    expect((await failure(messages.reply("usr_a", { from: B, replyTo: ask.id, text: "after all" }))).code).toBe("gone")
  })

  test(`a decline needs a reason of at most ${WHY_MAX} characters, and only asks can be declined`, async () => {
    const { messages } = setup()
    const ask = await messages.send("usr_a", msg({ kind: "ask" }))
    expect((await failure(messages.decline("usr_a", { from: B, replyTo: ask.id, why: "" }))).code).toBe("invalid")
    expect((await failure(messages.decline("usr_a", { from: B, replyTo: ask.id, why: "x".repeat(WHY_MAX + 1) }))).code).toBe("invalid")
    const tell = await messages.send("usr_a", msg())
    expect((await failure(messages.decline("usr_a", { from: B, replyTo: tell.id, why: "no" }))).code).toBe("invalid")
  })

  test("an ask expires at expiresAt: reads show it expired, answers are gone, expire() closes and returns it", async () => {
    const { messages, advance } = setup()
    const ask = await messages.send("usr_a", msg({ kind: "ask", expiresInMs: HOUR }))
    advance(HOUR - 1)
    expect((await messages.get("usr_a", ask.id))!.state).toBe("open")
    expect(await messages.expire("usr_a")).toEqual([])
    advance(1)
    expect((await messages.get("usr_a", ask.id))!.state).toBe("expired")
    expect((await messages.inbox("usr_a", B)).asks).toEqual([])
    expect((await failure(messages.reply("usr_a", { from: B, replyTo: ask.id, text: "late" }))).code).toBe("gone")
    const expired = await messages.expire("usr_a")
    expect(expired.map((m) => [m.id, m.state])).toEqual([[ask.id, "expired"]])
    expect(await messages.expire("usr_a")).toEqual([])
  })

  test("replying to a plain message is allowed repeatedly and leaves it unchanged", async () => {
    const { messages } = setup()
    const tell = await messages.send("usr_a", msg())
    await messages.reply("usr_a", { from: B, replyTo: tell.id, text: "ack" })
    const { original } = await messages.reply("usr_a", { from: B, replyTo: tell.id, text: "ack again" })
    expect(original).toEqual(tell)
  })

  test("only the recipient may reply: the sender, a third session, the user and other users get not_found", async () => {
    const { messages } = setup()
    const ask = await messages.send("usr_a", msg({ kind: "ask" }))
    for (const from of [A, C, ME, APP]) expect((await failure(messages.reply("usr_a", { from, replyTo: ask.id, text: "x" }))).code).toBe("not_found")
    expect((await failure(messages.reply("usr_b", { from: B, replyTo: ask.id, text: "x" }))).code).toBe("not_found")
    expect((await failure(messages.decline("usr_a", { from: C, replyTo: ask.id, why: "x" }))).code).toBe("not_found")
    expect((await failure(messages.reply("usr_a", { from: B, replyTo: "msg_unknown", text: "x" }))).code).toBe("not_found")
  })

  test("a reply from a later role holder generation is gone (never credited to the wrong holder)", async () => {
    const { messages } = setup()
    const ask = await messages.send("usr_a", msg({ kind: "ask", to: "@@reviewer", generation: 2 }))
    expect((await failure(messages.reply("usr_a", { from: B, replyTo: ask.id, text: "x", generation: 3 }))).code).toBe("gone")
    expect((await messages.get("usr_a", ask.id))!.state).toBe("open")
  })

  test("the user answers asks to @me; replies to the user or an app go to stored-only inboxes", async () => {
    const { messages } = setup()
    const toMe = await messages.send("usr_a", msg({ kind: "ask", recipient: ME, to: "@me" }))
    const { message } = await messages.reply("usr_a", { from: ME, replyTo: toMe.id, text: "yes" })
    expect(message).toMatchObject({ from: ME, recipient: A, to: "@alpha" })
    const fromApp = await messages.send("usr_a", msg({ from: APP, kind: "ask" }))
    const back = await messages.reply("usr_a", { from: B, replyTo: fromApp.id, text: "done" })
    expect(back.message).toMatchObject({ recipient: APP, to: "app:tok_1" })
    expect((await messages.inbox("usr_a", APP)).messages.map((m) => m.id)).toEqual([back.message.id])
    const fromUser = await messages.send("usr_a", msg({ from: ME, kind: "ask" }))
    expect((await messages.reply("usr_a", { from: B, replyTo: fromUser.id, text: "ok" })).message.to).toBe("@me")
  })

  test("a reply to an unnamed session addresses it by id", async () => {
    const { messages } = setup()
    const ask = await messages.send("usr_a", msg({ from: C, kind: "ask" }))
    expect((await messages.reply("usr_a", { from: B, replyTo: ask.id, text: "ok" })).message.to).toBe("ses_c")
  })
})

describe("delivery records", () => {
  test("setDelivery records how a message was delivered", async () => {
    const { messages, advance } = setup()
    const sent = await messages.send("usr_a", msg())
    advance(10)
    expect(await messages.setDelivery("usr_a", sent.id, "queued")).toMatchObject({ delivery: "queued", deliveredAt: T0 + 10 })
    expect(await messages.setDelivery("usr_a", sent.id, "pending")).toMatchObject({ delivery: "pending", deliveredAt: T0 + 10 })
    expect((await messages.get("usr_a", sent.id))!.delivery).toBe("pending")
    expect(await messages.setDelivery("usr_a", "msg_missing", "turn")).toBeUndefined()
    expect(await messages.setDelivery("usr_b", sent.id, "turn")).toBeUndefined()
  })
})

describe("mutes", () => {
  test("a muted session cannot message or ask the muter; others still can", async () => {
    const { messages } = setup()
    await messages.mute("usr_a", B, "ses_a")
    expect(await messages.muted("usr_a", B)).toEqual(["ses_a"])
    const error = await failure(messages.send("usr_a", msg()))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("muted")
    await messages.send("usr_a", msg({ from: C }))
    await messages.send("usr_a", msg({ from: B, recipient: A, to: "@alpha" }))
  })

  test("the muted session can still answer the muter's own asks", async () => {
    const { messages } = setup()
    const ask = await messages.send("usr_a", msg({ from: B, recipient: A, to: "@alpha", kind: "ask" }))
    await messages.mute("usr_a", B, "ses_a")
    await messages.reply("usr_a", { from: A, replyTo: ask.id, text: "answer" })
  })

  test("unmute; mutes are per muter and per user", async () => {
    const { messages } = setup()
    await messages.mute("usr_a", ME, "ses_a")
    await messages.mute("usr_a", B, "ses_a")
    await messages.mute("usr_a", B, "ses_a")
    expect(await messages.muted("usr_a", B)).toEqual(["ses_a"])
    expect(await messages.muted("usr_b", B)).toEqual([])
    await messages.unmute("usr_a", B, "ses_a")
    expect(await messages.muted("usr_a", B)).toEqual([])
    expect(await messages.muted("usr_a", ME)).toEqual(["ses_a"])
    await messages.send("usr_a", msg())
  })
})
