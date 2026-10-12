import { describe, expect, test } from "bun:test"
import { extractReply } from "../src/reply"

// Shapes copied from a real session.context response (OpenCode 2.0.25).
const messages = [
  { id: "msg_1", type: "synthetic", text: "voice link" },
  { id: "msg_2", type: "assistant", content: [{ type: "text", text: "old answer" }], finish: "stop" },
  { id: "msg_3", type: "idle" },
  { id: "msg_4", type: "user", text: "what changed?" },
  {
    id: "msg_5",
    type: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "Let me check." },
      { type: "tool", text: "" },
    ],
    finish: "tool-calls",
  },
  { id: "msg_6", type: "assistant", content: [{ type: "text", text: "Two files " }, { type: "text", text: "changed." }], finish: "stop" },
  { id: "msg_7", type: "idle" },
]

describe("extractReply", () => {
  test("returns the text of the last assistant message after the prompt", () => {
    expect(extractReply(messages, "msg_4")).toBe("Two files changed.")
  })

  test("falls back to earlier assistant text when the last message has none", () => {
    const toolOnly = [...messages.slice(0, 5), { id: "msg_6", type: "assistant", content: [{ type: "tool" }], finish: "stop" }]
    expect(extractReply(toolOnly, "msg_4")).toBe("Let me check.")
  })

  test("returns an empty string when the prompt is not found", () => {
    expect(extractReply(messages, "msg_missing")).toBe("")
  })

  test("ignores reasoning text", () => {
    const reasoningOnly = [messages[3]!, { id: "msg_5", type: "assistant", content: [{ type: "reasoning", text: "hmm" }] }]
    expect(extractReply(reasoningOnly, "msg_4")).toBe("")
  })
})
