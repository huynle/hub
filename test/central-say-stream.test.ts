// Speak while it writes: the hub cuts streamed assistant text into sentences as they complete.
import { describe, expect, test } from "bun:test"
import { SentenceStream } from "../src/central/say-stream"

/** Feeds `text` in `size`-character deltas; returns the sentences emitted after each delta, then at the end. */
function stream(text: string, size = 1, full = text) {
  const s = new SentenceStream()
  const steps: string[][] = []
  for (let i = 0; i < text.length; i += size) steps.push(s.push(text.slice(i, i + size)))
  return { live: steps.flat(), ended: s.end(full), steps }
}

describe("SentenceStream", () => {
  test("a sentence is emitted as soon as the next one starts; the last one at the end", () => {
    const s = new SentenceStream()
    expect(s.push("I checked the build.")).toEqual([])
    expect(s.push(" ")).toEqual([])
    expect(s.push("It")).toEqual(["I checked the build."])
    expect(s.push(" passes!")).toEqual([])
    expect(s.end("I checked the build. It passes!")).toEqual(["It passes!"])
  })

  test("character by character gives the same sentences as one piece", () => {
    const text = "First, the tests. Then lint? Yes! All good."
    const one = stream(text, 1)
    expect([...one.live, ...one.ended]).toEqual(["First, the tests.", "Then lint?", "Yes!", "All good."])
    const big = stream(text, 1000)
    expect([...big.live, ...big.ended]).toEqual(["First, the tests.", "Then lint?", "Yes!", "All good."])
  })

  test("abbreviations, decimals, versions, file names and lowercase continuations do not end a sentence", () => {
    const text = "Use e.g. the v1.2.3 build. It costs $3.50 per run. See Dr. Smith about config.ts files. Wait... maybe not. Done."
    const { live, ended } = stream(text, 3)
    expect([...live, ...ended]).toEqual([
      "Use e.g. the v1.2.3 build.",
      "It costs $3.50 per run.",
      "See Dr. Smith about config.ts files.",
      "Wait... maybe not.",
      "Done.",
    ])
  })

  test("a number at the end of the streamed text waits for more (3. could be 3.5)", () => {
    const s = new SentenceStream()
    expect(s.push("It took 3.")).toEqual([])
    expect(s.push("5 seconds. Next")).toEqual(["It took 3.5 seconds."])
  })

  test("lines end sentences: list items and headings are emitted line by line", () => {
    const text = "## Summary\n1. Fixed the parser\n2. Added tests\n- one more thing\n\nThat is all"
    const { live, ended } = stream(text, 4)
    expect(live).toEqual(["## Summary", "1. Fixed the parser", "2. Added tests", "- one more thing"])
    expect(ended).toEqual(["That is all"])
  })

  test("a fenced code block is one piece, emitted only once closed (the speak path omits it)", () => {
    const text = "Here is the fix.\n```ts\nconst a = 1. // not a sentence. Really.\nfoo()\n```\nThat should do it."
    const { live, ended } = stream(text, 2)
    expect(live).toEqual(["Here is the fix.", "```ts\nconst a = 1. // not a sentence. Really.\nfoo()\n```"])
    expect(ended).toEqual(["That should do it."])
  })

  test("an unclosed fence is flushed as is at the end", () => {
    expect(stream("Look:\n```sh\nls -la", 5).ended).toEqual(["```sh\nls -la"])
  })

  test("pieces without words are merged into the next sentence", () => {
    const { live, ended } = stream("---\nNext part. Done.", 2)
    expect([...live, ...ended]).toEqual(["---\nNext part.", "Done."])
  })

  test("a very long run without punctuation is cut near the limit at a comma or space", () => {
    const s = new SentenceStream({ maxChars: 40 })
    const out = s.push("one two three four five six, seven eight nine ten eleven")
    expect(out).toEqual(["one two three four five six,"])
    expect(s.end()).toEqual(["seven eight nine ten eleven"])
  })

  test("the ended text is authoritative: a missed delta is recovered", () => {
    const s = new SentenceStream()
    expect(s.push("Hello there. How")).toEqual(["Hello there."])
    expect(s.end("Hello there. How are you? Fine.")).toEqual(["How are you?", "Fine."])
  })

  test("joining late: the ended text continues after what was already spoken", () => {
    const s = new SentenceStream()
    expect(s.push("second one. Third")).toEqual(["second one."])
    expect(s.end("First one. second one. Third one.")).toEqual(["Third one."])
  })

  test("empty and whitespace-only text emits nothing", () => {
    const s = new SentenceStream()
    expect(s.push("   \n ")).toEqual([])
    expect(s.end("   ")).toEqual([])
  })
})
