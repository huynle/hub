import { describe, expect, test } from "bun:test"
import { speakable } from "../src/speakable"

describe("speakable", () => {
  test("strips inline code, emphasis, and headings", () => {
    expect(speakable("## Result\nThe file `.opencode/opencode.jsonc` is **important** and _local_.")).toBe(
      "Result. The file .opencode/opencode.jsonc is important and local.",
    )
  })

  test("replaces code blocks with a short note", () => {
    expect(speakable("Run this:\n```sh\nbun test\n```\nThen check.")).toBe("Run this: (code omitted) Then check.")
  })

  test("keeps link text and drops bare URLs", () => {
    expect(speakable("See [the docs](https://x.dev/a) or https://x.dev/b for more.")).toBe("See the docs or a link for more.")
  })

  test("turns list items into a sentence flow", () => {
    expect(speakable("Files:\n- server.ts\n- tui.ts\n1. first")).toBe("Files: server.ts. tui.ts. first")
  })

  test("caps long text at a word boundary with an ellipsis", () => {
    expect(speakable("one two three four five six", 14)).toBe("one two three…")
  })
})
