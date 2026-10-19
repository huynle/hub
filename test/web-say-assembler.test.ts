// Speak while it writes, phone side: incremental say events (one per sentence, numbered per message text
// part) are played in order, once; barge-in drops the rest of the replies that were speaking.
import { describe, expect, test } from "bun:test"
import { SayAssembler } from "../web/src/core/conversation-core"

const say = (seq: number | undefined, text: string, messageID = "msg_1", ordinal = 0) => ({ messageID, ordinal, seq, text })

describe("SayAssembler", () => {
  test("numbered sentences are released in order and the bubble text accumulates", () => {
    const a = new SayAssembler()
    expect(a.accept(say(0, "First one."))).toEqual({ sentences: ["First one."], text: "First one." })
    expect(a.accept(say(1, "Second one."))).toEqual({ sentences: ["Second one."], text: "First one. Second one." })
  })

  test("out of order: held until the gap is filled; duplicates are dropped", () => {
    const a = new SayAssembler()
    expect(a.accept(say(1, "Two."))).toBeUndefined()
    expect(a.accept(say(0, "One."))).toEqual({ sentences: ["One.", "Two."], text: "One. Two." })
    expect(a.accept(say(0, "One."))).toBeUndefined()
    expect(a.accept(say(1, "Two."))).toBeUndefined()
  })

  test("each text part has its own sequence; another message starts fresh", () => {
    const a = new SayAssembler()
    a.accept(say(0, "Part one."))
    expect(a.accept(say(0, "Part two.", "msg_1", 1))?.sentences).toEqual(["Part two."])
    expect(a.accept(say(0, "New reply.", "msg_2"))?.sentences).toEqual(["New reply."])
  })

  test("a say without seq (subagent result, older hub) is split into sentences as a whole", () => {
    const a = new SayAssembler()
    expect(a.accept(say(undefined, "Done. It works.", "msg_k"))).toEqual({ sentences: ["Done.", "It works."], text: "Done. It works." })
  })

  test("a code block sentence is spoken as '(code omitted)'; the bubble keeps the raw text", () => {
    const a = new SayAssembler()
    expect(a.accept(say(0, "```ts\nfoo()\n```"))).toEqual({ sentences: ["(code omitted)"], text: "```ts\nfoo()\n```" })
  })

  test("barge-in mutes the replies already speaking: their later sentences show but are not spoken", () => {
    const a = new SayAssembler()
    a.accept(say(0, "Long answer."))
    a.mute()
    expect(a.accept(say(1, "More of it."))).toEqual({ sentences: [], text: "Long answer. More of it." })
    expect(a.accept(say(0, "A new reply.", "msg_2"))?.sentences).toEqual(["A new reply."])
  })

  test("remembers a bounded number of messages", () => {
    const a = new SayAssembler({ limit: 2 })
    a.accept(say(0, "A.", "m1"))
    a.accept(say(0, "B.", "m2"))
    a.accept(say(0, "C.", "m3"))
    expect(a.size).toBe(2)
  })
})
