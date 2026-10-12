// Conversation mode: splitting agent replies into sentences for per-sentence TTS.
import { describe, expect, test } from "bun:test"
import { splitSentences } from "../web/conversation-core.js"

describe("splitSentences", () => {
  test("plain sentences", () => {
    expect(splitSentences("Hello there. How are you? Great!")).toEqual(["Hello there.", "How are you?", "Great!"])
  })

  test("abbreviations, decimals and file names do not end a sentence", () => {
    expect(splitSentences("Use e.g. the app.js file. Then run it.")).toEqual(["Use e.g. the app.js file.", "Then run it."])
    expect(splitSentences("It took 3.5 seconds, i.e. Fast enough. Done now.")).toEqual(["It took 3.5 seconds, i.e. Fast enough.", "Done now."])
    expect(splitSentences("Ask Dr. Smith and Mr. Jones about it. They know.")).toEqual(["Ask Dr. Smith and Mr. Jones about it.", "They know."])
    expect(splitSentences("I edited web/app.js. It works with v1.2.3 now.")).toEqual(["I edited web/app.js.", "It works with v1.2.3 now."])
  })

  test("a period followed by lowercase is not a boundary; ? and ! are", () => {
    expect(splitSentences("Check the docs. then retry later. Okay?  yes it is.")).toEqual(["Check the docs. then retry later.", "Okay?", "yes it is."])
  })

  test("closing quotes and parentheses stay with their sentence", () => {
    expect(splitSentences('He said "stop." Then he left. (It was late.) Fine.')).toEqual(['He said "stop."', "Then he left.", "(It was late.)", "Fine."])
  })

  test("list items and lines are separate sentences; numbering stays attached", () => {
    expect(splitSentences("Here are the steps:\n1. Install the deps.\n2. Run the tests.\n- Lint everything\n\nThat is all.")).toEqual([
      "Here are the steps:",
      "1. Install the deps.",
      "2. Run the tests.",
      "- Lint everything",
      "That is all.",
    ])
  })

  test("fenced code blocks are not split or read", () => {
    expect(splitSentences("Run this command:\n```sh\nnpm test. bun test.\n```\nThen tell me what happened.")).toEqual([
      "Run this command:",
      "(code omitted)",
      "Then tell me what happened.",
    ])
  })

  test("tiny fragments merge into the next sentence", () => {
    expect(splitSentences("OK. I will start the tests now.")).toEqual(["OK. I will start the tests now."])
    expect(splitSentences("Sure thing. I will start now.")).toEqual(["Sure thing.", "I will start now."])
  })

  test("over-long sentences are cut at a comma or space", () => {
    const long = `${"word ".repeat(40)}and, ${"more ".repeat(40)}end.`
    const parts = splitSentences(long, { maxChars: 220 })
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(220)
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " ").trim())
  })

  test("empty and whitespace input", () => {
    expect(splitSentences("")).toEqual([])
    expect(splitSentences("   \n  ")).toEqual([])
    expect(splitSentences("no punctuation at all")).toEqual(["no punctuation at all"])
  })
})
