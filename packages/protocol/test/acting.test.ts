// Phase 3 wire additions: hub prompts (deliver kind "prompt" with the grant it acts under, feature "hubPrompt") and
// a permission reply's message (a deny reason, feature "permissionMessage").
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"
import { featureForOp, KNOWN_SPOKE_FEATURES, MAX_FRAME, parseServerMessage, SPOKE_FEATURES, spokeFeatures, type ServerRequest } from "../src/index.ts"

const j = (v: unknown) => JSON.stringify(v)
const P = protocol as any
const frame = (req: unknown) => j({ t: "req", id: "a1", req })
const parses = (req: unknown) => parseServerMessage(frame(req)) !== undefined

const promptMeta = { kind: "prompt", from: "@orchestrator", to: "@api-refactor", grant: "g_12" }
const prompt = (extra: Record<string, unknown> = {}) => ({ op: "deliver", sessionID: "ses_1", messageID: "msg_7f", text: "run the tests", wake: true, meta: promptMeta, ...extra })
const permission = (extra: Record<string, unknown> = {}) => ({ op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "reject", ...extra })

describe("hub prompts (deliver kind prompt)", () => {
  test("prompt is a message kind; a prompt names the grant it acts under", () => {
    expect(P.MESSAGE_KINDS).toContain("prompt")
    const req = prompt()
    expect(parseServerMessage(frame(req))).toEqual({ t: "req", id: "a1", req } as any)
    expect(parses(prompt({ meta: { ...promptMeta, delivery: "steer" } }))).toBe(true)
  })

  test("a prompt without a grant is refused; only prompts carry one", () => {
    const { grant: _grant, ...noGrant } = promptMeta
    expect(parses(prompt({ meta: noGrant }))).toBe(false)
    expect(P.deliverProblem(prompt({ meta: noGrant }))).toMatch(/grant/)
    expect(parses(prompt({ meta: { kind: "msg", from: "@a", to: "@b", grant: "g_1" } }))).toBe(false)
  })

  test("the grant id is a plain id of at most 300 characters", () => {
    for (const grant of ["", "g 1", "g\u202e1", "x".repeat(301), 12]) expect(parses(prompt({ meta: { ...promptMeta, grant } }))).toBe(false)
    expect(parses(prompt({ meta: { ...promptMeta, grant: "g_" + "x".repeat(298) } }))).toBe(true)
  })
})

describe("permission reply message", () => {
  test("a reject may carry a message (OpenCode's reply message, the deny reason)", () => {
    const req = permission({ message: "Only tests may run in this worktree" })
    expect(parseServerMessage(frame(req))).toEqual({ t: "req", id: "a1", req } as any)
    expect(parses(permission({ message: "line one\nline two" }))).toBe(true)
  })

  test("only a reject carries a message", () => {
    expect(parses(permission({ decision: "once", message: "ok" }))).toBe(false)
    expect(parses(permission({ decision: "always", message: "ok" }))).toBe(false)
  })

  test("the message is 1–PERMISSION_MESSAGE_MAX characters without control, bidi or zero-width characters", () => {
    expect(P.PERMISSION_MESSAGE_MAX).toBe(1000)
    expect(parses(permission({ message: "x".repeat(1000) }))).toBe(true)
    for (const message of ["", "x".repeat(1001), "a\u0007b", "a\u202eb", "a\u200bb", "a\rb", 5]) expect(parses(permission({ message }))).toBe(false)
  })
})

describe("acting features", () => {
  test("hubPrompt and permissionMessage are announced features (old spokes do not imply them)", () => {
    expect(KNOWN_SPOKE_FEATURES as readonly string[]).toEqual(expect.arrayContaining(["hubPrompt", "permissionMessage"]))
    expect(SPOKE_FEATURES as readonly string[]).toEqual(expect.arrayContaining(["hubPrompt", "permissionMessage"]))
    const oldHello = { t: "hello", v: 1, processID: "p", kind: "service", directory: "/", pid: 1, mode: "always", opencodeVersion: "2.0", pluginVersion: "0.5" } as any
    expect(spokeFeatures(oldHello).has("hubPrompt")).toBe(false)
    expect(spokeFeatures(oldHello).has("permissionMessage")).toBe(false)
  })

  test("requestFeatures lists every feature a spoke must announce to serve a request", () => {
    const features = (req: unknown) => P.requestFeatures(req as ServerRequest)
    expect(features(prompt())).toEqual(["deliver", "hubPrompt"])
    expect(features({ ...prompt(), meta: { kind: "msg", from: "@a", to: "@b" } })).toEqual(["deliver"])
    expect(features(permission({ message: "no" }))).toEqual(["permissionMessage"])
    expect(features(permission())).toEqual([])
    expect(features({ op: "turn", sessionID: "ses_1", text: "hi", voiceStyle: false })).toEqual([])
    expect(features({ op: "timeline", sessionID: "ses_1" })).toEqual([featureForOp("timeline")])
  })

  test("the largest hub prompt still fits in one frame", () => {
    const req = prompt({ text: "\u0001".repeat(P.DELIVER_TEXT_MAX), meta: { ...promptMeta, grant: "g".repeat(300) } })
    expect(frame(req).length).toBeLessThan(MAX_FRAME)
  })
})
