import { describe, expect, test } from "bun:test"
import { encode, MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGES, MAX_PROMPT_IMAGES_BASE64, parseServerMessage, parseSpokeMessage, promptImagesProblem, PROTOCOL_VERSION } from "../src/protocol"

const hello = {
  t: "hello",
  v: PROTOCOL_VERSION,
  processID: "p1",
  kind: "standalone",
  directory: "/tmp/x",
  pid: 42,
  mode: "always",
  opencodeVersion: "2.0.25",
  pluginVersion: "0.1.0",
}
const j = (v: unknown) => JSON.stringify(v)

describe("parseSpokeMessage", () => {
  test("accepts a valid hello and round-trips through encode", () => {
    expect(parseSpokeMessage(encode(hello as any))).toEqual(hello as any)
  })

  test("rejects malformed JSON, oversized frames and unknown types", () => {
    expect(parseSpokeMessage("{")).toBeUndefined()
    expect(parseSpokeMessage("[]")).toBeUndefined()
    expect(parseSpokeMessage(j({ t: "nope" }))).toBeUndefined()
    expect(parseSpokeMessage("x".repeat(1_000_001))).toBeUndefined()
  })

  test("rejects a hello with a bad kind or mode", () => {
    expect(parseSpokeMessage(j({ ...hello, kind: "tui" }))).toBeUndefined()
    expect(parseSpokeMessage(j({ ...hello, mode: "off" }))).toBeUndefined()
  })

  test("validates session snapshots", () => {
    const ok = { t: "sessions", sessions: [{ id: "ses_1", title: "a", directory: "/d", updated: 1, owned: true }] }
    expect(parseSpokeMessage(j(ok))).toEqual(ok as any)
    expect(parseSpokeMessage(j({ t: "sessions", sessions: [{ id: "ses_1", title: "a", directory: "/d", updated: 1 }] }))).toBeUndefined()
  })

  test("only forwards allow-listed event types", () => {
    const ev = (type: string) => j({ t: "event", event: { type, data: { sessionID: "ses_1" } } })
    expect(parseSpokeMessage(ev("permission.asked"))).toBeDefined()
    expect(parseSpokeMessage(ev("mcp.status.changed"))).toBeUndefined()
  })

  test("spokes may only send their own request ops", () => {
    expect(parseSpokeMessage(j({ t: "req", id: "1", req: { op: "pairCode" } }))).toBeDefined()
    expect(parseSpokeMessage(j({ t: "req", id: "1", req: { op: "handoff", sessionID: "ses_1" } }))).toBeDefined()
    expect(parseSpokeMessage(j({ t: "req", id: "1", req: { op: "openLink", sessionID: "ses_1", voice: true } }))).toBeDefined()
    expect(parseSpokeMessage(j({ t: "req", id: "1", req: { op: "openLink", sessionID: "ses_1", voice: "yes" } }))).toBeUndefined()
    expect(parseSpokeMessage(j({ t: "req", id: "1", req: { op: "turn", sessionID: "ses_1", text: "x", voiceStyle: true } }))).toBeUndefined()
  })
})

describe("parseServerMessage", () => {
  test("accepts server requests and rejects spoke-only ops", () => {
    const turn = { t: "req", id: "r1", req: { op: "turn", sessionID: "ses_1", text: "hi", voiceStyle: true } }
    expect(parseServerMessage(j(turn))).toEqual(turn as any)
    expect(parseServerMessage(j({ t: "req", id: "r1", req: { op: "pairCode" } }))).toBeUndefined()
  })

  test("validates permission decisions", () => {
    const req = (decision: string) => j({ t: "req", id: "r", req: { op: "permission", sessionID: "ses_1", requestID: "per_1", decision } })
    expect(parseServerMessage(req("once"))).toBeDefined()
    expect(parseServerMessage(req("yes"))).toBeUndefined()
  })

  test("validates form replies: an answer object of bounded values, or a cancel", () => {
    const req = (extra: Record<string, unknown>) => j({ t: "req", id: "r", req: { op: "form", sessionID: "ses_1", formID: "frm_1", ...extra } })
    expect(parseServerMessage(req({ answer: { q0: "red", q1: ["S", "M"], q2: true, q3: 3 } }))).toBeDefined()
    expect(parseServerMessage(req({ cancel: true }))).toBeDefined()
    expect(parseServerMessage(req({}))).toBeUndefined()
    expect(parseServerMessage(req({ answer: { q0: "a" }, cancel: true }))).toBeUndefined()
    expect(parseServerMessage(req({ answer: { q0: { nested: 1 } } }))).toBeUndefined()
    expect(parseServerMessage(req({ answer: { q0: [1] } }))).toBeUndefined()
    expect(parseServerMessage(req({ answer: { q0: "x".repeat(20_001) } }))).toBeUndefined()
    expect(parseServerMessage(req({ answer: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, "v"])) }))).toBeUndefined()
    expect(parseServerMessage(req({ answer: [] }))).toBeUndefined()
  })

  test("accepts welcome, res and bye", () => {
    expect(parseServerMessage(j({ t: "welcome", v: 1, machineID: "m1", publicURL: "https://voice.example.com" }))).toBeDefined()
    expect(parseServerMessage(j({ t: "res", id: "1", ok: false, error: "x" }))).toBeDefined()
    expect(parseServerMessage(j({ t: "bye", reason: "revoked" }))).toBeDefined()
    expect(parseServerMessage(j({ t: "res", ok: true }))).toBeUndefined()
  })
})

describe("conversation ops", () => {
  const r = (req: unknown) => JSON.stringify({ t: "req", id: "c1", req })
  test("server accepts steer, interrupt and conversation; rejects malformed", () => {
    expect(parseServerMessage(r({ op: "steer", sessionID: "ses_1", text: "also add tests" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "steer", sessionID: "ses_1", text: "" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "interrupt", sessionID: "ses_1" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "conversation", sessionID: "ses_1", on: true }))).toBeDefined()
    expect(parseServerMessage(r({ op: "conversation", sessionID: "ses_1", on: "yes" }))).toBeUndefined()
  })
  test("spokes forward text.ended and agent.selected", () => {
    const ev = (type: string) => JSON.stringify({ t: "event", event: { type, data: { sessionID: "ses_1" } } })
    expect(parseSpokeMessage(ev("session.text.ended"))).toBeDefined()
    expect(parseSpokeMessage(ev("session.agent.selected"))).toBeDefined()
  })
  test("model catalog, preferences, timeline and detail requests are bounded", () => {
    expect(parseServerMessage(r({ op: "models", sessionID: "ses_1" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "modelPrefs", sessionID: "ses_1" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "setModelPrefs", sessionID: "ses_1", voice: { providerID: "anthropic", modelID: "claude", variant: "fast" }, worker: null }))).toBeDefined()
    expect(parseServerMessage(r({ op: "setModelPrefs", sessionID: "ses_1", voice: { providerID: "bad space", modelID: "x" } }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", limit: 50 }))).toBeDefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", limit: 201 }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", cursor: "x".repeat(5000) }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timelinePart", sessionID: "ses_1", messageID: "msg_1", partID: "tool_1" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "timelinePart", sessionID: "ses_1", messageID: "", partID: "tool_1" }))).toBeUndefined()
  })
})

describe("activity compaction", () => {
  const { compactActivity, summarizeToolInput } = require("../src/protocol")
  test("summarizes tool input without the full payload", () => {
    expect(summarizeToolInput({ command: "bun test\nmore" })).toBe("bun test")
    expect(summarizeToolInput({ filePath: "/a/b.ts", content: "x".repeat(10000) })).toBe("/a/b.ts")
    expect(summarizeToolInput({ content: "secret" })).toBe("")
    expect(summarizeToolInput({ command: "y".repeat(500) }).length).toBe(160)
  })
  test("drops tool input and output payloads", () => {
    const called = compactActivity({ type: "session.tool.called", data: { sessionID: "s", assistantMessageID: "m", id: "t", input: { filePath: "/x", content: "BIG" }, executed: true } })
    expect(JSON.stringify(called)).not.toContain("BIG")
    expect(called.data).toEqual({ sessionID: "s", assistantMessageID: "m", id: "t", summary: "/x", background: false })
    const ok = compactActivity({ type: "session.tool.success", data: { sessionID: "s", assistantMessageID: "m", id: "t", content: [{ type: "text", text: "OUTPUT" }] } })
    expect(JSON.stringify(ok)).not.toContain("OUTPUT")
    const failed = compactActivity({ type: "session.tool.failed", data: { sessionID: "s", assistantMessageID: "m", id: "t", error: { type: "x", message: "boom" } } })
    expect(failed.data.error).toBe("boom")
    expect(compactActivity({ type: "session.tool.called", data: { sessionID: "s", id: "t", input: { agent: "general", background: true } } }).data.background).toBe(true)
  })
  test("tool events are forwardable", () => {
    const ev = (type: string) => JSON.stringify({ t: "event", event: { type, data: { sessionID: "ses_1" } } })
    for (const t of ["session.tool.input.started", "session.tool.called", "session.tool.success", "session.tool.failed", "session.reasoning.started"]) expect(parseSpokeMessage(ev(t))).toBeDefined()
  })
  test("reasoning deltas and ends are forwardable in compact form (delta capped, full text dropped)", () => {
    const ev = (type: string) => JSON.stringify({ t: "event", event: { type, data: { sessionID: "ses_1" } } })
    for (const t of ["session.reasoning.delta", "session.reasoning.ended"]) expect(parseSpokeMessage(ev(t))).toBeDefined()
    const delta = compactActivity({ type: "session.reasoning.delta", data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "let me think", extra: "X" } })
    expect(delta).toEqual({ type: "session.reasoning.delta", data: { sessionID: "s", assistantMessageID: "m", delta: "let me think" } })
    const long = compactActivity({ type: "session.reasoning.delta", data: { sessionID: "s", assistantMessageID: "m", delta: "z".repeat(5000) } })
    expect((long!.data.delta as string).length).toBe(2000)
    const odd = compactActivity({ type: "session.reasoning.delta", data: { sessionID: "s", assistantMessageID: "m", delta: 42 } })
    expect(odd!.data.delta).toBe("")
    const ended = compactActivity({ type: "session.reasoning.ended", data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, text: "SECRET FULL REASONING" } })
    expect(ended).toEqual({ type: "session.reasoning.ended", data: { sessionID: "s", assistantMessageID: "m" } })
  })
})

describe("session browser ops", () => {
  const r = (req: unknown) => JSON.stringify({ t: "req", id: "b1", req })
  test("expose and create are validated", () => {
    expect(parseServerMessage(r({ op: "expose", sessionID: "ses_1", on: true }))).toBeDefined()
    expect(parseServerMessage(r({ op: "expose", sessionID: "ses_1" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "create", directory: "/home/user/projects/x", title: "New" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "create", directory: "relative/path" }))).toBeUndefined()
  })
  test("session info accepts optional workspace fields", () => {
    const s = { id: "ses_1", title: "a", directory: "/d/wt", updated: 1, owned: false, exposed: false, project: "/d", projectName: "d" }
    expect(parseSpokeMessage(JSON.stringify({ t: "sessions", sessions: [s] }))).toBeDefined()
    expect(parseSpokeMessage(JSON.stringify({ t: "sessions", sessions: [{ ...s, exposed: "no" }] }))).toBeUndefined()
  })
})

describe("open-in-terminal fields", () => {
  test("sessions carry open + terminal info; bad terminal info is rejected", () => {
    const s = { id: "ses_1", title: "a", directory: "/d", updated: 1, owned: false, open: true, terminal: { source: "herdr", workspaceID: "w7", workspace: "research", title: "OC | x", status: "working" } }
    expect(parseSpokeMessage(JSON.stringify({ t: "sessions", sessions: [s] }))).toBeDefined()
    expect(parseSpokeMessage(JSON.stringify({ t: "sessions", sessions: [{ ...s, terminal: { source: "tmux" } }] }))).toBeUndefined()
  })
  test("terminals frame lists Herdr workspaces", () => {
    const ok = { t: "terminals", herdr: { workspaces: [{ id: "w7", label: "research", directories: ["/home/user/projects/research"] }] } }
    expect(parseSpokeMessage(JSON.stringify(ok))).toBeDefined()
    expect(parseSpokeMessage(JSON.stringify({ t: "terminals" }))).toBeDefined()
    expect(parseSpokeMessage(JSON.stringify({ t: "terminals", herdr: { workspaces: [{ id: "w7" }] } }))).toBeUndefined()
  })
  test("create may target a Herdr workspace", () => {
    const r = (req: unknown) => JSON.stringify({ t: "req", id: "c", req })
    expect(parseServerMessage(r({ op: "create", directory: "/home/user/p", herdrWorkspace: "w7" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "create", directory: "/home/user/p", herdrWorkspace: "" }))).toBeUndefined()
  })
})

describe("prompt images", () => {
  const png = (size = 64) => {
    const bytes = Buffer.alloc(size)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    return bytes.toString("base64")
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64")
  const r = (req: unknown) => JSON.stringify({ t: "req", id: "i", req })

  test("accepts up to four well-formed images and names", () => {
    expect(promptImagesProblem([{ mime: "image/png", data: png(), name: "shot.png" }, { mime: "image/jpeg", data: jpeg }])).toBeUndefined()
    expect(promptImagesProblem(Array.from({ length: MAX_PROMPT_IMAGES }, () => ({ mime: "image/png", data: png() })))).toBeUndefined()
  })

  test("refuses too many, bad mime, bad base64, wrong magic bytes, oversize and bad names", () => {
    expect(promptImagesProblem("x")).toMatch(/array/)
    expect(promptImagesProblem(Array.from({ length: MAX_PROMPT_IMAGES + 1 }, () => ({ mime: "image/png", data: png() })))).toMatch(/at most 4/)
    expect(promptImagesProblem([{ mime: "image/svg+xml", data: png() }])).toMatch(/type/)
    expect(promptImagesProblem([{ mime: "image/png", data: "not base64!" }])).toMatch(/base64/)
    expect(promptImagesProblem([{ mime: "image/png", data: "iVBORw0KGgp=" }])).toMatch(/base64/) // non-canonical padding
    expect(promptImagesProblem([{ mime: "image/png", data: "" }])).toMatch(/base64|empty/)
    expect(promptImagesProblem([{ mime: "image/jpeg", data: png() }])).toMatch(/not a image\/jpeg|does not match/)
    expect(promptImagesProblem([{ mime: "image/png", data: png(MAX_PROMPT_IMAGE_BYTES + 1) }])).toMatch(/larger than/)
    // Each under the per-image cap, together over the total cap.
    const big = png(Math.floor(MAX_PROMPT_IMAGE_BYTES * 0.9))
    expect(big.length * 2).toBeGreaterThan(MAX_PROMPT_IMAGES_BASE64)
    expect(promptImagesProblem([{ mime: "image/png", data: big }, { mime: "image/png", data: big }])).toMatch(/together/)
    expect(promptImagesProblem([{ mime: "image/png", data: png(), name: 5 }])).toMatch(/name/)
    expect(promptImagesProblem([{ mime: "image/png", data: png(), name: "x".repeat(201) }])).toMatch(/name/)
    expect(promptImagesProblem([null])).toBeDefined()
  })

  test("turn and steer carry images; text may be empty only with images", () => {
    const images = [{ mime: "image/png", data: png(), name: "a.png" }]
    expect(parseServerMessage(r({ op: "turn", sessionID: "s", text: "", voiceStyle: false, images }))).toBeDefined()
    expect(parseServerMessage(r({ op: "steer", sessionID: "s", text: "", images }))).toBeDefined()
    expect(parseServerMessage(r({ op: "turn", sessionID: "s", text: "", voiceStyle: false }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "turn", sessionID: "s", text: "", voiceStyle: false, images: [] }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "steer", sessionID: "s", text: "hi", images: [{ mime: "text/plain", data: png() }] }))).toBeUndefined()
  })

  test("timelineFile asks for one attachment of a message", () => {
    expect(parseServerMessage(r({ op: "timelineFile", sessionID: "s", messageID: "m", index: 0 }))).toBeDefined()
    expect(parseServerMessage(r({ op: "timelineFile", sessionID: "s", messageID: "m", index: -1 }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timelineFile", sessionID: "s", messageID: "m", index: 1.5 }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timelineFile", sessionID: "s", messageID: "", index: 0 }))).toBeUndefined()
  })
})
