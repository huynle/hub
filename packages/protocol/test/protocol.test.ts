import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"
import {
  encode,
  EVIDENCE_LEVELS,
  featureForOp,
  FORWARDED_EVENTS,
  helloHarness,
  HUB_FEATURES,
  IMPLIED_OPENCODE_FEATURES,
  spokeFeatures,
  SPOKE_FEATURES,
  MAX_FRAME,
  MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGES, MAX_PROMPT_IMAGES_BASE64, parseServerMessage, parseSpokeMessage, promptImagesProblem, PROTOCOL_VERSION } from "../src/index.ts"

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

  test("a hello may list the spoke's features (strings); older spokes send none", () => {
    expect(parseSpokeMessage(j({ ...hello, features: ["autoName"] }))).toMatchObject({ features: ["autoName"] })
    expect(parseSpokeMessage(j({ ...hello, features: [] }))).toBeDefined()
    expect(parseSpokeMessage(j({ ...hello, features: "autoName" }))).toBeUndefined()
    expect(parseSpokeMessage(j({ ...hello, features: [5] }))).toBeUndefined()
    expect(parseSpokeMessage(j({ ...hello, features: Array(65).fill("x") }))).toBeUndefined()
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

  test("bye may carry retryAfterMs (draining): a whole number of ms up to MAX_RETRY_AFTER_MS", () => {
    const bye = { t: "bye", reason: "draining", retryAfterMs: 5000 }
    expect(parseServerMessage(j(bye))).toEqual(bye as any)
    expect(parseSpokeMessage(j(bye))).toEqual(bye as any)
    expect(parseServerMessage(j({ ...bye, retryAfterMs: 0 }))).toBeDefined()
    expect(parseServerMessage(j({ ...bye, retryAfterMs: protocol.MAX_RETRY_AFTER_MS }))).toBeDefined()
    expect(parseServerMessage(j({ ...bye, retryAfterMs: protocol.MAX_RETRY_AFTER_MS + 1 }))).toBeUndefined()
    expect(parseServerMessage(j({ ...bye, retryAfterMs: -1 }))).toBeUndefined()
    expect(parseServerMessage(j({ ...bye, retryAfterMs: 1.5 }))).toBeUndefined()
    expect(parseServerMessage(j({ ...bye, retryAfterMs: "5000" }))).toBeUndefined()
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
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", limit: 80, order: "desc" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", limit: 80, before: "msg_1:0" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", order: "sideways" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", before: "" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", before: "x".repeat(5000) }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", before: "a", cursor: "2" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timeline", sessionID: "ses_1", order: "desc", cursor: "2" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "timelinePart", sessionID: "ses_1", messageID: "msg_1", partID: "tool_1" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "timelinePart", sessionID: "ses_1", messageID: "", partID: "tool_1" }))).toBeUndefined()
  })
})

describe("activity compaction", () => {
  const { compactActivity, summarizeToolInput } = require("../src/index.ts")
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
  test("a subagent tool's child session goes out as a compact tool.called (old hubs accept it); other progress is dropped", () => {
    const progress = compactActivity({ type: "session.tool.progress", data: { sessionID: "s", assistantMessageID: "m", id: "t", metadata: { sessionID: "ses_child", status: "running", secret: "BIG" } } })
    expect(progress).toEqual({ type: "session.tool.called", data: { sessionID: "s", assistantMessageID: "m", id: "t", childSessionID: "ses_child" } })
    expect(compactActivity({ type: "session.tool.progress", data: { sessionID: "s", id: "t", metadata: { lines: 3 } } })).toBeUndefined()
    const ok = compactActivity({ type: "session.tool.success", data: { sessionID: "s", assistantMessageID: "m", id: "t", content: [], metadata: { sessionID: "ses_child", status: "completed" } } })
    expect(ok.data).toEqual({ sessionID: "s", assistantMessageID: "m", id: "t", childSessionID: "ses_child" })
    expect(FORWARDED_EVENTS.has(progress.type)).toBe(true)
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

  test("autoName carries just a session", () => {
    expect(parseServerMessage(r({ op: "autoName", sessionID: "ses_1" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "autoName", sessionID: "" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "autoName" }))).toBeUndefined()
  })

  test("rename carries a title string (the spoke checks its length and reports why)", () => {
    expect(parseServerMessage(r({ op: "rename", sessionID: "ses_1", title: "New name" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "rename", sessionID: "ses_1", title: "" }))).toBeDefined()
    expect(parseServerMessage(r({ op: "rename", sessionID: "ses_1" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "rename", sessionID: "", title: "x" }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "rename", sessionID: "ses_1", title: 5 }))).toBeUndefined()
    expect(parseServerMessage(r({ op: "rename", sessionID: "ses_1", title: "x".repeat(1001) }))).toBeUndefined()
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

describe("job and status compaction", () => {
  const { compactActivity } = require("../src/index.ts")
  const info = { id: "sh_1", status: "running", command: "bun run build && " + "x".repeat(500), cwd: "/w", shell: "bash", file: "/tmp/f", pid: 9, metadata: { sessionID: "ses_1", background: true }, time: { started: 1000 } }

  test("session.status keeps the type and a short retry reason", () => {
    expect(compactActivity({ type: "session.status", data: { sessionID: "s", status: { type: "busy" } } })).toEqual({ type: "session.status", data: { sessionID: "s", status: { type: "busy" } } })
    const retry = compactActivity({ type: "session.status", data: { sessionID: "s", status: { type: "retry", attempt: 3, message: "m".repeat(400), next: 9, action: { link: "x" } } } })
    expect(retry.data.status).toEqual({ type: "retry", attempt: 3, message: "m".repeat(199) + "…", next: 9 })
  })

  test("session.status retry passes next, errorType and errorStatus through only when valid", () => {
    const status = (s: Record<string, unknown>) => compactActivity({ type: "session.status", data: { sessionID: "s", status: { type: "retry", ...s } } }).data.status
    expect(status({ attempt: 2, next: 1_700_000_000_000, errorType: "provider.quota", errorStatus: 429 })).toEqual({ type: "retry", attempt: 2, next: 1_700_000_000_000, errorType: "provider.quota", errorStatus: 429 })
    expect(status({ next: "soon", errorType: "x".repeat(65), errorStatus: 99 })).toEqual({ type: "retry" })
    expect(status({ next: Infinity, errorType: "", errorStatus: 600 })).toEqual({ type: "retry" })
    expect(status({ errorStatus: 429.5 })).toEqual({ type: "retry" })
  })

  describe("session.retry.scheduled and session.execution.failed (OpenCode 2.2 errors)", () => {
  const P = require("../src/index.ts")
  const { compactActivity, COMPACTED_EVENTS, FORWARDED_EVENTS, parseSpokeMessage, encode, isHarnessEvent } = P
  const scheduled = {
    type: "session.retry.scheduled",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      attempt: 3,
      at: 1_700_000_000_000,
      error: { type: "provider.quota", message: "You exceeded your current quota", status: 429, response: { body: "SECRET BODY" }, retryAfterMs: 5000 },
    },
  }

  test("retry.scheduled is compacted, never forwarded as its own type (older hubs close on unknown types)", () => {
    expect(COMPACTED_EVENTS.has("session.retry.scheduled")).toBe(true)
    expect(FORWARDED_EVENTS.has("session.retry.scheduled")).toBe(false)
  })

  test("retry.scheduled becomes a session.status retry with attempt, message, next, errorType, errorStatus", () => {
    const out = compactActivity(scheduled)
    expect(out).toEqual({
      type: "session.status",
      data: { sessionID: "ses_1", status: { type: "retry", attempt: 3, message: "You exceeded your current quota", next: 1_700_000_000_000, errorType: "provider.quota", errorStatus: 429 } },
    })
    expect(JSON.stringify(out)).not.toContain("SECRET")
    expect(parseSpokeMessage(encode({ t: "event", event: out }))).toBeDefined()
    expect(isHarnessEvent(out)).toBe(true)
  })

  test("retry.scheduled caps the message and drops invalid fields; without a session it is dropped", () => {
    const out = compactActivity({ type: "session.retry.scheduled", data: { sessionID: "ses_1", attempt: "x", at: "later", error: { type: 7, message: "m".repeat(500), status: 1000 } } })
    expect(out.data.status).toEqual({ type: "retry", message: "m".repeat(199) + "…" })
    expect(compactActivity({ type: "session.retry.scheduled", data: { sessionID: "ses_1" } }).data.status).toEqual({ type: "retry" })
    expect(compactActivity({ type: "session.retry.scheduled", data: { attempt: 1 } })).toBeUndefined()
  })

  test("execution.failed keeps only the error's message, type and status, capped", () => {
    const out = compactActivity({
      type: "session.execution.failed",
      data: { sessionID: "ses_1", turnID: "turn_1", extra: "X", error: { type: "provider.auth", message: "Invalid API key", status: 401, response: { body: "SECRET BODY" }, retryAfterMs: 9 } },
    })
    expect(out).toEqual({ type: "session.execution.failed", data: { sessionID: "ses_1", turnID: "turn_1", error: { message: "Invalid API key", type: "provider.auth", status: 401 } } })
    expect(isHarnessEvent(out)).toBe(true)
    const long = compactActivity({ type: "session.execution.failed", data: { sessionID: "ses_1", error: { message: "e".repeat(5000), type: "t".repeat(65), status: 42 } } })
    expect(long.data.error.message.length).toBe(P.ERROR_MESSAGE_MAX)
    expect(P.ERROR_MESSAGE_MAX).toBe(1000)
    expect(long.data.error).toEqual({ message: expect.any(String) })
    expect(compactActivity({ type: "session.execution.failed", data: { sessionID: "ses_1" } }).data).toEqual({ sessionID: "ses_1", error: { message: "failed" } })
    expect(compactActivity({ type: "session.execution.failed", data: { sessionID: "ses_1", error: { message: "  " } } }).data.error).toEqual({ message: "failed" })
    expect(isHarnessEvent(long)).toBe(true)
  })
  })

  test("shell.created becomes {sessionID, id, kind, command ≤ 200, status, at, background}", () => {
    const out = compactActivity({ type: "shell.created", data: { info } })
    expect(out.data).toEqual({ sessionID: "ses_1", id: "sh_1", kind: "shell", command: expect.any(String), status: "running", at: 1000, background: true })
    expect(out.data.command.length).toBe(200)
    expect(JSON.stringify(out)).not.toContain("/tmp/f")
  })

  test("exits carry status and exit code; the session comes from the lookup; output is dropped", () => {
    const sessionOf = (id: string) => (id === "sh_1" || id === "pty_1" ? "ses_1" : undefined)
    expect(compactActivity({ type: "shell.exited", data: { id: "sh_1", status: "exited", exit: 2 } }, sessionOf, 5000).data).toEqual({ sessionID: "ses_1", id: "sh_1", kind: "shell", status: "exited", exit: 2, at: 5000 })
    expect(compactActivity({ type: "shell.deleted", data: { id: "sh_1" } }, sessionOf).data).toEqual({ sessionID: "ses_1", id: "sh_1", kind: "shell" })
    const ended = compactActivity({ type: "session.shell.ended", data: { sessionID: "ses_1", shell: { ...info, status: "killed", time: { started: 1, completed: 7 } }, output: { output: "SECRET" } } })
    expect(ended.data).toEqual({ sessionID: "ses_1", id: "sh_1", kind: "shell", status: "killed", at: 7 })
    expect(compactActivity({ type: "pty.exited", data: { id: "pty_1", exitCode: 0 } }, sessionOf, 9).data).toEqual({ sessionID: "ses_1", id: "pty_1", kind: "pty", status: "exited", exit: 0, at: 9 })
    expect(compactActivity({ type: "pty.created", data: { info: { id: "pty_1", title: "t", command: "htop", args: ["-d", "5"], cwd: "/", status: "running", pid: 1, sessionID: "ses_1" } } }, undefined, 3).data).toEqual({ sessionID: "ses_1", id: "pty_1", kind: "pty", command: "htop -d 5", status: "running", at: 3 })
  })

  test("job events without a known session are dropped", () => {
    expect(compactActivity({ type: "shell.exited", data: { id: "nope", status: "exited" } }, () => undefined)).toBeUndefined()
    expect(compactActivity({ type: "pty.created", data: { info: { id: "p", command: "sh", args: [], status: "running" } } })).toBeUndefined()
  })

  test("status, job and seed events pass the spoke-message check", () => {
    const ev = (type: string) => JSON.stringify({ t: "event", event: { type, data: { sessionID: "ses_1" } } })
    for (const t of ["session.status", "shell.created", "shell.exited", "shell.deleted", "session.shell.started", "session.shell.ended", "pty.created", "pty.updated", "pty.exited", "pty.deleted", "session.seed"]) expect(parseSpokeMessage(ev(t))).toBeDefined()
  })
})

// The hello and welcome checks of the v1 parsers deployed before harness fields existed (frozen copies): new
// frames must still pass them, so a new spoke can talk to an old hub and an old spoke to a new hub.
const oldHubAcceptsHello = (m: any) =>
  typeof m.v === "number" &&
  typeof m.processID === "string" && m.processID.length > 0 &&
  (m.kind === "service" || m.kind === "standalone") &&
  typeof m.directory === "string" &&
  typeof m.pid === "number" &&
  (m.mode === "always" || m.mode === "session") &&
  typeof m.opencodeVersion === "string" &&
  typeof m.pluginVersion === "string" &&
  (m.features === undefined || (Array.isArray(m.features) && m.features.length <= 64 && m.features.every((f: unknown) => typeof f === "string" && f.length > 0 && f.length <= 64)))
const oldSpokeAcceptsWelcome = (m: any) => typeof m.v === "number" && typeof m.machineID === "string" && m.machineID.length > 0 && typeof m.publicURL === "string"

describe("harness-neutral hello", () => {
  const newHello = { ...hello, harness: "opencode", harnessVersion: "2.0.25", evidence: "native", features: [...SPOKE_FEATURES] }

  test("an old hello (no harness) is an OpenCode spoke with native evidence and the implied v1 features", () => {
    const parsed = parseSpokeMessage(j(hello)) as any
    expect(parsed).toBeDefined()
    expect(helloHarness(parsed)).toEqual({ harness: "opencode", harnessVersion: "2.0.25", evidence: "native" })
    const features = spokeFeatures(parsed)
    for (const feature of IMPLIED_OPENCODE_FEATURES) expect(features.has(feature)).toBe(true)
    // autoName was always announced explicitly; an old spoke that did not announce it does not get it.
    expect(features.has("autoName")).toBe(false)
    expect(spokeFeatures({ ...parsed, features: ["autoName"] }).has("autoName")).toBe(true)
  })

  test("a new hello with harness, harnessVersion and evidence parses and keeps its declared values", () => {
    const parsed = parseSpokeMessage(j(newHello)) as any
    expect(parsed).toMatchObject({ harness: "opencode", harnessVersion: "2.0.25", evidence: "native" })
    expect(helloHarness(parsed)).toEqual({ harness: "opencode", harnessVersion: "2.0.25", evidence: "native" })
    const claude = { ...hello, harness: "claude-code", harnessVersion: "1.2.3", evidence: "hooks", features: ["timeline"] }
    const parsedClaude = parseSpokeMessage(j(claude)) as any
    expect(helloHarness(parsedClaude)).toEqual({ harness: "claude-code", harnessVersion: "1.2.3", evidence: "hooks" })
    // A declared harness gets only what it announces: no implied OpenCode features.
    expect([...spokeFeatures(parsedClaude)]).toEqual(["timeline"])
  })

  test("a harness that declares no evidence level is unknown, never assumed native", () => {
    const parsed = parseSpokeMessage(j({ ...hello, harness: "codex", harnessVersion: "0.9" })) as any
    expect(helloHarness(parsed)).toEqual({ harness: "codex", harnessVersion: "0.9", evidence: "unknown" })
  })

  test("validates harness, harnessVersion and evidence", () => {
    const bad = (extra: Record<string, unknown>) => parseSpokeMessage(j({ ...hello, ...extra }))
    expect(bad({ harness: "" })).toBeUndefined()
    expect(bad({ harness: 5 })).toBeUndefined()
    expect(bad({ harness: "x".repeat(65) })).toBeUndefined()
    expect(bad({ harness: "Open Code" })).toBeUndefined()
    expect(bad({ harnessVersion: 2 })).toBeUndefined()
    expect(bad({ harnessVersion: "x".repeat(101) })).toBeUndefined()
    expect(bad({ evidence: "" })).toBeUndefined()
    expect(bad({ evidence: "x".repeat(33) })).toBeUndefined()
    expect(bad({ evidence: ["native"] })).toBeUndefined()
    // An evidence level this hub does not know yet still parses (it counts as unknown), so a newer spoke connects.
    const future = parseSpokeMessage(j({ ...hello, harness: "x", evidence: "telepathy" })) as any
    expect(future).toBeDefined()
    expect(helloHarness(future).evidence).toBe("unknown")
    for (const level of EVIDENCE_LEVELS) expect(bad({ harness: "x", evidence: level })).toBeDefined()
  })

  test("a new hello still passes the old hub's parser (it keeps opencodeVersion)", () => {
    expect(oldHubAcceptsHello(newHello)).toBe(true)
    expect(oldHubAcceptsHello(JSON.parse(encode(parseSpokeMessage(j(newHello))!)))).toBe(true)
  })

  test("the OpenCode spoke announces every implied feature and autoName explicitly", () => {
    expect(SPOKE_FEATURES).toEqual(expect.arrayContaining([...IMPLIED_OPENCODE_FEATURES, "autoName"]))
    expect(SPOKE_FEATURES.length).toBeLessThanOrEqual(64)
  })

  test("core ops map to themselves (OpenCode spokes imply them); optional ops map to the feature that serves them", () => {
    for (const op of ["turn", "steer", "interrupt", "stop", "permission", "form"] as const) expect(featureForOp(op)).toBe(op)
    expect(featureForOp("timeline")).toBe("timeline")
    expect(featureForOp("setModelPrefs")).toBe("modelPrefs")
    expect(featureForOp("autoName")).toBe("autoName")
    expect(featureForOp("create")).toBe("create")
  })
})

describe("welcome features", () => {
  const welcome = { t: "welcome", v: PROTOCOL_VERSION, machineID: "m_1", publicURL: "https://hub.example" }

  test("a welcome may list the hub's features; an old welcome without them still parses", () => {
    expect(parseServerMessage(j(welcome))).toEqual(welcome as any)
    expect(parseServerMessage(j({ ...welcome, features: ["harness"] }))).toMatchObject({ features: ["harness"] })
    expect(parseServerMessage(j({ ...welcome, features: [] }))).toBeDefined()
  })

  test("rejects malformed welcome features", () => {
    expect(parseServerMessage(j({ ...welcome, features: "harness" }))).toBeUndefined()
    expect(parseServerMessage(j({ ...welcome, features: [1] }))).toBeUndefined()
    expect(parseServerMessage(j({ ...welcome, features: [""] }))).toBeUndefined()
    expect(parseServerMessage(j({ ...welcome, features: ["x".repeat(65)] }))).toBeUndefined()
    expect(parseServerMessage(j({ ...welcome, features: Array(65).fill("x") }))).toBeUndefined()
  })

  test("HUB_FEATURES is a valid welcome list and an old spoke still accepts the welcome", () => {
    expect(HUB_FEATURES).toContain("harness")
    const frame = { ...welcome, features: [...HUB_FEATURES] }
    expect(parseServerMessage(j(frame))).toEqual(frame as any)
    expect(oldSpokeAcceptsWelcome(frame)).toBe(true)
  })
})

describe("sessionTokens op", () => {
  const entry = (sessionID: string, extra: Record<string, unknown> = {}) => ({ sessionID, token: `hst.${sessionID}.sig`, exp: 1_793_000_000_000, ...extra })
  const frame = (req: Record<string, unknown>) => j({ t: "req", id: "r1", req: { op: "sessionTokens", ...req } })
  const parses = (req: Record<string, unknown>) => parseServerMessage(frame(req)) !== undefined

  test("accepts tokens for sessions, with or without the hub URL", () => {
    const req = { op: "sessionTokens", tokens: [entry("ses_a"), entry("ses_b")], hubURL: "https://hub.example.com/" }
    expect(parseServerMessage(j({ t: "req", id: "r1", req }))).toEqual({ t: "req", id: "r1", req } as any)
    expect(parses({ tokens: [entry("ses_a")] })).toBe(true)
    expect(parses({ tokens: [entry("ses_a")], hubURL: "http://127.0.0.1:4317" })).toBe(true)
    expect(parses({ tokens: [] })).toBe(true)
  })

  test("rejects malformed token lists and entries", () => {
    expect(parses({})).toBe(false)
    expect(parses({ tokens: "x" })).toBe(false)
    expect(parses({ tokens: [null] })).toBe(false)
    expect(parses({ tokens: [entry("")] })).toBe(false)
    expect(parses({ tokens: [entry("s".repeat(301))] })).toBe(false)
    expect(parses({ tokens: [entry("s".repeat(300))] })).toBe(true)
    expect(parses({ tokens: [{ sessionID: "ses_a", exp: 1 }] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { token: "" })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { token: "has space" })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { token: "tab\there" })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { token: "new\nline" })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { token: "non-ascii-é" })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { token: "x".repeat(4097) })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { token: "x".repeat(4096) })] })).toBe(true)
    expect(parses({ tokens: [entry("ses_a", { exp: "1" })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { exp: undefined })] })).toBe(false)
    expect(parses({ tokens: [entry("ses_a", { sessionID: 5 })] })).toBe(false)
  })

  test("at most SESSION_TOKENS_MAX tokens per frame", () => {
    expect(protocol.SESSION_TOKENS_MAX).toBe(500)
    const many = (n: number) => Array.from({ length: n }, (_, i) => entry(`ses_${i}`))
    expect(parses({ tokens: many(500) })).toBe(true)
    expect(parses({ tokens: many(501) })).toBe(false)
  })

  test("hubURL must be an http(s) URL of at most 2048 characters", () => {
    const tokens = [entry("ses_a")]
    expect(parses({ tokens, hubURL: "ftp://hub.example" })).toBe(false)
    expect(parses({ tokens, hubURL: "javascript:alert(1)" })).toBe(false)
    expect(parses({ tokens, hubURL: "not a url" })).toBe(false)
    expect(parses({ tokens, hubURL: "" })).toBe(false)
    expect(parses({ tokens, hubURL: 5 })).toBe(false)
    const base = "https://hub.example/"
    expect(parses({ tokens, hubURL: base + "p".repeat(2048 - base.length) })).toBe(true)
    expect(parses({ tokens, hubURL: base + "p".repeat(2049 - base.length) })).toBe(false)
  })

  test("sessionTokens is a spoke feature that must be announced: old OpenCode spokes do not imply it", () => {
    expect(SPOKE_FEATURES as readonly string[]).toContain("sessionTokens")
    expect(IMPLIED_OPENCODE_FEATURES as readonly string[]).not.toContain("sessionTokens")
    expect(featureForOp("sessionTokens" as any)).toBe("sessionTokens" as any)
    expect(spokeFeatures(hello as any).has("sessionTokens")).toBe(false)
    expect(spokeFeatures({ ...hello, harness: "opencode", features: [...SPOKE_FEATURES] } as any).has("sessionTokens")).toBe(true)
  })
})

describe("batchSessionTokens", () => {
  const entry = (i: number, tokenChars = 40) => ({ sessionID: `ses_${i}`, token: "t".repeat(tokenChars), exp: 1_793_000_000_000 + i })
  const frameChars = (req: unknown) => encode({ t: "req", id: "x".repeat(64), req } as any).length

  test("nothing to send: no batches", () => {
    expect(protocol.batchSessionTokens([])).toEqual([])
  })

  test("small lists fit one request carrying the hub URL", () => {
    const tokens = [entry(1), entry(2)]
    expect(protocol.batchSessionTokens(tokens, { hubURL: "https://hub.example" })).toEqual([{ op: "sessionTokens", tokens, hubURL: "https://hub.example" }])
    expect(protocol.batchSessionTokens(tokens)).toEqual([{ op: "sessionTokens", tokens }])
  })

  test("splits at SESSION_TOKENS_MAX per request, keeping order", () => {
    const tokens = Array.from({ length: 1201 }, (_, i) => entry(i, 8))
    const batches = protocol.batchSessionTokens(tokens)
    expect(batches.map((b: any) => b.tokens.length)).toEqual([500, 500, 201])
    expect(batches.flatMap((b: any) => b.tokens)).toEqual(tokens)
  })

  test("every batch fits the frame budget (default under MAX_FRAME) and parses on the spoke", () => {
    const tokens = Array.from({ length: 900 }, (_, i) => entry(i, 4096))
    const hubURL = "https://hub.example/" + "p".repeat(1500)
    const batches = protocol.batchSessionTokens(tokens, { hubURL })
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flatMap((b: any) => b.tokens)).toEqual(tokens)
    for (const req of batches) {
      expect(frameChars(req)).toBeLessThanOrEqual(MAX_FRAME)
      expect(parseServerMessage(encode({ t: "req", id: "x".repeat(64), req } as any))).toBeDefined()
    }
    const small = protocol.batchSessionTokens(tokens.slice(0, 10), { maxChars: 10_000 })
    for (const req of small) expect(JSON.stringify(req).length).toBeLessThanOrEqual(10_000)
    expect(small.length).toBeGreaterThan(1)
  })

  test("a token that exactly fills the budget gets a request of its own, never an empty one", () => {
    const one = [entry(1, 100)]
    const exact = JSON.stringify({ op: "sessionTokens", tokens: one }).length
    expect(protocol.batchSessionTokens(one, { maxChars: exact })).toEqual([{ op: "sessionTokens", tokens: one }])
    const two = [entry(1, 100), entry(2, 100)]
    const both = JSON.stringify({ op: "sessionTokens", tokens: two }).length
    expect(protocol.batchSessionTokens(two, { maxChars: both }).map((b: any) => b.tokens.length)).toEqual([2])
    expect(protocol.batchSessionTokens(two, { maxChars: both - 1 }).map((b: any) => b.tokens.length)).toEqual([1, 1])
  })

  test("a budget too small for a single token is an error, not a dropped token", () => {
    expect(() => protocol.batchSessionTokens([entry(1, 4096)], { maxChars: 1000 })).toThrow(RangeError)
  })
})
