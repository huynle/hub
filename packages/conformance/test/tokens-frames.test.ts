import { describe, expect, test } from "bun:test"
import { MAX_FRAME } from "../../protocol/src/index.ts"
import { frameProblems } from "../src/frames.ts"
import { tokenLeaks } from "../src/tokens.ts"

const tokens = [
  { kind: "machine", value: "hubm_aaaaaaaaaaaaaaaa" },
  { kind: "session", value: "hubs_bbbbbbbbbbbbbbbb" },
  { kind: "act", value: "huba_cccccccccccccccc" },
]

describe("token leaks", () => {
  test("clean output has no leaks", () => {
    expect(tokenLeaks([{ source: "stderr", text: "[fake] started\n" }, { source: "frames", text: '{"t":"hello"}' }], tokens)).toEqual([])
  })

  test("each token kind found in each source is reported, without the token itself", () => {
    const leaks = tokenLeaks(
      [
        { source: "stderr", text: `debug token=${tokens[1]!.value}\n` },
        { source: "stdout", text: `noise ${tokens[0]!.value} and ${tokens[2]!.value}` },
      ],
      tokens,
    )
    expect(leaks).toEqual(["the session token appears in stderr", "the machine token appears in stdout", "the act token appears in stdout"])
    for (const t of tokens) expect(leaks.join()).not.toContain(t.value)
  })

  test("also finds a token JSON-escaped or base64-encoded", () => {
    expect(tokenLeaks([{ source: "events", text: Buffer.from(`Bearer ${tokens[0]!.value}`).toString("base64") }], tokens)).toEqual(["the machine token appears in events (base64)"])
  })
})

describe("frame sizes", () => {
  test("frames within MAX_FRAME pass", () => {
    expect(frameProblems([{ size: 10, t: "hello" }, { size: MAX_FRAME, t: "res" }])).toEqual([])
  })

  test("a frame over MAX_FRAME fails", () => {
    expect(frameProblems([{ size: MAX_FRAME + 1, t: "event" }]).join()).toMatch(/event frame of 1000001 characters.*1000000/)
  })
})
