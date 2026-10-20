// Code highlighting for replies: a small tokenizer (no dependencies, no HTML out) for the languages agents write
// most. Tokens cover the input exactly; the console renders each as a <span class="tok-<kind>"> text node.
// Loaded lazily, on the first code block (web/src/app/Markdown.tsx).

export type TokenKind = "comment" | "string" | "number" | "keyword" | "type" | "fn" | "prop" | "attr" | "tag" | "meta" | "add" | "del"
export type Token = { text: string; kind?: TokenKind }

const ALIASES: Record<string, string> = {
  ts: "ts", typescript: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "ts", javascript: "ts", jsx: "ts", mjs: "ts", cjs: "ts", node: "ts",
  json: "json", jsonc: "json", json5: "json",
  bash: "bash", sh: "bash", shell: "bash", zsh: "bash", console: "bash", shellsession: "bash", fish: "bash",
  python: "python", py: "python", python3: "python",
  go: "go", golang: "go",
  rust: "rust", rs: "rust",
  yaml: "yaml", yml: "yaml",
  diff: "diff", patch: "diff",
  sql: "sql", postgresql: "sql", postgres: "sql", mysql: "sql", sqlite: "sql",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  md: "md", markdown: "md",
}

/** The tokenizer for a fence's info string (`ts`, `TypeScript`, `sh` …), or undefined. */
export function languageOf(tag: string): string | undefined {
  return ALIASES[String(tag ?? "").trim().toLowerCase()]
}

const words = (s: string) => new Set(s.split(" "))

type Rule = {
  kind?: TokenKind
  re: RegExp
  /** Only where a line (after indentation, "- ") or, for `word`, a word begins. */
  at?: "line" | "word" | "command"
  /** Characters a match can start with (skips the regex elsewhere: most positions match no rule). */
  first?: string
}
type Lang = { rules: Rule[]; keywords?: Set<string>; types?: Set<string>; ci?: boolean; macros?: boolean }

const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$"
const isIdent = (c: string | undefined) => c !== undefined && (isIdentStart(c) || (c >= "0" && c <= "9"))
function identAt(s: string, i: number): string {
  let end = i + 1
  while (isIdent(s[end])) end++
  return s.slice(i, end)
}
const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]{0,3}\b/y
const DQ = /"(?:[^"\\\n]|\\.)*"?/y
const SQ = /'(?:[^'\\\n]|\\.)*'?/y
const BLOCK = /\/\*[\s\S]*?(?:\*\/|$)/y
const LINE = /\/\/[^\n]*/y
const HASH = /#[^\n]*/y

const LANGS: Record<string, Lang> = {
  ts: {
    rules: [
      { kind: "comment", re: LINE, first: "/" },
      { kind: "comment", re: BLOCK, first: "/" },
      { kind: "string", re: /`(?:[^`\\]|\\[\s\S])*`?/y, first: "`" },
      { kind: "string", re: DQ, first: "\"" },
      { kind: "string", re: SQ, first: "'" },
      { kind: "number", re: NUM, first: "0123456789" },
    ],
    keywords: words(
      "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield",
    ),
    types: words("string number boolean bigint symbol object unknown never any void Promise Array Record Map Set Partial Readonly"),
  },
  json: {
    rules: [
      { kind: "comment", re: LINE, first: "/" },
      { kind: "comment", re: BLOCK, first: "/" },
      { kind: "prop", re: /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, first: "\"" },
      { kind: "string", re: DQ, first: "\"" },
      { kind: "number", re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, first: "-0123456789" },
    ],
    keywords: words("true false null"),
  },
  bash: {
    rules: [
      { kind: "comment", re: HASH, at: "word", first: "#" },
      { kind: "string", re: /"(?:[^"\\]|\\[\s\S])*"?/y, first: "\"" },
      { kind: "string", re: /'[^']*'?/y, first: "'" },
      { kind: "prop", re: /\$(?:\{[^}\n]*\}?|[\w@#?$!*-]+)/y, first: "$" },
      { kind: "fn", re: /[\w./-]+/y, at: "command" },
      { kind: "attr", re: /--?[\w-]+/y, at: "word", first: "-" },
    ],
    keywords: words("if then else elif fi for do done case esac while until function in export local return select time sudo"),
  },
  python: {
    rules: [
      { kind: "comment", re: HASH, first: "#" },
      { kind: "string", re: /[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y, first: "rRbBfFuU\"'" },
      { kind: "string", re: /[rRbBfFuU]{0,2}"(?:[^"\\\n]|\\.)*"?/y, first: "rRbBfFuU\"'" },
      { kind: "string", re: /[rRbBfFuU]{0,2}'(?:[^'\\\n]|\\.)*'?/y, first: "rRbBfFuU\"'" },
      { kind: "meta", re: /@[\w.]+/y, first: "@" },
      { kind: "number", re: NUM, first: "0123456789" },
    ],
    keywords: words(
      "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case",
    ),
    types: words("int str float bool list dict set tuple bytes object type"),
  },
  go: {
    rules: [
      { kind: "comment", re: LINE, first: "/" },
      { kind: "comment", re: BLOCK, first: "/" },
      { kind: "string", re: /`[^`]*`?/y, first: "`" },
      { kind: "string", re: DQ, first: "\"" },
      { kind: "string", re: SQ, first: "'" },
      { kind: "number", re: NUM, first: "0123456789" },
    ],
    keywords: words(
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota",
    ),
    types: words("string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr byte rune float32 float64 bool error any"),
  },
  rust: {
    rules: [
      { kind: "comment", re: LINE, first: "/" },
      { kind: "comment", re: BLOCK, first: "/" },
      { kind: "string", re: /b?r#*"[\s\S]*?(?:"#*|$)/y, first: "br" },
      { kind: "string", re: /b?"(?:[^"\\]|\\[\s\S])*"?/y, first: "b\"" },
      { kind: "string", re: /b?'(?:[^'\\\n]|\\.){1,8}'/y, first: "b'" },
      { kind: "meta", re: /#!?\[[^\]\n]*\]?/y, first: "#" },
      { kind: "number", re: NUM, first: "0123456789" },
    ],
    keywords: words(
      "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
    ),
    types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Some None Ok Err"),
    macros: true,
  },
  yaml: {
    rules: [
      { kind: "comment", re: HASH, at: "word", first: "#" },
      { kind: "prop", re: /[^\s#:'"][^\n:#]*?(?=\s*:(?:\s|$))/y, at: "line" },
      { kind: "string", re: DQ, first: "\"" },
      { kind: "string", re: /'(?:[^'\n]|'')*'?/y, first: "'" },
      { kind: "meta", re: /---|\.\.\./y, at: "line", first: "-." },
      { kind: "number", re: /-?\d+(?:\.\d+)?\b/y, first: "-0123456789" },
    ],
    keywords: words("true false null yes no on off"),
  },
  sql: {
    rules: [
      { kind: "comment", re: /--[^\n]*/y, first: "-" },
      { kind: "comment", re: BLOCK, first: "/" },
      { kind: "string", re: /'(?:[^']|'')*'?/y, first: "'" },
      { kind: "prop", re: /"[^"\n]*"?/y, first: "\"" },
      { kind: "number", re: /\d+(?:\.\d+)?\b/y, first: "0123456789" },
    ],
    keywords: words(
      "select from where and or not insert into values update set delete create table drop alter add column index primary key foreign references join left right inner outer full on as group by order having limit offset distinct union all null is in like between case when then else end exists returning with default unique check if begin commit rollback asc desc cascade view trigger",
    ),
    types: words("int integer bigint smallint serial text varchar char boolean bool date timestamp timestamptz json jsonb uuid real numeric float double decimal"),
    ci: true,
  },
  css: {
    rules: [
      { kind: "comment", re: BLOCK, first: "/" },
      { kind: "string", re: DQ, first: "\"" },
      { kind: "string", re: SQ, first: "'" },
      { kind: "keyword", re: /@[\w-]+/y, first: "@" },
      { kind: "prop", re: /--?[a-zA-Z][\w-]*(?=\s*:)|[a-zA-Z][\w-]*(?=\s*:[^:{]*[;}\n])/y },
      { kind: "number", re: /#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:%|[a-zA-Z]{1,4})?/y },
    ],
    keywords: words("important inherit initial unset none auto"),
  },
  md: {
    rules: [
      { kind: "keyword", re: /#{1,6}\s[^\n]*/y, at: "line", first: "#" },
      { kind: "meta", re: /(?:[-*+]|\d+[.)])(?=\s)/y, at: "line", first: "-*+0123456789" },
      { kind: "string", re: /`[^`\n]*`?/y, first: "`" },
      { kind: "type", re: /\*\*[^*\n]+\*\*|__[^_\n]+__/y, first: "*_" },
      { kind: "attr", re: /\[[^\]\n]*\]\([^)\n]*\)/y, first: "[" },
      { kind: "comment", re: />[^\n]*/y, at: "line", first: ">" },
    ],
  },
}

/** Whether `i` starts a line, ignoring indentation (and a YAML/Markdown list dash). */
function lineStart(s: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const c = s[k]!
    if (c === "\n") return true
    if (c !== " " && c !== "\t" && c !== "-") return false
  }
  return true
}

/** Whether `i` is where a shell command name goes: line start, or after | ; & ( `. */
function commandStart(s: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const c = s[k]!
    if (c === " " || c === "\t") continue
    return c === "\n" || c === "|" || c === ";" || c === "&" || c === "(" || c === "`" || c === "$"
  }
  return true
}

const wordStart = (s: string, i: number) => i === 0 || /\s/.test(s[i - 1]!)

function sticky(re: RegExp, s: string, i: number): string | undefined {
  re.lastIndex = i
  const m = re.exec(s)
  return m && m[0] ? m[0] : undefined
}

function diff(code: string): Token[] {
  const out: Token[] = []
  for (const [k, line] of code.split("\n").entries()) {
    if (k) out.push({ text: "\n" })
    if (!line) continue
    const kind: TokenKind | undefined = /^(@@|\+\+\+ |--- |diff |index )/.test(line) ? "meta" : line[0] === "+" ? "add" : line[0] === "-" ? "del" : undefined
    out.push(kind ? { text: line, kind } : { text: line })
  }
  return out
}

function html(code: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < code.length) {
    const comment = sticky(/<!--[\s\S]*?(?:-->|$)/y, code, i)
    if (comment) {
      out.push({ text: comment, kind: "comment" })
      i += comment.length
      continue
    }
    const open = sticky(/<\/?[A-Za-z][\w:.-]*|<![A-Za-z]+/y, code, i)
    if (!open) {
      const text = sticky(/[^<]+|</y, code, i)!
      out.push({ text })
      i += text.length
      continue
    }
    out.push({ text: open, kind: "tag" })
    i += open.length
    while (i < code.length) {
      const end = sticky(/\/?>/y, code, i)
      if (end) {
        out.push({ text: end, kind: "tag" })
        i += end.length
        break
      }
      const piece = sticky(/\s+/y, code, i)
      const attr = piece ? undefined : sticky(/[^\s=>/"']+/y, code, i)
      const value = piece || attr ? undefined : sticky(/"[^"]*"?|'[^']*'?/y, code, i)
      if (piece) out.push({ text: piece })
      else if (attr) out.push({ text: attr, kind: "attr" })
      else if (value) out.push({ text: value, kind: "string" })
      else out.push({ text: code[i]! })
      i += (piece ?? attr ?? value ?? code[i]!).length
    }
  }
  return out
}

function scan(code: string, lang: Lang): Token[] {
  const out: Token[] = []
  let plain = ""
  const emit = (text: string, kind: TokenKind | undefined) => {
    if (!kind) {
      plain += text
      return
    }
    if (plain) out.push({ text: plain })
    plain = ""
    out.push({ text, kind })
  }
  let i = 0
  outer: while (i < code.length) {
    const ch = code[i]!
    for (const rule of lang.rules) {
      if (rule.first && !rule.first.includes(ch)) continue
      if (rule.at === "line" && !lineStart(code, i)) continue
      if (rule.at === "word" && !wordStart(code, i)) continue
      if (rule.at === "command" && !commandStart(code, i)) continue
      const m = sticky(rule.re, code, i)
      if (!m) continue
      emit(m, rule.kind === "fn" && lang.keywords?.has(m) ? "keyword" : rule.kind)
      i += m.length
      continue outer
    }
    if (isIdentStart(ch)) {
      const word = identAt(code, i)
      const key = lang.ci ? word.toLowerCase() : word
      const after = code[i + word.length]
      let kind: TokenKind | undefined
      if (lang.keywords?.has(key)) kind = "keyword"
      else if (lang.types?.has(key)) kind = "type"
      else if (after === "(" || (lang.macros && after === "!" && code[i + word.length + 1] !== "=")) kind = "fn"
      emit(word, kind)
      i += word.length
      continue
    }
    plain += ch
    i++
  }
  if (plain) out.push({ text: plain })
  return out
}

/** Merges neighbouring plain tokens (fewer DOM nodes). */
function merge(tokens: Token[]): Token[] {
  const out: Token[] = []
  for (const t of tokens) {
    const last = out.at(-1)
    if (last && !last.kind && !t.kind) last.text += t.text
    else out.push({ ...t })
  }
  return out
}

/** Tokens of `code` in language `tag` (any alias); an unknown language is one plain token. */
export function highlight(code: string, tag: string): Token[] {
  const source = String(code ?? "")
  if (!source) return []
  const lang = languageOf(tag)
  if (lang === "diff") return merge(diff(source))
  if (lang === "html") return merge(html(source))
  const rules = lang ? LANGS[lang] : undefined
  return rules ? scan(source, rules) : [{ text: source }]
}
