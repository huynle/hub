// Core ops (turn, steer, interrupt, stop, permission, form) as announced features for non-OpenCode spokes (P7-T1).
import { describe, expect, test } from "bun:test"
import {
  CORE_OPS,
  featureForOp,
  helloHarness,
  HUB_FEATURES,
  IMPLIED_OPENCODE_FEATURES,
  KNOWN_SPOKE_FEATURES,
  parseSpokeMessage,
  PROTOCOL_VERSION,
  requestFeatures,
  SPOKE_FEATURES,
  spokeFeatures,
  type Hello,
  type ServerRequest,
} from "../src/index.ts"

const oldHello = { t: "hello", v: PROTOCOL_VERSION, processID: "p1", kind: "standalone", directory: "/tmp/x", pid: 42, mode: "always", opencodeVersion: "2.0.25", pluginVersion: "0.1.0" } as const
const parsed = (v: unknown) => parseSpokeMessage(JSON.stringify(v)) as Hello
const has = (hello: Hello, req: ServerRequest) => requestFeatures(req).every((f) => spokeFeatures(hello).has(f))

const turn: ServerRequest = { op: "turn", sessionID: "ses_1", text: "hi", voiceStyle: false }
const coreRequests: ServerRequest[] = [
  turn,
  { op: "steer", sessionID: "ses_1", text: "hi" },
  { op: "interrupt", sessionID: "ses_1" },
  { op: "stop", sessionID: "ses_1" },
  { op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "once" },
  { op: "form", sessionID: "ses_1", formID: "frm_1", cancel: true },
]

describe("core ops", () => {
  test("CORE_OPS lists the six core ops, each a known spoke feature", () => {
    expect([...CORE_OPS]).toEqual(["turn", "steer", "interrupt", "stop", "permission", "form"])
    for (const op of CORE_OPS) expect(KNOWN_SPOKE_FEATURES as readonly string[]).toContain(op)
    expect(KNOWN_SPOKE_FEATURES.length).toBeLessThanOrEqual(64)
  })

  test("featureForOp and requestFeatures name the core op itself", () => {
    for (const op of CORE_OPS) expect(featureForOp(op)).toBe(op)
    for (const req of coreRequests) expect(requestFeatures(req)).toContain(req.op as (typeof CORE_OPS)[number])
    // Options still add their own features.
    expect(requestFeatures({ op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "reject", message: "no" })).toEqual(["permission", "permissionMessage"])
  })

  test("an old OpenCode hello (no harness) keeps every core op and its implied features, unchanged", () => {
    const hello = parsed(oldHello)
    expect(hello).toEqual(oldHello as unknown as Hello)
    const features = spokeFeatures(hello)
    for (const op of CORE_OPS) expect(features.has(op)).toBe(true)
    for (const f of IMPLIED_OPENCODE_FEATURES) expect(features.has(f)).toBe(true)
    for (const req of coreRequests) expect(has(hello, req)).toBe(true)
    expect(features.has("autoName")).toBe(false)
  })

  test("an OpenCode hello with harness 'opencode' implies the core ops without announcing them", () => {
    const hello = parsed({ ...oldHello, harness: "opencode", harnessVersion: "2.0.25", evidence: "native", features: [...SPOKE_FEATURES] })
    for (const req of coreRequests) expect(has(hello, req)).toBe(true)
  })

  test("a claude-code hello without 'turn' fails requestFeatures for turn; announced core ops pass", () => {
    const hello = parsed({ ...oldHello, harness: "claude-code", harnessVersion: "2.1.296", evidence: "hooks", features: ["permission", "deliver"] })
    expect(spokeFeatures(hello).has("turn")).toBe(false)
    expect(has(hello, turn)).toBe(false)
    expect(has(hello, { op: "interrupt", sessionID: "ses_1" })).toBe(false)
    expect(has(hello, { op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "once" })).toBe(true)
    // No implied OpenCode features either.
    expect([...spokeFeatures(hello)].sort()).toEqual(["deliver", "permission"])
  })

  test("nothing new is announced: SPOKE_FEATURES and HUB_FEATURES carry no core op", () => {
    for (const op of CORE_OPS) {
      expect(SPOKE_FEATURES as readonly string[]).not.toContain(op)
      expect(HUB_FEATURES as readonly string[]).not.toContain(op)
      expect(IMPLIED_OPENCODE_FEATURES as readonly string[]).not.toContain(op)
    }
    expect([...SPOKE_FEATURES]).toEqual([...IMPLIED_OPENCODE_FEATURES, "autoName", "sessionTokens", "deliver", "hubPrompt", "permissionMessage", "actTokens", "launch"])
    expect([...HUB_FEATURES]).toEqual(["harness", "messaging", "nodes", "launches"])
  })
})

describe("opencodeVersion", () => {
  const { opencodeVersion: _v, ...noVersion } = oldHello

  test("optional for a non-OpenCode harness hello", () => {
    const hello = parsed({ ...noVersion, harness: "claude-code", harnessVersion: "2.1.296", evidence: "hooks" })
    expect(hello).toBeDefined()
    expect(helloHarness(hello)).toEqual({ harness: "claude-code", harnessVersion: "2.1.296", evidence: "hooks" })
  })

  test("still required for an OpenCode hello (no harness, or harness 'opencode') and must be text when sent", () => {
    expect(parsed(noVersion)).toBeUndefined()
    expect(parsed({ ...noVersion, harness: "opencode", harnessVersion: "2.0.25", evidence: "native" })).toBeUndefined()
    expect(parsed({ ...noVersion, harness: "codex", opencodeVersion: 5 })).toBeUndefined()
    // A non-OpenCode spoke that wants to reach hubs predating `harness` keeps sending it (e.g. "").
    expect(parsed({ ...oldHello, opencodeVersion: "", harness: "codex", evidence: "rpc" })).toBeDefined()
  })
})
