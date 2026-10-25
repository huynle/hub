// Session token delivery (src/central/session-token-push.ts): on sessions frames of spokes that announce
// "sessionTokens", tokens for the sessions they report (new ones, or ones that need a refresh), deduped per
// connection, batched, retried after "unknown" skips or failures, and refreshed by a periodic sweep.
// Registry, minter, transport, clock and timers are fakes.
import { beforeEach, describe, expect, test } from "bun:test"
import { SESSION_TOKEN_MAX_CHARS, type ActTokensRequest, type ResultFor, type SessionTokensRequest } from "../src/protocol"
import { SESSION_TOKEN_SWEEP_MS, SessionTokenPush, type PushRegistry, type TokenMinter } from "../src/central/session-token-push"

const LIFETIME = 24 * 60 * 60 * 1000
const HUB = "http://hub.test"

let clock: number
let conns: Map<string, { machine: string; sessions: string[]; features: boolean; act?: boolean; launch?: string }>
let stamps: Map<string, string>
let refused: Set<string>
let minted: number
let sent: Array<{ connID: string; req: SessionTokensRequest | ActTokensRequest }>
let answer: (connID: string, req: SessionTokensRequest | ActTokensRequest) => Promise<ResultFor["sessionTokens"]>
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
let logged: string[]
let push: SessionTokenPush

const registry: PushRegistry = {
  supports: (connID, feature) =>
    (feature === "sessionTokens" && conns.get(connID)?.features === true) || (feature === "actTokens" && conns.get(connID)?.act === true),
  connMachine: (connID) => conns.get(connID)?.machine,
  reportedSessions: (connID) => conns.get(connID)?.sessions ?? [],
  launchOf: (connID) => conns.get(connID)?.launch,
}
const minter: TokenMinter = {
  lifetimeMs: LIFETIME,
  stamp: (machine) => stamps.get(machine),
  mint: (machine, sessionID) => {
    const stamp = stamps.get(machine)
    if (!stamp || refused.has(sessionID)) return undefined
    return { token: `tok_${sessionID}_${++minted}`, exp: clock + LIFETIME, stamp }
  },
  mintAct: (machine, sessionID) => {
    const stamp = stamps.get(machine)
    if (!stamp || refused.has(sessionID)) return undefined
    return { token: `act_${sessionID}_${++minted}`, exp: clock + LIFETIME, stamp }
  },
}
const applyAll = async (_connID: string, req: SessionTokensRequest | ActTokensRequest) => ({ applied: req.tokens.map((t) => t.sessionID), skipped: [] })

const make = (extra: Partial<ConstructorParameters<typeof SessionTokenPush>[0]> = {}) =>
  new SessionTokenPush({
    registry,
    tokens: minter,
    send: (connID, req) => {
      sent.push({ connID, req })
      return answer(connID, req)
    },
    hubURL: HUB,
    now: () => clock,
    timers: {
      set: (fn, ms) => {
        const timer = { fn, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clear: (handle) => void ((handle as { cleared: boolean }).cleared = true),
    },
    log: (message) => logged.push(message),
    ...extra,
  })
/** Session IDs of every token sent, in order. */
const sentIDs = () => sent.flatMap((s) => s.req.tokens.map((t) => t.sessionID))

beforeEach(() => {
  clock = 1_800_000_000_000
  conns = new Map([["c1", { machine: "mch_a", sessions: ["ses_1", "ses_child"], features: true }]])
  stamps = new Map([["mch_a", "s1"]])
  refused = new Set()
  minted = 0
  sent = []
  answer = applyAll
  timers = []
  logged = []
  push = make()
})

describe("sessions frames", () => {
  test("sends a token for every reported session, subagents included, with the hub URL", async () => {
    await push.sessions("c1")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.connID).toBe("c1")
    expect(sent[0]!.req).toEqual({
      op: "sessionTokens",
      hubURL: HUB,
      tokens: [
        { sessionID: "ses_1", token: "tok_ses_1_1", exp: clock + LIFETIME },
        { sessionID: "ses_child", token: "tok_ses_child_2", exp: clock + LIFETIME },
      ],
    })
  })

  test("a spoke without the sessionTokens feature gets nothing", async () => {
    conns.get("c1")!.features = false
    await push.sessions("c1")
    expect(sent).toEqual([])
    expect(minted).toBe(0)
  })

  test("an unknown connection gets nothing", async () => {
    await push.sessions("c_gone")
    expect(sent).toEqual([])
  })

  test("unchanged sessions are not sent again; new ones are sent alone", async () => {
    await push.sessions("c1")
    await push.sessions("c1")
    expect(sent).toHaveLength(1)
    conns.get("c1")!.sessions.push("ses_2")
    await push.sessions("c1")
    expect(sent).toHaveLength(2)
    expect(sent[1]!.req.tokens.map((t) => t.sessionID)).toEqual(["ses_2"])
  })

  test("a session the minter refuses (another tenant's, revoked machine) is not sent", async () => {
    refused.add("ses_child")
    await push.sessions("c1")
    expect(sentIDs()).toEqual(["ses_1"])
    stamps.delete("mch_a")
    conns.get("c1")!.sessions.push("ses_2")
    await push.sessions("c1")
    expect(sent).toHaveLength(1)
  })

  test("a session that stops being reported and comes back gets a new token", async () => {
    await push.sessions("c1")
    conns.get("c1")!.sessions = ["ses_1"]
    await push.sessions("c1")
    conns.get("c1")!.sessions = ["ses_1", "ses_child"]
    await push.sessions("c1")
    expect(sentIDs()).toEqual(["ses_1", "ses_child", "ses_child"])
  })

  test("each connection has its own tokens: a reconnect (new connection) gets all of them again", async () => {
    await push.sessions("c1")
    conns.delete("c1")
    conns.set("c2", { machine: "mch_a", sessions: ["ses_1", "ses_child"], features: true })
    await push.sessions("c2")
    expect(sent.map((s) => [s.connID, s.req.tokens.length])).toEqual([
      ["c1", 2],
      ["c2", 2],
    ])
  })

  test("an epoch or key change (new stamp) resends every token", async () => {
    await push.sessions("c1")
    stamps.set("mch_a", "s2")
    await push.sessions("c1")
    expect(sentIDs()).toEqual(["ses_1", "ses_child", "ses_1", "ses_child"])
  })

  test("a token with less than a third of its lifetime left is refreshed on the next frame", async () => {
    await push.sessions("c1")
    clock += LIFETIME - LIFETIME / 3 - 1
    await push.sessions("c1")
    expect(sent).toHaveLength(1)
    clock += 2
    await push.sessions("c1")
    expect(sent).toHaveLength(2)
    expect(sent[1]!.req.tokens.map((t) => t.exp)).toEqual([clock + LIFETIME, clock + LIFETIME])
  })

  test("'unknown' skips are retried on the next frame; applied ones are not", async () => {
    answer = async (_c, req) => ({ applied: ["ses_1"], skipped: req.tokens.filter((t) => t.sessionID !== "ses_1").map((t) => ({ sessionID: t.sessionID, reason: "unknown" as const })) })
    await push.sessions("c1")
    answer = applyAll
    await push.sessions("c1")
    expect(sentIDs()).toEqual(["ses_1", "ses_child", "ses_child"])
    await push.sessions("c1")
    expect(sent).toHaveLength(2)
  })

  test("a failed send (disconnect, timeout) is retried on the next frame and logged without tokens", async () => {
    answer = async () => {
      throw new Error("OpenCode process disconnected")
    }
    await push.sessions("c1")
    answer = applyAll
    await push.sessions("c1")
    expect(sent).toHaveLength(2)
    expect(sent[1]!.req.tokens).toHaveLength(2)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain("OpenCode process disconnected")
    expect(logged.join()).not.toContain("tok_")
  })

  test("a frame while a send is in flight does not send the same tokens twice", async () => {
    let release!: () => void
    answer = (c, req) => new Promise((resolve) => (release = () => resolve(applyAll(c, req))))
    const first = push.sessions("c1")
    await push.sessions("c1")
    release()
    await first
    expect(sent).toHaveLength(1)
  })

  test("many tokens are split into frames that fit (batchSessionTokens)", async () => {
    conns.get("c1")!.sessions = Array.from({ length: 30 }, (_, i) => `ses_${i}`)
    push = make({ maxChars: 400 })
    await push.sessions("c1")
    expect(sent.length).toBeGreaterThan(1)
    for (const { req } of sent) expect(JSON.stringify(req).length).toBeLessThanOrEqual(400)
    expect(sentIDs()).toEqual(conns.get("c1")!.sessions)
  })

  test("a token too large for any frame is dropped with a log line; the others still go", async () => {
    const big: TokenMinter = { ...minter, mint: (m, s) => ({ ...minter.mint(m, s)!, ...(s === "ses_1" ? { token: "x".repeat(SESSION_TOKEN_MAX_CHARS) } : {}) }) }
    push = make({ tokens: big, maxChars: 1000 })
    await push.sessions("c1")
    expect(sentIDs()).toEqual(["ses_child"])
    expect(logged.join()).not.toContain("xxxx")
  })
})

describe("errors", () => {
  test("a minter that throws (e.g. an unreadable key file) is logged; sessions() and the sweep still resolve", async () => {
    const broken: TokenMinter = {
      ...minter,
      mint: () => {
        throw new Error("Invalid token-keys.json")
      },
    }
    push = make({ tokens: broken })
    await push.sessions("c1")
    push.start()
    timers[0]!.fn()
    await push.idle()
    expect(sent).toEqual([])
    expect(logged.filter((m) => m.includes("Invalid token-keys.json")).length).toBeGreaterThanOrEqual(2)
    expect(timers).toHaveLength(2)
  })
})

describe("refresh sweep", () => {
  test("start arms a timer; each sweep refreshes tokens nearing expiry and re-arms", async () => {
    push.start()
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(SESSION_TOKEN_SWEEP_MS)
    expect(SESSION_TOKEN_SWEEP_MS).toBeLessThan(LIFETIME / 3)
    await push.sessions("c1")
    expect(sent).toHaveLength(1)

    timers[0]!.fn()
    await push.idle()
    expect(sent).toHaveLength(1)
    expect(timers).toHaveLength(2)

    clock += LIFETIME - LIFETIME / 3 + 1
    timers[1]!.fn()
    await push.idle()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.req.tokens.map((t) => t.sessionID)).toEqual(["ses_1", "ses_child"])
    expect(timers).toHaveLength(3)
  })

  test("the sweep forgets connections that are gone and sends nothing for them", async () => {
    await push.sessions("c1")
    conns.delete("c1")
    clock += LIFETIME
    await push.sweep()
    conns.set("c1", { machine: "mch_a", sessions: ["ses_1"], features: true })
    expect(sent).toHaveLength(1)
    await push.sessions("c1")
    expect(sent).toHaveLength(2)
  })

  test("the sweep retries sessions whose token was skipped", async () => {
    answer = async (_c, req) => ({ applied: [], skipped: req.tokens.map((t) => ({ sessionID: t.sessionID, reason: "unknown" as const })) })
    await push.sessions("c1")
    answer = applyAll
    await push.sweep()
    expect(sentIDs()).toEqual(["ses_1", "ses_child", "ses_1", "ses_child"])
  })

  test("stop clears the timer; a later sweep does not re-arm", async () => {
    push.start()
    push.stop()
    expect(timers[0]!.cleared).toBe(true)
    await push.sweep()
    expect(timers).toHaveLength(1)
  })
})

describe("act tokens", () => {
  const ofOp = (op: string) => sent.filter((s) => s.req.op === op)
  const tokensOf = (op: string) => ofOp(op).flatMap((s) => s.req.tokens.map((t) => t.token))

  test("a spoke announcing actTokens gets act tokens in their own op, without a hub URL", async () => {
    conns.get("c1")!.act = true
    await push.sessions("c1")
    expect(ofOp("sessionTokens")).toHaveLength(1)
    expect(ofOp("actTokens")).toHaveLength(1)
    const act = ofOp("actTokens")[0]!.req
    expect("hubURL" in act).toBe(false)
    expect(act.tokens.map((t) => t.sessionID)).toEqual(["ses_1", "ses_child"])
    expect(act.tokens.every((t) => t.token.startsWith("act_") && t.exp === clock + LIFETIME)).toBe(true)
    // Act tokens never travel in a sessionTokens frame, and shell tokens never in an actTokens frame.
    expect(tokensOf("sessionTokens").every((t) => t.startsWith("tok_"))).toBe(true)
  })

  test("a spoke without actTokens never gets an act token, and none is minted", async () => {
    await push.sessions("c1")
    await push.sweep()
    expect(ofOp("actTokens")).toEqual([])
    expect(JSON.stringify(sent)).not.toContain("act_")
  })

  test("only actTokens (no sessionTokens) still gets act tokens; neither feature gets nothing", async () => {
    conns.get("c1")!.features = false
    conns.get("c1")!.act = true
    await push.sessions("c1")
    expect(ofOp("sessionTokens")).toEqual([])
    expect(ofOp("actTokens")).toHaveLength(1)
    conns.get("c1")!.act = false
    clock += LIFETIME
    await push.sessions("c1")
    expect(sent).toHaveLength(1)
  })

  test("a launch-bound connection (a sandboxed spoke) gets session tokens but never act tokens, even on refresh", async () => {
    conns.get("c1")!.act = true
    conns.get("c1")!.launch = "lch_1"
    await push.sessions("c1")
    clock += LIFETIME
    await push.sessions("c1")
    await push.sweep()
    expect(ofOp("sessionTokens").length).toBeGreaterThanOrEqual(2)
    expect(ofOp("actTokens")).toEqual([])
    expect(JSON.stringify(sent)).not.toContain("act_")
  })

  test("a minter without mintAct sends no act tokens", async () => {
    conns.get("c1")!.act = true
    const { mintAct: _mintAct, ...shellOnly } = minter
    push = make({ tokens: shellOnly })
    await push.sessions("c1")
    expect(ofOp("actTokens")).toEqual([])
    expect(ofOp("sessionTokens")).toHaveLength(1)
  })

  test("act tokens are deduped, retried and refreshed on their own", async () => {
    conns.get("c1")!.act = true
    answer = async (_connID, req) =>
      req.op === "actTokens" ? { applied: ["ses_1"], skipped: [{ sessionID: "ses_child", reason: "unknown" }] } : applyAll(_connID, req)
    await push.sessions("c1")
    answer = applyAll
    await push.sessions("c1")
    // Only the skipped act token is resent; no shell token is.
    expect(ofOp("sessionTokens")).toHaveLength(1)
    expect(ofOp("actTokens").map((s) => s.req.tokens.map((t) => t.sessionID))).toEqual([["ses_1", "ses_child"], ["ses_child"]])
    // A new stamp resends both kinds.
    stamps.set("mch_a", "s2")
    await push.sessions("c1")
    expect(ofOp("sessionTokens")).toHaveLength(2)
    expect(ofOp("actTokens")).toHaveLength(3)
  })
})
