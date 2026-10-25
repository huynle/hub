// Act tokens (phase 3): a second per-session credential the hub sends only to spokes announcing "actTokens", in
// its own op, so a spoke that only knows sessionTokens can never mistake one for a shell token.
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"
import { featureForOp, IMPLIED_OPENCODE_FEATURES, KNOWN_SPOKE_FEATURES, parseServerMessage, requestFeatures, SPOKE_FEATURES, spokeFeatures } from "../src/index.ts"

const j = (v: unknown) => JSON.stringify(v)
const P = protocol as any
const entry = (sessionID: string, extra: Record<string, unknown> = {}) => ({ sessionID, token: `hst1.${sessionID}.sig`, exp: 1_793_000_000_000, ...extra })
const frame = (req: Record<string, unknown>) => j({ t: "req", id: "r1", req: { op: "actTokens", ...req } })
const parses = (req: Record<string, unknown>) => parseServerMessage(frame(req)) !== undefined

describe("actTokens op", () => {
  test("accepts act tokens for sessions", () => {
    const req = { op: "actTokens", tokens: [entry("ses_a"), entry("ses_b")] }
    expect(parseServerMessage(j({ t: "req", id: "r1", req }))).toEqual({ t: "req", id: "r1", req } as any)
    expect(parses({ tokens: [] })).toBe(true)
  })

  test("rejects malformed token lists, entries, and a hub URL (act tokens never travel with one)", () => {
    expect(parses({})).toBe(false)
    expect(parses({ tokens: "x" })).toBe(false)
    expect(parses({ tokens: [entry("")] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { token: "has space" })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { exp: "1" })] })).toBe(false)
    expect(parses({ tokens: Array.from({ length: 501 }, (_, i) => entry(`ses_${i}`)) })).toBe(false)
    expect(parses({ tokens: [entry("ses_a")], hubURL: "https://hub.example" })).toBe(false)
  })

  test("actTokens is a feature that must be announced; old spokes never get the op", () => {
    expect(KNOWN_SPOKE_FEATURES as readonly string[]).toContain("actTokens")
    expect(SPOKE_FEATURES as readonly string[]).toContain("actTokens")
    expect(IMPLIED_OPENCODE_FEATURES as readonly string[]).not.toContain("actTokens")
    expect(featureForOp("actTokens" as any)).toBe("actTokens" as any)
    expect(requestFeatures({ op: "actTokens", tokens: [] } as any)).toEqual(["actTokens"] as any)
    expect(spokeFeatures({ machineID: "m", features: ["sessionTokens"] } as any).has("actTokens")).toBe(false)
  })

  test("batchActTokens splits like batchSessionTokens, without a hub URL", () => {
    const tokens = Array.from({ length: 501 }, (_, i) => entry(`ses_${i}`))
    const batches = P.batchActTokens(tokens)
    expect(batches.map((b: any) => b.tokens.length)).toEqual([500, 1])
    expect(batches.every((b: any) => b.op === "actTokens" && !("hubURL" in b))).toBe(true)
    const one = [entry("ses_a")]
    const exact = j({ op: "actTokens", tokens: one }).length
    expect(P.batchActTokens(one, { maxChars: exact })).toEqual([{ op: "actTokens", tokens: one }])
    expect(() => P.batchActTokens(one, { maxChars: exact - 1 })).toThrow(RangeError)
  })
})
