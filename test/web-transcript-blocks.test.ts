// Transcript layout (web/src/lib/transcript.ts), markdown (web/src/lib/markdown.ts) and patch parsing
// (web/src/lib/diff.ts) for the session view.
import { describe, expect, test } from "bun:test"
import { retryView, thoughtView, transcriptBlocks } from "../web/src/lib/transcript"
import { Timeline } from "../web/src/core/timeline-core"
import { parseInline, parseMarkdown, safeHref } from "../web/src/lib/markdown"
import { parsePatch } from "../web/src/lib/diff"

describe("transcriptBlocks", () => {
  test("user pills, assistant text, thoughts with duration, and consecutive tools folded into one group", () => {
    const blocks = transcriptBlocks([
      { key: "u1", kind: "user", text: "fix it", at: 1 },
      { key: "r1", kind: "reasoning", text: "hmm", state: "done", at: 1000, completed: 13_400 },
      { key: "t1", kind: "tool", name: "read", state: "done", at: 2 },
      { key: "t2", kind: "tool", name: "bash", state: "failed", at: 3 },
      { key: "t3", kind: "tool", name: "edit", state: "running", at: 4 },
      { key: "a1", kind: "assistant", text: "Done.", at: 5 },
      { key: "t4", kind: "tool", name: "bash", state: "done", at: 6 },
    ])
    expect(blocks.map((b) => b.type)).toEqual(["user", "thought", "tools", "assistant", "tools"])
    expect(blocks[1]).toMatchObject({ type: "thought", seconds: 12, running: false })
    expect(blocks[2]).toMatchObject({ type: "tools", failed: 1, running: 1 })
    expect(blocks[2]!.type === "tools" && blocks[2]!.items.map((i) => i.key)).toEqual(["t1", "t2", "t3"])
  })

  test("subagent rows link to the child session; its own nested rows stay out of the transcript", () => {
    const blocks = transcriptBlocks([
      { key: "sub:kid", kind: "subagent", label: "Fix tests", state: "working", sessionID: "kid", depth: 0 },
      { key: "k1", kind: "tool", name: "read", state: "done", sessionID: "kid", depth: 1 },
      { key: "a1", kind: "assistant", text: "ok", depth: 0 },
    ])
    expect(blocks).toEqual([
      { type: "subagent", key: "sub:kid", sessionID: "kid", label: "Fix tests", state: "working" },
      { type: "assistant", key: "a1", text: "ok", live: false },
    ])
  })

  test("running thought without timing; empty assistant text is skipped", () => {
    const blocks = transcriptBlocks([
      { key: "r", kind: "reasoning", state: "running", text: "" },
      { key: "a", kind: "assistant", text: "" },
    ])
    expect(blocks).toEqual([{ type: "thought", key: "r", text: "", running: true }])
  })
})

describe("transcriptBlocks: failed and retried turns", () => {
  const rows = [
    { key: "u1", kind: "user", text: "go", pos: 1 },
    { key: "m1:retry:1", kind: "retry", messageID: "m1", text: "Rate limited", errorType: "provider.rate-limit", errorStatus: 429, attempt: 3, next: 1_250_000, pos: 2 },
    { key: "m1:error", kind: "error", messageID: "m1", text: "You exceeded your current quota", errorType: "provider.quota", errorStatus: 429, pos: 3 },
  ]
  test("error rows: label, message and HTTP status; retry rows keep attempt, reason and next time", () => {
    const blocks = transcriptBlocks(rows)
    expect(blocks.map((b) => b.type)).toEqual(["user", "retry", "error"])
    expect(blocks[2]).toEqual({ type: "error", key: "m1:error", label: "Quota exceeded", message: "You exceeded your current quota", status: "HTTP 429" })
    expect(blocks[1]).toMatchObject({ type: "retry", key: "m1:retry:1", attempt: 3, next: 1_250_000, errorType: "provider.rate-limit", message: "Rate limited" })
  })
  test("an error without a known type shows its message; one without text still shows", () => {
    expect(transcriptBlocks([{ key: "e", kind: "error", text: "Boom" }])).toEqual([{ type: "error", key: "e", label: "Boom" }])
    expect(transcriptBlocks([{ key: "e", kind: "error" }])).toEqual([{ type: "error", key: "e", label: "Error" }])
  })
  test("retryView: a live countdown that disappears once the time is past", () => {
    const [retry] = transcriptBlocks([rows[1]!])
    if (retry?.type !== "retry") throw new Error("not a retry block")
    expect(retryView(retry, 1_000_000)).toEqual({ text: "Retrying (attempt 3) · next in 4m 10s: Rate limited", waiting: true })
    expect(retryView(retry, 1_300_000)).toEqual({ text: "Retrying (attempt 3): Rate limited", waiting: false })
  })
})

describe("transcriptBlocks: attachments", () => {
  test("history images get lazy URLs; other files become named chips; image-only messages still show", () => {
    const blocks = transcriptBlocks([
      { key: "u1:text", kind: "user", text: "what is this?", sessionID: "ses 1", messageID: "msg/1", files: [
        { index: 0, mime: "image/png", name: "shot.png" },
        { index: 1, mime: "text/plain", name: "notes.txt" },
        { index: 2, mime: "image/svg+xml", name: "logo.svg" },
      ] },
      { key: "u2:text", kind: "user", text: "", sessionID: "s", messageID: "m2", files: [{ index: 0, mime: "image/jpeg" }] },
      { key: "u3:text", kind: "user", text: "", sessionID: "s", messageID: "m3" },
    ])
    expect(blocks).toEqual([
      { type: "user", key: "u1:text", text: "what is this?", images: [
        { key: "u1:text:0", name: "shot.png", mime: "image/png", src: "/api/sessions/ses%201/timeline/messages/msg%2F1/files/0" },
        { key: "u1:text:1", name: "notes.txt", mime: "text/plain" },
        { key: "u1:text:2", name: "logo.svg", mime: "image/svg+xml" },
      ] },
      { type: "user", key: "u2:text", text: "", images: [{ key: "u2:text:0", name: "image", mime: "image/jpeg", src: "/api/sessions/s/timeline/messages/m2/files/0" }] },
    ])
  })

  test("a message just sent shows its local previews", () => {
    const blocks = transcriptBlocks([{ key: "local:1", kind: "user", text: "", images: [{ name: "a.jpg", mime: "image/jpeg", preview: "blob:x" }] }])
    expect(blocks).toEqual([{ type: "user", key: "local:1", text: "", images: [{ key: "local:1:0", name: "a.jpg", mime: "image/jpeg", src: "blob:x" }] }])
  })
})

describe("markdown", () => {
  test("paragraphs, headings, lists, fenced code, quotes and rules", () => {
    const blocks = parseMarkdown("# Title\n\nSome *text* here.\nsame para\n\n- one\n- two\n\n1. first\n2. second\n\n```ts\nconst x = 1\n```\n> quoted\n\n---")
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "code", "quote", "rule"])
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 })
    expect(blocks[2]).toMatchObject({ type: "list", ordered: false })
    expect(blocks[3]).toMatchObject({ type: "list", ordered: true, start: 1 })
    expect(blocks[4]).toEqual({ type: "code", lang: "ts", text: "const x = 1" })
  })

  test("an unterminated fence (still streaming) is still code", () => {
    expect(parseMarkdown("```\npartial")).toEqual([{ type: "code", lang: "", text: "partial" }])
  })

  test("inline code, bold, italic and links; unsafe links become text", () => {
    expect(parseInline("a `b` **c** _d_ [e](https://x.dev) [f](javascript:alert(1))")).toEqual([
      { type: "text", text: "a " },
      { type: "code", text: "b" },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "d" }] },
      { type: "text", text: " " },
      { type: "link", href: "https://x.dev", children: [{ type: "text", text: "e" }] },
      { type: "text", text: " " },
      { type: "text", text: "f" },
    ])
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c")
    expect(safeHref("data:text/html,x")).toBeUndefined()
  })

  test("safeHref keeps http(s), mailto and same-site paths", () => {
    expect(safeHref("https://x.dev/a?b=c#d")).toBe("https://x.dev/a?b=c#d")
    expect(safeHref("HTTP://x.dev")).toBe("HTTP://x.dev")
    expect(safeHref("  /s/ses_1  ")).toBe("/s/ses_1")
    expect(safeHref("/settings?tab=speech")).toBe("/settings?tab=speech")
  })

  test("safeHref rejects links a browser would resolve off-site or run as script", () => {
    for (const href of [
      "//evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "\\\\evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/ /evil.com",
      "/\u0000/evil.com",
      "/\u007f/evil.com",
      "/\u00a0/evil.com",
      "https://evil.com\\@good.com",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "vbscript:x",
      "data:text/html,x",
      "DATA:text/html,x",
      "evil.com",
      "",
    ]) {
      expect(safeHref(href)).toBeUndefined()
    }
  })
})

describe("parsePatch", () => {
  test("numbers old and new lines across hunks", () => {
    const lines = parsePatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n same\n@@ -10,1 +10,2 @@\n ctx\n+added")
    expect(lines.filter((l) => l.type !== "meta").map((l) => [l.type, l.oldNo, l.newNo, l.text])).toEqual([
      ["hunk", undefined, undefined, "@@ -1,3 +1,3 @@"],
      ["context", 1, 1, "keep"],
      ["del", 2, undefined, "old"],
      ["add", undefined, 2, "new"],
      ["context", 3, 3, "same"],
      ["hunk", undefined, undefined, "@@ -10,1 +10,2 @@"],
      ["context", 10, 10, "ctx"],
      ["add", undefined, 11, "added"],
    ])
  })
})

describe("thoughtView", () => {
  const thought = (extra: Partial<{ text: string; running: boolean; seconds: number }>) => ({ type: "thought" as const, key: "m:0", text: "", running: false, ...extra })

  test("a finished thought with text expands to that text", () => {
    expect(thoughtView(thought({ text: "Read the test first.", seconds: 12 }))).toEqual({ label: "Thought for 12s", body: "Read the test first.", muted: false })
  })

  test("no readable text (encrypted reasoning only): still expandable, with an explanation", () => {
    const view = thoughtView(thought({ seconds: 3 }))
    expect(view.label).toBe("Thought for 3s")
    expect(view.body).toBe("The model didn't share its reasoning text (only an encrypted summary).")
    expect(view.muted).toBe(true)
  })

  test("running: streamed text so far, or a waiting note", () => {
    expect(thoughtView(thought({ running: true, text: "Look at " }))).toEqual({ label: "Thinking…", body: "Look at ", muted: false })
    expect(thoughtView(thought({ running: true }))).toMatchObject({ label: "Thinking…", muted: true })
  })

  test("live deltas end up as an expandable thought block", () => {
    const timeline = new Timeline()
    timeline.appendReasoning({ sessionID: "s", messageID: "m1", delta: "Check the picker.", at: 1000 })
    timeline.endReasoning("s", 5000)
    const [block] = transcriptBlocks(timeline.rows())
    expect(block).toMatchObject({ type: "thought", text: "Check the picker.", running: false, seconds: 4 })
    expect(thoughtView(block as never).body).toBe("Check the picker.")
  })
})
