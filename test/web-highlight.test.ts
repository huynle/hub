// Code highlighting (web/src/lib/highlight.ts): a small tokenizer for the languages agents write most.
import { describe, expect, test } from "bun:test"
import { highlight, languageOf, type Token } from "../web/src/lib/highlight"

/** The tokens of a kind, as text. */
const of = (tokens: Token[], kind: Token["kind"]) => tokens.filter((t) => t.kind === kind).map((t) => t.text)

describe("languageOf", () => {
  test("aliases", () => {
    for (const [tag, lang] of [
      ["ts", "ts"],
      ["TypeScript", "ts"],
      ["tsx", "ts"],
      ["jsx", "ts"],
      ["javascript", "ts"],
      ["mjs", "ts"],
      ["json", "json"],
      ["jsonc", "json"],
      ["sh", "bash"],
      ["shell", "bash"],
      ["zsh", "bash"],
      ["console", "bash"],
      ["py", "python"],
      ["golang", "go"],
      ["rs", "rust"],
      ["yml", "yaml"],
      ["patch", "diff"],
      ["postgresql", "sql"],
      ["scss", "css"],
      ["svg", "html"],
      ["xml", "html"],
      ["markdown", "md"],
    ] as const)
      expect(languageOf(tag)).toBe(lang)
    expect(languageOf("")).toBeUndefined()
    expect(languageOf("cobol")).toBeUndefined()
  })
})

describe("highlight", () => {
  const samples: Array<[string, string]> = [
    ["ts", 'const a: number = 1 // one\nfunction f(x) { return `t ${x}` + "s" }\n/* block\ncomment */'],
    ["json", '{"a": 1, "b": [true, null, "x\\"y"]}'],
    ["bash", 'echo "$HOME" # comment\nnpm test --watch=false'],
    ["python", 'def f(x):\n    """doc"""\n    return x + 1  # c'],
    ["go", 'func main() {\n\tfmt.Println("hi", 0x1f)\n}'],
    ["rust", 'fn main() { let s = "x"; println!("{}", s); }'],
    ["yaml", "name: hub # c\nlist:\n  - 'a'\n  - 2"],
    ["diff", "@@ -1,2 +1,2 @@\n-old\n+new\n same"],
    ["sql", "SELECT id FROM users WHERE name = 'x' -- c"],
    ["css", ".a { color: #fff; margin: 0 2px; } /* c */"],
    ["html", '<a href="/x" class=y>t</a><!-- c -->'],
    ["md", "# Title\n- item `code` **b**"],
    ["ts", "unterminated `template ${"],
    ["ts", '"unterminated string'],
    ["ts", "/* unterminated"],
    ["nope", "plain <b> text"],
  ]
  for (const [lang, code] of samples) {
    test(`${lang}: tokens cover the text exactly`, () => {
      const tokens = highlight(code, lang)
      expect(tokens.map((t) => t.text).join("")).toBe(code)
      expect(tokens.every((t) => t.text.length > 0)).toBe(true)
    })
  }

  test("ts: keywords, strings, comments, numbers, functions", () => {
    const t = highlight('const a = 1 // one\nfunction f(x) { return "s" }', "ts")
    expect(of(t, "keyword")).toEqual(["const", "function", "return"])
    expect(of(t, "string")).toEqual(['"s"'])
    expect(of(t, "comment")).toEqual(["// one"])
    expect(of(t, "number")).toEqual(["1"])
    expect(of(t, "fn")).toEqual(["f"])
  })

  test("ts: a // inside a string is not a comment", () => {
    const t = highlight('fetch("https://x.dev") // go', "ts")
    expect(of(t, "string")).toEqual(['"https://x.dev"'])
    expect(of(t, "comment")).toEqual(["// go"])
  })

  test("json: keys are properties, values strings", () => {
    const t = highlight('{"a": "b", "c": true}', "json")
    expect(of(t, "prop")).toEqual(['"a"', '"c"'])
    expect(of(t, "string")).toEqual(['"b"'])
    expect(of(t, "keyword")).toEqual(["true"])
  })

  test("bash: comments only at a word start", () => {
    const t = highlight("echo a#b # real", "bash")
    expect(of(t, "comment")).toEqual(["# real"])
    expect(of(t, "fn")).toEqual(["echo"])
  })

  test("python: triple-quoted strings span lines", () => {
    expect(of(highlight('x = """a\nb"""', "python"), "string")).toEqual(['"""a\nb"""'])
  })

  test("diff: whole lines added, deleted, hunks", () => {
    const t = highlight("@@ -1 +1 @@\n-old\n+new\n same\n+++ b/x", "diff")
    expect(of(t, "meta")).toEqual(["@@ -1 +1 @@", "+++ b/x"])
    expect(of(t, "del")).toEqual(["-old"])
    expect(of(t, "add")).toEqual(["+new"])
  })

  test("yaml: keys and comments", () => {
    const t = highlight("name: hub # c\nurl: http://x#y", "yaml")
    expect(of(t, "prop")).toEqual(["name", "url"])
    expect(of(t, "comment")).toEqual(["# c"])
  })

  test("sql: keywords in any case", () => {
    expect(of(highlight("select * from t where a = 1", "sql"), "keyword")).toEqual(["select", "from", "where"])
  })

  test("html: tags, attributes, values", () => {
    const t = highlight('<a href="/x">t</a>', "html")
    expect(of(t, "tag")).toEqual(["<a", ">", "</a", ">"])
    expect(of(t, "attr")).toEqual(["href"])
    expect(of(t, "string")).toEqual(['"/x"'])
  })

  test("unknown languages are one plain token", () => {
    expect(highlight("a b", "cobol")).toEqual([{ text: "a b" }])
    expect(highlight("", "ts")).toEqual([])
  })

  test("huge input stays fast", () => {
    // ~100 KB (the console highlights at most 64 KB per block); generous for loaded CI machines.
    const code = 'const x = "a" // c\n'.repeat(5_000)
    const t0 = performance.now()
    const tokens = highlight(code, "ts")
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(tokens.map((t) => t.text).join("")).toBe(code)
  })
})
