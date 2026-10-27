// GET /api/agent/events (lifecycle design, frozen "Events route and tool"): the canonical journal read with an
// opaque, versioned, authenticated, tenant-bound cursor; bounded long polling; filters that advance the cursor;
// family and audience filtering per actor; typed reset for expired cursors and 400 invalid_cursor for bad ones.
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { decodeCursor, encodeCursor } from "../src/central/agent/event-cursor"
import { AGENT_EVENTS_AGE_MS, AGENT_EVENTS_MAX, AgentEvents, archiveEvent, messageEvent } from "../src/central/agent/events"
import { read } from "../src/central/agent/events-routes"
import { MemoryEventLog } from "../src/central/backend/memory-events"
import { MemoryKv } from "../src/central/backend/memory-kv"
import type { Message } from "../src/central/agent/messages"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

const tokens: Record<string, { tokenID: string; scopes: string[]; userID?: string }> = {
  hat_fake_none: { tokenID: "tok_none", scopes: ["sessions:read", "sessions:manage"] },
  hat_fake_sub: { tokenID: "tok_sub", scopes: ["events:subscribe"] },
  hat_fake_read: { tokenID: "tok_read", scopes: ["events:subscribe", "sessions:read"] },
  hat_fake_manage: { tokenID: "tok_manage", scopes: ["events:subscribe", "sessions:manage"] },
  hat_fake_msgs: { tokenID: "tok_msgs", scopes: ["events:subscribe", "messages:read"] },
  hat_fake_launch: { tokenID: "tok_launch", scopes: ["events:subscribe", "sessions:launch"] },
  hat_fake_bob: { tokenID: "tok_bob", scopes: ["events:subscribe", "sessions:read", "sessions:manage"], userID: "bob" },
}
const verifiers: BearerVerifier[] = [
  {
    kind: "app",
    verify: (token) => {
      const t = tokens[token]
      return t ? { kind: "app", userID: t.userID ?? "local", tokenID: t.tokenID, scopes: t.scopes } : undefined
    },
  },
]

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const json = async (r: Response) => (await r.json()) as any
const start = async (overrides: Record<string, unknown> = {}) => (h = await harness({ agent: { verifiers }, ...overrides } as any))

/** GET /api/agent/events as the user (cookie) or an app token. */
function events(query: Record<string, string | number | string[]> = {}, token?: string) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) for (const v of Array.isArray(value) ? value : [value]) params.append(key, String(v))
  const qs = params.toString()
  const path = `/api/agent/events${qs ? `?${qs}` : ""}`
  return token ? h!.api(path, { cookie: null, origin: null, headers: { authorization: `Bearer ${token}` } }) : h!.api(path)
}

const cursorOf = async (token?: string) => {
  const res = await events({}, token)
  expect(res.status).toBe(200)
  const body = await json(res)
  expect(body).toMatchObject({ events: [], more: false, reset: false })
  expect(body.cursor).toMatch(/^hev1_/)
  return body.cursor as string
}

const archive = (sessionID: string, archived = true, userID = "local") => h!.agentEvents.append(userID, archiveEvent(sessionID, archived))

const message = (from: Message["from"], recipient: Message["recipient"]): Message =>
  ({ id: `msg_${Math.random().toString(16).slice(2, 10)}`, kind: "msg", from, to: "@x", recipient, text: "SECRET body", state: "sent", at: 1, hop: 0 }) as Message

describe("GET /api/agent/events", () => {
  test("without a cursor: no events and a cursor at the latest; with it, what came after, then nothing", async () => {
    await start()
    const cursor = await cursorOf()
    await archive("ses_1")
    await archive("ses_2")
    const first = await json(await events({ cursor }))
    expect(first).toMatchObject({ more: false, reset: false })
    expect(first.events.map((e: any) => [e.type, e.subject.sessionID])).toEqual([
      ["session.archived", "ses_1"],
      ["session.archived", "ses_2"],
    ])
    expect(first.events[0]).toEqual({ id: expect.stringMatching(/^evt_/), at: expect.any(Number), type: "session.archived", subject: { sessionID: "ses_1" }, data: { archived: true } })
    expect(first.cursor).not.toBe(cursor)
    const again = await json(await events({ cursor: first.cursor }))
    expect(again).toMatchObject({ events: [], cursor: first.cursor, more: false, reset: false })
  })

  test("limit pages through with more; a type filter still advances the cursor over what it skipped", async () => {
    await start()
    const cursor = await cursorOf()
    for (const id of ["ses_1", "ses_2", "ses_3"]) await archive(id)
    const page = await json(await events({ cursor, limit: 2 }))
    expect(page.events.length).toBe(2)
    expect(page.more).toBe(true)
    const rest = await json(await events({ cursor: page.cursor }))
    expect(rest.events.map((e: any) => e.subject.sessionID)).toEqual(["ses_3"])
    expect(rest.more).toBe(false)

    const from = rest.cursor
    await archive("ses_4")
    const filtered = await json(await events({ cursor: from, type: "session.changed" }))
    expect(filtered).toMatchObject({ events: [], more: false, reset: false })
    expect(filtered.cursor).not.toBe(from)
    expect((await json(await events({ cursor: filtered.cursor }))).events).toEqual([])
    const both = await json(await events({ cursor: from, type: ["session.changed", "session.archived"] }))
    expect(both.events.map((e: any) => e.subject.sessionID)).toEqual(["ses_4"])
  })

  test("a session filter keeps that session's events", async () => {
    await start()
    await spoke(h!, { sessions: [session("ses_1", { title: "API", projectName: "hub" }), session("ses_2", { title: "Web", projectName: "hub" })] })
    await waitFor(() => (h!.store.agentData("local").names?.length ?? 0) === 2)
    const cursor = await cursorOf()
    await archive("ses_1")
    await archive("ses_2")
    const body = await json(await events({ cursor, session: "ses_2" }))
    expect(body.events.map((e: any) => e.subject.sessionID)).toEqual(["ses_2"])
  })

  test("bounds: wait 0–60, limit 1–200, inputs validated", async () => {
    await start()
    for (const query of [{ wait: 61 }, { wait: -1 }, { wait: "x" }, { limit: 0 }, { limit: 201 }, { limit: "1.5" }]) {
      const res = await events(query as any)
      expect(res.status).toBe(400)
      expect((await json(res)).error.code).toBe("invalid")
    }
  })

  test("long polling: a waiting read answers as soon as an event arrives", async () => {
    await start()
    const cursor = await cursorOf()
    const started = Date.now()
    const pending = events({ cursor, wait: 10 })
    await Bun.sleep(100)
    await archive("ses_9")
    const body = await json(await pending)
    expect(body.events.map((e: any) => e.subject.sessionID)).toEqual(["ses_9"])
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test("long polling with nothing to read answers empty at the deadline, with a usable cursor", async () => {
    await start()
    const cursor = await cursorOf()
    const started = Date.now()
    const body = await json(await events({ cursor, wait: 1 }))
    expect(body).toMatchObject({ events: [], cursor, more: false, reset: false })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  test("bad cursors answer 400 invalid_cursor: malformed, forged, unsupported version, another user's", async () => {
    await start()
    tokens.hat_fake_bob!.userID = (await h!.store.upsertUser({ email: "bob@example.com", role: "user" })).id
    const cursor = await cursorOf()
    const body = cursor.slice("hev1_".length)
    const flipped = body.slice(0, -2) + (body.at(-2) === "A" ? "B" : "A") + body.at(-1)
    const bobs = await cursorOf("hat_fake_bob")
    for (const bad of ["nope", "hev1_", `hev1_${flipped}`, `hev2_${body}`, "hev1_e30", bobs]) {
      const res = await events({ cursor: bad })
      expect(res.status).toBe(400)
      expect((await json(res)).error.code).toBe("invalid_cursor")
    }
  })

  test("an expired cursor answers a typed reset with a fresh cursor and the reads to refresh", async () => {
    let clock = Date.now()
    await start({ now: () => clock })
    const cursor = await cursorOf()
    await archive("ses_1")
    clock += 25 * 3_600_000
    await archive("ses_2")
    const body = await json(await events({ cursor }))
    expect(body).toMatchObject({ events: [], more: false, reset: true, refresh: ["status", "sessions", "inbox", "decisions", "launches"] })
    expect(body.cursor).toMatch(/^hev1_/)
    expect(body.cursor).not.toBe(cursor)
    expect((await json(await events({ cursor: body.cursor }))).reset).toBe(false)
  })
})

describe("app tokens", () => {
  test("polling needs events:subscribe", async () => {
    await start()
    const res = await events({}, "hat_fake_none")
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe("forbidden")
  })

  test("each family needs its scope: session (sessions:read), manage (sessions:manage)", async () => {
    await start()
    const cursors = { sub: await cursorOf("hat_fake_sub"), read: await cursorOf("hat_fake_read"), manage: await cursorOf("hat_fake_manage") }
    await h!.agentEvents.append("local", { type: "session.changed", family: "session", subject: { sessionID: "ses_1" }, data: { state: "idle" } })
    await archive("ses_1")
    const types = async (token: string, cursor: string) => (await json(await events({ cursor }, `hat_fake_${token}`))).events.map((e: any) => e.type)
    expect(await types("sub", cursors.sub)).toEqual([])
    expect(await types("read", cursors.read)).toEqual(["session.changed"])
    expect(await types("manage", cursors.manage)).toEqual(["session.archived"])
  })

  test("messages: only those the app is a party to, with messages:read; never their text", async () => {
    await start()
    const cursor = await cursorOf("hat_fake_msgs")
    const mine = message({ kind: "app", tokenID: "tok_msgs" } as any, { kind: "session", sessionID: "ses_1" } as any)
    const other = message({ kind: "user" } as any, { kind: "session", sessionID: "ses_1" } as any)
    await h!.agentEvents.append("local", messageEvent(other))
    await h!.agentEvents.append("local", messageEvent(mine))
    const res = await events({ cursor }, "hat_fake_msgs")
    const text = await res.text()
    expect(text).not.toContain("SECRET")
    expect(JSON.parse(text).events.map((e: any) => e.subject.messageID)).toEqual([mine.id])
    expect(text).not.toContain("audience")
    expect(text).not.toContain("family")
  })

  test("launches: only those the app started, with sessions:launch", async () => {
    await start()
    const cursor = await cursorOf("hat_fake_launch")
    for (const [id, by] of [["lch_mine", "app:tok_launch"], ["lch_user", "user"]]) await h!.agentEvents.append("local", { type: "launch.changed", family: "launch", subject: { launchID: id! }, data: { state: "queued" }, audience: { by: by! } })
    const body = await json(await events({ cursor }, "hat_fake_launch"))
    expect(body.events.map((e: any) => e.subject.launchID)).toEqual(["lch_mine"])
  })

  test("tenancy: another user's token never reads this user's events", async () => {
    await start()
    tokens.hat_fake_bob!.userID = (await h!.store.upsertUser({ email: "bob@example.com", role: "user" })).id
    const bob = await cursorOf("hat_fake_bob")
    await archive("ses_1")
    expect((await json(await events({ cursor: bob }, "hat_fake_bob"))).events).toEqual([])
  })
})

describe("cursor codec and read()", () => {
  const secrets: Record<string, Buffer> = { k1: Buffer.alloc(32, 1), k2: Buffer.alloc(32, 2) }
  let active = "k1"
  const keys = { active: () => ({ kid: active, secret: secrets[active]! }), key: (kid: string) => secrets[kid] }
  const user = { kind: "user", userID: "u1" } as any

  test("round trip, bound to the user, still valid after key rotation, never showing the user", () => {
    const cursor = encodeCursor(keys, "u1", "abc.7")
    expect(cursor).toMatch(/^hev1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(Buffer.from(cursor.slice(5).split(".")[0]!, "base64url").toString()).not.toContain("u1")
    expect(decodeCursor(keys, "u1", cursor)).toBe("abc.7")
    expect(decodeCursor(keys, "u2", cursor)).toBeUndefined()
    active = "k2"
    expect(decodeCursor(keys, "u1", cursor)).toBe("abc.7")
    active = "k1"
    expect(decodeCursor({ ...keys, key: () => undefined }, "u1", cursor)).toBeUndefined()
  })

  test("a cursor past the journal's latest record (same epoch) is invalid_cursor, not a reset", async () => {
    const events = new AgentEvents({ log: new MemoryEventLog({ max: AGENT_EVENTS_MAX, maxAgeMs: AGENT_EVENTS_AGE_MS }), kv: new MemoryKv() })
    const latest = await events.latest("u1")
    const future = `${latest.split(".")[0]}.${Number(latest.split(".")[1]) + 5}`
    const deps = { events, keys, directory: { resolve: () => ({ sessions: [] }) } as any }
    await expect(read(deps, "u1", user, { cursor: encodeCursor(keys, "u1", future), wait: 0, limit: 50, types: [] })).rejects.toMatchObject({ code: "invalid_cursor" })
    // Another epoch (a restart) is a reset.
    const page = await read(deps, "u1", user, { cursor: encodeCursor(keys, "u1", "zzz.3"), wait: 0, limit: 50, types: [] })
    expect(page).toMatchObject({ events: [], reset: true })
  })

  test("at most 1,000 records are inspected per read; more says the rest remain", async () => {
    const events = new AgentEvents({ log: new MemoryEventLog({ max: AGENT_EVENTS_MAX, maxAgeMs: AGENT_EVENTS_AGE_MS }), kv: new MemoryKv() })
    const deps = { events, keys, directory: { resolve: () => ({ sessions: [] }) } as any }
    const start = encodeCursor(keys, "u1", await events.latest("u1"))
    for (let i = 0; i < 1005; i++) await events.append("u1", { type: "session.changed", family: "session", subject: { sessionID: `ses_${i}` }, data: {} })
    const first = await read(deps, "u1", user, { cursor: start, wait: 0, limit: 200, types: ["nothing.matches"] })
    expect(first).toMatchObject({ events: [], more: true, reset: false })
    const second = await read(deps, "u1", user, { cursor: first.cursor, wait: 0, limit: 200, types: [] })
    expect(second.events.map((e) => e.subject.sessionID)).toEqual(["ses_1000", "ses_1001", "ses_1002", "ses_1003", "ses_1004"])
    expect(second.more).toBe(false)
  })
})
