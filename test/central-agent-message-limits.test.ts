// Loop protection for agent messages (design §3.4): the hop tracker (8 hops without a human turn) and the
// limiter (pair, per-user and wake budgets), over the backend interfaces with a fake clock.
import { describe, expect, test } from "bun:test"
import type { Party } from "../src/central/agent/envelope"
import { AgentError } from "../src/central/agent/errors"
import {
  HOP_CAP,
  HOP_TTL_MS,
  HopTracker,
  MessageLimiter,
  PAIR_LIMIT,
  USER_LIMIT,
  WAKE_BUDGET,
  WINDOW_MS,
  overHopCap,
} from "../src/central/agent/message-limits"
import { MemoryCounters } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"

const T0 = 1_700_000_000_000 - (1_700_000_000_000 % WINDOW_MS)

function clock() {
  let t = T0
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const ses = (id: string): Party => ({ kind: "session", sessionID: id })
const user: Party = { kind: "user" }
const app: Party = { kind: "app", tokenID: "tok_1" }

async function failure(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof AgentError) return cause
    throw cause
  }
  throw new Error("expected an AgentError")
}

describe("HopTracker", () => {
  function setup() {
    const c = clock()
    const state = new MemoryStateStore({ now: c.now })
    return { ...c, state, hops: new HopTracker({ state, now: c.now }) }
  }

  test("a session that has not received anything sends hop 1; the user sends hop 0", async () => {
    const { hops } = setup()
    expect(await hops.next("usr_a", ses("ses_a"))).toBe(1)
    expect(await hops.next("usr_a", user)).toBe(0)
    expect(await hops.next("usr_a", app)).toBe(1)
  })

  test("a chain grows one hop per message and is over the cap after 8", async () => {
    const { hops } = setup()
    let from = ses("ses_a")
    let to = ses("ses_b")
    const seen: number[] = []
    for (let i = 0; i < 10; i++) {
      const hop = await hops.next("usr_a", from)
      seen.push(hop)
      await hops.received("usr_a", to, hop)
      ;[from, to] = [to, from]
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(HOP_CAP).toBe(8)
    expect(seen.map(overHopCap)).toEqual([false, false, false, false, false, false, false, false, true, true])
  })

  test("a human turn resets the session's depth (reset hook)", async () => {
    const { hops } = setup()
    await hops.received("usr_a", ses("ses_b"), 8)
    expect(await hops.next("usr_a", ses("ses_b"))).toBe(9)
    await hops.humanTurn("usr_a", "ses_b")
    expect(await hops.next("usr_a", ses("ses_b"))).toBe(1)
  })

  test("a message from the user (hop 0) counts as a human turn for its recipient", async () => {
    const { hops } = setup()
    await hops.received("usr_a", ses("ses_b"), 6)
    await hops.received("usr_a", ses("ses_b"), 0)
    expect(await hops.next("usr_a", ses("ses_b"))).toBe(1)
  })

  test("depth keeps the deepest chain reaching a session", async () => {
    const { hops } = setup()
    await hops.received("usr_a", ses("ses_b"), 5)
    await hops.received("usr_a", ses("ses_b"), 2)
    expect(await hops.depth("usr_a", ses("ses_b"))).toBe(5)
  })

  test("depth expires HOP_TTL_MS after the last message reached the session", async () => {
    const { hops, advance } = setup()
    await hops.received("usr_a", ses("ses_b"), 7)
    advance(HOP_TTL_MS - 1)
    expect(await hops.depth("usr_a", ses("ses_b"))).toBe(7)
    advance(1)
    expect(await hops.depth("usr_a", ses("ses_b"))).toBe(0)
  })

  test("depths are per user (tenancy)", async () => {
    const { hops } = setup()
    await hops.received("usr_a", ses("ses_b"), 7)
    expect(await hops.depth("usr_b", ses("ses_b"))).toBe(0)
  })

  test("concurrent receipts keep the deepest hop (version-checked writes)", async () => {
    const { hops } = setup()
    await Promise.all([1, 4, 2, 6, 3].map((hop) => hops.received("usr_a", ses("ses_b"), hop)))
    expect(await hops.depth("usr_a", ses("ses_b"))).toBe(6)
  })
})

describe("MessageLimiter", () => {
  function setup(limits?: ConstructorParameters<typeof MessageLimiter>[0]["limits"]) {
    const c = clock()
    const counters = new MemoryCounters({ now: c.now })
    return { ...c, limiter: new MessageLimiter({ counters, now: c.now, limits }) }
  }

  test(`admits ${PAIR_LIMIT} messages per pair per window, then rate_limited with retryAfter to the window end`, async () => {
    const { limiter, advance } = setup()
    advance(4 * 60_000)
    for (let i = 0; i < PAIR_LIMIT; i++) await limiter.admit("usr_a", ses("ses_a"), ses("ses_b"))
    const error = await failure(limiter.admit("usr_a", ses("ses_a"), ses("ses_b")))
    expect(error.code).toBe("rate_limited")
    expect(error.options.extra).toEqual({ retryAfter: 360, limit: "pair" })
    // Other pairs and the reverse direction are separate.
    await limiter.admit("usr_a", ses("ses_b"), ses("ses_a"))
    await limiter.admit("usr_a", ses("ses_a"), ses("ses_c"))
    // The next window admits again.
    advance(6 * 60_000)
    await limiter.admit("usr_a", ses("ses_a"), ses("ses_b"))
  })

  test("a refused message does not use up more of the window", async () => {
    const { limiter, advance } = setup({ pair: 2 })
    await limiter.admit("usr_a", ses("ses_a"), ses("ses_b"))
    await limiter.admit("usr_a", ses("ses_a"), ses("ses_b"))
    for (let i = 0; i < 5; i++) await failure(limiter.admit("usr_a", ses("ses_a"), ses("ses_b")))
    advance(WINDOW_MS)
    await limiter.admit("usr_a", ses("ses_a"), ses("ses_b"))
    await limiter.admit("usr_a", ses("ses_a"), ses("ses_b"))
  })

  test(`caps a user at ${USER_LIMIT} messages per window across pairs`, async () => {
    const { limiter } = setup({ user: 3 })
    await limiter.admit("usr_a", ses("ses_a"), ses("ses_b"))
    await limiter.admit("usr_a", ses("ses_c"), ses("ses_d"))
    await limiter.admit("usr_a", user, ses("ses_d"))
    const error = await failure(limiter.admit("usr_a", app, ses("ses_e")))
    expect(error.code).toBe("rate_limited")
    expect(error.options.extra).toMatchObject({ limit: "user" })
    // Another user is not affected.
    await limiter.admit("usr_b", ses("ses_a"), ses("ses_b"))
  })

  test(`a recipient's wake budget (${WAKE_BUDGET} per window) runs out; messages are still admitted`, async () => {
    const { limiter, advance } = setup({ wake: 2 })
    expect(await limiter.wake("usr_a", ses("ses_b"))).toBe(true)
    expect(await limiter.wake("usr_a", ses("ses_b"))).toBe(true)
    expect(await limiter.wake("usr_a", ses("ses_b"))).toBe(false)
    expect(await limiter.wake("usr_a", ses("ses_c"))).toBe(true)
    expect(await limiter.wake("usr_b", ses("ses_b"))).toBe(true)
    await limiter.admit("usr_a", ses("ses_a"), ses("ses_b"))
    advance(WINDOW_MS)
    expect(await limiter.wake("usr_a", ses("ses_b"))).toBe(true)
  })
})
