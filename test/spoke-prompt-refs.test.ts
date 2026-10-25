// Prompt references (src/spoke/prompt-refs.ts, design §2.4): hub addresses in a prompt get context, never routing.
import { describe, expect, test } from "bun:test"
import { findReferences } from "../src/spoke/prompt-refs"

describe("findReferences", () => {
  test("finds @name, @name.project, @@role and @@role.project", () => {
    expect(findReferences({ text: "ask @api-refactor and @bob.hub, then @@reviewer or @@qa.web" })).toEqual(["@api-refactor", "@bob.hub", "@@reviewer", "@@qa.web"])
  })

  test("each address once, in order of appearance", () => {
    expect(findReferences({ text: "@bob then @@rev then @bob again" })).toEqual(["@bob", "@@rev"])
  })

  test("a sentence-ending dot or comma is not part of the address", () => {
    expect(findReferences({ text: "talk to @bob. Or @@rev, maybe @carl.hub." })).toEqual(["@bob", "@@rev", "@carl.hub"])
  })

  test("no addresses: emails, file paths, uppercase, too short, @me", () => {
    expect(findReferences({ text: "mail huy@example.com, see @src/index.ts and @README.md, @Bob @x @me @me.hub" })).toEqual([])
  })

  test("a file the harness attached for the same @x wins (mention range overlaps)", () => {
    const text = "look at @notes please, and @bob"
    const start = text.indexOf("@notes")
    expect(findReferences({ text, files: [{ uri: "file:///p/notes", mention: { start, end: start + 6, text: "@notes" } }] })).toEqual(["@bob"])
  })

  test("a subagent with the same name wins (agents mention or name)", () => {
    const text = "@explore the code, @general too, and @bob"
    expect(findReferences({ text, agents: [{ name: "explore", mention: { start: 0, end: 8, text: "@explore" } }, { name: "general" }] })).toEqual(["@bob"])
  })

  test("@@role never clashes with a harness mention of the bare name", () => {
    expect(findReferences({ text: "@@explore", agents: [{ name: "explore" }] })).toEqual(["@@explore"])
  })

  test("empty or missing text", () => {
    expect(findReferences({ text: "" })).toEqual([])
    expect(findReferences({} as any)).toEqual([])
  })
})
