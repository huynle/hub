// Markdown parser (web/src/lib/markdown.ts): input → node tree, written as compact outlines (structural, not HTML).
// ["p", ...inline] · ["h2", ...] · ["pre", lang, text] · ["ul" | "ol" | "ol:3", "loose"?, ["li", "[x]"?, ...blocks]] ·
// ["quote", ...blocks] · ["table", "left,center,-", ["tr", ["th", ...]], ["tr", ["td", ...]]] · ["hr"].
// Inline: "text" · ["br"] · ["code", text] · ["strong" | "em" | "del" | "mark", ...] · ["a", href, ...] · ["img", alt, href | null].
import { describe, expect, test } from "bun:test"
import { parseInline, parseMarkdown, safeHref, type Inline, type MdBlock } from "../web/src/lib/markdown"

const o = (nodes: Inline[]): unknown[] =>
  nodes.map((n) => {
    switch (n.type) {
      case "text":
        return n.text
      case "br":
        return ["br"]
      case "code":
        return ["code", n.text]
      case "link":
        return ["a", n.href, ...o(n.children)]
      case "image":
        return ["img", n.alt, n.href ?? null]
      default:
        return [n.type, ...o(n.children)]
    }
  })

const tree = (blocks: MdBlock[]): unknown[] =>
  blocks.map((b) => {
    switch (b.type) {
      case "paragraph":
        return ["p", ...o(b.children)]
      case "heading":
        return [`h${b.level}`, ...o(b.children)]
      case "code":
        return ["pre", b.lang, b.text]
      case "rule":
        return ["hr"]
      case "quote":
        return ["quote", ...tree(b.blocks)]
      case "list":
        return [
          b.ordered ? (b.start === 1 ? "ol" : `ol:${b.start}`) : "ul",
          ...(b.loose ? ["loose"] : []),
          ...b.items.map((i) => ["li", ...(i.checked === undefined ? [] : [i.checked ? "[x]" : "[ ]"]), ...tree(i.blocks)]),
        ]
      case "table":
        return ["table", b.align.map((a) => a ?? "-").join(","), ["tr", ...b.head.map((c) => ["th", ...o(c)])], ...b.rows.map((r) => ["tr", ...r.map((c) => ["td", ...o(c)])])]
    }
  })

const md = (source: string, streaming = false) => tree(parseMarkdown(source, { streaming }))
const inline = (source: string) => o(parseInline(source))

describe("markdown blocks", () => {
  const cases: Array<[string, string, unknown[]]> = [
    ["paragraphs; single newlines are line breaks", "a\nb\n\nc", [["p", "a", ["br"], "b"], ["p", "c"]]],
    ["two trailing spaces break a line", "a  \nb", [["p", "a", ["br"], "b"]]],
    ["a trailing backslash breaks a line", "a\\\nb", [["p", "a", ["br"], "b"]]],
    ["ATX headings", "# T\n## U ##", [["h1", "T"], ["h2", "U"]]],
    ["setext headings", "Title\n=====\n\nSub\n---", [["h1", "Title"], ["h2", "Sub"]]],
    ["a rule between paragraphs", "a\n\n---\n\nb", [["p", "a"], ["hr"], ["p", "b"]]],
    ["tight bullet list", "- a\n- b", [["ul", ["li", ["p", "a"]], ["li", ["p", "b"]]]]],
    ["ordered list keeps its start", "3. a\n4. b", [["ol:3", ["li", ["p", "a"]], ["li", ["p", "b"]]]]],
    [
      "nested lists, mixed ordered and unordered",
      "1. one\n   - a\n   - b\n2. two\n  1. deep",
      [["ol", ["li", ["p", "one"], ["ul", ["li", ["p", "a"]], ["li", ["p", "b"]]]], ["li", ["p", "two"], ["ol", ["li", ["p", "deep"]]]]]],
    ],
    [
      "three levels with two-space indents",
      "- a\n  - b\n    - c\n- d",
      [["ul", ["li", ["p", "a"], ["ul", ["li", ["p", "b"], ["ul", ["li", ["p", "c"]]]]]], ["li", ["p", "d"]]]],
    ],
    [
      "task lists",
      "- [ ] todo\n- [x] done\n- [X] Done too",
      [["ul", ["li", "[ ]", ["p", "todo"]], ["li", "[x]", ["p", "done"]], ["li", "[x]", ["p", "Done too"]]]],
    ],
    [
      "multi-paragraph items make a loose list",
      "1. First\n\n   More about first.\n\n2. Second",
      [["ol", "loose", ["li", ["p", "First"], ["p", "More about first."]], ["li", ["p", "Second"]]]],
    ],
    ["a nested list's blank lines do not loosen the outer list", "- a\n  - b\n\n  - c\n- d", [["ul", ["li", ["p", "a"], ["ul", "loose", ["li", ["p", "b"]], ["li", ["p", "c"]]]], ["li", ["p", "d"]]]]],
    ["lazy continuation lines stay in the item", "- a\nstill a\n- b", [["ul", ["li", ["p", "a", ["br"], "still a"]], ["li", ["p", "b"]]]]],
    [
      "fenced code inside a list item",
      "- run:\n  ```sh\n  npm test\n  ```\n- done",
      [["ul", ["li", ["p", "run:"], ["pre", "sh", "npm test"]], ["li", ["p", "done"]]]],
    ],
    ["a list starting at 1 interrupts a paragraph", "Steps:\n1. a\n2. b", [["p", "Steps:"], ["ol", ["li", ["p", "a"]], ["li", ["p", "b"]]]]],
    ["a number mid-paragraph is not a list", "In\n2024. was", [["p", "In", ["br"], "2024. was"]]],
    ["different bullets start a new list", "- a\n* b", [["ul", ["li", ["p", "a"]]], ["ul", ["li", ["p", "b"]]]]],
    [
      "blocks inside a quote",
      "> # Note\n> - a\n> - b\n>\n> ```js\n> x()\n> ```",
      [["quote", ["h1", "Note"], ["ul", ["li", ["p", "a"]], ["li", ["p", "b"]]], ["pre", "js", "x()"]]],
    ],
    ["lazy quote continuation", "> a\nb", [["quote", ["p", "a", ["br"], "b"]]]],
    ["nested quotes", "> a\n>> b", [["quote", ["p", "a"], ["quote", ["p", "b"]]]]],
    [
      "table with alignment, inline formatting and a short row",
      "| a | b | c |\n|:--|:-:|--:|\n| **x** | `y` | [z](https://z.dev) |\n| 1 |",
      [
        [
          "table",
          "left,center,right",
          ["tr", ["th", "a"], ["th", "b"], ["th", "c"]],
          ["tr", ["td", ["strong", "x"]], ["td", ["code", "y"]], ["td", ["a", "https://z.dev", "z"]]],
          ["tr", ["td", "1"], ["td"], ["td"]],
        ],
      ],
    ],
    ["table without outer pipes; escaped pipe", "a | b\n--- | ---\nx \\| y | z | extra", [["table", "-,-", ["tr", ["th", "a"], ["th", "b"]], ["tr", ["td", "x | y"], ["td", "z"]]]]],
    ["no delimiter row: not a table", "a | b\nnot delim", [["p", "a | b", ["br"], "not delim"]]],
    ["a table ends at a line without pipes", "| a |\n|---|\n| 1 |\nafter", [["table", "-", ["tr", ["th", "a"]], ["tr", ["td", "1"]]], ["p", "after"]]],
    ["header and delimiter cell counts must match", "| a | b |\n|---|\n| 1 | 2 |", [["p", "| a | b |", ["br"], "|---|", ["br"], "| 1 | 2 |"]]],
    ["tilde fence", "~~~py\nprint(1)\n~~~", [["pre", "py", "print(1)"]]],
    ["a longer fence holds a shorter one", "````md\n```js\nx\n```\n````", [["pre", "md", "```js\nx\n```"]]],
    ["an unterminated fence is code", "```ts\nconst a", [["pre", "ts", "const a"]]],
    ["HTML is text", "<div onclick=x>hi</div>", [["p", "<div onclick=x>hi</div>"]]],
  ]
  for (const [name, source, expected] of cases) test(name, () => expect(md(source)).toEqual(expected))
})

describe("markdown inline", () => {
  const cases: Array<[string, string, unknown[]]> = [
    ["strike and highlight", "~~gone~~ and ==hot==", [["del", "gone"], " and ", ["mark", "hot"]]],
    ["spaced == and ~~ are text", "a == b ~~ c", ["a == b ~~ c"]],
    ["bold with em inside", "**bold _and em_**", [["strong", "bold ", ["em", "and em"]]]],
    ["arithmetic and snake_case are text", "2 * 3 * 4 snake_case_name", ["2 * 3 * 4 snake_case_name"]],
    ["line break", "a\nb", ["a", ["br"], "b"]],
    ["bare URL; trailing punctuation stays outside", "see https://x.dev/a_(b). and http://y.dev, ok", ["see ", ["a", "https://x.dev/a_(b)", "https://x.dev/a_(b)"], ". and ", ["a", "http://y.dev", "http://y.dev"], ", ok"]],
    ["bare URL in parentheses", "(see https://x.dev)", ["(see ", ["a", "https://x.dev", "https://x.dev"], ")"]],
    ["angle autolink", "<https://y.dev/p?q=1>", [["a", "https://y.dev/p?q=1", "https://y.dev/p?q=1"]]],
    ["backslash escapes", "\\*not em\\* \\[x\\](y) \\`c\\` \\==m\\==", ["*not em* [x](y) `c` ==m=="]],
    ["a backslash before a letter stays", "C:\\path", ["C:\\path"]],
    ["image becomes a link with its alt text", "![logo](https://x.dev/l.png)", [["img", "logo", "https://x.dev/l.png"]]],
    ["image with an unsafe source keeps only its alt text", "![bad](javascript:x)", [["img", "bad", null]]],
    ["brackets inside a link label", "[a [b] c](https://x.dev)", [["a", "https://x.dev", "a [b] c"]]],
    ["a link title is ignored", '[x](https://ok.dev "title")', [["a", "https://ok.dev", "x"]]],
    ["code spans with backtick runs", "``a ` b`` and `c`", [["code", "a ` b"], " and ", ["code", "c"]]],
    ["no formatting inside code", "`**x** [y](https://z)`", [["code", "**x** [y](https://z)"]]],
  ]
  for (const [name, source, expected] of cases) test(name, () => expect(inline(source)).toEqual(expected))
})

describe("markdown XSS", () => {
  const hostile = [
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](  javascript:alert(1)  )",
    "[x](<javascript:alert(1)>)",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](vbscript:msgbox)",
    "[x](//evil.com)",
    "[x](/\\evil.com)",
    "[x [y](javascript:alert(1))](https://ok.dev)",
    "[[x](javascript:a)](javascript:b)",
    "<javascript:alert(1)>",
    "javascript:alert(1)",
    "![x](data:image/png;base64,AAA)",
    "![x](javascript:alert(1))",
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "| [x](javascript:a) | b |\n|---|---|\n| <script> | ![i](data:x) |",
    "> [x](javascript:a)\n- [y](data:x)",
  ]
  const links = (blocks: MdBlock[]): string[] => {
    const out: string[] = []
    const walkInline = (nodes: Inline[]) => {
      for (const n of nodes) {
        if (n.type === "link") out.push(n.href)
        if (n.type === "image" && n.href) out.push(n.href)
        if ("children" in n) walkInline(n.children)
      }
    }
    const walk = (bs: MdBlock[]) => {
      for (const b of bs) {
        if (b.type === "paragraph" || b.type === "heading") walkInline(b.children)
        if (b.type === "quote") walk(b.blocks)
        if (b.type === "list") for (const i of b.items) walk(i.blocks)
        if (b.type === "table") for (const row of [b.head, ...b.rows]) for (const cell of row) walkInline(cell)
      }
    }
    walk(blocks)
    return out
  }
  for (const source of hostile) {
    test(`only safe hrefs: ${JSON.stringify(source)}`, () => {
      for (const href of links(parseMarkdown(source))) expect(safeHref(href)).toBe(href)
      for (const href of links(parseMarkdown(source, { streaming: true }))) expect(safeHref(href)).toBe(href)
    })
  }
  test("unsafe links keep their label as text", () => {
    expect(inline("[x [y](javascript:alert(1))](https://ok.dev)")).toEqual([["a", "https://ok.dev", "x ", "y"]])
    expect(inline("<javascript:alert(1)>")).toEqual(["<javascript:alert(1)>"])
    expect(inline("[x](data:text/html,hi)")).toEqual(["x"])
    expect(inline("<script>alert(1)</script>")).toEqual(["<script>alert(1)</script>"])
  })
})

describe("markdown while streaming", () => {
  const cases: Array<[string, string, unknown[], unknown[]]> = [
    ["unclosed bold", "Hello **wor", [["p", "Hello ", ["strong", "wor"]]], [["p", "Hello **wor"]]],
    ["unclosed code span", "run `npm te", [["p", "run ", ["code", "npm te"]]], [["p", "run `npm te"]]],
    ["unclosed strike", "~~del", [["p", ["del", "del"]]], [["p", "~~del"]]],
    ["link target still arriving", "see [docs](https://exa", [["p", "see ", "docs"]], [["p", "see [docs](https://exa"]]],
    ["only the last block is open", "**a\n\nb", [["p", "**a"], ["p", "b"]], [["p", "**a"], ["p", "b"]]],
    ["table header alone", "| a | b |", [["table", "-,-", ["tr", ["th", "a"], ["th", "b"]]]], [["p", "| a | b |"]]],
    ["last item of a list", "- a\n- **b", [["ul", ["li", ["p", "a"]], ["li", ["p", ["strong", "b"]]]]], [["ul", ["li", ["p", "a"]], ["li", ["p", "**b"]]]]],
    [
      "row still arriving",
      "| a | b |\n|---|---|\n| 1 | **x",
      [["table", "-,-", ["tr", ["th", "a"], ["th", "b"]], ["tr", ["td", "1"], ["td", ["strong", "x"]]]]],
      [["table", "-,-", ["tr", ["th", "a"], ["th", "b"]], ["tr", ["td", "1"], ["td", "**x"]]]],
    ],
  ]
  for (const [name, source, streaming, done] of cases) {
    test(name, () => {
      expect(md(source, true)).toEqual(streaming)
      expect(md(source)).toEqual(done)
    })
  }
  test("a partial delimiter row on the last line is already a table", () => {
    expect(md("| a | b |\n| --- | -")).toEqual([["table", "-,-", ["tr", ["th", "a"], ["th", "b"]]]])
    expect(md("| a | b |\n|")).toEqual([["p", "| a | b |", ["br"], "|"]])
  })
  test("an unterminated fence stays code", () => expect(md("```ts\nconst a", true)).toEqual([["pre", "ts", "const a"]]))
})
